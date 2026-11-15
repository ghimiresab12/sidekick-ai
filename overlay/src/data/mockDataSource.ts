/**
 * MOCK implementation of SidekickDataSource.
 *
 * Plays the role of the backend (session coordinator + recommendation manager +
 * event log) entirely in memory, using the scripted seed in mock-session.json.
 * It is deliberately strict — it enforces the same lifecycle rules and
 * invariants the real backend must, so UI bugs surface now, not at integration.
 *
 * It has no network, Chert, model or audio code.
 */
import type { Observation, Session } from '../contracts/sidekick';
import type {
  RecommendationWithContext,
  TimelineEvent,
  TimelineEventType,
  VoiceExplanation,
  VoicePlaybackReport,
} from '../contracts/proposed';
import { canRun, nextState, type SessionCommand } from '../session/sessionMachine';
import { generateMockReview } from './mockReviewGenerator';
import { validateSeed, type FeedStep, type MockSeed } from './mockSeed';
import { DataSourceError, type SessionSnapshot, type SidekickDataSource } from './SidekickDataSource';

export interface MockDataSourceOptions {
  /** Simulated network latency for commands (ms). Tests pass 0. */
  latencyMs?: number;
  /** Clock for timestamps (tests may inject). */
  now?: () => Date;
  /** Override the seed's session id (used when starting a new mock session). */
  sessionId?: string;
}

/** Demo-only controls; never part of the real data-source interface. */
export interface MockControls {
  /** Play the next scripted feed step immediately (only while active). */
  advanceFeed(): Promise<boolean>;
  remainingFeedSteps(): number;
}

export type MockDataSource = SidekickDataSource & { readonly mock: MockControls };

export const STALE_EXPLANATION_PREFIX =
  'This refers to an earlier observation that is not currently verified. ';

const SOURCE_LABEL: Record<Observation['source'], string> = {
  screen: 'Screen observation',
  transcript: 'Conversation',
  participant_report: 'Participant report',
};

export function createMockDataSource(rawSeed: unknown, options: MockDataSourceOptions = {}): MockDataSource {
  const latency = options.latencyMs ?? 350;
  const now = options.now ?? (() => new Date());

  // Validate once at the boundary. If invalid, every call reports the error.
  let seed: MockSeed | null = null;
  let seedError: string | null = null;
  try {
    seed = validateSeed(rawSeed);
  } catch (e) {
    seedError = e instanceof Error ? e.message : 'Mock data is invalid.';
  }

  const sessionId = options.sessionId ?? seed?.session.id ?? 'mock-session';
  let session: Session | null = seed
    ? { ...structuredClone(seed.session), id: sessionId, latestObservationIds: [], recommendationIds: [] }
    : null;
  let observations: Observation[] = [];
  let recommendations: RecommendationWithContext[] = [];
  let events: TimelineEvent[] = [];
  let discarded = false;
  let eventCounter = 0;

  // Scripted feed scheduling.
  let feedIndex = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let timerDueAt = 0;
  let pausedRemainingMs: number | null = null;

  const listeners = new Set<(s: SessionSnapshot) => void>();

  const iso = () => now().toISOString();
  const delay = (ms: number) => (ms > 0 ? new Promise<void>((r) => setTimeout(r, ms)) : Promise.resolve());

  function live(): { session: Session; seed: MockSeed } {
    if (seedError) throw new DataSourceError('invalid_data', seedError);
    if (discarded || !session || !seed) {
      throw new DataSourceError('discarded', 'This session was discarded; its data no longer exists.');
    }
    return { session, seed };
  }

  function snapshot(): SessionSnapshot {
    const { session: s } = live();
    return structuredClone({ session: s, recommendations, observations, events });
  }

  function emit() {
    if (listeners.size === 0) return;
    const s = snapshot();
    listeners.forEach((l) => l(s));
  }

  function log(type: TimelineEventType, summary: string, extra: Partial<TimelineEvent> = {}) {
    events.push({ id: `${sessionId}-e${++eventCounter}`, sessionId, time: iso(), type, summary, ...extra });
  }

  function transition(command: SessionCommand) {
    const { session: s } = live();
    if (!canRun(s.status, command)) {
      throw new DataSourceError('invalid_transition', `Cannot ${command} a session that is ${s.status}.`);
    }
    const to = nextState(s.status, command);
    if (to && to !== 'discarded') s.status = to;
    return s;
  }

  function findRec(id: string) {
    const rec = recommendations.find((r) => r.id === id && r.sessionId === sessionId);
    if (!rec) throw new DataSourceError('not_found', 'That recommendation does not exist in this session.');
    return rec;
  }

  // ---- scripted feed ---------------------------------------------------

  function clearTimer() {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  function scheduleNext(waitMs?: number) {
    clearTimer();
    const step = seed?.feed[feedIndex];
    if (!step || session?.status !== 'active') return;
    const wait = waitMs ?? step.afterMs;
    timerDueAt = Date.now() + wait;
    timer = setTimeout(() => {
      timer = null;
      playNextStep();
    }, wait);
  }

  function playNextStep(): boolean {
    const step = seed?.feed[feedIndex];
    if (!step || session?.status !== 'active') return false;
    feedIndex += 1;
    applyStep(step);
    emit();
    scheduleNext();
    return true;
  }

  function applyStep(step: FeedStep) {
    const { session: s } = live();
    const t = iso();
    const newObs = step.observations ?? [];
    for (const o of newObs) {
      observations.push({ ...o, sessionId, observedAt: t });
      log('observation', `${SOURCE_LABEL[o.source]}: ${o.summary}`, { observationIds: [o.id] });
    }
    if (newObs.length > 0) s.latestObservationIds = newObs.map((o) => o.id);

    for (const ru of step.roleUpdates ?? []) {
      const p = s.participants[ru.participantId];
      if (!p) continue;
      p.role = ru.role;
      log('role_updated', `${p.displayName ?? ru.participantId} assigned to ${ru.role} (stated in conversation).`, {
        observationIds: [ru.observationId],
      });
    }

    for (const r of step.recommendations ?? []) {
      if (recommendations.some((x) => x.id === r.id)) continue; // de-duplicate by id
      recommendations.push({ ...r, sessionId, createdAt: t, status: 'active' });
      s.recommendationIds.push(r.id);
      log('recommendation_created', `Recommendation shown: ${r.title}`, {
        recommendationId: r.id,
        observationIds: [...r.evidenceObservationIds],
      });
    }

    for (const id of step.resolves ?? []) {
      const rec = recommendations.find((r) => r.id === id);
      // Resolution needs a newer observation (validated in the seed) and only
      // applies to cards that are still open.
      if (!rec || rec.status === 'resolved' || rec.status === 'dismissed') continue;
      rec.status = 'resolved';
      log('recommendation_resolved', `Marked resolved after a later observation: ${rec.title}`, {
        recommendationId: id,
        observationIds: newObs.map((o) => o.id),
      });
    }
  }

  // ---- public interface -----------------------------------------------

  return {
    mode: 'mock',

    async getSnapshot() {
      await delay(latency);
      return snapshot();
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async startSession() {
      await delay(latency);
      const s = transition('start');
      s.consentActive = true;
      s.startedAt = iso();
      log('session_started', 'Session started after participant consent.');
      if (s.activityConfirmed) log('activity_confirmed', `Activity confirmed: ${s.activity}.`);
      emit();
      scheduleNext();
    },

    async pauseSession() {
      await delay(latency);
      transition('pause');
      // Freeze the feed: no new observations or advice while paused.
      pausedRemainingMs = timer ? Math.max(0, timerDueAt - Date.now()) : null;
      clearTimer();
      // Existing advice can no longer be verified → mark stale (design.md §7).
      for (const r of recommendations) {
        if (r.status !== 'active') continue;
        r.status = 'stale';
        log('recommendation_stale', `Marked earlier / not currently verified (session paused): ${r.title}`, {
          recommendationId: r.id,
        });
      }
      log('session_paused', 'Session paused. New observation processing stopped.');
      emit();
    },

    async resumeSession() {
      await delay(latency);
      transition('resume');
      log('session_resumed', 'Session resumed after participant action.');
      emit();
      scheduleNext(pausedRemainingMs ?? undefined);
      pausedRemainingMs = null;
    },

    async endSession() {
      await delay(latency);
      const s = transition('end');
      clearTimer(); // stop observation FIRST
      pausedRemainingMs = null;
      s.consentActive = false;
      s.endedAt = iso();
      log('session_ended', 'Session ended. Observation stopped.');
      emit();
    },

    async discardSession() {
      await delay(latency);
      transition('discard');
      clearTimer();
      discarded = true;
      session = null;
      observations = [];
      recommendations = [];
      events = [];
      listeners.clear();
    },

    async dismissRecommendation(recommendationId) {
      await delay(latency);
      const { session: s } = live();
      if (s.status === 'ended') {
        throw new DataSourceError('invalid_state', 'This session has ended; recommendations can no longer change.');
      }
      const rec = findRec(recommendationId);
      if (rec.status !== 'active' && rec.status !== 'stale') {
        throw new DataSourceError('invalid_state', `Cannot dismiss a ${rec.status} recommendation.`);
      }
      rec.status = 'dismissed';
      log('recommendation_dismissed', `Recommendation dismissed by participant: ${rec.title}`, {
        recommendationId,
      });
      emit();
    },

    async requestVoiceExplanation(recommendationId): Promise<VoiceExplanation> {
      await delay(latency);
      const { session: s, seed: sd } = live();
      if (s.status !== 'active') {
        throw new DataSourceError('invalid_state', 'Voice explanations are only available during an active session.');
      }
      const rec = findRec(recommendationId);
      if (rec.status === 'dismissed') {
        throw new DataSourceError('invalid_state', 'This recommendation was dismissed.');
      }
      const base = sd.explanations[recommendationId]?.text;
      if (!base) throw new DataSourceError('not_found', 'No grounded explanation is available for this recommendation.');
      const earlier = rec.status !== 'active';
      rec.voiceRequestedAt = iso();
      rec.voiceDeliveryStatus = 'pending';
      log('voice_requested', `Voice explanation requested: ${rec.title}`, { recommendationId });
      emit();
      return {
        recommendationId,
        text: earlier ? STALE_EXPLANATION_PREFIX + base : base,
        refersToEarlierObservation: earlier,
        evidenceObservationIds: [...rec.evidenceObservationIds],
        generatedAt: iso(),
      };
    },

    reportVoicePlayback(recommendationId, report: VoicePlaybackReport) {
      if (discarded || !session) return; // nothing left to record
      const rec = recommendations.find((r) => r.id === recommendationId);
      if (!rec) return;
      switch (report) {
        case 'playing':
          rec.voiceDeliveryStatus = 'playing_locally';
          break;
        case 'finished':
          rec.voiceDeliveryStatus = 'finished';
          log('voice_finished', `Voice explanation finished (played locally): ${rec.title}`, { recommendationId });
          break;
        case 'failed':
          rec.voiceDeliveryStatus = 'failed';
          log('voice_failed', `Voice explanation could not play; text fallback shown: ${rec.title}`, { recommendationId });
          break;
        case 'cancelled':
          // No 'cancelled' value exists in the agreed voiceDeliveryStatus; leave it as-is.
          log('voice_cancelled', `Voice explanation stopped: ${rec.title}`, { recommendationId });
          break;
      }
      emit();
    },

    async generateReview() {
      await delay(latency * 2);
      const { session: s } = live();
      if (s.status !== 'ended') {
        throw new DataSourceError('invalid_state', 'End the session before generating a review.');
      }
      return generateMockReview(snapshot(), now());
    },

    mock: {
      async advanceFeed() {
        if (seedError || discarded || session?.status !== 'active') return false;
        clearTimer();
        return playNextStep();
      },
      remainingFeedSteps() {
        return seed ? seed.feed.length - feedIndex : 0;
      },
    },
  };
}
