/**
 * Sidekick shared contracts.
 *
 * These types are OURS — they are not Chert's event schema and must never import
 * or mirror provider SDK types. Adapters (Chert, model) translate into these
 * shapes; the overlay consumes the view types near the bottom of this file.
 *
 * All timestamps are ISO 8601 strings with an explicit timezone (`Z` or `±HH:MM`);
 * the engine normalizes everything it stores to UTC (`…Z`).
 * Everything here is JSON-serializable.
 */

export type IsoTime = string;

export type SessionStatus = 'starting' | 'active' | 'paused' | 'ended';
export type Activity = 'unconfirmed' | 'gaming' | 'planning' | 'social';
export type EvidenceQuality = 'clear' | 'partial' | 'unknown';

/**
 * How a piece of context (role, goal, decision) became known.
 * - `transcript`: extracted from a conversation observation (requires its ID).
 * - `participant_report`: a participant stated it through the UI.
 * - `manual`: a verified correction made in the UI.
 * `participant_report` and `manual` are "verified corrections" and take precedence
 * over transcript-derived changes (see `RoleChange`).
 */
export type ContextSource = 'transcript' | 'participant_report' | 'manual';

/** Primitive scene facts produced upstream (model adapter / tactical rules). */
export type ScreenFacts = Record<string, string | number | boolean>;

/** Optional provenance accepted by context-changing calls. */
export interface ContextOptions {
  source: ContextSource;
  /** Required when `source` is `transcript`; must be a conversation observation in this session. */
  sourceObservationId?: string;
}

// ── Participants and roles ──────────────────────────────────────────────────

/**
 * One applied role change (assignment or clear). Ordered by `effectiveAt`:
 * the source time of the utterance for `transcript`, engine time otherwise.
 */
export interface RoleChange {
  /** Session-wide context revision at which this change was applied. */
  revision: number;
  kind: 'assigned' | 'cleared';
  participantId: string;
  /** The new role (`assigned` only). */
  role?: string;
  previousRole?: string;
  effectiveAt: IsoTime;
  recordedAt: IsoTime;
  source: ContextSource;
  sourceObservationId?: string;
}

export interface Participant {
  /** Assigned by the engine. */
  id: string;
  displayName: string;
  /**
   * Opaque adapter handle used to match `ConversationInput.speakerRef`.
   * Set it ONLY when the provider's speaker attribution has been verified live.
   */
  externalRef?: string;
  /** Current role — the single source of truth. */
  role?: string;
  /** The change that produced the current state (kept after a clear, for ordering). */
  lastRoleChange?: RoleChange;
}

export type ContextUpdateOutcome =
  /** The change was applied. */
  | 'applied'
  /** Same role restated; ordering refreshed, nothing else changed. */
  | 'unchanged'
  /** A newer change (or a verified correction) already exists; this one was ignored. */
  | 'ignored_superseded';

export interface RoleUpdateResult {
  outcome: ContextUpdateOutcome;
  participant: Participant;
  /** Active recommendations marked stale because they relied on the old role. */
  invalidatedRecommendationIds: string[];
}

// ── Group goals and decisions ───────────────────────────────────────────────

export interface GroupGoal {
  id: string;
  /** Explicitly stated goal only — never inferred. */
  text: string;
  /** Source time of the statement (transcript) or engine time. */
  statedAt: IsoTime;
  recordedAt: IsoTime;
  source: ContextSource;
  sourceObservationId?: string;
  revision: number;
  active: boolean;
  retiredAt?: IsoTime;
  retiredRevision?: number;
  retiredSource?: ContextSource;
  retiredSourceObservationId?: string;
}

export interface GoalRetireResult {
  goal: GroupGoal;
  invalidatedRecommendationIds: string[];
}

/** An explicit group decision. Recorded only when stated — the engine never infers decisions. */
export interface GroupDecision {
  id: string;
  /** Short statement of what was decided. */
  text: string;
  /** Newest source time among `sourceObservationIds`, else engine time. */
  decidedAt: IsoTime;
  recordedAt: IsoTime;
  source: ContextSource;
  sourceObservationIds: string[];
  participantIds: string[];
  relatedRecommendationId?: string;
  relatedGoalId?: string;
}

export interface DecisionInput {
  text: string;
  source: ContextSource;
  /** Required (≥1 conversation observation) when `source` is `transcript`. */
  sourceObservationIds?: string[];
  participantIds?: string[];
  relatedRecommendationId?: string;
  relatedGoalId?: string;
}

// ── Observations ────────────────────────────────────────────────────────────

interface ObservationBase {
  id: string;
  sessionId: string;
  /** Capture generation the producer stamped on the input (see `SessionSnapshot.captureGeneration`). */
  captureGeneration: number;
  /** Source time reported by the producer (adapter/model). Drives ordering and staleness. */
  observedAt: IsoTime;
  /** Engine clock at ingest. Lets us detect late delivery. */
  receivedAt: IsoTime;
}

export interface ConversationObservation extends ObservationBase {
  source: 'transcript';
  /** Length-capped utterance text, held in memory only. */
  text: string;
  /** Present only when `speakerRef` matched a participant's verified `externalRef`. */
  speakerParticipantId?: string;
}

export interface ScreenObservation extends ObservationBase {
  source: 'screen';
  /** Structured description of a sampled frame — never raw pixels. */
  summary: string;
  evidenceQuality: EvidenceQuality;
  facts?: ScreenFacts;
  /** Short ephemeral reference only (length-capped; not a data URI). Never sent to the overlay. */
  frameRef?: string;
}

export type Observation = ConversationObservation | ScreenObservation;
export type ObservationSource = Observation['source'];

/**
 * Capture generation: an engine-owned lifecycle marker. It increments on every
 * start/pause/resume/end. A producer reads `SessionSnapshot.captureGeneration` at the
 * moment it **captures** raw input (receives the Chert event/frame) and carries that
 * number through all later processing (e.g. model calls) into `ingest*`. It is ours,
 * not a Chert field. Inputs stamped with a paused/ended or unknown generation are
 * rejected; inputs from an earlier active generation are stored but can never be
 * condition evidence for new advice.
 */
export type CaptureGeneration = number;

/** What the Chert adapter sends for speech. The engine adds id/sessionId/receivedAt. */
export interface ConversationInput {
  captureGeneration: CaptureGeneration;
  observedAt: IsoTime;
  text: string;
  /** Opaque provider speaker handle, only if attribution is verified. Unmatched refs are ignored. */
  speakerRef?: string;
}

/** What the model adapter sends after interpreting a sampled frame. */
export interface ScreenInput {
  /** The generation read when the frame was captured — not when the model finished. */
  captureGeneration: CaptureGeneration;
  observedAt: IsoTime;
  summary: string;
  evidenceQuality: EvidenceQuality;
  facts?: ScreenFacts;
  frameRef?: string;
}

// ── Recommendations ─────────────────────────────────────────────────────────

export type RecommendationStatus = 'active' | 'dismissed' | 'resolved' | 'stale';
export type Urgency = 'normal' | 'important';

/** Why a card became stale. */
export type StaleReason =
  | 'no_recent_condition_evidence'
  | 'session_paused'
  | 'session_ended'
  | 'role_changed'
  | 'goal_changed';

/** Produced by the reasoning layer (or mocks). Untrusted until validated by the engine. */
export interface RecommendationCandidate {
  /** Stable issue key, e.g. "left_defense_uncovered". Drives de-duplication. */
  fingerprint: string;
  title: string;
  shortAdvice: string;
  /**
   * Observations showing the condition itself (e.g. frames of the empty left zone).
   * At least one. These — and only these — drive freshness and staleness.
   * Screen observations with `evidenceQuality: 'unknown'` are not accepted here.
   */
  conditionObservationIds: string[];
  /**
   * Supporting context (e.g. the utterance that assigned the role). Never refreshes a card.
   */
  contextObservationIds?: string[];
  relatedParticipantIds?: string[];
  relatedGoalId?: string;
  urgency: Urgency;
  /**
   * `SessionSnapshot.contextRevision` the reasoning layer read before evaluating.
   * If any role or goal changed since (revision moved on), the candidate is rejected
   * with `stale_context` and must be re-evaluated against current context.
   */
  basedOnContextRevision: number;
}

/** Role/goal context captured when the card was created. Never rewritten afterwards. */
export interface RecommendationContext {
  contextRevision: number;
  capturedAt: IsoTime;
  participants: Array<{ participantId: string; displayName: string; role?: string; roleRevision?: number }>;
  goal?: { goalId: string; text: string };
}

export interface Recommendation {
  id: string;
  sessionId: string;
  fingerprint: string;
  title: string;
  shortAdvice: string;
  conditionObservationIds: string[];
  contextObservationIds: string[];
  relatedParticipantIds: string[];
  relatedGoalId?: string;
  urgency: Urgency;
  status: RecommendationStatus;
  createdAt: IsoTime;
  updatedAt: IsoTime;
  /** Engine time of the last status change (used for cooldown). */
  statusChangedAt: IsoTime;
  /** Newest `observedAt` among condition evidence. Never moves backwards. */
  lastConditionAt: IsoTime;
  /** Set when status is `stale`. */
  staleReason?: StaleReason;
  resolvedByObservationId?: string;
  /** Equals `contextAtCreation.contextRevision`: the context the advice was evaluated against. */
  contextAtCreation: RecommendationContext;
}

export type ProposeOutcome =
  | { outcome: 'created'; recommendation: Recommendation }
  /** Same issue already active: evidence appended, no new card. `refreshed` = condition time advanced. */
  | { outcome: 'merged'; recommendation: Recommendation; refreshed: boolean }
  /** Same issue was recently dismissed/resolved: nothing shown. */
  | { outcome: 'suppressed'; reason: 'cooldown'; recommendationId: string };

// ── Voice explanation requests (playback itself is local, in the requester's UI) ──

export type VoiceRequestStatus = 'pending' | 'playing_locally' | 'finished' | 'failed' | 'cancelled';
export type VoiceCancelReason =
  | 'user'
  | 'client_disconnected'
  | 'session_paused'
  | 'session_ended'
  | 'timeout';

export interface VoiceRequest {
  /** Unique per attempt. Every playback callback must quote it. */
  id: string;
  sessionId: string;
  recommendationId: string;
  requesterParticipantId?: string;
  status: VoiceRequestStatus;
  requestedAt: IsoTime;
  updatedAt: IsoTime;
  cancelReason?: VoiceCancelReason;
}

export type ContextChange =
  | { kind: 'role_changed'; change: RoleChange; displayName: string }
  | { kind: 'goal_retired'; goalId: string; text: string; retiredAt: IsoTime; revision: number };

/** Grounding packet for one explanation. Separates what was true at creation from later corrections. */
export interface ExplanationContext {
  recommendation: Recommendation;
  conditionEvidence: Observation[];
  contextEvidence: Observation[];
  /** Roles/goal as they were when the card was created (same as `recommendation.contextAtCreation`). */
  contextAtCreation: RecommendationContext;
  /** Corrections to that context made after creation, oldest first. Empty if none. */
  changesSinceCreation: ContextChange[];
  /** True if the card is stale or its newest condition evidence is outside the stale window. */
  isStale: boolean;
  staleReason?: StaleReason;
  /** Milliseconds between the newest condition evidence and now (engine clock). */
  conditionAgeMs: number;
}

export interface ExplanationRequest {
  request: VoiceRequest;
  context: ExplanationContext;
}

// ── Session timeline (input to the end-of-session review) ───────────────────

interface EventBase {
  id: string;
  sessionId: string;
  /** When it happened: source time for observations and transcript-derived context, else engine time. */
  time: IsoTime;
  /** Engine time when the event was recorded. */
  recordedAt: IsoTime;
  /** Short human-readable label. Never needed for reconstruction — use the structured fields. */
  summary: string;
}

export type SessionEventPayload =
  | { type: 'session_started' }
  | { type: 'session_paused' }
  | { type: 'session_resumed' }
  | { type: 'session_ended' }
  | { type: 'participant_added'; participantId: string; displayName: string }
  | { type: 'role_updated'; change: RoleChange }
  | {
      type: 'goal_set';
      goalId: string;
      text: string;
      source: ContextSource;
      sourceObservationId?: string;
      revision: number;
    }
  | {
      type: 'goal_retired';
      goalId: string;
      source: ContextSource;
      sourceObservationId?: string;
      revision: number;
    }
  | { type: 'activity_confirmed'; activity: Activity }
  | { type: 'decision_recorded'; decision: GroupDecision }
  | { type: 'observation'; observationId: string; source: ObservationSource; speakerParticipantId?: string }
  | {
      type: 'recommendation_created';
      recommendationId: string;
      fingerprint: string;
      conditionObservationIds: string[];
      contextObservationIds: string[];
      relatedParticipantIds: string[];
      relatedGoalId?: string;
      contextRevision: number;
    }
  | { type: 'recommendation_dismissed'; recommendationId: string }
  | { type: 'recommendation_resolved'; recommendationId: string; observationId: string }
  | {
      type: 'recommendation_stale';
      recommendationId: string;
      reason: StaleReason;
      participantId?: string;
      goalId?: string;
    }
  | {
      type: 'voice_requested';
      recommendationId: string;
      voiceRequestId: string;
      requesterParticipantId?: string;
    }
  | {
      type: 'voice_finished';
      recommendationId: string;
      voiceRequestId: string;
      outcome: 'finished' | 'failed' | 'cancelled';
      cancelReason?: VoiceCancelReason;
    };

export type SessionEvent = EventBase & SessionEventPayload;
export type SessionEventType = SessionEvent['type'];

// ── Session snapshot ────────────────────────────────────────────────────────

export interface SessionSnapshot {
  id: string;
  externalRef?: string;
  status: SessionStatus;
  consentGiven: boolean;
  activity: Activity;
  activityConfirmed: boolean;
  suggestedActivity?: Activity;
  createdAt: IsoTime;
  startedAt?: IsoTime;
  endedAt?: IsoTime;
  /** Increments on every applied role/goal change. Send it back as `basedOnContextRevision`. */
  contextRevision: number;
  /** Current capture generation. Stamp it on inputs at capture time. */
  captureGeneration: CaptureGeneration;
  participants: Participant[];
  goals: GroupGoal[];
  decisions: GroupDecision[];
  recommendations: Recommendation[];
  voiceRequests: VoiceRequest[];
  observationCount: number;
  /** True once `maxObservations` was hit; further observations are rejected. */
  observationLimitReached: boolean;
  /** True once `maxTimelineEvents` was hit; further events (except `session_ended`) are dropped. */
  timelineTruncated: boolean;
}

// ── Overlay feed ────────────────────────────────────────────────────────────

export interface RecommendationView {
  id: string;
  status: RecommendationStatus;
  staleReason?: StaleReason;
  title: string;
  shortAdvice: string;
  urgency: Urgency;
  createdAt: IsoTime;
  lastConditionAt: IsoTime;
  evidence: Array<{
    observationId: string;
    kind: 'condition' | 'context';
    source: ObservationSource;
    observedAt: IsoTime;
  }>;
  /** Participants and roles as they were when the card was created. */
  relatedParticipants: Array<{ id: string; displayName: string; role?: string }>;
  /** True if a related role or goal was corrected after the card was created. */
  contextChangedSinceCreation: boolean;
  /** Whether the overlay may offer "Explain with voice" right now. */
  canExplain: boolean;
  /** Latest voice request for this card, if any. */
  voice?: { requestId: string; status: VoiceRequestStatus };
}

export interface OverlayState {
  sessionId: string;
  /**
   * Monotonic per-session state version. The engine never delivers a lower version
   * after a higher one to the same listener; transports that may reorder messages
   * should drop any snapshot whose version is not greater than the last one applied.
   */
  version: number;
  status: SessionStatus;
  activity: Activity;
  activityConfirmed: boolean;
  suggestedActivity?: Activity;
  /** The single prominent card: an active card, `important` first, then newest. */
  prominent?: RecommendationView;
  /** All other cards, newest first (by `createdAt`). */
  history: RecommendationView[];
  /** True while any explanation in this session is pending or playing. */
  voiceBusy: boolean;
  /** The in-flight request, if any. The UI must stop local playback when this disappears or changes. */
  activeVoiceRequest?: { requestId: string; recommendationId: string; status: VoiceRequestStatus };
}

export type OverlayListener = (state: OverlayState) => void;

// ── Engine configuration and results ────────────────────────────────────────

export interface EngineConfig {
  /** Suppress an equivalent card for this long after it was dismissed/resolved. */
  cooldownMs: number;
  /** An active card with no condition evidence newer than this becomes stale. */
  staleAfterMs: number;
  /** Tolerated producer-vs-engine clock difference; also the verified-correction precedence window. */
  maxClockSkewMs: number;
  /** Max observations held per session (bounds memory). */
  maxObservations: number;
  /** Max timeline events per session. */
  maxTimelineEvents: number;
  /** A voice request with no terminal callback after this long is cancelled (`timeout`). */
  voiceRequestTimeoutMs: number;
}

export type EngineError =
  | 'session_not_found'
  | 'consent_required'
  | 'session_not_active'
  | 'invalid_transition'
  | 'invalid_input'
  | 'invalid_timestamp'
  | 'timestamp_out_of_range'
  | 'observation_limit_reached'
  | 'participant_not_found'
  | 'goal_not_found'
  | 'recommendation_not_found'
  | 'evidence_not_found'
  | 'insufficient_evidence'
  | 'stale_evidence'
  | 'stale_context'
  | 'invalid_generation'
  | 'resolution_needs_newer_evidence'
  | 'voice_busy'
  | 'voice_request_not_found';

export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: EngineError; detail?: string };
