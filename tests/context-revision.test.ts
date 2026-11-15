import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeSession, candidate, error, say, screen, value } from './helpers.js';

/** Builds a candidate the way the reasoning layer would: read revision, evaluate, send later. */
function setupWithRole() {
  const ctx = activeSession();
  const { engine, clock, sid, alex } = ctx;
  value(engine.assignRole(sid, alex.id, 'left defense', { source: 'manual' }));
  const goal = value(engine.setGoal(sid, 'Keep the left covered', { source: 'manual' }));
  clock.set(20);
  const frame = screen(engine, sid, 20);
  const revision = value(engine.getSession(sid)).contextRevision;
  const delayed = candidate([frame.id], {
    relatedParticipantIds: [alex.id], relatedGoalId: goal.id, basedOnContextRevision: revision,
  });
  return { ...ctx, goal, frame, revision, delayed };
}

test('[R2-2] candidate built before a role assignment is rejected as stale_context', () => {
  const { engine, clock, sid, alex, delayed } = setupWithRole();
  clock.set(21);
  value(engine.assignRole(sid, alex.id, 'striker', { source: 'manual' }));
  assert.equal(error(engine.proposeRecommendation(sid, delayed)), 'stale_context');
  assert.equal(value(engine.getSession(sid)).recommendations.length, 0);
});

test('[R2-2] candidate built before a role clear is rejected as stale_context', () => {
  const { engine, clock, sid, alex, delayed } = setupWithRole();
  clock.set(21);
  value(engine.clearRole(sid, alex.id, { source: 'participant_report' }));
  assert.equal(error(engine.proposeRecommendation(sid, delayed)), 'stale_context');
});

test('[R2-2] candidate built before a goal retirement is rejected as stale_context', () => {
  const { engine, clock, sid, goal, delayed } = setupWithRole();
  clock.set(21);
  value(engine.retireGoal(sid, goal.id, { source: 'manual' }));
  assert.equal(error(engine.proposeRecommendation(sid, delayed)), 'stale_context');
});

test('[R2-2] a role change about an unrelated participant also supersedes the candidate', () => {
  const { engine, clock, sid, delayed } = setupWithRole();
  const sam = value(engine.addParticipant(sid, { displayName: 'Sam' }));
  clock.set(21);
  value(engine.assignRole(sid, sam.id, 'left defense', { source: 'manual' })); // "who covers left" changed
  assert.equal(error(engine.proposeRecommendation(sid, delayed)), 'stale_context');
});

test('[R2-2] an old candidate cannot recreate advice invalidated by a newer correction', () => {
  const { engine, clock, sid, alex, delayed } = setupWithRole();
  const first = value(engine.proposeRecommendation(sid, delayed));
  assert.equal(first.outcome, 'created');
  clock.set(21);
  value(engine.assignRole(sid, alex.id, 'striker', { source: 'manual' })); // invalidates the card
  clock.set(22);
  const freshFrame = screen(engine, sid, 22);
  // A second result from the same (old) evaluation round arrives late, with a fresh frame:
  assert.equal(error(engine.proposeRecommendation(sid, { ...delayed, conditionObservationIds: [freshFrame.id] })), 'stale_context');
  const recs = value(engine.getSession(sid)).recommendations;
  assert.equal(recs.length, 1);
  assert.equal(recs[0]?.status, 'stale');
  assert.equal(recs[0]?.staleReason, 'role_changed');
});

test('[R2-2] a stale-context candidate cannot merge into (refresh) an active card', () => {
  const { engine, clock, sid, frame } = setupWithRole();
  const sam = value(engine.addParticipant(sid, { displayName: 'Sam' }));
  const rev = value(engine.getSession(sid)).contextRevision;
  const card = value(engine.proposeRecommendation(sid, candidate([frame.id], { fingerprint: 'other', basedOnContextRevision: rev })));
  assert.equal(card.outcome, 'created');
  clock.set(21);
  value(engine.assignRole(sid, sam.id, 'midfield', { source: 'manual' })); // unrelated to the card
  clock.set(25);
  const newer = screen(engine, sid, 25);
  assert.equal(
    error(engine.proposeRecommendation(sid, candidate([newer.id], { fingerprint: 'other', basedOnContextRevision: rev }))),
    'stale_context',
  );
  const rec = value(engine.getSession(sid)).recommendations[0]!;
  assert.equal(rec.status, 'active', 'unrelated card stays active');
  assert.equal(rec.lastConditionAt, frame.observedAt, 'and was not refreshed by the stale candidate');
});

test('[R2-2] re-evaluated candidate at the current revision is accepted with its context preserved', () => {
  const { engine, clock, sid, alex, delayed } = setupWithRole();
  clock.set(21);
  value(engine.assignRole(sid, alex.id, 'striker', { source: 'manual' }));
  const sam = value(engine.addParticipant(sid, { displayName: 'Sam' }));
  value(engine.assignRole(sid, sam.id, 'left defense', { source: 'manual' }));
  const rev = value(engine.getSession(sid)).contextRevision;
  const r = value(engine.proposeRecommendation(sid, {
    ...delayed, relatedParticipantIds: [sam.id], shortAdvice: 'Have Sam drop back.', basedOnContextRevision: rev,
  }));
  assert.equal(r.outcome, 'created');
  if (r.outcome !== 'created') return;
  assert.equal(r.recommendation.contextAtCreation.contextRevision, rev);
  assert.deepEqual(r.recommendation.contextAtCreation.participants.map((p) => [p.displayName, p.role]), [['Sam', 'left defense']]);
  assert.deepEqual(r.recommendation.conditionObservationIds, delayed.conditionObservationIds);
});

test('[R2-2] no-op context updates do not supersede candidates', () => {
  const { engine, clock, sid, alex, delayed } = setupWithRole();
  clock.set(21);
  assert.equal(value(engine.assignRole(sid, alex.id, 'left defense', { source: 'manual' })).outcome, 'unchanged');
  const old = say(engine, sid, 1, 'Alex right'); // older than the manual role → ignored
  assert.equal(
    value(engine.assignRole(sid, alex.id, 'right defense', { source: 'transcript', sourceObservationId: old.id })).outcome,
    'ignored_superseded',
  );
  assert.equal(value(engine.proposeRecommendation(sid, delayed)).outcome, 'created');
});

test('[R2-2] basedOnContextRevision is required and cannot be from the future', () => {
  const { engine, sid, frame, revision } = setupWithRole();
  const { basedOnContextRevision: _omit, ...missing } = candidate([frame.id], { basedOnContextRevision: 0 });
  assert.equal(error(engine.proposeRecommendation(sid, missing as never)), 'invalid_input');
  assert.equal(error(engine.proposeRecommendation(sid, candidate([frame.id], { basedOnContextRevision: -1 }) as never)), 'invalid_input');
  assert.equal(error(engine.proposeRecommendation(sid, candidate([frame.id], { basedOnContextRevision: 1.5 }) as never)), 'invalid_input');
  assert.equal(error(engine.proposeRecommendation(sid, candidate([frame.id], { basedOnContextRevision: revision + 1 }) as never)), 'invalid_input');
});
