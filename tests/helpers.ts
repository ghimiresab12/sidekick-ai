import assert from 'node:assert/strict';
import type { RecommendationCandidate, Result } from '../src/contracts/types.js';
import { SidekickEngine, type EngineOptions } from '../src/engine.js';
import { FakeClock, at } from '../src/mock/demo-scenario.js';

export type Engine = SidekickEngine;

export { at };

export function setup(options: EngineOptions = {}) {
  const clock = new FakeClock();
  let n = 0;
  const engine = new SidekickEngine({ now: clock.now, newId: () => `id-${++n}`, ...options });
  return { engine, clock };
}

/** Engine with one active session and a participant "Alex". */
export function activeSession(options: EngineOptions = {}) {
  const { engine, clock } = setup(options);
  const sid = value(engine.createSession()).id;
  const alex = value(engine.addParticipant(sid, { displayName: 'Alex', externalRef: 'spk-alex' }));
  value(engine.startWithConsent(sid));
  return { engine, clock, sid, alex };
}

export function value<T>(result: Result<T>): T {
  if (!result.ok) assert.fail(`expected ok, got ${result.error} ${result.detail ?? ''}`);
  return result.value;
}

export function error<T>(result: Result<T>): string {
  assert.equal(result.ok, false, 'expected an error result');
  return result.ok ? '' : result.error;
}

/** Current capture generation (what an adapter reads when raw input arrives). */
export function gen(engine: SidekickEngine, sid: string): number {
  const r = engine.getSession(sid);
  return r.ok ? r.value.captureGeneration : 1;
}

/** Proposes a candidate evaluated against the current context revision unless one is given. */
export function propose(engine: SidekickEngine, sid: string) {
  return (c: Partial<RecommendationCandidate>) => {
    const r = engine.getSession(sid);
    const basedOnContextRevision = r.ok ? r.value.contextRevision : 0;
    return engine.proposeRecommendation(sid, { basedOnContextRevision, ...c } as never);
  };
}

export function screen(engine: SidekickEngine, sid: string, seconds: number, covered = false) {
  return value(
    engine.ingestScreen(sid, {
      captureGeneration: gen(engine, sid),
      observedAt: at(seconds),
      summary: covered ? 'Left zone covered' : 'Left zone empty',
      evidenceQuality: 'clear',
      facts: { leftZoneCovered: covered },
    }),
  );
}

export function say(engine: SidekickEngine, sid: string, seconds: number, text = 'Alex has left defense') {
  return value(engine.ingestConversation(sid, { captureGeneration: gen(engine, sid), observedAt: at(seconds), text }));
}

export function candidate(conditionObservationIds: string[], extra: Record<string, unknown> = {}) {
  return {
    fingerprint: 'left_defense_uncovered',
    title: 'Left defense appears exposed',
    shortAdvice: 'Have Alex drop back or arrange cover.',
    conditionObservationIds,
    urgency: 'important' as const,
    ...extra,
  } as unknown as RecommendationCandidate;
}
