import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeSession, at, candidate, error, gen, propose, setup, value } from './helpers.js';

test('[R2-3] capture generation increments on every lifecycle transition', () => {
  const { engine, clock } = setup();
  const sid = value(engine.createSession()).id;
  assert.equal(gen(engine, sid), 0);
  assert.equal(value(engine.startWithConsent(sid)).captureGeneration, 1);
  clock.set(1);
  assert.equal(value(engine.pause(sid)).captureGeneration, 2);
  assert.equal(value(engine.resume(sid)).captureGeneration, 3);
  assert.equal(value(engine.end(sid)).captureGeneration, 4);
});

/** Pause at t=21, resume at t=23. Returns the pre-pause generation. */
function pauseResume() {
  const ctx = activeSession({ maxClockSkewMs: 5_000, staleAfterMs: 15_000 });
  const { engine, clock, sid } = ctx;
  const beforePause = gen(engine, sid);
  clock.set(21);
  value(engine.pause(sid));
  const duringPause = gen(engine, sid);
  clock.set(23);
  value(engine.resume(sid));
  return { ...ctx, beforePause, duringPause, afterResume: gen(engine, sid) };
}

test('[R2-3] pre-pause capture with a clock skewed to look post-resume cannot be condition evidence', () => {
  const { engine, clock, sid, beforePause } = pauseResume();
  clock.set(24);
  // Captured at ~t=20.9 (before the pause) by a producer whose clock runs exactly +5s ahead.
  // Old timestamp-floor logic accepted this (25.9 ≥ resume at 23). Processed after resume:
  const skewed = value(engine.ingestScreen(sid, {
    mediaSource: 'screen_share', captureGeneration: beforePause, observedAt: at(25.9), summary: 'Left zone empty', evidenceQuality: 'clear',
  }));
  assert.equal(skewed.captureGeneration, beforePause, 'stored with its real capture generation');
  assert.equal(error(propose(engine, sid)(candidate([skewed.id]))), 'stale_evidence');
  // Exactly at the admission boundary (now + maxClockSkewMs) behaves the same:
  const boundary = value(engine.ingestScreen(sid, {
    mediaSource: 'screen_share', captureGeneration: beforePause, observedAt: at(29), summary: 'Left zone empty', evidenceQuality: 'clear',
  }));
  assert.equal(error(propose(engine, sid)(candidate([boundary.id]))), 'stale_evidence');
  assert.equal(value(engine.getSession(sid)).recommendations.length, 0);
});

test('[R2-3] post-resume capture with a lagging clock is still valid condition evidence', () => {
  const { engine, clock, sid, afterResume } = pauseResume();
  clock.set(24);
  // Captured after resume, but the producer clock is 3s behind → timestamp falls inside the pause.
  const lagging = value(engine.ingestScreen(sid, {
    mediaSource: 'screen_share', captureGeneration: afterResume, observedAt: at(21.5), summary: 'Left zone empty', evidenceQuality: 'clear',
  }));
  assert.equal(value(propose(engine, sid)(candidate([lagging.id]))).outcome, 'created');
});

test('[R2-3] input captured while paused is rejected regardless of timestamp', () => {
  const { engine, clock, sid, duringPause } = pauseResume();
  clock.set(24);
  for (const t of [22, 24]) {
    assert.equal(
      error(engine.ingestScreen(sid, { mediaSource: 'screen_share', captureGeneration: duringPause, observedAt: at(t), summary: 's', evidenceQuality: 'clear' })),
      'invalid_generation',
    );
    assert.equal(
      error(engine.ingestConversation(sid, { captureGeneration: duringPause, observedAt: at(t), text: 'x' })),
      'invalid_generation',
    );
  }
});

test('[R2-3] unknown, future and malformed generations are rejected', () => {
  const { engine, clock, sid, afterResume } = pauseResume();
  clock.set(24);
  for (const g of [afterResume + 1, 0, -1, 1.5, '3', null, undefined]) {
    assert.equal(
      error(engine.ingestScreen(sid, { mediaSource: 'screen_share', captureGeneration: g as never, observedAt: at(24), summary: 's', evidenceQuality: 'clear' })),
      'invalid_generation',
      `generation ${String(g)}`,
    );
  }
});

test('[R2-3] earlier-generation observations remain usable as context and role provenance', () => {
  const { engine, clock, sid, alex, beforePause } = pauseResume();
  clock.set(24);
  const talk = value(engine.ingestConversation(sid, { captureGeneration: beforePause, observedAt: at(20), text: 'Alex left' }));
  assert.equal(
    value(engine.assignRole(sid, alex.id, 'left defense', { source: 'transcript', sourceObservationId: talk.id })).outcome,
    'applied',
  );
  const frame = value(engine.ingestScreen(sid, { mediaSource: 'screen_share', captureGeneration: gen(engine, sid), observedAt: at(24), summary: 'gap', evidenceQuality: 'clear' }));
  const r = value(propose(engine, sid)(candidate([frame.id], { contextObservationIds: [talk.id] })));
  assert.equal(r.outcome, 'created');
});
