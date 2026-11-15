import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OverlayState, SessionEvent } from '../src/contracts/types.js';
import { activeSession, candidate, error, propose, screen, value } from './helpers.js';

function assertMonotonic(states: OverlayState[], label: string) {
  for (let i = 1; i < states.length; i++) {
    assert.ok(states[i]!.version > states[i - 1]!.version, `${label}: version went ${states[i - 1]!.version} → ${states[i]!.version}`);
  }
}

function indexOf(events: SessionEvent[], type: SessionEvent['type']) {
  return events.findIndex((e) => e.type === type);
}

/** Session with two cards; card A goes stale at t=17 while card B stays active. */
function twoCards() {
  const ctx = activeSession();
  const { engine, clock, sid } = ctx;
  clock.set(1);
  const a = value(propose(engine, sid)(candidate([screen(engine, sid, 1).id], { fingerprint: 'a' })));
  clock.set(10);
  value(propose(engine, sid)(candidate([screen(engine, sid, 10).id], { fingerprint: 'b' })));
  if (a.outcome !== 'created') assert.fail('expected created');
  return { ...ctx, recA: a.recommendation.id };
}

test('[R2-1] a subscriber ending the session cannot interrupt requestExplanation (original repro)', () => {
  const { engine, clock, sid, recA } = twoCards();
  value(engine.subscribe(sid, (s) => {
    if (s.status === 'active' && s.history.some((c) => c.status === 'stale')) engine.end(sid);
  }));
  clock.set(17); // requestExplanation's internal sweep makes card A stale
  const r = engine.requestExplanation(sid, recA);
  assert.equal(r.ok, true, 'the operation completes atomically before any listener runs');
  const events = value(engine.getTimeline(sid));
  const ended = indexOf(events, 'session_ended');
  assert.ok(ended > 0, 'subscriber ended the session afterwards');
  assert.ok(indexOf(events, 'voice_requested') < ended, 'voice_requested is never recorded after session_ended');
  assert.ok(!events.slice(ended + 1).some((e) => e.type === 'voice_requested'));
  const req = value(engine.getSession(sid)).voiceRequests[0]!;
  assert.deepEqual([req.status, req.cancelReason], ['cancelled', 'session_ended']);
  assert.equal(value(engine.getOverlayState(sid)).activeVoiceRequest, undefined);
});

test('[R2-1] no listener receives an older snapshot after a newer cancellation (original repro)', () => {
  const { engine, sid, recA } = twoCards();
  const a: OverlayState[] = [];
  const b: OverlayState[] = [];
  value(engine.subscribe(sid, (s) => {
    a.push(s);
    if (s.activeVoiceRequest) engine.cancelExplanation(sid, s.activeVoiceRequest.requestId, 'user');
  }));
  value(engine.subscribe(sid, (s) => b.push(s)));
  value(engine.requestExplanation(sid, recA));
  assertMonotonic(a, 'A');
  assertMonotonic(b, 'B');
  const current = value(engine.getOverlayState(sid));
  assert.equal(b.at(-1)?.version, current.version, 'B ends on the latest state');
  assert.equal(b.at(-1)?.activeVoiceRequest, undefined, 'B ends idle, not busy');
  assert.equal(a.at(-1)?.version, current.version);
});

test('[R2-1] multiple subscribers: one pauses during notification; all converge on paused', () => {
  const { engine, clock, sid } = activeSession();
  const seen: OverlayState[][] = [[], [], []];
  value(engine.subscribe(sid, (s) => seen[0]!.push(s)));
  value(engine.subscribe(sid, (s) => { seen[1]!.push(s); if (s.prominent && s.status === 'active') engine.pause(sid); }));
  value(engine.subscribe(sid, (s) => seen[2]!.push(s)));
  clock.set(1);
  value(propose(engine, sid)(candidate([screen(engine, sid, 1).id])));
  const final = value(engine.getOverlayState(sid));
  assert.equal(final.status, 'paused');
  seen.forEach((states, i) => {
    assertMonotonic(states, `listener ${i}`);
    assert.equal(states.at(-1)?.version, final.version, `listener ${i} ends on latest`);
    assert.equal(states.at(-1)?.status, 'paused');
  });
  // Listener 2 (after the pausing one) never saw the pre-pause "card active" snapshot.
  assert.ok(!seen[2]!.some((s) => s.prominent !== undefined));
});

test('[R2-1] multiple subscribers: one ends the session during notification', () => {
  const { engine, clock, sid } = activeSession();
  const later: OverlayState[] = [];
  value(engine.subscribe(sid, (s) => { if (s.prominent && s.status === 'active') engine.end(sid); }));
  value(engine.subscribe(sid, (s) => later.push(s)));
  clock.set(1);
  value(propose(engine, sid)(candidate([screen(engine, sid, 1).id])));
  assertMonotonic(later, 'later');
  assert.equal(later.at(-1)?.status, 'ended');
  assert.ok(!later.some((s) => s.prominent !== undefined), 'no stale active-card snapshot after end');
});

test('[R2-1] multiple subscribers: one discards during notification; others get nothing stale', () => {
  const { engine, clock, sid } = activeSession();
  const errors: unknown[] = [];
  const later: OverlayState[] = [];
  value(engine.subscribe(sid, (s) => { if (s.prominent) engine.discard(sid); }));
  value(engine.subscribe(sid, (s) => later.push(s)));
  const before = later.length;
  clock.set(1);
  value(propose(engine, sid)(candidate([screen(engine, sid, 1).id])));
  assert.equal(later.length, before, 'no snapshot delivered for a discarded session');
  assert.equal(error(engine.getSession(sid)), 'session_not_found');
  assert.deepEqual(errors, []);
});

test('[R2-1] chained reentrant calls stay ordered: request → playing → finished', () => {
  const { engine, sid, recA } = twoCards();
  const watcher: OverlayState[] = [];
  value(engine.subscribe(sid, (s) => {
    const v = s.activeVoiceRequest;
    if (v?.status === 'pending') engine.reportVoiceStatus(sid, v.requestId, 'playing_locally');
    else if (v?.status === 'playing_locally') engine.reportVoiceStatus(sid, v.requestId, 'finished');
  }));
  value(engine.subscribe(sid, (s) => watcher.push(s)));
  value(engine.requestExplanation(sid, recA));
  assertMonotonic(watcher, 'watcher');
  assert.equal(watcher.at(-1)?.activeVoiceRequest, undefined);
  const types = value(engine.getTimeline(sid)).map((e) => e.type);
  assert.ok(types.indexOf('voice_requested') < types.indexOf('voice_finished'));
});

test('[R2-1] listeners never run mid-operation', () => {
  const { engine, clock, sid, recA } = twoCards();
  const seenAtCallback: string[][] = [];
  value(engine.subscribe(sid, () => {
    seenAtCallback.push(value(engine.getTimeline(sid)).map((e) => e.type));
  }));
  seenAtCallback.length = 0;
  clock.set(17); // the sweep inside requestExplanation changes overlay state first…
  value(engine.requestExplanation(sid, recA));
  // …yet the first callback already sees the whole operation, including voice_requested.
  assert.equal(seenAtCallback.length, 1, 'one coalesced notification per operation');
  const types = seenAtCallback[0]!;
  assert.ok(types.includes('recommendation_stale') && types.includes('voice_requested'));
});

test('[R2-1] unsubscribe and subscribe during notification are honored deterministically', () => {
  const { engine, clock, sid } = activeSession();
  const lateJoiner: OverlayState[] = [];
  const removed: OverlayState[] = [];
  let unsubscribeB: () => void = () => {};
  value(engine.subscribe(sid, (s) => {
    if (s.prominent) {
      unsubscribeB();
      value(engine.subscribe(sid, (x) => lateJoiner.push(x)));
    }
  }));
  unsubscribeB = value(engine.subscribe(sid, (s) => removed.push(s)));
  const removedBefore = removed.length;
  clock.set(1);
  value(propose(engine, sid)(candidate([screen(engine, sid, 1).id])));
  assert.equal(removed.length, removedBefore, 'unsubscribed listener gets nothing more');
  assert.equal(lateJoiner.at(-1)?.version, value(engine.getOverlayState(sid)).version, 'new listener gets current state');
});

test('[R2-1] a listener that keeps changing state is stopped by the loop guard', () => {
  const errors: unknown[] = [];
  const { engine, sid } = activeSession({ onListenerError: (e) => errors.push(e) });
  let flip = false;
  value(engine.subscribe(sid, () => {
    flip = !flip;
    engine.suggestActivity(sid, flip ? 'gaming' : 'planning');
  }));
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]), /notification loop/);
  assert.equal(value(engine.getSession(sid)).status, 'active', 'engine still usable');
});
