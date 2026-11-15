/**
 * MOCK DATA ONLY. A scripted version of the gaming demo story
 * ("Alex is responsible for left defense") used for tests and `npm run demo`.
 *
 * Nothing here comes from Chert or a model. The hard-coded inputs stand in for
 * what the Chert adapter (transcripts), the model adapter (screen summaries) and
 * the reasoning layer (candidates, role extraction) will provide later.
 */
import type { OverlayState, SessionEvent } from '../contracts/types.js';
import { SidekickEngine } from '../engine.js';

const BASE = Date.parse('2026-11-14T18:00:00.000Z');
export const at = (seconds: number): string => new Date(BASE + seconds * 1000).toISOString();

/** Manually advanced clock so the scenario is deterministic. */
export class FakeClock {
  #ms: number;
  constructor(startMs = BASE) {
    this.#ms = startMs;
  }
  now = (): Date => new Date(this.#ms);
  set(seconds: number): void {
    this.#ms = BASE + seconds * 1000;
  }
}

function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: string; detail?: string }): T {
  if (!result.ok) throw new Error(`mock scenario step failed: ${result.error} ${result.detail ?? ''}`);
  return result.value;
}

export interface DemoResult {
  engine: SidekickEngine;
  sessionId: string;
  recommendationId: string;
  overlayUpdates: OverlayState[];
  timeline: SessionEvent[];
}

export function runDemoScenario(): DemoResult {
  const clock = new FakeClock();
  let n = 0;
  const engine = new SidekickEngine({ now: clock.now, newId: () => `id-${++n}` });
  const overlayUpdates: OverlayState[] = [];

  const session = unwrap(engine.createSession({ externalRef: 'mock-call-1' }));
  const sid = session.id;
  // The adapter reads the capture generation when raw input arrives and carries it along.
  const generation = () => unwrap(engine.getSession(sid)).captureGeneration;
  // The reasoning layer reads the context revision before evaluating a rule.
  const contextRevision = () => unwrap(engine.getSession(sid)).contextRevision;
  unwrap(engine.subscribe(sid, (state) => overlayUpdates.push(state)));

  const alex = unwrap(engine.addParticipant(sid, { displayName: 'Alex', externalRef: 'mock-speaker-alex' }));
  unwrap(engine.addParticipant(sid, { displayName: 'Sam', externalRef: 'mock-speaker-sam' }));
  unwrap(engine.startWithConsent(sid));
  unwrap(engine.suggestActivity(sid, 'gaming'));
  unwrap(engine.confirmActivity(sid, 'gaming'));

  // t=2s: role statement (role extraction would come from the reasoning layer).
  clock.set(2);
  const utterance = unwrap(
    engine.ingestConversation(sid, {
      captureGeneration: generation(),
      observedAt: at(2),
      text: 'Alex is responsible for left defense.',
      speakerRef: 'mock-speaker-sam',
    }),
  );
  unwrap(engine.assignRole(sid, alex.id, 'left defense', { source: 'transcript', sourceObservationId: utterance.id }));
  const goal = unwrap(
    engine.setGoal(sid, 'Keep the left side covered', { source: 'transcript', sourceObservationId: utterance.id }),
  );
  const plan = unwrap(
    engine.ingestConversation(sid, {
      captureGeneration: generation(),
      observedAt: at(3),
      text: 'If Alex pushes up, Sam covers left.',
      speakerRef: 'mock-speaker-alex',
    }),
  );
  unwrap(
    engine.recordDecision(sid, {
      text: 'Sam covers left when Alex pushes up',
      source: 'transcript',
      sourceObservationIds: [plan.id],
      participantIds: [alex.id],
      relatedGoalId: goal.id,
    }),
  );

  // t=10s: a frame shows the left zone covered.
  clock.set(10);
  unwrap(
    engine.ingestScreen(sid, {
      mediaSource: 'screen_share',
      captureGeneration: generation(),
      observedAt: at(9),
      summary: 'Blue defender near left defensive zone',
      evidenceQuality: 'clear',
      facts: { leftZoneCovered: true },
    }),
  );

  // t=20s: two consecutive frames show it uncovered → one card, then a merge.
  clock.set(20);
  const gap1 = unwrap(
    engine.ingestScreen(sid, {
      mediaSource: 'screen_share',
      captureGeneration: generation(),
      observedAt: at(19),
      summary: 'Blue defender advanced past midfield; left defensive zone empty',
      evidenceQuality: 'clear',
      facts: { leftZoneCovered: false },
    }),
  );
  const candidate = {
    fingerprint: 'left_defense_uncovered',
    title: 'Left defense appears exposed',
    shortAdvice: 'Alex advanced and the left zone looks uncovered. Have Alex drop back or arrange cover.',
    conditionObservationIds: [gap1.id],
    contextObservationIds: [utterance.id],
    relatedParticipantIds: [alex.id],
    relatedGoalId: goal.id,
    urgency: 'important' as const,
    basedOnContextRevision: contextRevision(),
  };
  const created = unwrap(engine.proposeRecommendation(sid, candidate));
  if (created.outcome !== 'created') throw new Error('expected a new card');

  clock.set(24);
  const gap2 = unwrap(
    engine.ingestScreen(sid, {
      mediaSource: 'screen_share',
      captureGeneration: generation(),
      observedAt: at(23),
      summary: 'Left defensive zone still empty',
      evidenceQuality: 'clear',
      facts: { leftZoneCovered: false },
    }),
  );
  unwrap(engine.proposeRecommendation(sid, { ...candidate, conditionObservationIds: [gap2.id] }));

  // t=26s: requester presses "Explain with voice"; the UI would play it locally.
  clock.set(26);
  const recId = created.recommendation.id;
  // The backend would turn `context` into text; the requester's UI speaks it locally.
  const { request } = unwrap(engine.requestExplanation(sid, recId));
  unwrap(engine.reportVoiceStatus(sid, request.id, 'playing_locally'));
  clock.set(32);
  unwrap(engine.reportVoiceStatus(sid, request.id, 'finished'));

  // t=36s: a newer frame shows the zone covered again → resolved.
  clock.set(36);
  const covered = unwrap(
    engine.ingestScreen(sid, {
      mediaSource: 'screen_share',
      captureGeneration: generation(),
      observedAt: at(35),
      summary: 'Blue defender back in left defensive zone',
      evidenceQuality: 'clear',
      facts: { leftZoneCovered: true },
    }),
  );
  unwrap(engine.resolve(sid, recId, covered.id));

  clock.set(60);
  unwrap(engine.end(sid));

  return {
    engine,
    sessionId: sid,
    recommendationId: recId,
    overlayUpdates,
    timeline: unwrap(engine.getTimeline(sid)),
  };
}
