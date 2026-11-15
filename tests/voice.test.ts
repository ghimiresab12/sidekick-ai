import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OverlayState } from '../src/contracts/types.js';
import { activeSession, candidate, error, say, screen, value, propose } from './helpers.js';

function withCard(options = {}) {
  const ctx = activeSession(options);
  const { engine, clock, sid, alex } = ctx;
  value(engine.assignRole(sid, alex.id, 'left defense', { source: 'manual' }));
  const goal = value(engine.setGoal(sid, 'Keep the left covered', { source: 'manual' }));
  clock.set(20);
  const u = say(engine, sid, 2);
  const obs = screen(engine, sid, 19);
  const r = value(propose(engine, sid)(candidate([obs.id], {
    contextObservationIds: [u.id], relatedParticipantIds: [alex.id], relatedGoalId: goal.id,
  })));
  if (r.outcome !== 'created') assert.fail('expected created');
  return { ...ctx, recId: r.recommendation.id, obs, u, goal };
}

test('explanation context is grounded in the selected card and separates condition from context', () => {
  const { engine, sid, recId, obs, u, alex, goal } = withCard();
  const c = value(engine.getExplanationContext(sid, recId));
  assert.equal(c.recommendation.id, recId);
  assert.deepEqual(c.conditionEvidence.map((o) => o.id), [obs.id]);
  assert.deepEqual(c.contextEvidence.map((o) => o.id), [u.id]);
  assert.deepEqual(c.contextAtCreation.participants.map((p) => [p.participantId, p.role]), [[alex.id, 'left defense']]);
  assert.equal(c.contextAtCreation.goal?.goalId, goal.id);
  assert.deepEqual(c.changesSinceCreation, []);
  assert.equal(c.isStale, false);
  assert.equal(c.conditionAgeMs, 1000);
  assert.equal(error(engine.getExplanationContext(sid, 'missing')), 'recommendation_not_found');
});

test('[F4] explanation reports later corrections separately instead of reinterpreting the card', () => {
  const { engine, clock, sid, recId, alex, goal } = withCard();
  clock.set(21);
  value(engine.assignRole(sid, alex.id, 'striker', { source: 'manual' }));
  clock.set(22);
  value(engine.retireGoal(sid, goal.id, { source: 'manual' }));
  const c = value(engine.getExplanationContext(sid, recId));
  assert.equal(c.contextAtCreation.participants[0]?.role, 'left defense', 'original context preserved');
  assert.equal(c.isStale, true);
  assert.equal(c.staleReason, 'role_changed');
  assert.deepEqual(c.changesSinceCreation.map((x) => x.kind), ['role_changed', 'goal_retired']);
  const role = c.changesSinceCreation[0];
  assert.ok(role?.kind === 'role_changed' && role.change.previousRole === 'left defense' && role.change.role === 'striker');
});

test('[F5] each attempt gets a unique request ID; callbacks must quote the live one', () => {
  const { engine, clock, sid, recId } = withCard();
  const first = value(engine.requestExplanation(sid, recId)).request;
  assert.equal(first.status, 'pending');
  assert.equal(error(engine.requestExplanation(sid, recId)), 'voice_busy');
  value(engine.reportVoiceStatus(sid, first.id, 'playing_locally'));
  assert.equal(error(engine.reportVoiceStatus(sid, first.id, 'playing_locally')), 'invalid_transition');
  clock.set(25);
  value(engine.reportVoiceStatus(sid, first.id, 'finished'));

  const second = value(engine.requestExplanation(sid, recId)).request;
  assert.notEqual(second.id, first.id);
  // A stale callback from the first attempt must not touch the second:
  assert.equal(error(engine.reportVoiceStatus(sid, first.id, 'finished')), 'invalid_transition');
  assert.equal(error(engine.reportVoiceStatus(sid, first.id, 'playing_locally')), 'invalid_transition');
  assert.equal(error(engine.reportVoiceStatus(sid, 'made-up', 'finished')), 'voice_request_not_found');
  assert.equal(value(engine.getOverlayState(sid)).activeVoiceRequest?.requestId, second.id);

  const events = value(engine.getTimeline(sid));
  const requested = events.flatMap((e) => (e.type === 'voice_requested' ? [e.voiceRequestId] : []));
  assert.deepEqual(requested, [first.id, second.id]);
  const finished = events.flatMap((e) => (e.type === 'voice_finished' ? [[e.voiceRequestId, e.outcome]] : []));
  assert.deepEqual(finished, [[first.id, 'finished']]);
});

test('[F5] request IDs from another session are not found', () => {
  const { engine, sid, recId } = withCard();
  const req = value(engine.requestExplanation(sid, recId)).request;
  const other = value(engine.createSession()).id;
  value(engine.startWithConsent(other));
  assert.equal(error(engine.reportVoiceStatus(other, req.id, 'finished')), 'voice_request_not_found');
  assert.equal(error(engine.cancelExplanation(other, req.id, 'user')), 'voice_request_not_found');
});

test('[F5] pause cancels in-flight playback; callbacks after pause are rejected', () => {
  const { engine, sid, recId } = withCard();
  const states: OverlayState[] = [];
  value(engine.subscribe(sid, (s) => states.push(s)));
  const req = value(engine.requestExplanation(sid, recId)).request;
  value(engine.reportVoiceStatus(sid, req.id, 'playing_locally'));
  value(engine.pause(sid));
  const r = value(engine.getSession(sid)).voiceRequests[0]!;
  assert.deepEqual([r.status, r.cancelReason], ['cancelled', 'session_paused']);
  assert.equal(states.at(-1)?.activeVoiceRequest, undefined, 'overlay tells the UI to stop speaking');
  assert.equal(error(engine.reportVoiceStatus(sid, req.id, 'finished')), 'invalid_transition');
  assert.equal(error(engine.requestExplanation(sid, recId)), 'session_not_active');
});

test('[F5] playback cannot start after the session ends', () => {
  const { engine, sid, recId } = withCard();
  const req = value(engine.requestExplanation(sid, recId)).request;
  value(engine.end(sid));
  assert.equal(error(engine.reportVoiceStatus(sid, req.id, 'playing_locally')), 'invalid_transition');
  const r = value(engine.getSession(sid)).voiceRequests[0]!;
  assert.deepEqual([r.status, r.cancelReason], ['cancelled', 'session_ended']);
  assert.equal(error(engine.requestExplanation(sid, recId)), 'session_not_active');
});

test('[F5] discard abandons requests; later callbacks get session_not_found', () => {
  const { engine, sid, recId } = withCard();
  const req = value(engine.requestExplanation(sid, recId)).request;
  value(engine.discard(sid));
  assert.equal(error(engine.reportVoiceStatus(sid, req.id, 'playing_locally')), 'session_not_found');
  assert.equal(error(engine.cancelExplanation(sid, req.id, 'user')), 'session_not_found');
});

test('[F5] client cancel (Stop / disconnect) and timeout free the voice slot', () => {
  const { engine, clock, sid, recId } = withCard({ voiceRequestTimeoutMs: 10_000 });
  const a = value(engine.requestExplanation(sid, recId)).request;
  assert.equal(value(engine.cancelExplanation(sid, a.id, 'client_disconnected')).cancelReason, 'client_disconnected');
  assert.equal(error(engine.cancelExplanation(sid, a.id, 'user')), 'invalid_transition');
  assert.equal(error(engine.cancelExplanation(sid, a.id, 'timeout' as never)), 'invalid_input', 'engine-only reasons are rejected');

  const b = value(engine.requestExplanation(sid, recId)).request;
  clock.set(31); // no callback for > 10s; the card is stale by now too
  engine.sweepAll();
  const timedOut = value(engine.getSession(sid)).voiceRequests.find((r) => r.id === b.id)!;
  assert.deepEqual([timedOut.status, timedOut.cancelReason], ['cancelled', 'timeout']);
  assert.equal(error(engine.reportVoiceStatus(sid, b.id, 'finished')), 'invalid_transition');
  assert.ok(value(engine.requestExplanation(sid, recId)).request.id);
});

test('failed playback is recorded as a text fallback', () => {
  const { engine, sid, recId } = withCard();
  const req = value(engine.requestExplanation(sid, recId)).request;
  assert.equal(value(engine.reportVoiceStatus(sid, req.id, 'failed')).status, 'failed');
  const last = value(engine.getTimeline(sid)).at(-1)!;
  assert.ok(last.type === 'voice_finished' && last.outcome === 'failed');
});

test('cannot explain dismissed cards; requester must be a participant', () => {
  const { engine, sid, recId } = withCard();
  assert.equal(error(engine.requestExplanation(sid, recId, { requesterParticipantId: 'ghost' })), 'participant_not_found');
  value(engine.dismiss(sid, recId));
  assert.equal(error(engine.requestExplanation(sid, recId)), 'invalid_transition');
});

test('requester is recorded on the request and the event', () => {
  const { engine, sid, recId, alex } = withCard();
  const { request } = value(engine.requestExplanation(sid, recId, { requesterParticipantId: alex.id }));
  assert.equal(request.requesterParticipantId, alex.id);
  const ev = value(engine.getTimeline(sid)).find((e) => e.type === 'voice_requested');
  assert.ok(ev?.type === 'voice_requested' && ev.requesterParticipantId === alex.id);
});
