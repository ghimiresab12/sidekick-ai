/**
 * SidekickEngine — in-memory session memory and recommendation lifecycle.
 *
 * Out of scope by design: Chert I/O, Gemini/model reasoning, game-state
 * interpretation, tactical rules, explanation text generation, and private
 * local speech playback. Those live in adapters and the UI, and talk to this
 * engine only through the contracts in `src/contracts/types.ts`.
 *
 * Every public method validates its input and returns a `Result` instead of
 * throwing, so a late or malformed event can never crash the call pipeline.
 * Everything is held in memory; nothing is written to disk.
 */
import { randomUUID } from 'node:crypto';
import type {
  Activity,
  ContextChange,
  ContextOptions,
  ContextSource,
  ConversationInput,
  ConversationObservation,
  DecisionInput,
  EngineConfig,
  EngineError,
  ExplanationContext,
  ExplanationRequest,
  GoalRetireResult,
  GroupDecision,
  GroupGoal,
  ListObservationsQuery,
  Observation,
  ObservationSource,
  OverlayListener,
  OverlayState,
  Participant,
  ProposeOutcome,
  Recommendation,
  RecommendationCandidate,
  RecommendationContext,
  RecommendationView,
  Result,
  RoleChange,
  RoleUpdateResult,
  ScreenInput,
  ScreenObservation,
  SessionEvent,
  SessionEventPayload,
  SessionSnapshot,
  SessionStatus,
  StaleReason,
  VoiceCancelReason,
  VoiceRequest,
} from './contracts/types.js';
import {
  LIMITS,
  checkCandidate,
  checkContextOptions,
  checkConversationInput,
  checkCreateSessionOptions,
  checkDecisionInput,
  checkExplanationOptions,
  checkListObservationsQuery,
  checkParticipantInput,
  checkScreenInput,
  isActivity,
  isClientCancelReason,
  isNonEmptyString,
  parseIsoTime,
  type Check,
} from './contracts/validate.js';
import {
  decideProposal,
  isConditionStale,
  newestFirst,
  pickProminent,
} from './recommendations/recommendation-rules.js';
import { Timeline } from './sessions/timeline.js';

/** Test/demo defaults. Tune per game; pass overrides to the constructor. */
export const DEFAULT_ENGINE_CONFIG: Readonly<EngineConfig> = Object.freeze({
  cooldownMs: 30_000,
  staleAfterMs: 15_000,
  maxClockSkewMs: 5_000,
  maxObservations: 2_000,
  maxTimelineEvents: 5_000,
  voiceRequestTimeoutMs: 60_000,
});

export interface EngineOptions extends Partial<EngineConfig> {
  /** Injected clock (tests use a fake clock). */
  now?: () => Date;
  /** Injected ID generator. */
  newId?: () => string;
  /** Called if an overlay listener throws; the engine keeps running. */
  onListenerError?: (error: unknown) => void;
}

interface StoredObservation {
  observation: Observation;
  observedAtMs: number;
}

interface SessionState {
  id: string;
  externalRef?: string;
  status: SessionStatus;
  consentGiven: boolean;
  activity: Activity;
  activityConfirmed: boolean;
  suggestedActivity?: Activity;
  createdAt: string;
  startedAt?: string;
  startedAtMs?: number;
  endedAt?: string;
  /** Current capture generation; increments on every start/pause/resume/end. */
  captureGeneration: number;
  /** Generations during which the session was active (inputs may be stored). */
  activeGenerations: Set<number>;
  contextRevision: number;
  participants: Map<string, Participant>;
  roleChanges: RoleChange[];
  goals: Map<string, GroupGoal>;
  decisions: Map<string, GroupDecision>;
  observations: Map<string, StoredObservation>;
  latestObservationId: Partial<Record<ObservationSource, string>>;
  recommendations: Map<string, Recommendation>;
  voiceRequests: Map<string, VoiceRequest>;
  lastVoiceRequestByRecommendation: Map<string, string>;
  activeVoiceRequestId?: string;
  timeline: Timeline;
  timelineTruncated: boolean;
  /** Listener → highest state version already delivered to it. */
  listeners: Map<OverlayListener, number>;
  /** Monotonic overlay state version; bumped by `#changed`. */
  version: number;
  observationLimitReached: boolean;
}

/** Upper bound on restart rounds in one flush (a listener that keeps changing state). */
const MAX_NOTIFY_ROUNDS = 50;

interface Provenance {
  effectiveMs: number;
  source: ContextSource;
  sourceObservationId?: string;
}

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const err = <T>(error: EngineError, detail?: string): Result<T> =>
  detail === undefined ? { ok: false, error } : { ok: false, error, detail };
const fromCheck = <T>(check: Check): Result<T> =>
  check.ok ? err('invalid_input') : err(check.error, check.detail);
const clone = <T>(value: T): T => structuredClone(value);
const iso = (ms: number): string => new Date(ms).toISOString();
const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;
const isVerified = (source: ContextSource): boolean => source !== 'transcript';
const isLive = (r: VoiceRequest): boolean => r.status === 'pending' || r.status === 'playing_locally';
const isOpenCard = (r: Recommendation): boolean => r.status === 'active' || r.status === 'stale';

export class SidekickEngine {
  readonly config: Readonly<EngineConfig>;
  readonly #sessions = new Map<string, SessionState>();
  readonly #now: () => Date;
  readonly #newId: () => string;
  readonly #onListenerError: (error: unknown) => void;
  /** Nesting depth of public calls; notifications flush only when it returns to 0. */
  #depth = 0;
  #flushing = false;

  constructor(options: EngineOptions = {}) {
    const { now, newId, onListenerError, ...overrides } = options ?? {};
    const config: EngineConfig = { ...DEFAULT_ENGINE_CONFIG };
    for (const key of Object.keys(DEFAULT_ENGINE_CONFIG) as Array<keyof EngineConfig>) {
      const value = overrides[key];
      if (value !== undefined) config[key] = value;
    }
    for (const [key, value] of Object.entries(config)) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new RangeError(`${key} must be a finite, non-negative number`);
      }
    }
    for (const key of ['maxObservations', 'maxTimelineEvents'] as const) {
      if (!Number.isInteger(config[key]) || config[key] < 1) {
        throw new RangeError(`${key} must be a positive integer`);
      }
    }
    this.config = Object.freeze(config);
    this.#now = now ?? (() => new Date());
    this.#newId = newId ?? randomUUID;
    this.#onListenerError = onListenerError ?? (() => {});
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /** Creates a session in `starting`. No input is processed until `startWithConsent`. */
  createSession(options?: { externalRef?: string }): Result<SessionSnapshot> {
    return this.#op(() => this.#createSession(options));
  }

  #createSession(options?: { externalRef?: string }): Result<SessionSnapshot> {
    const check = checkCreateSessionOptions(options);
    if (!check.ok) return fromCheck(check);
    const id = this.#newId();
    const state: SessionState = {
      id,
      status: 'starting',
      consentGiven: false,
      activity: 'unconfirmed',
      activityConfirmed: false,
      createdAt: this.#nowIso(),
      captureGeneration: 0,
      activeGenerations: new Set(),
      contextRevision: 0,
      participants: new Map(),
      roleChanges: [],
      goals: new Map(),
      decisions: new Map(),
      observations: new Map(),
      latestObservationId: {},
      recommendations: new Map(),
      voiceRequests: new Map(),
      lastVoiceRequestByRecommendation: new Map(),
      timeline: new Timeline(),
      timelineTruncated: false,
      listeners: new Map(),
      version: 0,
      observationLimitReached: false,
    };
    if (options?.externalRef !== undefined) state.externalRef = options.externalRef;
    this.#sessions.set(id, state);
    return ok(this.#snapshot(state));
  }

  /** Explicit participant consent: `starting` → `active`. */
  startWithConsent(sessionId: string): Result<SessionSnapshot> {
    return this.#withSession(sessionId, (s) => {
      if (s.status !== 'starting') return err('invalid_transition', `cannot start from ${s.status}`);
      const nowMs = this.#nowMs();
      s.status = 'active';
      s.consentGiven = true;
      s.startedAt = iso(nowMs);
      s.startedAtMs = nowMs;
      this.#nextGeneration(s, true);
      this.#record(s, { type: 'session_started' }, 'Session started with participant consent');
      this.#notify(s);
      return ok(this.#snapshot(s));
    });
  }

  /**
   * Stops new processing. Cancels any in-flight explanation (`session_paused`) and
   * marks active cards stale. Starts a new capture generation: inputs captured while
   * paused are rejected, and after resume only current-generation evidence can create advice.
   */
  pause(sessionId: string): Result<SessionSnapshot> {
    return this.#withSession(sessionId, (s) => {
      if (s.status !== 'active') return err('invalid_transition', `cannot pause from ${s.status}`);
      s.status = 'paused';
      this.#nextGeneration(s, false);
      this.#cancelActiveVoice(s, 'session_paused');
      this.#markAllActiveStale(s, 'session_paused');
      this.#record(s, { type: 'session_paused' }, 'Observation paused');
      this.#notify(s);
      return ok(this.#snapshot(s));
    });
  }

  resume(sessionId: string): Result<SessionSnapshot> {
    return this.#withSession(sessionId, (s) => {
      if (s.status !== 'paused') return err('invalid_transition', `cannot resume from ${s.status}`);
      s.status = 'active';
      this.#nextGeneration(s, true);
      this.#record(s, { type: 'session_resumed' }, 'Observation resumed');
      this.#notify(s);
      return ok(this.#snapshot(s));
    });
  }

  /** Stops processing permanently. Cancels in-flight explanations. Timeline kept until `discard`. */
  end(sessionId: string): Result<SessionSnapshot> {
    return this.#withSession(sessionId, (s) => {
      if (s.status !== 'active' && s.status !== 'paused') {
        return err('invalid_transition', `cannot end from ${s.status}`);
      }
      s.status = 'ended';
      s.endedAt = this.#nowIso();
      this.#nextGeneration(s, false);
      this.#cancelActiveVoice(s, 'session_ended');
      this.#markAllActiveStale(s, 'session_ended');
      this.#record(s, { type: 'session_ended' }, 'Session ended; observation stopped');
      this.#notify(s);
      return ok(this.#snapshot(s));
    });
  }

  /**
   * Deletes all in-memory data for the session and drops its overlay subscriptions.
   * Any in-flight explanation is abandoned; later callbacks get `session_not_found`.
   * The UI that called discard is responsible for stopping its own local playback.
   */
  discard(sessionId: string): Result<{ sessionId: string }> {
    return this.#op(() => this.#discard(sessionId));
  }

  #discard(sessionId: string): Result<{ sessionId: string }> {
    const s = typeof sessionId === 'string' ? this.#sessions.get(sessionId) : undefined;
    if (!s) return err('session_not_found');
    s.listeners.clear();
    s.observations.clear();
    s.recommendations.clear();
    s.participants.clear();
    s.roleChanges.length = 0;
    s.goals.clear();
    s.decisions.clear();
    s.voiceRequests.clear();
    s.lastVoiceRequestByRecommendation.clear();
    delete s.activeVoiceRequestId;
    s.timeline.clear();
    this.#sessions.delete(sessionId);
    return ok({ sessionId });
  }

  // ── Participants, roles, goals, decisions, activity ───────────────────────

  addParticipant(sessionId: string, input: { displayName: string; externalRef?: string }): Result<Participant> {
    return this.#withOpenSession(sessionId, (s) => {
      const check = checkParticipantInput(input);
      if (!check.ok) return fromCheck(check);
      const { externalRef } = input;
      if (externalRef !== undefined) {
        for (const p of s.participants.values()) {
          if (p.externalRef === externalRef) return err('invalid_input', 'externalRef already in use');
        }
      }
      const participant: Participant = { id: this.#newId(), displayName: input.displayName.trim() };
      if (externalRef !== undefined) participant.externalRef = externalRef;
      s.participants.set(participant.id, participant);
      this.#record(
        s,
        { type: 'participant_added', participantId: participant.id, displayName: participant.displayName },
        `Participant added: ${participant.displayName}`,
      );
      this.#notify(s);
      return ok(clone(participant));
    });
  }

  /**
   * Assigns or corrects a role. Changes are ordered by effective time (the source
   * utterance's `observedAt` for transcript-derived changes, engine time otherwise):
   * - an older change than the participant's last role change is ignored;
   * - a verified correction (`manual` / `participant_report`) beats a transcript-derived
   *   change unless the transcript change is newer by more than `maxClockSkewMs`.
   * Active recommendations that relied on the old role are marked stale (`role_changed`).
   */
  assignRole(sessionId: string, participantId: string, role: string, options: ContextOptions): Result<RoleUpdateResult> {
    return this.#withOpenSession(sessionId, (s) => {
      const p = s.participants.get(participantId);
      if (!p) return err('participant_not_found');
      if (!isNonEmptyString(role, LIMITS.role)) {
        return err('invalid_input', `role must be 1–${LIMITS.role} characters`);
      }
      return this.#applyRoleChange(s, p, role.trim(), options);
    });
  }

  /** Removes a role. The clear is kept as `lastRoleChange` so older delayed assignments cannot restore it. */
  clearRole(sessionId: string, participantId: string, options: ContextOptions): Result<RoleUpdateResult> {
    return this.#withOpenSession(sessionId, (s) => {
      const p = s.participants.get(participantId);
      if (!p) return err('participant_not_found');
      return this.#applyRoleChange(s, p, undefined, options);
    });
  }

  setGoal(sessionId: string, text: string, options: ContextOptions): Result<GroupGoal> {
    return this.#withOpenSession(sessionId, (s) => {
      if (!isNonEmptyString(text, LIMITS.goalText)) {
        return err('invalid_input', `goal text must be 1–${LIMITS.goalText} characters`);
      }
      const prov = this.#provenance(s, options);
      if (!prov.ok) return prov;
      const revision = ++s.contextRevision;
      const goal: GroupGoal = {
        id: this.#newId(),
        text: text.trim(),
        statedAt: iso(prov.value.effectiveMs),
        recordedAt: this.#nowIso(),
        source: prov.value.source,
        revision,
        active: true,
      };
      if (prov.value.sourceObservationId !== undefined) goal.sourceObservationId = prov.value.sourceObservationId;
      s.goals.set(goal.id, goal);
      const payload: SessionEventPayload = {
        type: 'goal_set', goalId: goal.id, text: goal.text, source: goal.source, revision,
        ...(goal.sourceObservationId ? { sourceObservationId: goal.sourceObservationId } : {}),
      };
      this.#record(s, payload, `Group goal: ${truncate(goal.text, 120)}`, prov.value.effectiveMs);
      return ok(clone(goal));
    });
  }

  /** Retires a goal. Active recommendations tied to it are marked stale (`goal_changed`). */
  retireGoal(sessionId: string, goalId: string, options: ContextOptions): Result<GoalRetireResult> {
    return this.#withOpenSession(sessionId, (s) => {
      const goal = s.goals.get(goalId);
      if (!goal) return err('goal_not_found');
      const prov = this.#provenance(s, options);
      if (!prov.ok) return prov;
      if (!goal.active) return ok({ goal: clone(goal), invalidatedRecommendationIds: [] });
      if (prov.value.effectiveMs < Date.parse(goal.statedAt)) {
        return err('invalid_transition', 'retirement predates the goal');
      }
      const revision = ++s.contextRevision;
      goal.active = false;
      goal.retiredAt = iso(prov.value.effectiveMs);
      goal.retiredRevision = revision;
      goal.retiredSource = prov.value.source;
      if (prov.value.sourceObservationId !== undefined) goal.retiredSourceObservationId = prov.value.sourceObservationId;
      const payload: SessionEventPayload = {
        type: 'goal_retired', goalId: goal.id, source: prov.value.source, revision,
        ...(prov.value.sourceObservationId ? { sourceObservationId: prov.value.sourceObservationId } : {}),
      };
      this.#record(s, payload, `Goal retired: ${truncate(goal.text, 120)}`, prov.value.effectiveMs);
      const invalidated = this.#invalidate(s, (r) => r.relatedGoalId === goal.id, 'goal_changed', { goalId: goal.id });
      this.#notify(s);
      return ok({ goal: clone(goal), invalidatedRecommendationIds: invalidated });
    });
  }

  /** Records an explicitly stated group decision. The engine never infers decisions. */
  recordDecision(sessionId: string, input: DecisionInput): Result<GroupDecision> {
    return this.#withOpenSession(sessionId, (s) => {
      const check = checkDecisionInput(input);
      if (!check.ok) return fromCheck(check);
      const sourceIds = [...new Set(input.sourceObservationIds ?? [])];
      let decidedMs: number | undefined;
      for (const id of sourceIds) {
        const stored = s.observations.get(id);
        if (!stored) return err('evidence_not_found', `observation ${id} is not in this session`);
        if (input.source === 'transcript' && stored.observation.source !== 'transcript') {
          return err('invalid_input', 'transcript-derived decisions must cite conversation observations');
        }
        decidedMs = Math.max(decidedMs ?? stored.observedAtMs, stored.observedAtMs);
      }
      const participantIds = [...new Set(input.participantIds ?? [])];
      for (const id of participantIds) {
        if (!s.participants.has(id)) return err('participant_not_found', `participant ${id}`);
      }
      if (input.relatedRecommendationId !== undefined && !s.recommendations.has(input.relatedRecommendationId)) {
        return err('recommendation_not_found');
      }
      if (input.relatedGoalId !== undefined && !s.goals.has(input.relatedGoalId)) return err('goal_not_found');

      const effectiveMs = decidedMs ?? this.#nowMs();
      const decision: GroupDecision = {
        id: this.#newId(),
        text: input.text.trim(),
        decidedAt: iso(effectiveMs),
        recordedAt: this.#nowIso(),
        source: input.source,
        sourceObservationIds: sourceIds,
        participantIds,
      };
      if (input.relatedRecommendationId !== undefined) decision.relatedRecommendationId = input.relatedRecommendationId;
      if (input.relatedGoalId !== undefined) decision.relatedGoalId = input.relatedGoalId;
      s.decisions.set(decision.id, decision);
      this.#record(
        s,
        { type: 'decision_recorded', decision: clone(decision) },
        `Decision: ${truncate(decision.text, 120)}`,
        effectiveMs,
      );
      return ok(clone(decision));
    });
  }

  /** Records a suggested activity. It is not applied until a participant confirms it. */
  suggestActivity(sessionId: string, activity: Activity): Result<SessionSnapshot> {
    return this.#withOpenSession(sessionId, (s) => {
      if (!isActivity(activity) || activity === 'unconfirmed') {
        return err('invalid_input', 'activity must be gaming | planning | social');
      }
      s.suggestedActivity = activity;
      this.#notify(s);
      return ok(this.#snapshot(s));
    });
  }

  /** A participant confirmed (or corrected) the activity. */
  confirmActivity(sessionId: string, activity: Activity): Result<SessionSnapshot> {
    return this.#withOpenSession(sessionId, (s) => {
      if (!isActivity(activity) || activity === 'unconfirmed') {
        return err('invalid_input', 'activity must be gaming | planning | social');
      }
      s.activity = activity;
      s.activityConfirmed = true;
      delete s.suggestedActivity;
      this.#record(s, { type: 'activity_confirmed', activity }, `Activity confirmed: ${activity}`);
      this.#notify(s);
      return ok(this.#snapshot(s));
    });
  }

  // ── Observation ingest (adapter entry points) ─────────────────────────────

  ingestConversation(sessionId: string, input: ConversationInput): Result<ConversationObservation> {
    return this.#withSession(sessionId, (s) => {
      const gate = this.#ingestGate(s);
      if (!gate.ok) return gate;
      const check = checkConversationInput(input);
      if (!check.ok) return fromCheck(check);
      const timing = this.#admitObservation(s, input.observedAt, input.captureGeneration);
      if (!timing.ok) return timing;

      const speaker =
        input.speakerRef === undefined
          ? undefined
          : [...s.participants.values()].find((p) => p.externalRef === input.speakerRef);
      const observation: ConversationObservation = {
        id: this.#newId(),
        sessionId: s.id,
        captureGeneration: input.captureGeneration,
        source: 'transcript',
        observedAt: iso(timing.value),
        receivedAt: this.#nowIso(),
        text: input.text.trim(),
      };
      if (speaker) observation.speakerParticipantId = speaker.id;
      const who = speaker ? speaker.displayName : 'speaker unverified';
      this.#storeObservation(s, observation, timing.value, `Speech observed (${who})`);
      return ok(clone(observation));
    });
  }

  ingestScreen(sessionId: string, input: ScreenInput): Result<ScreenObservation> {
    return this.#withSession(sessionId, (s) => {
      const gate = this.#ingestGate(s);
      if (!gate.ok) return gate;
      const check = checkScreenInput(input);
      if (!check.ok) return fromCheck(check);
      const timing = this.#admitObservation(s, input.observedAt, input.captureGeneration);
      if (!timing.ok) return timing;

      const observation: ScreenObservation = {
        id: this.#newId(),
        sessionId: s.id,
        captureGeneration: input.captureGeneration,
        source: 'screen',
        mediaSource: input.mediaSource,
        observedAt: iso(timing.value),
        receivedAt: this.#nowIso(),
        summary: input.summary.trim(),
        evidenceQuality: input.evidenceQuality,
      };
      if (input.facts !== undefined) observation.facts = { ...input.facts };
      if (input.frameRef !== undefined) observation.frameRef = input.frameRef;
      this.#storeObservation(
        s,
        observation,
        timing.value,
        `${observation.mediaSource === 'camera' ? 'Camera' : 'Screen share'} (${observation.evidenceQuality}): ${truncate(observation.summary, 120)}`,
      );
      return ok(clone(observation));
    });
  }

  getObservation(sessionId: string, observationId: string): Result<Observation> {
    return this.#withSession(sessionId, (s) => {
      const stored = s.observations.get(observationId);
      return stored ? ok(clone(stored.observation)) : err('evidence_not_found');
    });
  }

  /**
   * Read-only, bounded view of stored observations, ordered by **source time**
   * (oldest first; ties keep arrival order). When more match than `limit`, the newest
   * `limit` are returned, or the oldest with `keep: 'oldest'`. No side effects: no sweep,
   * no events, no overlay version bump.
   */
  listObservations(sessionId: string, query?: ListObservationsQuery): Result<Observation[]> {
    return this.#withSession(sessionId, (s) => {
      const check = checkListObservationsQuery(query);
      if (!check.ok) return fromCheck(check);
      const q = query ?? {};
      const sinceMs = q.observedSince === undefined ? undefined : parseIsoTime(q.observedSince);
      const untilMs = q.observedUntil === undefined ? undefined : parseIsoTime(q.observedUntil);
      const ids = q.ids === undefined ? undefined : new Set(q.ids);
      const limit = q.limit ?? LIMITS.listObservationsDefault;
      const matches = [...s.observations.values()]
        .map((stored, index) => ({ stored, index }))
        .filter(({ stored: { observation: o, observedAtMs } }) =>
          (q.source === undefined || o.source === q.source) &&
          (q.captureGeneration === undefined || o.captureGeneration === q.captureGeneration) &&
          (sinceMs === undefined || observedAtMs >= sinceMs) &&
          (untilMs === undefined || observedAtMs <= untilMs) &&
          (ids === undefined || ids.has(o.id)))
        .sort((a, b) => a.stored.observedAtMs - b.stored.observedAtMs || a.index - b.index);
      const kept = q.keep === 'oldest' ? matches.slice(0, limit) : matches.slice(-limit);
      return ok(kept.map((m) => clone(m.stored.observation)));
    });
  }

  /** Newest observation of a source by **source time** (not arrival order). */
  getLatestObservation(sessionId: string, source: ObservationSource): Result<Observation | undefined> {
    return this.#withSession(sessionId, (s) => {
      if (source !== 'transcript' && source !== 'screen') return err('invalid_input', 'source must be transcript | screen');
      const id = s.latestObservationId[source];
      const stored = id === undefined ? undefined : s.observations.get(id);
      return ok(stored ? clone(stored.observation) : undefined);
    });
  }

  // ── Recommendations (reasoning-layer entry points) ────────────────────────

  /**
   * Proposes advice. Freshness is judged **only** on `conditionObservationIds`:
   * - newest condition evidence must be within `staleAfterMs` and observed after the last resume;
   * - an active card with the same fingerprint is merged (condition time only moves forward);
   * - a recently dismissed/resolved card with the same fingerprint suppresses it (cooldown).
   */
  proposeRecommendation(sessionId: string, candidate: RecommendationCandidate): Result<ProposeOutcome> {
    return this.#withSession(sessionId, (s) => {
      if (s.status === 'starting') return err('consent_required');
      if (s.status !== 'active') return err('session_not_active');
      const check = checkCandidate(candidate);
      if (!check.ok) return fromCheck(check);
      if (candidate.basedOnContextRevision > s.contextRevision) {
        return err('invalid_input', 'basedOnContextRevision is newer than the session context');
      }
      if (candidate.basedOnContextRevision < s.contextRevision) {
        return err('stale_context', 'roles or goals changed since this candidate was evaluated');
      }

      const conditionIds = [...new Set(candidate.conditionObservationIds)];
      let newest: StoredObservation | undefined;
      for (const id of conditionIds) {
        const stored = s.observations.get(id);
        if (!stored) return err('evidence_not_found', `observation ${id} is not in this session`);
        if (stored.observation.source === 'screen' && stored.observation.mediaSource !== 'screen_share') {
          return err('insufficient_evidence', `observation ${id} is not from a shared screen`);
        }
        if (stored.observation.source === 'screen' && stored.observation.evidenceQuality === 'unknown') {
          return err('insufficient_evidence', `observation ${id} has unknown evidence quality`);
        }
        if (stored.observation.captureGeneration !== s.captureGeneration) {
          return err('stale_evidence', `observation ${id} was captured before the last pause/resume`);
        }
        if (!newest || stored.observedAtMs > newest.observedAtMs) newest = stored;
      }
      const contextIds = [...new Set(candidate.contextObservationIds ?? [])];
      for (const id of contextIds) {
        if (!s.observations.has(id)) return err('evidence_not_found', `observation ${id} is not in this session`);
      }
      const relatedIds = [...new Set(candidate.relatedParticipantIds ?? [])];
      for (const id of relatedIds) {
        if (!s.participants.has(id)) return err('participant_not_found', `participant ${id}`);
      }
      if (candidate.relatedGoalId !== undefined) {
        const goal = s.goals.get(candidate.relatedGoalId);
        if (!goal) return err('goal_not_found');
        if (!goal.active) return err('invalid_input', 'relatedGoalId refers to a retired goal');
      }

      const nowMs = this.#nowMs();
      // `newest` is defined: checkCandidate guarantees at least one condition ID.
      const newestCondition = newest!;
      const newestAt = newestCondition.observation.observedAt;
      if (isConditionStale(newestAt, nowMs, this.config.staleAfterMs)) {
        return err('stale_evidence', 'newest condition evidence is older than the stale window');
      }

      const changed = this.#sweep(s, nowMs);
      const decision = decideProposal(s.recommendations.values(), candidate.fingerprint, nowMs, this.config.cooldownMs);
      const nowIso = iso(nowMs);

      if (decision.kind === 'suppress') {
        if (changed) this.#notify(s);
        return ok({ outcome: 'suppressed', reason: 'cooldown', recommendationId: decision.existing.id });
      }

      if (decision.kind === 'merge') {
        // The card keeps its original text and context snapshot; only evidence is appended.
        const rec = decision.existing;
        const addedCondition = conditionIds.filter((id) => !rec.conditionObservationIds.includes(id));
        rec.conditionObservationIds.push(...addedCondition);
        rec.contextObservationIds = rec.contextObservationIds.filter((id) => !addedCondition.includes(id));
        const addedContext = contextIds.filter(
          (id) => !rec.contextObservationIds.includes(id) && !rec.conditionObservationIds.includes(id),
        );
        rec.contextObservationIds.push(...addedContext);
        const refreshed = newestCondition.observedAtMs > Date.parse(rec.lastConditionAt);
        if (refreshed) rec.lastConditionAt = newestAt;
        const touched = addedCondition.length + addedContext.length > 0 || refreshed;
        if (touched) rec.updatedAt = nowIso;
        if (changed || touched) this.#notify(s);
        return ok({ outcome: 'merged', recommendation: clone(rec), refreshed });
      }

      const rec: Recommendation = {
        id: this.#newId(),
        sessionId: s.id,
        fingerprint: candidate.fingerprint,
        title: candidate.title.trim(),
        shortAdvice: candidate.shortAdvice.trim(),
        conditionObservationIds: conditionIds,
        contextObservationIds: contextIds,
        relatedParticipantIds: relatedIds,
        urgency: candidate.urgency,
        status: 'active',
        createdAt: nowIso,
        updatedAt: nowIso,
        statusChangedAt: nowIso,
        lastConditionAt: newestAt,
        contextAtCreation: this.#captureContext(s, relatedIds, candidate.relatedGoalId, nowIso),
      };
      if (candidate.relatedGoalId !== undefined) rec.relatedGoalId = candidate.relatedGoalId;
      s.recommendations.set(rec.id, rec);
      const payload: SessionEventPayload = {
        type: 'recommendation_created',
        recommendationId: rec.id,
        fingerprint: rec.fingerprint,
        conditionObservationIds: [...conditionIds],
        contextObservationIds: [...contextIds],
        relatedParticipantIds: [...relatedIds],
        contextRevision: rec.contextAtCreation.contextRevision,
        ...(rec.relatedGoalId ? { relatedGoalId: rec.relatedGoalId } : {}),
      };
      this.#record(s, payload, `Advice shown: ${rec.title}`);
      this.#notify(s);
      return ok({ outcome: 'created', recommendation: clone(rec) });
    });
  }

  /** User dismissed the card. It stays in history and the review. */
  dismiss(sessionId: string, recommendationId: string): Result<Recommendation> {
    return this.#withSession(sessionId, (s) => {
      const rec = s.recommendations.get(recommendationId);
      if (!rec) return err('recommendation_not_found');
      if (!isOpenCard(rec)) return err('invalid_transition', `cannot dismiss a ${rec.status} recommendation`);
      this.#setStatus(rec, 'dismissed');
      this.#record(s, { type: 'recommendation_dismissed', recommendationId: rec.id }, `Advice dismissed: ${rec.title}`);
      this.#notify(s);
      return ok(clone(rec));
    });
  }

  /**
   * Marks the issue resolved. Requires an observation from this session whose source
   * time is strictly newer than the card's newest condition evidence (FR-13). Whether
   * that observation actually shows a resolution is the reasoning layer's call.
   */
  resolve(sessionId: string, recommendationId: string, observationId: string): Result<Recommendation> {
    return this.#withSession(sessionId, (s) => {
      const rec = s.recommendations.get(recommendationId);
      if (!rec) return err('recommendation_not_found');
      if (!isOpenCard(rec)) return err('invalid_transition', `cannot resolve a ${rec.status} recommendation`);
      const stored = s.observations.get(observationId);
      if (!stored) return err('evidence_not_found');
      if (stored.observedAtMs <= Date.parse(rec.lastConditionAt)) {
        return err('resolution_needs_newer_evidence');
      }
      this.#setStatus(rec, 'resolved');
      rec.resolvedByObservationId = observationId;
      this.#record(
        s,
        { type: 'recommendation_resolved', recommendationId: rec.id, observationId },
        `Issue appears resolved: ${rec.title}`,
      );
      this.#notify(s);
      return ok(clone(rec));
    });
  }

  /**
   * Marks active cards stale when their newest condition evidence is older than
   * `staleAfterMs`, and times out abandoned voice requests. Runs automatically on
   * ingest/propose; the integrator should also call `sweepAll()` on a short interval.
   * Returns IDs of recommendations that became stale in this call.
   */
  sweepStale(sessionId: string): Result<string[]> {
    return this.#withSession(sessionId, (s) => {
      const before = new Set([...s.recommendations.values()].filter((r) => r.status === 'stale').map((r) => r.id));
      if (this.#sweep(s, this.#nowMs())) this.#notify(s);
      return ok([...s.recommendations.values()].filter((r) => r.status === 'stale' && !before.has(r.id)).map((r) => r.id));
    });
  }

  sweepAll(): void {
    this.#op(() => {
      for (const id of [...this.#sessions.keys()]) this.sweepStale(id);
    });
  }

  // ── Voice explanations (playback itself happens locally in the requester's UI) ──

  /**
   * Read-only grounding packet for one recommendation. It separates the context the
   * card was created with from corrections made afterwards.
   */
  getExplanationContext(sessionId: string, recommendationId: string): Result<ExplanationContext> {
    return this.#withSession(sessionId, (s) => {
      const rec = s.recommendations.get(recommendationId);
      if (!rec) return err('recommendation_not_found');
      return ok(this.#explanationContext(s, rec, this.#nowMs()));
    });
  }

  /**
   * The requester pressed "Explain with voice" on one card. Creates a voice request with
   * a unique ID and returns it with the grounding context. The backend turns the context
   * into text; the requester's UI speaks it locally — never into the shared call.
   * One live request per session (`voice_busy`). Requires an active session.
   */
  requestExplanation(
    sessionId: string,
    recommendationId: string,
    options?: { requesterParticipantId?: string },
  ): Result<ExplanationRequest> {
    return this.#withSession(sessionId, (s) => {
      if (s.status === 'starting') return err('consent_required');
      if (s.status !== 'active') return err('session_not_active');
      const check = checkExplanationOptions(options);
      if (!check.ok) return fromCheck(check);
      const requester = options?.requesterParticipantId;
      if (requester !== undefined && !s.participants.has(requester)) return err('participant_not_found');
      const nowMs = this.#nowMs();
      if (this.#sweep(s, nowMs)) this.#notify(s);
      const rec = s.recommendations.get(recommendationId);
      if (!rec) return err('recommendation_not_found');
      if (!isOpenCard(rec)) return err('invalid_transition', `cannot explain a ${rec.status} recommendation`);
      if (s.activeVoiceRequestId !== undefined) return err('voice_busy');

      const request: VoiceRequest = {
        id: this.#newId(),
        sessionId: s.id,
        recommendationId: rec.id,
        status: 'pending',
        requestedAt: iso(nowMs),
        updatedAt: iso(nowMs),
      };
      if (requester !== undefined) request.requesterParticipantId = requester;
      s.voiceRequests.set(request.id, request);
      s.lastVoiceRequestByRecommendation.set(rec.id, request.id);
      s.activeVoiceRequestId = request.id;
      this.#record(
        s,
        {
          type: 'voice_requested', recommendationId: rec.id, voiceRequestId: request.id,
          ...(requester !== undefined ? { requesterParticipantId: requester } : {}),
        },
        `Explanation requested: ${rec.title}`,
      );
      this.#notify(s);
      return ok({ request: clone(request), context: this.#explanationContext(s, rec, nowMs) });
    });
  }

  /**
   * Playback callback from the requester's UI. Must quote the current request ID:
   * unknown IDs → `voice_request_not_found`; superseded/cancelled/finished IDs or
   * out-of-order statuses → `invalid_transition`. Playback cannot start unless the
   * session is active.
   */
  reportVoiceStatus(
    sessionId: string,
    requestId: string,
    status: 'playing_locally' | 'finished' | 'failed',
  ): Result<VoiceRequest> {
    return this.#withSession(sessionId, (s) => {
      const request = s.voiceRequests.get(requestId);
      if (!request) return err('voice_request_not_found');
      if (request.id !== s.activeVoiceRequestId || !isLive(request)) {
        return err('invalid_transition', `request is ${request.status}`);
      }
      const nowIso = this.#nowIso();
      if (status === 'playing_locally') {
        if (s.status !== 'active') return err('session_not_active');
        if (request.status !== 'pending') return err('invalid_transition', 'playback already started');
        request.status = 'playing_locally';
        request.updatedAt = nowIso;
      } else if (status === 'finished' || status === 'failed') {
        this.#finishVoice(s, request, status);
      } else {
        return err('invalid_input', 'status must be playing_locally | finished | failed');
      }
      this.#notify(s);
      return ok(clone(request));
    });
  }

  /** Client-side cancel: the user pressed Stop, or the requesting client disconnected. */
  cancelExplanation(sessionId: string, requestId: string, reason: 'user' | 'client_disconnected'): Result<VoiceRequest> {
    return this.#withSession(sessionId, (s) => {
      if (!isClientCancelReason(reason)) return err('invalid_input', 'reason must be user | client_disconnected');
      const request = s.voiceRequests.get(requestId);
      if (!request) return err('voice_request_not_found');
      if (!isLive(request)) return err('invalid_transition', `request is ${request.status}`);
      this.#finishVoice(s, request, 'cancelled', reason);
      this.#notify(s);
      return ok(clone(request));
    });
  }

  // ── Reads and overlay subscription ────────────────────────────────────────

  getSession(sessionId: string): Result<SessionSnapshot> {
    return this.#withSession(sessionId, (s) => ok(this.#snapshot(s)));
  }

  getOverlayState(sessionId: string): Result<OverlayState> {
    return this.#withSession(sessionId, (s) => ok(this.#overlayState(s)));
  }

  /** Ordered session events (by `time`, ties by recording order) — the input to the review. */
  getTimeline(sessionId: string): Result<SessionEvent[]> {
    return this.#withSession(sessionId, (s) => ok(s.timeline.list()));
  }

  /**
   * Pushes a full `OverlayState` snapshot immediately and after every change.
   * Returns an unsubscribe function. `discard()` drops all subscriptions.
   */
  subscribe(sessionId: string, listener: OverlayListener): Result<() => void> {
    return this.#withSession(sessionId, (s) => {
      if (typeof listener !== 'function') return err('invalid_input', 'listener must be a function');
      // Delivered (current state) when this call returns, never mid-operation.
      s.listeners.set(listener, -1);
      return ok(() => {
        s.listeners.delete(listener);
      });
    });
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  #nowMs(): number {
    return this.#now().getTime();
  }

  #nowIso(): string {
    return iso(this.#nowMs());
  }

  #withSession<T>(sessionId: string, fn: (s: SessionState) => Result<T>): Result<T> {
    return this.#op(() => {
      const s = typeof sessionId === 'string' ? this.#sessions.get(sessionId) : undefined;
      return s ? fn(s) : err('session_not_found');
    });
  }

  /**
   * Runs one public operation. Listener callbacks never run inside an operation, so a
   * subscriber can't interrupt a lifecycle check halfway. Pending notifications are
   * flushed when the outermost operation returns.
   */
  #op<T>(fn: () => T): T {
    this.#depth += 1;
    try {
      return fn();
    } finally {
      this.#depth -= 1;
      if (this.#depth === 0) this.#flush();
    }
  }

  /** Context edits are allowed in starting/active/paused, never after the session ended. */
  #withOpenSession<T>(sessionId: string, fn: (s: SessionState) => Result<T>): Result<T> {
    return this.#withSession(sessionId, (s) => (s.status === 'ended' ? err('session_not_active') : fn(s)));
  }

  /** Validates provenance and resolves the effective time of a context change. */
  #provenance(s: SessionState, options: unknown): Result<Provenance> {
    const check = checkContextOptions(options);
    if (!check.ok) return fromCheck(check);
    const { source, sourceObservationId } = options as ContextOptions;
    if (sourceObservationId === undefined) return ok({ effectiveMs: this.#nowMs(), source });
    const stored = s.observations.get(sourceObservationId);
    if (!stored) return err('evidence_not_found', 'sourceObservationId is not in this session');
    if (source === 'transcript') {
      if (stored.observation.source !== 'transcript') {
        return err('invalid_input', 'transcript-derived context must cite a conversation observation');
      }
      return ok({ effectiveMs: stored.observedAtMs, source, sourceObservationId });
    }
    return ok({ effectiveMs: this.#nowMs(), source, sourceObservationId });
  }

  /**
   * Ordering + precedence rule for role changes (see `assignRole`).
   * - Verified correction vs anything already applied: always wins. Corrections are live
   *   user actions ordered by arrival, and any applied transcript change was admitted with
   *   `observedAt ≤ its arrival + maxClockSkewMs`, so it cannot be "newer" than the click.
   * - Transcript vs verified: wins only if `effectiveAt > correction + maxClockSkewMs`,
   *   i.e. it was certainly spoken after the correction even at the maximum allowed skew.
   * - Transcript vs transcript: newer-or-equal utterance time wins.
   */
  #roleChangeWins(current: RoleChange | undefined, source: ContextSource, effectiveMs: number): boolean {
    if (!current) return true;
    if (isVerified(source)) return true;
    const currentMs = Date.parse(current.effectiveAt);
    if (isVerified(current.source)) return effectiveMs > currentMs + this.config.maxClockSkewMs;
    return effectiveMs >= currentMs;
  }

  #applyRoleChange(
    s: SessionState,
    p: Participant,
    role: string | undefined,
    options: ContextOptions,
  ): Result<RoleUpdateResult> {
    const prov = this.#provenance(s, options);
    if (!prov.ok) return prov;
    const { effectiveMs, source, sourceObservationId } = prov.value;
    if (!this.#roleChangeWins(p.lastRoleChange, source, effectiveMs)) {
      return ok({ outcome: 'ignored_superseded', participant: clone(p), invalidatedRecommendationIds: [] });
    }
    const nowIso = this.#nowIso();
    if (p.role === role) {
      // Restatement (or clearing an empty role): refresh ordering so older delayed
      // contradictions stay ignored. No context revision, event or invalidation.
      if (!p.lastRoleChange) {
        p.lastRoleChange = {
          revision: s.contextRevision,
          kind: 'cleared',
          participantId: p.id,
          effectiveAt: iso(effectiveMs),
          recordedAt: nowIso,
          source,
        };
        if (sourceObservationId !== undefined) p.lastRoleChange.sourceObservationId = sourceObservationId;
      } else {
        p.lastRoleChange = { ...p.lastRoleChange, effectiveAt: iso(effectiveMs), recordedAt: nowIso, source };
        if (sourceObservationId !== undefined) p.lastRoleChange.sourceObservationId = sourceObservationId;
        else delete p.lastRoleChange.sourceObservationId;
      }
      return ok({ outcome: 'unchanged', participant: clone(p), invalidatedRecommendationIds: [] });
    }

    const change: RoleChange = {
      revision: ++s.contextRevision,
      kind: role === undefined ? 'cleared' : 'assigned',
      participantId: p.id,
      effectiveAt: iso(effectiveMs),
      recordedAt: nowIso,
      source,
    };
    if (role !== undefined) change.role = role;
    if (p.role !== undefined) change.previousRole = p.role;
    if (sourceObservationId !== undefined) change.sourceObservationId = sourceObservationId;

    if (role === undefined) delete p.role;
    else p.role = role;
    p.lastRoleChange = change;
    s.roleChanges.push(change);

    const was = change.previousRole === undefined ? '' : ` (was: ${change.previousRole})`;
    const summary =
      role === undefined ? `${p.displayName} role cleared${was}` : `${p.displayName} assigned role: ${role}${was}`;
    this.#record(s, { type: 'role_updated', change: clone(change) }, summary, effectiveMs);
    const invalidated = this.#invalidate(
      s,
      (r) => r.relatedParticipantIds.includes(p.id),
      'role_changed',
      { participantId: p.id },
    );
    this.#notify(s);
    return ok({ outcome: 'applied', participant: clone(p), invalidatedRecommendationIds: invalidated });
  }

  /** Marks matching **active** cards stale because their context changed. */
  #invalidate(
    s: SessionState,
    match: (r: Recommendation) => boolean,
    reason: 'role_changed' | 'goal_changed',
    extra: { participantId?: string; goalId?: string },
  ): string[] {
    const ids: string[] = [];
    for (const rec of s.recommendations.values()) {
      if (rec.status === 'active' && match(rec)) {
        this.#markStale(s, rec, reason, extra);
        ids.push(rec.id);
      }
    }
    return ids;
  }

  #captureContext(
    s: SessionState,
    participantIds: string[],
    goalId: string | undefined,
    capturedAt: string,
  ): RecommendationContext {
    const context: RecommendationContext = {
      contextRevision: s.contextRevision,
      capturedAt,
      participants: participantIds.map((id) => {
        const p = s.participants.get(id)!;
        const entry: RecommendationContext['participants'][number] = { participantId: p.id, displayName: p.displayName };
        if (p.role !== undefined) entry.role = p.role;
        if (p.lastRoleChange !== undefined) entry.roleRevision = p.lastRoleChange.revision;
        return entry;
      }),
    };
    const goal = goalId === undefined ? undefined : s.goals.get(goalId);
    if (goal) context.goal = { goalId: goal.id, text: goal.text };
    return context;
  }

  #changesSinceCreation(s: SessionState, rec: Recommendation): ContextChange[] {
    const since = rec.contextAtCreation.contextRevision;
    const changes: Array<{ revision: number; change: ContextChange }> = [];
    for (const change of s.roleChanges) {
      if (change.revision > since && rec.relatedParticipantIds.includes(change.participantId)) {
        const displayName = s.participants.get(change.participantId)?.displayName ?? 'unknown';
        changes.push({ revision: change.revision, change: { kind: 'role_changed', change: clone(change), displayName } });
      }
    }
    const goal = rec.relatedGoalId === undefined ? undefined : s.goals.get(rec.relatedGoalId);
    if (goal && goal.retiredRevision !== undefined && goal.retiredRevision > since && goal.retiredAt) {
      changes.push({
        revision: goal.retiredRevision,
        change: { kind: 'goal_retired', goalId: goal.id, text: goal.text, retiredAt: goal.retiredAt, revision: goal.retiredRevision },
      });
    }
    return changes.sort((a, b) => a.revision - b.revision).map((c) => c.change);
  }

  #explanationContext(s: SessionState, rec: Recommendation, nowMs: number): ExplanationContext {
    const pick = (ids: string[]) =>
      ids.map((id) => s.observations.get(id)?.observation).filter((o): o is Observation => o !== undefined);
    const context: ExplanationContext = {
      recommendation: rec,
      conditionEvidence: pick(rec.conditionObservationIds),
      contextEvidence: pick(rec.contextObservationIds),
      contextAtCreation: rec.contextAtCreation,
      changesSinceCreation: this.#changesSinceCreation(s, rec),
      isStale: rec.status === 'stale' || isConditionStale(rec.lastConditionAt, nowMs, this.config.staleAfterMs),
      conditionAgeMs: Math.max(0, nowMs - Date.parse(rec.lastConditionAt)),
    };
    if (rec.staleReason !== undefined) context.staleReason = rec.staleReason;
    return clone(context);
  }

  /** Lifecycle gate, checked before input validation so callers learn the session state first. */
  #ingestGate(s: SessionState): Result<true> {
    if (s.status === 'starting') return err('consent_required');
    if (s.status !== 'active') return err('session_not_active');
    return ok(true);
  }

  /**
   * Generation + timestamp gate for new observations. Returns the parsed source time.
   * The capture generation (not the timestamp) decides whether input was captured while paused.
   */
  #admitObservation(s: SessionState, observedAt: string, generation: number): Result<number> {
    if (generation > s.captureGeneration) return err('invalid_generation', 'captureGeneration is from the future');
    if (!s.activeGenerations.has(generation)) {
      return err('invalid_generation', 'input was captured while the session was not active');
    }
    const observedMs = parseIsoTime(observedAt);
    if (observedMs === undefined) return err('invalid_timestamp');
    const nowMs = this.#nowMs();
    const skew = this.config.maxClockSkewMs;
    if (observedMs > nowMs + skew) return err('timestamp_out_of_range', 'observedAt is in the future');
    if (s.startedAtMs !== undefined && observedMs < s.startedAtMs - skew) {
      return err('timestamp_out_of_range', 'observedAt is before consent was given');
    }
    if (s.observations.size >= this.config.maxObservations) {
      s.observationLimitReached = true;
      return err('observation_limit_reached');
    }
    return ok(observedMs);
  }

  #storeObservation(s: SessionState, observation: Observation, observedAtMs: number, summary: string): void {
    s.observations.set(observation.id, { observation, observedAtMs });
    const latestId = s.latestObservationId[observation.source];
    const latest = latestId === undefined ? undefined : s.observations.get(latestId);
    if (!latest || observedAtMs > latest.observedAtMs) s.latestObservationId[observation.source] = observation.id;
    const payload: SessionEventPayload = {
      type: 'observation',
      observationId: observation.id,
      source: observation.source,
      ...(observation.source === 'transcript' && observation.speakerParticipantId
        ? { speakerParticipantId: observation.speakerParticipantId }
        : {}),
    };
    this.#record(s, payload, summary, observedAtMs);
    if (this.#sweep(s, this.#nowMs())) this.#notify(s);
  }

  /** Marks expired active cards stale and times out abandoned voice requests. True if anything changed. */
  #sweep(s: SessionState, nowMs: number): boolean {
    let changed = false;
    for (const rec of s.recommendations.values()) {
      if (rec.status === 'active' && isConditionStale(rec.lastConditionAt, nowMs, this.config.staleAfterMs)) {
        this.#markStale(s, rec, 'no_recent_condition_evidence');
        changed = true;
      }
    }
    const active = s.activeVoiceRequestId === undefined ? undefined : s.voiceRequests.get(s.activeVoiceRequestId);
    if (active && nowMs - Date.parse(active.updatedAt) > this.config.voiceRequestTimeoutMs) {
      this.#finishVoice(s, active, 'cancelled', 'timeout');
      changed = true;
    }
    return changed;
  }

  #markAllActiveStale(s: SessionState, reason: StaleReason): void {
    for (const rec of s.recommendations.values()) {
      if (rec.status === 'active') this.#markStale(s, rec, reason);
    }
  }

  #markStale(
    s: SessionState,
    rec: Recommendation,
    reason: StaleReason,
    extra: { participantId?: string; goalId?: string } = {},
  ): void {
    this.#setStatus(rec, 'stale');
    rec.staleReason = reason;
    const labels: Record<StaleReason, string> = {
      no_recent_condition_evidence: 'No recent condition evidence',
      session_paused: 'Session paused; advice no longer verified',
      session_ended: 'Session ended; advice refers to an earlier moment',
      role_changed: 'Related role changed',
      goal_changed: 'Related goal changed',
    };
    this.#record(
      s,
      { type: 'recommendation_stale', recommendationId: rec.id, reason, ...extra },
      `${labels[reason]}: ${rec.title}`,
    );
  }

  #setStatus(rec: Recommendation, status: Recommendation['status']): void {
    const nowIso = this.#nowIso();
    rec.status = status;
    rec.statusChangedAt = nowIso;
    rec.updatedAt = nowIso;
    if (status !== 'stale') delete rec.staleReason;
  }

  #cancelActiveVoice(s: SessionState, reason: VoiceCancelReason): void {
    const active = s.activeVoiceRequestId === undefined ? undefined : s.voiceRequests.get(s.activeVoiceRequestId);
    if (active && isLive(active)) this.#finishVoice(s, active, 'cancelled', reason);
  }

  #finishVoice(
    s: SessionState,
    request: VoiceRequest,
    outcome: 'finished' | 'failed' | 'cancelled',
    cancelReason?: VoiceCancelReason,
  ): void {
    request.status = outcome;
    request.updatedAt = this.#nowIso();
    if (cancelReason !== undefined) request.cancelReason = cancelReason;
    if (s.activeVoiceRequestId === request.id) delete s.activeVoiceRequestId;
    const title = s.recommendations.get(request.recommendationId)?.title ?? request.recommendationId;
    const label =
      outcome === 'finished' ? 'finished' : outcome === 'failed' ? 'failed (text fallback)' : `cancelled (${cancelReason})`;
    this.#record(
      s,
      {
        type: 'voice_finished',
        recommendationId: request.recommendationId,
        voiceRequestId: request.id,
        outcome,
        ...(cancelReason !== undefined ? { cancelReason } : {}),
      },
      `Explanation ${label}: ${title}`,
    );
  }

  #nextGeneration(s: SessionState, active: boolean): void {
    s.captureGeneration += 1;
    if (active) s.activeGenerations.add(s.captureGeneration);
  }

  /** Appends an event. Past `maxTimelineEvents`, events are dropped (except `session_ended`). */
  #record(s: SessionState, payload: SessionEventPayload, summary: string, timeMs: number = this.#nowMs()): void {
    if (s.timeline.size >= this.config.maxTimelineEvents && payload.type !== 'session_ended') {
      s.timelineTruncated = true;
      return;
    }
    const event = {
      id: this.#newId(),
      sessionId: s.id,
      time: iso(timeMs),
      recordedAt: this.#nowIso(),
      summary,
      ...payload,
    } as SessionEvent;
    s.timeline.record(event, timeMs);
  }

  #snapshot(s: SessionState): SessionSnapshot {
    const snap: SessionSnapshot = {
      id: s.id,
      status: s.status,
      consentGiven: s.consentGiven,
      activity: s.activity,
      activityConfirmed: s.activityConfirmed,
      createdAt: s.createdAt,
      contextRevision: s.contextRevision,
      captureGeneration: s.captureGeneration,
      participants: [...s.participants.values()],
      goals: [...s.goals.values()],
      decisions: [...s.decisions.values()],
      recommendations: [...s.recommendations.values()],
      voiceRequests: [...s.voiceRequests.values()],
      observationCount: s.observations.size,
      observationLimitReached: s.observationLimitReached,
      timelineTruncated: s.timelineTruncated,
    };
    if (s.externalRef !== undefined) snap.externalRef = s.externalRef;
    if (s.suggestedActivity !== undefined) snap.suggestedActivity = s.suggestedActivity;
    if (s.startedAt !== undefined) snap.startedAt = s.startedAt;
    if (s.endedAt !== undefined) snap.endedAt = s.endedAt;
    return clone(snap);
  }

  #overlayState(s: SessionState): OverlayState {
    const recs = [...s.recommendations.values()];
    const active = s.activeVoiceRequestId === undefined ? undefined : s.voiceRequests.get(s.activeVoiceRequestId);
    const voiceBusy = active !== undefined;
    const prominent = pickProminent(recs);
    const state: OverlayState = {
      sessionId: s.id,
      version: s.version,
      status: s.status,
      activity: s.activity,
      activityConfirmed: s.activityConfirmed,
      history: newestFirst(recs)
        .filter((r) => r !== prominent)
        .map((r) => this.#view(s, r, voiceBusy)),
      voiceBusy,
    };
    if (prominent) state.prominent = this.#view(s, prominent, voiceBusy);
    if (active) {
      state.activeVoiceRequest = { requestId: active.id, recommendationId: active.recommendationId, status: active.status };
    }
    if (s.suggestedActivity !== undefined) state.suggestedActivity = s.suggestedActivity;
    return state;
  }

  #view(s: SessionState, rec: Recommendation, voiceBusy: boolean): RecommendationView {
    const evidenceOf = (ids: string[], kind: 'condition' | 'context') =>
      ids.flatMap((id) => {
        const o = s.observations.get(id)?.observation;
      return o ? [{ observationId: o.id, kind, source: o.source, ...(o.source === 'screen' ? { mediaSource: o.mediaSource } : {}), observedAt: o.observedAt }] : [];
      });
    const view: RecommendationView = {
      id: rec.id,
      status: rec.status,
      title: rec.title,
      shortAdvice: rec.shortAdvice,
      urgency: rec.urgency,
      createdAt: rec.createdAt,
      lastConditionAt: rec.lastConditionAt,
      evidence: [...evidenceOf(rec.conditionObservationIds, 'condition'), ...evidenceOf(rec.contextObservationIds, 'context')],
      relatedParticipants: rec.contextAtCreation.participants.map((p) =>
        p.role !== undefined
          ? { id: p.participantId, displayName: p.displayName, role: p.role }
          : { id: p.participantId, displayName: p.displayName },
      ),
      contextChangedSinceCreation: this.#changesSinceCreation(s, rec).length > 0,
      canExplain: isOpenCard(rec) && s.status === 'active' && !voiceBusy,
    };
    if (rec.staleReason !== undefined) view.staleReason = rec.staleReason;
    const requestId = s.lastVoiceRequestByRecommendation.get(rec.id);
    const request = requestId === undefined ? undefined : s.voiceRequests.get(requestId);
    if (request) view.voice = { requestId: request.id, status: request.status };
    return view;
  }

  /** Marks overlay-visible state as changed. Delivery happens in `#flush`. */
  #notify(s: SessionState): void {
    s.version += 1;
  }

  /**
   * Delivers the **current** overlay state to every listener that is behind it, in
   * subscription order. If a listener changes the state (reentrant call), the round
   * stops and restarts with the newer state, so no listener ever receives an older
   * version after a newer one, and every listener ends on the latest state.
   * Reentrant calls made during a flush do not flush themselves.
   */
  #flush(): void {
    if (this.#flushing) return;
    this.#flushing = true;
    try {
      const rounds = new Map<string, number>();
      let pending = true;
      while (pending) {
        pending = false;
        for (const s of [...this.#sessions.values()]) {
          if (this.#sessions.get(s.id) !== s) continue;
          const behind = [...s.listeners.entries()].filter(([, delivered]) => delivered < s.version);
          if (behind.length === 0) continue;
          const round = (rounds.get(s.id) ?? 0) + 1;
          rounds.set(s.id, round);
          if (round > MAX_NOTIFY_ROUNDS) {
            // Stop delivering for this session; its listeners can resync via getOverlayState.
            for (const listener of s.listeners.keys()) s.listeners.set(listener, s.version);
            this.#onListenerError(new Error('overlay notification loop: listeners kept changing state'));
            continue;
          }
          const version = s.version;
          const state = this.#overlayState(s);
          for (const [listener] of behind) {
            if (this.#sessions.get(s.id) !== s || s.version !== version) break;
            if (!s.listeners.has(listener)) continue;
            s.listeners.set(listener, version);
            this.#emit(listener, clone(state));
          }
          pending = true;
        }
      }
    } finally {
      this.#flushing = false;
    }
  }

  #emit(listener: OverlayListener, state: OverlayState): void {
    try {
      listener(state);
    } catch (error) {
      this.#onListenerError(error);
    }
  }
}
