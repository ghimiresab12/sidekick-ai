import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeSession, at, candidate, say, screen, value, gen, propose } from './helpers.js';

test('records lifecycle, context, observation and recommendation events with timestamps', () => {
  const { engine, clock, sid, alex } = activeSession();
  clock.set(3);
  const u = say(engine, sid, 2);
  value(engine.assignRole(sid, alex.id, 'left defense', { source: 'transcript', sourceObservationId: u.id }));
  value(engine.confirmActivity(sid, 'gaming'));
  clock.set(20);
  const obs = screen(engine, sid, 19);
  const r = value(propose(engine, sid)(candidate([obs.id], { contextObservationIds: [u.id] })));
  if (r.outcome !== 'created') assert.fail('expected created');
  clock.set(25);
  value(engine.dismiss(sid, r.recommendation.id));
  clock.set(30);
  value(engine.end(sid));

  const events = value(engine.getTimeline(sid));
  assert.deepEqual(events.map((e) => e.type), [
    'participant_added', 'session_started', 'observation', 'role_updated', 'activity_confirmed',
    'observation', 'recommendation_created', 'recommendation_dismissed', 'session_ended',
  ]);
  for (const e of events) {
    assert.equal(e.sessionId, sid);
    assert.ok(e.id && e.summary);
    assert.ok(!Number.isNaN(Date.parse(e.time)) && !Number.isNaN(Date.parse(e.recordedAt)));
  }
  const createdEv = events.find((e) => e.type === 'recommendation_created');
  assert.ok(createdEv?.type === 'recommendation_created');
  assert.equal(createdEv.recommendationId, r.recommendation.id);
  assert.deepEqual(createdEv.conditionObservationIds, [obs.id]);
  assert.deepEqual(createdEv.contextObservationIds, [u.id]);
  assert.equal(createdEv.time, at(20));
  const role = events.find((e) => e.type === 'role_updated');
  assert.ok(role?.type === 'role_updated');
  assert.equal(role.change.sourceObservationId, u.id);
  assert.equal(role.time, at(2), 'role event placed at utterance time');
  assert.equal(role.recordedAt, at(3));
});

test('[F6] structured payloads reconstruct the session without parsing summaries', () => {
  const { engine, clock, sid, alex } = activeSession();
  value(engine.assignRole(sid, alex.id, 'left defense', { source: 'manual' }));
  clock.set(1);
  value(engine.assignRole(sid, alex.id, 'striker', { source: 'manual' }));
  const roleEvents = value(engine.getTimeline(sid)).flatMap((e) => (e.type === 'role_updated' ? [e.change] : []));
  assert.deepEqual(
    roleEvents.map((c) => [c.participantId, c.previousRole, c.role, c.source, c.revision]),
    [[alex.id, undefined, 'left defense', 'manual', 1], [alex.id, 'left defense', 'striker', 'manual', 2]],
  );
});

test('observation events use source time so late frames are ordered correctly', () => {
  const { engine, clock, sid } = activeSession();
  clock.set(30);
  value(engine.confirmActivity(sid, 'gaming'));
  const late = screen(engine, sid, 25);
  const tail = value(engine.getTimeline(sid)).slice(-2);
  assert.deepEqual(tail.map((e) => e.type), ['observation', 'activity_confirmed']);
  assert.ok(tail[0]?.type === 'observation' && tail[0].observationId === late.id);
});

test('merges and suppressions do not spam the timeline', () => {
  const { engine, clock, sid } = activeSession();
  for (let t = 20; t < 25; t++) {
    clock.set(t);
    value(propose(engine, sid)(candidate([screen(engine, sid, t).id])));
  }
  assert.equal(value(engine.getTimeline(sid)).filter((e) => e.type === 'recommendation_created').length, 1);
});

test('timeline is bounded; session_ended is always kept and truncation is flagged', () => {
  const { engine, clock, sid } = activeSession({ maxTimelineEvents: 4 });
  clock.set(1);
  for (let i = 0; i < 5; i++) screen(engine, sid, 1);
  value(engine.end(sid));
  const events = value(engine.getTimeline(sid));
  assert.equal(events.length, 5);
  assert.equal(events.at(-1)?.type, 'session_ended');
  assert.equal(value(engine.getSession(sid)).timelineTruncated, true);
});

test('timeline returns copies and does not include raw transcript text', () => {
  const { engine, clock, sid } = activeSession();
  clock.set(1);
  value(engine.ingestConversation(sid, { captureGeneration: gen(engine, sid),  observedAt: at(1), text: 'my secret phone number is 555', speakerRef: 'spk-alex' }));
  const events = value(engine.getTimeline(sid));
  events[0]!.summary = 'tampered';
  assert.notEqual(value(engine.getTimeline(sid))[0]?.summary, 'tampered');
  assert.ok(!JSON.stringify(events).includes('555'));
  const obs = events.find((e) => e.type === 'observation');
  assert.equal(obs?.summary, 'Speech observed (Alex)');
});
