import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SidekickCoordinator } from '../../src/coordinator/coordinator.js';
import type { ReasoningFn } from '../../src/coordinator/ports.js';
import type { ScreenInput } from '../../src/contracts/types.js';
import { controlledSoccerResolution } from '../../src/recommendations/recommendation-rules.js';
import { FakeClock, at } from '../../src/mock/demo-scenario.js';
import { value, candidate, propose, error } from '../helpers.js';

const { mockReasoning } = await import(new URL('../../../tests/integration/reasoning-wiring.mts', import.meta.url).href) as { mockReasoning: ReasoningFn };

async function setup(options: { reasoning?: ReasoningFn; cooldownMs?: number; setTimer?: (fn: () => void, ms: number) => () => void } = {}) {
  const clock = new FakeClock();
  const coordinator = new SidekickCoordinator({
    reasoning: options.reasoning ?? mockReasoning, now: clock.now,
    engine: { staleAfterMs: 60_000, ...(options.cooldownMs !== undefined ? { cooldownMs: options.cooldownMs } : {}) },
    resolutionRule: controlledSoccerResolution,
    ...(options.setTimer ? { setTimer: options.setTimer } : {}),
  });
  const engine = coordinator.engine;
  const sid = value(coordinator.createSession()).id;
  assert.ok(coordinator.addParticipant(sid, { displayName: 'Alex' }).ok);
  value(coordinator.confirmActivity(sid, 'gaming'));
  value(coordinator.startWithConsent(sid));
  clock.set(1);
  value(coordinator.ingestConversation(sid, { captureGeneration: 1, observedAt: at(1), text: 'Alex is responsible for left defense.' }));
  await coordinator.whenIdle(sid);
  const screen = (seconds: number, over: Partial<ScreenInput> = {}) => value(coordinator.ingestScreen(sid, {
    captureGeneration: value(engine.getSession(sid)).captureGeneration,
    observedAt: at(seconds), summary: 'Left zone visible and uncovered', evidenceQuality: 'clear',
    facts: { leftZoneVisible: true, leftZoneUncovered: true }, ...over,
  }));
  clock.set(2);
  const uncovered = screen(2);
  await coordinator.whenIdle(sid);
  const rec = value(engine.getSession(sid)).recommendations[0]!;
  assert.equal(rec.status, 'active');
  const covered = (seconds: number, over: Partial<ScreenInput> = {}) => screen(seconds, {
    summary: 'Left zone covered', facts: { leftZoneVisible: true, leftZoneUncovered: false }, ...over,
  });
  const current = () => value(engine.getSession(sid)).recommendations.find((r) => r.id === rec.id)!;
  return { coordinator, engine, clock, sid, rec, screen, covered, current, uncovered };
}

test('[resolution] uncovered → covered resolves, records exact evidence, cancels voice, and versions state', async () => {
  const h = await setup();
  const request = value(h.coordinator.requestExplanation(h.sid, h.rec.id)).request;
  value(h.coordinator.reportVoiceStatus(h.sid, request.id, 'playing_locally'));
  const version = value(h.engine.getOverlayState(h.sid)).version;
  h.clock.set(3);
  const covered = h.covered(3);
  assert.equal(h.current().status, 'resolved', 'resolution must not wait for model inference');
  assert.equal(h.current().resolvedByObservationId, covered.id);
  const state = value(h.engine.getOverlayState(h.sid));
  assert.ok(state.version > version);
  assert.equal(state.prominent, undefined);
  assert.equal(state.activeVoiceRequest, undefined);
  const voice = value(h.engine.getSession(h.sid)).voiceRequests[0]!;
  assert.equal(voice.status, 'cancelled');
  assert.equal(voice.cancelReason, 'recommendation_resolved');
  const events = value(h.engine.getTimeline(h.sid));
  assert.ok(events.some((e) => e.type === 'recommendation_resolved' && e.recommendationId === h.rec.id && e.observationId === covered.id));
  await h.coordinator.whenIdle(h.sid);
  h.clock.set(4);
  const recurrence = h.screen(4);
  const suppressed = value(propose(h.engine, h.sid)(candidate([recurrence.id])));
  assert.equal(suppressed.outcome, 'suppressed', 'the existing 30-second cooldown is preserved');
  await h.coordinator.whenIdle(h.sid);
});

for (const [label, over] of [
  ['partial', { evidenceQuality: 'partial' }],
  ['unknown', { evidenceQuality: 'unknown' }],
  ['invisible zone', { facts: { leftZoneVisible: false, leftZoneUncovered: false } }],
  ['missing visibility', { facts: { leftZoneUncovered: false } }],
  ['missing coverage', { facts: { leftZoneVisible: true } }],
] as Array<[string, Partial<ScreenInput>]>) {
  test(`[resolution] ${label} does not resolve`, async () => {
    const h = await setup(); h.clock.set(3); h.covered(3, over);
    await h.coordinator.whenIdle(h.sid);
    assert.equal(h.current().status, 'active');
  });
}

test('[resolution] older or tied covered evidence cannot resolve a newer condition', async () => {
  const h = await setup(); h.clock.set(3);
  h.covered(1.5); h.covered(2);
  await h.coordinator.whenIdle(h.sid);
  assert.equal(h.current().status, 'active');
});

test('[resolution] an unclear newest screen blocks late covered evidence, including timestamp ties', async () => {
  for (const seconds of [3, 4]) {
    const h = await setup(); h.clock.set(4);
    h.screen(seconds, { evidenceQuality: 'unknown', facts: {} });
    h.covered(3);
    await h.coordinator.whenIdle(h.sid);
    assert.equal(h.current().status, 'active');
  }
});

test('[resolution] all clear newest ties may agree, but an incomplete page of ties never resolves', async () => {
  const h = await setup(); h.clock.set(3);
  // Store directly to construct the entire tied batch before asking the coordinator to evaluate it.
  const input: ScreenInput = { captureGeneration: 1, observedAt: at(3), summary: 'covered', evidenceQuality: 'clear', facts: { leftZoneVisible: true, leftZoneUncovered: false } };
  value(h.engine.ingestScreen(h.sid, input));
  h.covered(3);
  assert.equal(h.current().status, 'resolved');
  await h.coordinator.whenIdle(h.sid);
  const many = await setup(); many.clock.set(3);
  for (let i = 0; i < 500; i++) value(many.engine.ingestScreen(many.sid, input));
  many.covered(3);
  assert.equal(many.current().status, 'active');
  await many.coordinator.whenIdle(many.sid);
});

test('[resolution] stale cards and unrelated fingerprints are not automatically resolved', async () => {
  const h = await setup(); h.clock.set(63);
  h.covered(63);
  await h.coordinator.whenIdle(h.sid);
  assert.equal(h.current().status, 'stale');
  const other = await setup();
  const outcome = value(propose(other.engine, other.sid)(candidate([other.uncovered.id], { fingerprint: 'another_issue' })));
  assert.equal(outcome.outcome, 'created');
  other.clock.set(3); other.covered(3);
  await other.coordinator.whenIdle(other.sid);
  assert.equal(value(other.engine.getSession(other.sid)).recommendations.find((r) => r.fingerprint === 'another_issue')!.status, 'active');
});

test('[resolution] old-generation covered evidence cannot resolve after resume; engine also rejects it', async () => {
  const h = await setup();
  value(h.coordinator.pause(h.sid)); value(h.coordinator.resume(h.sid));
  h.clock.set(3); h.screen(3); await h.coordinator.whenIdle(h.sid);
  const current = value(h.engine.getSession(h.sid)).recommendations.find((r) => r.status === 'active')!;
  h.clock.set(4);
  const old = h.covered(4, { captureGeneration: 1 });
  assert.equal(error(h.engine.resolve(h.sid, current.id, old.id)), 'stale_evidence');
  await h.coordinator.whenIdle(h.sid);
  assert.equal(value(h.engine.getSession(h.sid)).recommendations.find((r) => r.id === current.id)!.status, 'active');
});

test('[resolution] a new generation may recur with a lagging source clock', async () => {
  const h = await setup({ cooldownMs: 0 });
  h.clock.set(3); h.covered(3); await h.coordinator.whenIdle(h.sid);
  assert.equal(h.current().status, 'resolved');
  value(h.coordinator.pause(h.sid)); value(h.coordinator.resume(h.sid));
  h.clock.set(4); h.screen(2.5); await h.coordinator.whenIdle(h.sid);
  const active = value(h.engine.getSession(h.sid)).recommendations.filter((r) => r.status === 'active');
  assert.equal(active.length, 1, 'the old generation resolution must not reject a post-resume capture');
});

test('[resolution] resolving one card does not cancel an explanation of a different card', async () => {
  const h = await setup();
  const other = value(propose(h.engine, h.sid)(candidate([h.uncovered.id], { fingerprint: 'another_issue' })));
  assert.ok(other.outcome === 'created');
  const request = value(h.coordinator.requestExplanation(h.sid, other.recommendation.id)).request;
  value(h.coordinator.reportVoiceStatus(h.sid, request.id, 'playing_locally'));
  h.clock.set(3); h.covered(3); await h.coordinator.whenIdle(h.sid);
  assert.equal(h.current().status, 'resolved');
  assert.equal(value(h.engine.getOverlayState(h.sid)).activeVoiceRequest?.requestId, request.id);
});

for (const transition of ['pause', 'end', 'discard'] as const) {
  test(`[resolution] reentrant ${transition} during ingest sweep prevents resolution`, async () => {
    const h = await setup();
    // Ordinary observation storage doesn't notify overlay listeners. Arrange for ingest
    // to expire a different card, forcing a notification before resolution is evaluated.
    const old = value(h.engine.ingestScreen(h.sid, { captureGeneration: 1, observedAt: at(1), summary: 'old screen', evidenceQuality: 'clear' }));
    value(propose(h.engine, h.sid)(candidate([old.id], { fingerprint: 'another_issue' })));
    let changed = false;
    value(h.engine.subscribe(h.sid, () => {
      const latest = h.engine.getLatestObservation(h.sid, 'screen');
      if (!changed && latest.ok && latest.value?.source === 'screen' && latest.value.facts?.leftZoneUncovered === false) {
        changed = true;
        assert.ok(h.coordinator[transition](h.sid).ok);
      }
    }));
    h.clock.set(62); h.covered(62); await h.coordinator.whenIdle(h.sid);
    assert.ok(changed);
    const timeline = h.engine.getTimeline(h.sid);
    if (timeline.ok) assert.ok(!timeline.value.some((e) => e.type === 'recommendation_resolved'));
    else assert.equal(transition, 'discard');
  });
}

test('[resolution] engine rejects partial, unknown, transcript, stale and future resolution evidence', async () => {
  const h = await setup(); h.clock.set(3);
  for (const quality of ['partial', 'unknown'] as const) {
    const obs = h.covered(3, { evidenceQuality: quality });
    assert.equal(error(h.engine.resolve(h.sid, h.rec.id, obs.id)), 'insufficient_evidence');
  }
  const speech = value(h.engine.ingestConversation(h.sid, { captureGeneration: 1, observedAt: at(3), text: 'covered' }));
  assert.equal(error(h.engine.resolve(h.sid, h.rec.id, speech.id)), 'insufficient_evidence');
  const future = h.covered(4);
  assert.equal(error(h.engine.resolve(h.sid, h.rec.id, future.id)), 'stale_evidence');
  h.clock.set(65);
  assert.equal(error(h.engine.resolve(h.sid, h.rec.id, future.id)), 'stale_evidence');
  await h.coordinator.whenIdle(h.sid);
});

test('[resolution] future evidence resolves only when the eligibility timer wakes', async () => {
  let wake = () => {};
  const h = await setup({ setTimer: (fn) => { wake = fn; return () => {}; } });
  h.covered(3); await h.coordinator.whenIdle(h.sid);
  assert.equal(h.current().status, 'active');
  h.clock.set(3); wake(); await h.coordinator.whenIdle(h.sid);
  assert.equal(h.current().status, 'resolved');
});

test('[resolution] late reasoning cannot recreate a resolved card, even after cooldown', async () => {
  let release = () => {};
  let hold = false;
  const reasoning: ReasoningFn = async (request, signal) => {
    const output = await mockReasoning(request, signal);
    if (hold) { hold = false; await new Promise<void>((r) => { release = r; }); }
    return output;
  };
  const h = await setup({ reasoning });
  hold = true; h.clock.set(3); h.screen(3);
  // Let the async provider compute its old candidate before the newer covered frame arrives.
  await new Promise((r) => setImmediate(r));
  h.clock.set(4); const covered = h.covered(4);
  assert.equal(h.current().status, 'resolved');
  h.clock.set(35); release(); await h.coordinator.whenIdle(h.sid);
  assert.equal(value(h.engine.getSession(h.sid)).recommendations.length, 1);
  assert.equal(error(propose(h.engine, h.sid)(candidate([h.uncovered.id]))), 'stale_evidence', 'engine watermark survives cooldown');
  assert.equal(error(propose(h.engine, h.sid)(candidate([covered.id]))), 'stale_evidence', 'equality is also obsolete');
  h.clock.set(36); h.screen(36); await h.coordinator.whenIdle(h.sid);
  assert.equal(value(h.engine.getSession(h.sid)).recommendations.filter((r) => r.status === 'active').length, 1, 'newer recurrence is allowed');
});
