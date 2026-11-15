/**
 * In-process backend: the REAL session engine, SidekickCoordinator and reasoning
 * module (`src/`, unmodified), hosted in the page, fed with SYNTHETIC input.
 *
 * Why it exists: the local HTTP/SSE bridge is not on main yet, and the overlay needs
 * an offline mode for isolated frontend work and demos. Instead of the old
 * hand-written mock, which re-implemented lifecycle and card rules, this runs the
 * actual backend code, so the UI always sees exactly what the engine produces.
 *
 * What is real here: lifecycle rules, capture generations, reasoning (deterministic
 * mock provider, never Gemini: no keys exist in the browser), coordinator abort and
 * revalidation, card dedupe/staleness, voice request lifecycle, the timeline.
 * What is synthetic: the participants and the two scripted inputs below. Nothing
 * touches a microphone, camera, screen share, network or Chert.
 */
import { SidekickCoordinator } from '../../../src/coordinator/coordinator';
import type { CoordinatorDiagnostic, ReasoningFn } from '../../../src/coordinator/ports';
import { reason } from '../../../src/reasoning/reason.mts';
import { createMockProvider } from '../../../src/adapters/model/mock.mts';
import type { Result } from '../../../src/contracts/types';
import type { ExplanationScript, SessionTimeline } from '../contracts/pending';
import type { OverlayState } from '../contracts/shared';
import { buildExplanationText } from './explanationText';
import {
  BackendError,
  type BackendLabel,
  type BackendListener,
  type LocalVoiceStatus,
  type SidekickBackend,
} from './SidekickBackend';

/** Synthetic participants for the soccer demo. Not real people. */
const PARTICIPANTS = ['Alex', 'Jordan', 'Sam'];

type FeedStep =
  | { source: 'transcript'; text: string }
  | { source: 'screen'; summary: string; facts: Record<string, boolean> };

/** The scripted demo story. Each step is ingested with the CURRENT capture generation. */
export const SYNTHETIC_FEED: readonly FeedStep[] = [
  { source: 'transcript', text: 'Alex is responsible for left defense.' },
  {
    source: 'screen',
    summary: 'Synthetic game frame: the left defensive zone appears uncovered.',
    facts: { leftZoneVisible: true, leftZoneUncovered: true },
  },
];

export interface InProcessOptions {
  /** Inject a reasoning function (tests: slow/gated reasoning). Default: real `reason()` + mock provider. */
  reasoning?: ReasoningFn;
  now?: () => Date;
  feed?: readonly FeedStep[];
}

export const IN_PROCESS_LABEL: BackendLabel = {
  title: 'Offline simulation',
  detail:
    'Real session engine, coordinator and reasoning code running in this page · deterministic mock reasoning, not Gemini · synthetic inputs, no Chert/FaceTime media · companion panel, not a native overlay',
  syntheticInput: true,
};

function unwrap<T>(result: Result<T> | { ok: false; error: string; detail?: string }): T {
  if (result.ok) return (result as { ok: true; value: T }).value;
  const code = result.error as BackendError['code'];
  throw new BackendError(code, undefined);
}

export function createInProcessBackend(options: InProcessOptions = {}): SidekickBackend {
  const provider = createMockProvider();
  const diagnostics: CoordinatorDiagnostic[] = [];
  const coordinator = new SidekickCoordinator({
    reasoning: options.reasoning ?? ((request, signal) => reason(request, provider, { signal })),
    // engineering.md "Superseded condition evidence": the facts the MVP rule depends on.
    conditionFactKeys: ['leftZoneVisible', 'leftZoneUncovered'],
    onDiagnostic: (d) => diagnostics.push(d),
    ...(options.now ? { now: options.now } : {}),
  });
  const engine = coordinator.engine;
  const feed = options.feed ?? SYNTHETIC_FEED;
  const now = options.now ?? (() => new Date());

  const sessionId = unwrap(coordinator.createSession()).id;
  for (const displayName of PARTICIPANTS) unwrap(engine.addParticipant(sessionId, { displayName }));
  // The real flow is "suggested automatically, confirmed by users"; the overlay has no
  // confirm-activity control yet, so the synthetic setup confirms the MVP activity.
  unwrap(engine.confirmActivity(sessionId, 'gaming'));

  let feedIndex = 0;
  let discarded = false;

  const live = () => {
    if (discarded) throw new BackendError('session_not_found');
  };

  async function ingest(step: FeedStep): Promise<void> {
    const generation = unwrap(engine.getSession(sessionId)).captureGeneration;
    const observedAt = now().toISOString();
    const before = diagnostics.length;
    if (step.source === 'transcript') {
      unwrap(coordinator.ingestConversation(sessionId, { captureGeneration: generation, observedAt, text: step.text }));
    } else {
      unwrap(
        coordinator.ingestScreen(sessionId, {
          captureGeneration: generation,
          observedAt,
          summary: step.summary,
          evidenceQuality: 'clear',
          facts: step.facts,
        }),
      );
    }
    await coordinator.whenIdle(sessionId);
    const failed = diagnostics.slice(before).find((d) => d.type === 'reasoning_failed');
    if (failed) throw new BackendError('reasoning_failed');
  }

  return {
    label: IN_PROCESS_LABEL,

    connect(listener: BackendListener) {
      if (discarded) {
        listener.onConnection('unavailable', 'This session was discarded.');
        return () => {};
      }
      listener.onConnection('connected');
      // The engine emits the current state when subscribe returns, then on every change.
      const unsubscribe = unwrap(engine.subscribe(sessionId, (state: OverlayState) => listener.onState(state)));
      return unsubscribe;
    },

    async startSession() {
      live();
      unwrap(coordinator.startWithConsent(sessionId));
    },
    async pauseSession() {
      live();
      unwrap(coordinator.pause(sessionId));
    },
    async resumeSession() {
      live();
      unwrap(coordinator.resume(sessionId));
    },
    async endSession() {
      live();
      unwrap(coordinator.end(sessionId));
    },
    async discardSession() {
      live();
      unwrap(coordinator.discard(sessionId));
      discarded = true;
    },

    async dismiss(recommendationId) {
      live();
      unwrap(engine.dismiss(sessionId, recommendationId));
    },

    async requestExplanation(recommendationId): Promise<ExplanationScript> {
      live();
      const { request, context } = unwrap(engine.requestExplanation(sessionId, recommendationId));
      return { request, text: buildExplanationText(context), refersToEarlierObservation: context.isStale };
    },
    async reportVoiceStatus(requestId, status: LocalVoiceStatus) {
      live();
      unwrap(engine.reportVoiceStatus(sessionId, requestId, status));
    },
    async cancelExplanation(requestId) {
      live();
      unwrap(engine.cancelExplanation(sessionId, requestId, 'user'));
    },

    async getTimeline(): Promise<SessionTimeline> {
      live();
      const events = unwrap(engine.getTimeline(sessionId));
      const truncated = unwrap(engine.getSession(sessionId)).timelineTruncated;
      return { events, truncated };
    },

    simulation: {
      async advance() {
        live();
        const step = feed[feedIndex];
        if (!step) return;
        const status = unwrap(engine.getSession(sessionId)).status;
        if (status !== 'active') throw new BackendError('session_not_active');
        feedIndex += 1;
        await ingest(step);
      },
      remaining: () => (discarded ? 0 : feed.length - feedIndex),
    },
  };
}
