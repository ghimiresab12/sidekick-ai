import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideProposal } from '../src/recommendations/recommendation-rules.js';
import type { ProposeOutcome, Recommendation, Result } from '../src/contracts/types.js';
import { activeSession, at, candidate, error, say, screen, value, gen, propose } from './helpers.js';

function created(result: Result<ProposeOutcome>): Recommendation {
  const v = value(result);
  assert.equal(v.outcome, 'created');
  if (v.outcome !== 'created') throw new Error('unreachable');
  return v.recommendation;
}

test('creates an active card with condition/context evidence and a context snapshot', () => {
  const { engine, clock, sid, alex } = activeSession();
  value(engine.assignRole(sid, alex.id, 'left defense', { source: 'manual' }));
  clock.set(20);
  const u = say(engine, sid, 2);
  const obs = screen(engine, sid, 19);
  const rec = created(propose(engine, sid)(candidate([obs.id], {
    contextObservationIds: [u.id], relatedParticipantIds: [alex.id],
  })));
  assert.equal(rec.status, 'active');
  assert.deepEqual(rec.conditionObservationIds, [obs.id]);
  assert.deepEqual(rec.contextObservationIds, [u.id]);
  assert.equal(rec.lastConditionAt, at(19));
  assert.equal(rec.createdAt, at(20));
  assert.deepEqual(rec.contextAtCreation.participants, [
    { participantId: alex.id, displayName: 'Alex', role: 'left defense', roleRevision: 1 },
  ]);
  assert.equal(rec.contextAtCreation.contextRevision, 1);
});

test('camera observations cannot be condition evidence for screen-share soccer coaching', () => {
  const { engine, clock, sid } = activeSession();
  clock.set(20);
  const observation = value(engine.ingestScreen(sid, {
    mediaSource: 'camera', captureGeneration: gen(engine, sid), observedAt: at(19), summary: 'clear-looking camera image',
    evidenceQuality: 'clear', facts: { leftZoneVisible: true, leftZoneUncovered: true },
  }));
  const result = propose(engine, sid)(candidate([observation.id]));
  assert.equal(error(result), 'insufficient_evidence');
});

test('duplicate fingerprint while active merges instead of creating a second card', () => {
  const { engine, clock, sid } = activeSession();
  clock.set(20);
  const first = created(propose(engine, sid)(candidate([screen(engine, sid, 19).id])));
  clock.set(24);
  const merged = value(propose(engine, sid)(candidate([screen(engine, sid, 23).id])));
  assert.equal(merged.outcome, 'merged');
  if (merged.outcome !== 'merged') return;
  assert.equal(merged.recommendation.id, first.id);
  assert.equal(merged.refreshed, true);
  assert.equal(merged.recommendation.lastConditionAt, at(23));
  assert.equal(merged.recommendation.conditionObservationIds.length, 2);
  assert.equal(value(engine.getSession(sid)).recommendations.length, 1);
  assert.equal(value(engine.getTimeline(sid)).filter((e) => e.type === 'recommendation_created').length, 1);
});

test('late (older) condition evidence merges without refreshing lastConditionAt', () => {
  const { engine, clock, sid } = activeSession();
  clock.set(20);
  const rec = created(propose(engine, sid)(candidate([screen(engine, sid, 19).id])));
  const late = screen(engine, sid, 14);
  const merged = value(propose(engine, sid)(candidate([late.id])));
  assert.ok(merged.outcome === 'merged' && merged.refreshed === false);
  if (merged.outcome !== 'merged') return;
  assert.equal(merged.recommendation.lastConditionAt, at(19), 'freshness never moves backwards');
  assert.equal(merged.recommendation.id, rec.id);
});

test('late condition evidence cannot keep a card alive past the stale window', () => {
  const { engine, clock, sid } = activeSession({ staleAfterMs: 15_000 });
  clock.set(20);
  created(propose(engine, sid)(candidate([screen(engine, sid, 19).id])));
  clock.set(30);
  const merged = value(propose(engine, sid)(candidate([screen(engine, sid, 16).id])));
  assert.equal(merged.outcome === 'merged' && merged.refreshed, false);
  clock.set(35);
  assert.equal(value(engine.sweepStale(sid)).length, 1);
  assert.equal(value(engine.getSession(sid)).recommendations[0]?.staleReason, 'no_recent_condition_evidence');
});

test('[F2] fresh conversation context does not make old visual evidence current (create)', () => {
  const { engine, clock, sid } = activeSession({ staleAfterMs: 15_000 });
  clock.set(30);
  const oldGap = screen(engine, sid, 10);
  const freshTalk = say(engine, sid, 29, 'Alex is on left defense');
  assert.equal(
    error(propose(engine, sid)(candidate([oldGap.id], { contextObservationIds: [freshTalk.id] }))),
    'stale_evidence',
  );
});

test('[F2] fresh context merged into a card never refreshes it or delays staleness', () => {
  const { engine, clock, sid } = activeSession({ staleAfterMs: 15_000 });
  clock.set(20);
  const gap = screen(engine, sid, 20);
  created(propose(engine, sid)(candidate([gap.id])));
  clock.set(30);
  const talk = say(engine, sid, 30);
  const merged = value(propose(engine, sid)(candidate([gap.id], { contextObservationIds: [talk.id] })));
  assert.ok(merged.outcome === 'merged');
  if (merged.outcome !== 'merged') return;
  assert.equal(merged.refreshed, false);
  assert.equal(merged.recommendation.lastConditionAt, at(20));
  assert.ok(merged.recommendation.contextObservationIds.includes(talk.id));
  clock.set(36);
  value(engine.sweepStale(sid));
  assert.equal(value(engine.getSession(sid)).recommendations[0]?.status, 'stale');
});

test('[F2] condition evidence of unknown quality is rejected; overlap is rejected', () => {
  const { engine, clock, sid } = activeSession();
  clock.set(1);
  const blurry = value(engine.ingestScreen(sid, { mediaSource: 'screen_share', captureGeneration: gen(engine, sid),  observedAt: at(1), summary: 'unclear', evidenceQuality: 'unknown' }));
  assert.equal(error(propose(engine, sid)(candidate([blurry.id]))), 'insufficient_evidence');
  const ok = screen(engine, sid, 1);
  assert.equal(error(propose(engine, sid)(candidate([ok.id], { contextObservationIds: [ok.id] }))), 'invalid_input');
});

test('[F3] after pause/resume, identical pre-pause condition evidence cannot recreate the card', () => {
  const { engine, clock, sid } = activeSession({ staleAfterMs: 15_000 });
  clock.set(20);
  const gap = screen(engine, sid, 20);
  created(propose(engine, sid)(candidate([gap.id])));
  clock.set(21);
  value(engine.pause(sid));
  clock.set(23);
  value(engine.resume(sid));
  assert.equal(error(propose(engine, sid)(candidate([gap.id]))), 'stale_evidence');
  assert.equal(value(engine.getSession(sid)).recommendations.length, 1);
  // Fresh post-resume evidence creates a new, current card:
  clock.set(24);
  const fresh = created(propose(engine, sid)(candidate([screen(engine, sid, 24).id])));
  assert.equal(fresh.status, 'active');
  assert.equal(value(engine.getSession(sid)).recommendations.length, 2);
});

test('evidence older than the stale window cannot create a card', () => {
  const { engine, clock, sid } = activeSession({ staleAfterMs: 15_000 });
  clock.set(30);
  assert.equal(error(propose(engine, sid)(candidate([screen(engine, sid, 10).id]))), 'stale_evidence');
});

test('cooldown suppresses an equivalent card after dismissal, then allows it', () => {
  const { engine, clock, sid } = activeSession({ cooldownMs: 30_000 });
  clock.set(20);
  const rec = created(propose(engine, sid)(candidate([screen(engine, sid, 20).id])));
  value(engine.dismiss(sid, rec.id));
  clock.set(40);
  assert.deepEqual(value(propose(engine, sid)(candidate([screen(engine, sid, 40).id]))), {
    outcome: 'suppressed', reason: 'cooldown', recommendationId: rec.id,
  });
  clock.set(51);
  created(propose(engine, sid)(candidate([screen(engine, sid, 51).id])));
});

test('cooldown also applies after resolution; different fingerprints are independent', () => {
  const { engine, clock, sid } = activeSession();
  clock.set(20);
  const rec = created(propose(engine, sid)(candidate([screen(engine, sid, 20).id])));
  clock.set(25);
  value(engine.resolve(sid, rec.id, screen(engine, sid, 25, true).id));
  clock.set(30);
  const obs = screen(engine, sid, 30);
  assert.equal(value(propose(engine, sid)(candidate([obs.id]))).outcome, 'suppressed');
  assert.equal(value(propose(engine, sid)(candidate([obs.id], { fingerprint: 'right_defense_uncovered' }))).outcome, 'created');
});

test('a naturally stale card does not block a fresh card for the same issue', () => {
  const { engine, clock, sid } = activeSession({ staleAfterMs: 15_000 });
  clock.set(20);
  const first = created(propose(engine, sid)(candidate([screen(engine, sid, 20).id])));
  clock.set(40);
  value(engine.sweepStale(sid));
  assert.notEqual(created(propose(engine, sid)(candidate([screen(engine, sid, 40).id]))).id, first.id);
});

test('ingest sweeps stale cards automatically; sweepAll covers sessions with no input', () => {
  const { engine, clock, sid } = activeSession({ staleAfterMs: 15_000 });
  clock.set(20);
  created(propose(engine, sid)(candidate([screen(engine, sid, 20).id])));
  clock.set(36);
  say(engine, sid, 36);
  assert.equal(value(engine.getSession(sid)).recommendations[0]?.status, 'stale');

  const other = activeSession({ staleAfterMs: 15_000 });
  other.clock.set(20);
  created(propose(other.engine, other.sid)(candidate([screen(other.engine, other.sid, 20).id])));
  other.clock.set(50);
  other.engine.sweepAll();
  assert.equal(value(other.engine.getSession(other.sid)).recommendations[0]?.status, 'stale');
});

test('resolve requires a strictly newer observation', () => {
  const { engine, clock, sid } = activeSession();
  clock.set(20);
  const evidence = screen(engine, sid, 20);
  const rec = created(propose(engine, sid)(candidate([evidence.id])));
  assert.equal(error(engine.resolve(sid, rec.id, screen(engine, sid, 18, true).id)), 'resolution_needs_newer_evidence');
  assert.equal(error(engine.resolve(sid, rec.id, evidence.id)), 'resolution_needs_newer_evidence');
  assert.equal(error(engine.resolve(sid, rec.id, 'missing')), 'evidence_not_found');
  clock.set(25);
  const newer = screen(engine, sid, 25, true);
  const resolved = value(engine.resolve(sid, rec.id, newer.id));
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.resolvedByObservationId, newer.id);
  assert.equal(error(engine.resolve(sid, rec.id, newer.id)), 'invalid_transition');
  assert.equal(error(engine.dismiss(sid, rec.id)), 'invalid_transition');
});

test('validates candidates: condition evidence required and must belong to the session', () => {
  const { engine, clock, sid } = activeSession();
  clock.set(1);
  const obs = screen(engine, sid, 1);
  assert.equal(error(propose(engine, sid)(candidate([]))), 'invalid_input');
  assert.equal(error(propose(engine, sid)(candidate(['missing']))), 'evidence_not_found');
  assert.equal(error(propose(engine, sid)(candidate([obs.id], { contextObservationIds: ['missing'] }))), 'evidence_not_found');
  assert.equal(error(propose(engine, sid)(candidate([obs.id], { title: 'x'.repeat(81) }))), 'invalid_input');
  assert.equal(error(propose(engine, sid)(candidate([obs.id], { fingerprint: 'has spaces' }))), 'invalid_input');
  assert.equal(error(propose(engine, sid)(candidate([obs.id], { urgency: 'critical' }))), 'invalid_input');
  assert.equal(error(propose(engine, sid)(candidate([obs.id], { relatedParticipantIds: ['ghost'] }))), 'participant_not_found');
  assert.equal(error(propose(engine, sid)(candidate([obs.id], { relatedGoalId: 'ghost' }))), 'goal_not_found');
});

test('no recommendations while paused or ended', () => {
  const { engine, clock, sid } = activeSession();
  clock.set(1);
  const obs = screen(engine, sid, 1);
  value(engine.pause(sid));
  assert.equal(error(propose(engine, sid)(candidate([obs.id]))), 'session_not_active');
  value(engine.end(sid));
  assert.equal(error(propose(engine, sid)(candidate([obs.id]))), 'session_not_active');
});

test('decideProposal picks the most recent closed card for cooldown', () => {
  const rec = (id: string, status: Recommendation['status'], changedAt: string): Recommendation => ({
    id, sessionId: 's', fingerprint: 'f', title: 't', shortAdvice: 'a', conditionObservationIds: ['o'],
    contextObservationIds: [], relatedParticipantIds: [], urgency: 'normal', status, createdAt: changedAt,
    updatedAt: changedAt, statusChangedAt: changedAt, lastConditionAt: changedAt,
    contextAtCreation: { contextRevision: 0, capturedAt: changedAt, participants: [] },
  });
  const recs = [rec('old', 'dismissed', at(0)), rec('new', 'resolved', at(50))];
  const d = decideProposal(recs, 'f', Date.parse(at(60)), 30_000);
  assert.equal(d.kind === 'suppress' && d.existing.id, 'new');
  assert.equal(decideProposal(recs, 'f', Date.parse(at(81)), 30_000).kind, 'create');
  assert.equal(decideProposal(recs, 'other', Date.parse(at(60)), 30_000).kind, 'create');
});
