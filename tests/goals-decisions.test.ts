import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeSession, candidate, error, say, screen, value, propose } from './helpers.js';

test('[F6] goals carry IDs, provenance and revisions in structured events', () => {
  const { engine, clock, sid } = activeSession();
  clock.set(5);
  const u = say(engine, sid, 3, 'Our goal is to keep the left covered');
  const goal = value(engine.setGoal(sid, 'Keep the left covered', { source: 'transcript', sourceObservationId: u.id }));
  assert.equal(goal.statedAt, u.observedAt);
  assert.equal(goal.revision, 1);
  clock.set(9);
  const { goal: retired } = value(engine.retireGoal(sid, goal.id, { source: 'manual' }));
  assert.equal(retired.active, false);
  assert.equal(retired.retiredRevision, 2);

  const events = value(engine.getTimeline(sid));
  const set = events.find((e) => e.type === 'goal_set');
  assert.ok(set?.type === 'goal_set');
  assert.deepEqual(
    { goalId: set.goalId, text: set.text, source: set.source, sourceObservationId: set.sourceObservationId, time: set.time },
    { goalId: goal.id, text: 'Keep the left covered', source: 'transcript', sourceObservationId: u.id, time: u.observedAt },
  );
  const ret = events.find((e) => e.type === 'goal_retired');
  assert.ok(ret?.type === 'goal_retired' && ret.goalId === goal.id && ret.source === 'manual');
});

test('[F4] retiring a goal marks cards tied to it stale', () => {
  const { engine, clock, sid } = activeSession();
  const goal = value(engine.setGoal(sid, 'Keep the left covered', { source: 'manual' }));
  clock.set(20);
  const r = value(propose(engine, sid)(candidate([screen(engine, sid, 20).id], { relatedGoalId: goal.id })));
  assert.equal(r.outcome, 'created');
  clock.set(21);
  const res = value(engine.retireGoal(sid, goal.id, { source: 'manual' }));
  assert.equal(res.invalidatedRecommendationIds.length, 1);
  const card = value(engine.getSession(sid)).recommendations[0]!;
  assert.equal(card.staleReason, 'goal_changed');
  assert.equal(card.contextAtCreation.goal?.text, 'Keep the left covered');
  clock.set(22);
  assert.equal(
    error(propose(engine, sid)(candidate([screen(engine, sid, 22).id], { relatedGoalId: goal.id }))),
    'invalid_input',
    'new advice cannot cite a retired goal',
  );
});

test('goal retirement cannot predate the goal; missing goals are reported', () => {
  const { engine, clock, sid } = activeSession();
  clock.set(10);
  const early = say(engine, sid, 2, 'forget the left');
  const goal = value(engine.setGoal(sid, 'Keep the left covered', { source: 'manual' }));
  assert.equal(error(engine.retireGoal(sid, goal.id, { source: 'transcript', sourceObservationId: early.id })), 'invalid_transition');
  assert.equal(error(engine.retireGoal(sid, 'missing', { source: 'manual' })), 'goal_not_found');
  assert.equal(error(engine.retireGoal(sid, goal.id, undefined as never)), 'invalid_input');
});

test('[F6] explicit decisions are structured events with timestamped evidence', () => {
  const { engine, clock, sid, alex } = activeSession();
  const goal = value(engine.setGoal(sid, 'Keep the left covered', { source: 'manual' }));
  clock.set(10);
  const a = say(engine, sid, 6, 'If Alex pushes up');
  const b = say(engine, sid, 8, 'then Sam covers left');
  clock.set(12);
  const d = value(engine.recordDecision(sid, {
    text: 'Sam covers left when Alex pushes up',
    source: 'transcript',
    sourceObservationIds: [a.id, b.id],
    participantIds: [alex.id],
    relatedGoalId: goal.id,
  }));
  assert.equal(d.decidedAt, b.observedAt, 'decision time = newest supporting utterance');
  assert.equal(d.recordedAt, new Date(Date.parse(b.observedAt) + 4000).toISOString());
  const ev = value(engine.getTimeline(sid)).find((e) => e.type === 'decision_recorded');
  assert.ok(ev?.type === 'decision_recorded');
  assert.deepEqual(ev.decision, d);
  assert.equal(ev.time, d.decidedAt);
  assert.deepEqual(value(engine.getSession(sid)).decisions, [d]);
});

test('[F6] decisions are never inferred: provenance is required and validated', () => {
  const { engine, clock, sid } = activeSession();
  clock.set(1);
  const frame = screen(engine, sid, 1);
  assert.equal(error(engine.recordDecision(sid, { text: 'x', source: 'transcript' })), 'invalid_input');
  assert.equal(error(engine.recordDecision(sid, { text: 'x', source: 'transcript', sourceObservationIds: [frame.id] })), 'invalid_input');
  assert.equal(error(engine.recordDecision(sid, { text: 'x', source: 'manual', sourceObservationIds: ['missing'] })), 'evidence_not_found');
  assert.equal(error(engine.recordDecision(sid, { text: 'x', source: 'manual', participantIds: ['ghost'] })), 'participant_not_found');
  assert.equal(error(engine.recordDecision(sid, { text: 'x', source: 'manual', relatedRecommendationId: 'ghost' })), 'recommendation_not_found');
  assert.equal(error(engine.recordDecision(sid, { text: '', source: 'manual' })), 'invalid_input');
  const manual = value(engine.recordDecision(sid, { text: 'Switch formation', source: 'manual' }));
  assert.deepEqual(manual.sourceObservationIds, []);
});
