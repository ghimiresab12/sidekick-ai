/**
 * In-process backend: the REAL session engine, SidekickCoordinator and reasoning
 * module (`src/`, unmodified), hosted in the page, fed with SYNTHETIC input.
 *
 * DEVELOPMENT MODE ONLY. The live overlay uses `httpBackend` (the Node bridge owns the
 * engine and session state). This exists for tests and offline demos, and is loaded only
 * when explicitly selected (App.tsx, lazy import), so the live build contains no engine.
 * It runs the actual backend code rather than a hand-written fake, and returns the same
 * browser projections and explanation text as the bridge (`src/privacy/browser-projection.ts`,
 * `src/explanations/explanation-text.ts`), so both modes show the same shapes.
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
import { buildExplanationText } from '../../../src/explanations/explanation-text';
import { projectOverlayState, projectTimelineEvent, projectVoiceRequest } from '../../../src/privacy/browser-projection';
import type { BrowserSessionTimeline, ExplanationScript, OverlayState } from '../contracts/shared';
import {
  BackendError,
  type BackendCapabilities,
  type BackendLabel,
  type BackendListener,
  type LocalVoiceStatus,
  type SidekickBackend,
} from './SidekickBackend';

/** Synthetic participants for the soccer demo. Not real people. */
const PARTICIPANTS = ['Alex', 'Jordan', 'Sam'];

type FeedStep =
  | { source: 'transcript'; text: string }
  | { source: 'screen'; mediaSource: 'screen_share'; summary: string; facts: Record<string, boolean> };

/** The scripted demo story. Each step is ingested with the CURRENT capture generation. */
export const SYNTHETIC_FEED: readonly FeedStep[] = [
  { source: 'transcript', text: 'Alex is responsible for left defense.' },
  {
    source: 'screen',
    mediaSource: 'screen_share',
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

const IN_PROCESS_CAPABILITIES: BackendCapabilities = { consent: 'local', resume: true };

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
  for (const displayName of PARTICIPANTS) unwrap(coordinator.addParticipant(sessionId, { displayName }));
  // The synthetic setup confirms the MVP activity (the bridge mode has a "Confirm gaming" control).
  unwrap(coordinator.confirmActivity(sessionId, 'gaming'));

  let feedIndex = 0;
  let discarded = false;
  const discardListeners = new Set<() => void>();

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
          mediaSource: step.mediaSource,
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
    capabilities: IN_PROCESS_CAPABILITIES,

    connect(listener: BackendListener) {
      if (discarded) {
        listener.onConnection('unavailable', 'This session was discarded.');
        return () => {};
      }
      listener.onConnection('connected');
      // The engine emits the current state when subscribe returns, then on every change.
      const unsubscribe = unwrap(engine.subscribe(sessionId, (state: OverlayState) => listener.onState(projectOverlayState(state))));
      const onDiscarded = () => listener.onDiscarded?.();
      discardListeners.add(onDiscarded);
      return () => {
        discardListeners.delete(onDiscarded);
        unsubscribe();
      };
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
      for (const notify of discardListeners) notify();
      discardListeners.clear();
    },

    async dismiss(recommendationId) {
      live();
      unwrap(coordinator.dismiss(sessionId, recommendationId));
    },

    async requestExplanation(recommendationId): Promise<ExplanationScript> {
      live();
      const { request, context } = unwrap(coordinator.requestExplanation(sessionId, recommendationId));
      return { request: projectVoiceRequest(request), text: buildExplanationText(context), refersToEarlierObservation: context.isStale };
    },
    async reportVoiceStatus(requestId, status: LocalVoiceStatus) {
      live();
      unwrap(coordinator.reportVoiceStatus(sessionId, requestId, status));
    },
    async cancelExplanation(requestId) {
      live();
      unwrap(coordinator.cancelExplanation(sessionId, requestId, 'user'));
    },

    async getTimeline(): Promise<BrowserSessionTimeline> {
      live();
      const events = unwrap(engine.getTimeline(sessionId));
      const snap = unwrap(engine.getSession(sessionId));
      // Same projection as the bridge: no goal or decision wording, rebuilt summaries, safe roles.
      const lookup = {
        names: new Map(snap.participants.map((p) => [p.id, p.displayName])),
        titles: new Map(snap.recommendations.map((r) => [r.id, r.title])),
      };
      return { events: events.map((e) => projectTimelineEvent(e, lookup)), truncated: snap.timelineTruncated };
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
