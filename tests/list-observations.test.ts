import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeSession, at, candidate, error, gen, propose, say, screen, value } from './helpers.js';

test('lists observations ordered by source time, not arrival order', () => {
  const { engine, clock, sid } = activeSession();
  clock.set(20);
  const late = screen(engine, sid, 15);
  const early = say(engine, sid, 5);
  const middle = screen(engine, sid, 10);
  assert.deepEqual(value(engine.listObservations(sid)).map((o) => o.id), [early.id, middle.id, late.id]);
});

test('filters by source, generation, observedSince and ids (ANDed)', () => {
  const { engine, clock, sid } = activeSession();
  clock.set(10);
  const t1 = say(engine, sid, 1);
  const s1 = screen(engine, sid, 2);
  value(engine.pause(sid));
  value(engine.resume(sid));
  const s3 = screen(engine, sid, 9);
  assert.deepEqual(value(engine.listObservations(sid, { source: 'screen' })).map((o) => o.id), [s1.id, s3.id]);
  assert.deepEqual(value(engine.listObservations(sid, { captureGeneration: 1 })).map((o) => o.id), [t1.id, s1.id]);
  assert.deepEqual(value(engine.listObservations(sid, { observedSince: at(2) })).map((o) => o.id), [s1.id, s3.id]);
  assert.deepEqual(value(engine.listObservations(sid, { ids: [s3.id, t1.id, 'unknown'] })).map((o) => o.id), [t1.id, s3.id]);
  assert.deepEqual(value(engine.listObservations(sid, { source: 'screen', captureGeneration: gen(engine, sid) })).map((o) => o.id), [s3.id]);
});

test('limit keeps the newest matches; default is 100 and the maximum is 500', () => {
  const { engine, clock, sid } = activeSession();
  clock.set(200);
  const all = Array.from({ length: 120 }, (_, i) => screen(engine, sid, i));
  assert.deepEqual(value(engine.listObservations(sid, { limit: 3 })).map((o) => o.id), all.slice(-3).map((o) => o.id));
  assert.equal(value(engine.listObservations(sid)).length, 100);
  assert.equal(value(engine.listObservations(sid))[0]?.id, all[20]?.id);
  assert.equal(value(engine.listObservations(sid, { limit: 500 })).length, 120);
});

test('rejects malformed queries', () => {
  const { engine, sid } = activeSession();
  for (const q of [null, 'x', [], { source: 'audio' }, { captureGeneration: -1 }, { captureGeneration: 1.5 },
    { ids: 'a' }, { ids: Array.from({ length: 101 }, (_, i) => `id${i}`) },
    { limit: 0 }, { limit: 501 }, { limit: 2.5 }, { keep: 'middle' }]) {
    assert.equal(error(engine.listObservations(sid, q as never)), 'invalid_input', JSON.stringify(q));
  }
  assert.equal(error(engine.listObservations(sid, { observedSince: 'yesterday' })), 'invalid_timestamp');
  assert.equal(error(engine.listObservations(sid, { observedUntil: 'tomorrow' })), 'invalid_timestamp');
  assert.equal(error(engine.listObservations('missing')), 'session_not_found');
});

test('is read-only: no overlay version bump, no events, no stale sweep', () => {
  const { engine, clock, sid } = activeSession({ staleAfterMs: 15_000 });
  clock.set(20);
  value(propose(engine, sid)(candidate([screen(engine, sid, 20).id])));
  clock.set(60); // card would be swept stale by any mutating call
  const version = value(engine.getOverlayState(sid)).version;
  const events = value(engine.getTimeline(sid)).length;
  value(engine.listObservations(sid));
  value(engine.listObservations(sid, { source: 'screen', limit: 1 }));
  assert.equal(value(engine.getOverlayState(sid)).version, version);
  assert.equal(value(engine.getTimeline(sid)).length, events);
  assert.equal(value(engine.getSession(sid)).recommendations[0]?.status, 'active', 'listing does not sweep');
});

test('returns copies and never leaks another session\'s observations', () => {
  const { engine, clock, sid } = activeSession();
  clock.set(1);
  const obs = screen(engine, sid, 1);
  const other = value(engine.createSession()).id;
  value(engine.startWithConsent(other));
  assert.deepEqual(value(engine.listObservations(other, { ids: [obs.id] })), []);
  const listed = value(engine.listObservations(sid))[0] as { summary: string };
  listed.summary = 'tampered';
  assert.notEqual((value(engine.getObservation(sid, obs.id)) as { summary: string }).summary, 'tampered');
});

test('observedUntil bounds the newest time; keep: oldest keeps the earliest matches', () => {
  const { engine, clock, sid } = activeSession();
  clock.set(20);
  const frames = [3, 5, 7, 9, 11].map((s) => screen(engine, sid, s));
  assert.deepEqual(value(engine.listObservations(sid, { observedUntil: at(7) })).map((o) => o.id), frames.slice(0, 3).map((o) => o.id));
  assert.deepEqual(value(engine.listObservations(sid, { observedSince: at(5), observedUntil: at(9) })).map((o) => o.id),
    frames.slice(1, 4).map((o) => o.id));
  assert.deepEqual(value(engine.listObservations(sid, { limit: 2, keep: 'oldest' })).map((o) => o.id), frames.slice(0, 2).map((o) => o.id));
  assert.deepEqual(value(engine.listObservations(sid, { limit: 2, keep: 'newest' })).map((o) => o.id), frames.slice(3).map((o) => o.id));
  assert.deepEqual(value(engine.listObservations(sid, { observedSince: at(8), keep: 'oldest', limit: 1 })).map((o) => o.id), [frames[3]!.id]);
});
