import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OverlayState } from '../src/contracts/types.js';
import { activeSession, candidate, error, say, screen, value, gen, propose } from './helpers.js';

test('subscribe pushes an immediate snapshot and one per change; unsubscribe stops it', () => {
  const { engine, clock, sid } = activeSession();
  const states: OverlayState[] = [];
  const unsubscribe = value(engine.subscribe(sid, (s) => states.push(s)));
  assert.equal(states.length, 1);
  assert.equal(states[0]?.prominent, undefined);
  clock.set(20);
  const obs = screen(engine, sid, 20);
  assert.equal(states.length, 1, 'a plain observation does not change the overlay');
  value(propose(engine, sid)(candidate([obs.id])));
  assert.equal(states.length, 2);
  assert.equal(states[1]?.prominent?.title, 'Left defense appears exposed');
  value(propose(engine, sid)(candidate([obs.id])));
  assert.equal(states.length, 2, 'a no-op merge does not push');
  unsubscribe();
  value(engine.pause(sid));
  assert.equal(states.length, 2);
});

test('snapshot labels condition vs context evidence and contains no internal data', () => {
  const { engine, clock, sid, alex } = activeSession();
  value(engine.assignRole(sid, alex.id, 'left defense', { source: 'manual' }));
  clock.set(20);
  const u = say(engine, sid, 2);
  const obs = value(engine.ingestScreen(sid, { captureGeneration: gen(engine, sid), 
    observedAt: '2026-11-14T18:00:20Z', summary: 'empty', evidenceQuality: 'clear', frameRef: 'frame-123',
  }));
  value(propose(engine, sid)(candidate([obs.id], { contextObservationIds: [u.id], relatedParticipantIds: [alex.id] })));
  const state = value(engine.getOverlayState(sid));
  const card = state.prominent!;
  assert.deepEqual(card.evidence, [
    { observationId: obs.id, kind: 'condition', source: 'screen', observedAt: obs.observedAt },
    { observationId: u.id, kind: 'context', source: 'transcript', observedAt: u.observedAt },
  ]);
  assert.deepEqual(card.relatedParticipants, [{ id: alex.id, displayName: 'Alex', role: 'left defense' }]);
  assert.equal(card.contextChangedSinceCreation, false);
  assert.equal(card.canExplain, true);
  const json = JSON.stringify(state);
  for (const secret of ['frame-123', 'spk-alex', 'fingerprint', 'Alex has left defense']) {
    assert.ok(!json.includes(secret), `overlay must not include ${secret}`);
  }
  assert.deepEqual(JSON.parse(json), state, 'snapshot is plain JSON');
});

test('[F4] after a role correction the card shows creation-time roles and flags the change', () => {
  const { engine, clock, sid, alex } = activeSession();
  value(engine.assignRole(sid, alex.id, 'left defense', { source: 'manual' }));
  clock.set(20);
  value(propose(engine, sid)(candidate([screen(engine, sid, 20).id], { relatedParticipantIds: [alex.id] })));
  clock.set(21);
  value(engine.assignRole(sid, alex.id, 'striker', { source: 'manual' }));
  const card = value(engine.getOverlayState(sid)).history[0]!;
  assert.equal(card.status, 'stale');
  assert.equal(card.staleReason, 'role_changed');
  assert.equal(card.contextChangedSinceCreation, true);
  assert.equal(card.relatedParticipants[0]?.role, 'left defense');
});

test('one prominent card: important beats normal; history is strictly newest first', () => {
  const { engine, clock, sid } = activeSession();
  clock.set(20);
  const obs = screen(engine, sid, 20);
  value(propose(engine, sid)(candidate([obs.id], { fingerprint: 'a', title: 'Important A' })));
  clock.set(21);
  value(propose(engine, sid)(candidate([obs.id], { fingerprint: 'b', title: 'Normal B', urgency: 'normal' })));
  clock.set(22);
  const d = value(propose(engine, sid)(candidate([obs.id], { fingerprint: 'd', title: 'Dismissed D', urgency: 'normal' })));
  if (d.outcome === 'created') value(engine.dismiss(sid, d.recommendation.id));
  let state = value(engine.getOverlayState(sid));
  assert.equal(state.prominent?.title, 'Important A');
  assert.deepEqual(state.history.map((v) => v.title), ['Dismissed D', 'Normal B'], 'newest first, regardless of status');
  clock.set(23);
  value(propose(engine, sid)(candidate([obs.id], { fingerprint: 'c', title: 'Important C' })));
  state = value(engine.getOverlayState(sid));
  assert.equal(state.prominent?.title, 'Important C');
  assert.deepEqual(state.history.map((v) => v.title), ['Dismissed D', 'Normal B', 'Important A']);
});

test('no prominent card once everything is stale; nothing is explainable unless active', () => {
  const { engine, clock, sid } = activeSession();
  clock.set(20);
  value(propose(engine, sid)(candidate([screen(engine, sid, 20).id])));
  value(engine.pause(sid));
  const paused = value(engine.getOverlayState(sid));
  assert.equal(paused.prominent, undefined);
  assert.equal(paused.history[0]?.status, 'stale');
  assert.equal(paused.history[0]?.staleReason, 'session_paused');
  assert.equal(paused.history[0]?.canExplain, false, 'no explanations while paused');
  value(engine.resume(sid));
  assert.equal(value(engine.getOverlayState(sid)).history[0]?.canExplain, true, 'stale cards can be explained as "earlier"');
  value(engine.end(sid));
  assert.equal(value(engine.getOverlayState(sid)).history[0]?.canExplain, false);
});

test('a throwing listener does not break the engine or other listeners', () => {
  const errors: unknown[] = [];
  const { engine, clock, sid } = activeSession({ onListenerError: (e) => errors.push(e) });
  const seen: OverlayState[] = [];
  value(engine.subscribe(sid, () => { throw new Error('ui bug'); }));
  value(engine.subscribe(sid, (s) => seen.push(s)));
  clock.set(1);
  value(propose(engine, sid)(candidate([screen(engine, sid, 1).id])));
  assert.equal(seen.length, 2);
  assert.equal(errors.length, 2);
});

test('listeners receive independent copies', () => {
  const { engine, clock, sid } = activeSession();
  let a: OverlayState | undefined;
  let b: OverlayState | undefined;
  value(engine.subscribe(sid, (s) => { a = s; }));
  value(engine.subscribe(sid, (s) => { b = s; }));
  clock.set(1);
  value(propose(engine, sid)(candidate([screen(engine, sid, 1).id])));
  a!.prominent!.title = 'tampered';
  assert.equal(b!.prominent!.title, 'Left defense appears exposed');
  assert.equal(value(engine.getOverlayState(sid)).prominent?.title, 'Left defense appears exposed');
});

test('subscribe validates input', () => {
  const { engine, sid } = activeSession();
  assert.equal(error(engine.subscribe(sid, 'nope' as never)), 'invalid_input');
  assert.equal(error(engine.subscribe('missing', () => {})), 'session_not_found');
});
