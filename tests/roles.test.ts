import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeSession, at, candidate, error, gen, propose, say, screen, setup, value } from './helpers.js';

test('assigns a role with ordered, sourced provenance', () => {
  const { engine, clock, sid, alex } = activeSession();
  clock.set(4);
  const u = say(engine, sid, 2);
  const r = value(engine.assignRole(sid, alex.id, 'left defense', { source: 'transcript', sourceObservationId: u.id }));
  assert.equal(r.outcome, 'applied');
  assert.equal(r.participant.role, 'left defense');
  const change = r.participant.lastRoleChange!;
  assert.equal(change.kind, 'assigned');
  assert.equal(change.effectiveAt, u.observedAt, 'transcript changes take effect at utterance time');
  assert.equal(change.sourceObservationId, u.id);
  assert.equal(change.revision, 1);
});

test('a newer correction supersedes the old role and records previousRole', () => {
  const { engine, clock, sid, alex } = activeSession();
  value(engine.assignRole(sid, alex.id, 'left defense', { source: 'manual' }));
  clock.set(1);
  const r = value(engine.assignRole(sid, alex.id, 'right defense', { source: 'participant_report' }));
  assert.equal(r.participant.role, 'right defense');
  assert.equal(r.participant.lastRoleChange?.previousRole, 'left defense');
  const stored = value(engine.getSession(sid)).participants.find((x) => x.id === alex.id);
  assert.equal(stored?.role, 'right defense', 'single source of truth holds the latest role');
  assert.equal(value(engine.getTimeline(sid)).filter((e) => e.type === 'role_updated').length, 2);
});

test('[F1] delayed transcript assignment cannot overwrite a newer transcript assignment', () => {
  const { engine, clock, sid, alex } = activeSession();
  clock.set(20);
  const older = say(engine, sid, 10, 'Alex take left');
  const newer = say(engine, sid, 15, 'Actually Alex take right');
  value(engine.assignRole(sid, alex.id, 'right defense', { source: 'transcript', sourceObservationId: newer.id }));
  // Extraction of the older utterance finishes late:
  const r = value(engine.assignRole(sid, alex.id, 'left defense', { source: 'transcript', sourceObservationId: older.id }));
  assert.equal(r.outcome, 'ignored_superseded');
  assert.equal(r.participant.role, 'right defense');
});

test('[F1] verified manual correction beats a delayed transcript assignment', () => {
  const { engine, clock, sid, alex } = activeSession();
  clock.set(10);
  const u = say(engine, sid, 8, 'Alex take left');
  clock.set(12);
  value(engine.assignRole(sid, alex.id, 'goalkeeper', { source: 'manual' })); // effective t=12
  // Extraction of the t=8 utterance lands after the manual correction:
  assert.equal(
    value(engine.assignRole(sid, alex.id, 'left defense', { source: 'transcript', sourceObservationId: u.id })).outcome,
    'ignored_superseded',
  );
  // Even a transcript statement slightly newer (within maxClockSkewMs = 5s) cannot override it:
  clock.set(16);
  const near = say(engine, sid, 15, 'Alex left');
  assert.equal(
    value(engine.assignRole(sid, alex.id, 'left defense', { source: 'transcript', sourceObservationId: near.id })).outcome,
    'ignored_superseded',
  );
  // A clearly later statement (more than 5s after the correction) is new information and applies:
  clock.set(19);
  const later = say(engine, sid, 18, 'Alex move to left now');
  assert.equal(
    value(engine.assignRole(sid, alex.id, 'left defense', { source: 'transcript', sourceObservationId: later.id })).outcome,
    'applied',
  );
});

test('[F1] a verified correction overrides a transcript role even when source clock runs ahead', () => {
  const { engine, clock, sid, alex } = activeSession();
  clock.set(10);
  const ahead = say(engine, sid, 13, 'Alex left'); // source clock 3s ahead of engine
  value(engine.assignRole(sid, alex.id, 'left defense', { source: 'transcript', sourceObservationId: ahead.id }));
  const r = value(engine.assignRole(sid, alex.id, 'right defense', { source: 'manual' })); // effective t=10
  assert.equal(r.outcome, 'applied');
});

test('[F1] clearing a role keeps ordering so an older delayed assignment cannot restore it', () => {
  const { engine, clock, sid, alex } = activeSession();
  clock.set(10);
  const first = say(engine, sid, 2, 'Alex left');
  const u = say(engine, sid, 5, 'Alex left again');
  value(engine.assignRole(sid, alex.id, 'left defense', { source: 'transcript', sourceObservationId: first.id }));
  value(engine.clearRole(sid, alex.id, { source: 'participant_report' }));
  const p = value(engine.getSession(sid)).participants.find((x) => x.id === alex.id)!;
  assert.equal(p.role, undefined);
  assert.equal(p.lastRoleChange?.kind, 'cleared');
  const r = value(engine.assignRole(sid, alex.id, 'left defense', { source: 'transcript', sourceObservationId: u.id }));
  assert.equal(r.outcome, 'ignored_superseded');
  assert.equal(r.participant.role, undefined);
});

test('[F1] clearing an unset role still blocks an older delayed assignment', () => {
  const { engine, clock, sid, alex } = activeSession();
  clock.set(10);
  const u = say(engine, sid, 5, 'Alex left');
  assert.equal(value(engine.clearRole(sid, alex.id, { source: 'manual' })).outcome, 'unchanged');
  const r = value(engine.assignRole(sid, alex.id, 'left defense', { source: 'transcript', sourceObservationId: u.id }));
  assert.equal(r.outcome, 'ignored_superseded');
  assert.equal(value(engine.getTimeline(sid)).filter((e) => e.type === 'role_updated').length, 0);
});

test('[F1] restating the same role refreshes ordering so an older contradiction stays ignored', () => {
  const { engine, clock, sid, alex } = activeSession();
  clock.set(20);
  const first = say(engine, sid, 5, 'Alex left');
  const contradiction = say(engine, sid, 8, 'Alex right');
  const restated = say(engine, sid, 12, 'Alex left, confirmed');
  value(engine.assignRole(sid, alex.id, 'left defense', { source: 'transcript', sourceObservationId: first.id }));
  assert.equal(
    value(engine.assignRole(sid, alex.id, 'left defense', { source: 'transcript', sourceObservationId: restated.id })).outcome,
    'unchanged',
  );
  assert.equal(
    value(engine.assignRole(sid, alex.id, 'right defense', { source: 'transcript', sourceObservationId: contradiction.id })).outcome,
    'ignored_superseded',
  );
  assert.equal(value(engine.getTimeline(sid)).filter((e) => e.type === 'role_updated').length, 1);
});

test('moving a role to someone else: clear one, assign the other', () => {
  const { engine, sid, alex } = activeSession();
  const sam = value(engine.addParticipant(sid, { displayName: 'Sam' }));
  value(engine.assignRole(sid, alex.id, 'left defense', { source: 'manual' }));
  value(engine.clearRole(sid, alex.id, { source: 'participant_report' }));
  value(engine.assignRole(sid, sam.id, 'left defense', { source: 'participant_report' }));
  const participants = value(engine.getSession(sid)).participants;
  assert.equal(participants.find((p) => p.id === alex.id)?.role, undefined);
  assert.equal(participants.find((p) => p.id === sam.id)?.role, 'left defense');
});

test('[F4] a role correction marks dependent active cards stale and reports them', () => {
  const { engine, clock, sid, alex } = activeSession();
  value(engine.assignRole(sid, alex.id, 'left defense', { source: 'manual' }));
  clock.set(20);
  const r = value(propose(engine, sid)(candidate([screen(engine, sid, 20).id], { relatedParticipantIds: [alex.id] })));
  const unrelated = value(propose(engine, sid)(candidate([screen(engine, sid, 20).id], { fingerprint: 'other' })));
  assert.equal(r.outcome, 'created');
  clock.set(21);
  const res = value(engine.assignRole(sid, alex.id, 'striker', { source: 'manual' }));
  assert.ok(r.outcome === 'created' && res.invalidatedRecommendationIds.includes(r.recommendation.id));
  const recs = value(engine.getSession(sid)).recommendations;
  const card = recs.find((x) => r.outcome === 'created' && x.id === r.recommendation.id)!;
  assert.equal(card.status, 'stale');
  assert.equal(card.staleReason, 'role_changed');
  assert.equal(card.contextAtCreation.participants[0]?.role, 'left defense', 'creation context is never rewritten');
  assert.equal(recs.find((x) => unrelated.outcome === 'created' && x.id === unrelated.recommendation.id)?.status, 'active');
  const staleEvent = value(engine.getTimeline(sid)).find((e) => e.type === 'recommendation_stale');
  assert.ok(staleEvent?.type === 'recommendation_stale' && staleEvent.reason === 'role_changed' && staleEvent.participantId === alex.id);
});

test('roles can be set during setup before consent', () => {
  const { engine } = setup();
  const sid = value(engine.createSession()).id;
  const p = value(engine.addParticipant(sid, { displayName: 'Alex' }));
  assert.equal(value(engine.assignRole(sid, p.id, 'goalkeeper', { source: 'manual' })).participant.role, 'goalkeeper');
});

test('rejects unknown participants, empty roles, bad sources and invalid provenance', () => {
  const { engine, clock, sid, alex } = activeSession();
  clock.set(1);
  const frame = screen(engine, sid, 1);
  assert.equal(error(engine.assignRole(sid, 'ghost', 'left defense', { source: 'manual' })), 'participant_not_found');
  assert.equal(error(engine.assignRole(sid, alex.id, '   ', { source: 'manual' })), 'invalid_input');
  assert.equal(error(engine.assignRole(sid, alex.id, 'x', { source: 'guess' as never })), 'invalid_input');
  assert.equal(error(engine.assignRole(sid, alex.id, 'x', { source: 'transcript' })), 'invalid_input', 'transcript needs a source utterance');
  assert.equal(error(engine.assignRole(sid, alex.id, 'x', { source: 'transcript', sourceObservationId: 'missing' })), 'evidence_not_found');
  assert.equal(error(engine.assignRole(sid, alex.id, 'x', { source: 'transcript', sourceObservationId: frame.id })), 'invalid_input');
});

test('duplicate participant externalRef is rejected', () => {
  const { engine, sid } = activeSession();
  assert.equal(error(engine.addParticipant(sid, { displayName: 'Copy', externalRef: 'spk-alex' })), 'invalid_input');
});

function talkAt(engine: Parameters<typeof gen>[0], sid: string, seconds: number, text = 'Alex left') {
  return value(engine.ingestConversation(sid, { captureGeneration: gen(engine, sid), observedAt: at(seconds), text }));
}

for (const skewMs of [5_000, 0]) {
  const skew = skewMs / 1000;

  test(`[R2-4] maxClockSkewMs=${skewMs}: manual correction beats a transcript stamped exactly at the admission boundary`, () => {
    const { engine, clock, sid, alex } = activeSession({ maxClockSkewMs: skewMs });
    clock.set(10);
    const ahead = talkAt(engine, sid, 10 + skew); // observedAt = now + maxClockSkewMs (accepted)
    value(engine.assignRole(sid, alex.id, 'left defense', { source: 'transcript', sourceObservationId: ahead.id }));
    const r = value(engine.assignRole(sid, alex.id, 'right defense', { source: 'manual' }));
    assert.equal(r.outcome, 'applied');
    assert.equal(r.participant.role, 'right defense');
  });

  test(`[R2-4] maxClockSkewMs=${skewMs}: delayed transcripts up to correction + skew cannot undo it`, () => {
    const { engine, clock, sid, alex } = activeSession({ maxClockSkewMs: skewMs });
    clock.set(10);
    value(engine.assignRole(sid, alex.id, 'right defense', { source: 'participant_report' })); // T = 10
    clock.set(10 + skew); // so a transcript stamped T + skew is admissible
    for (const t of [9, 10, 10 + skew]) {
      const u = talkAt(engine, sid, t);
      assert.equal(
        value(engine.assignRole(sid, alex.id, 'left defense', { source: 'transcript', sourceObservationId: u.id })).outcome,
        'ignored_superseded',
        `transcript at t=${t}`,
      );
    }
    // 1 ms past the boundary it is certainly a later statement and applies:
    clock.set(10 + skew + 0.001);
    const later = talkAt(engine, sid, 10 + skew + 0.001);
    assert.equal(
      value(engine.assignRole(sid, alex.id, 'left defense', { source: 'transcript', sourceObservationId: later.id })).outcome,
      'applied',
    );
  });
}

test('[R2-4] a later manual correction always beats an earlier one (arrival order)', () => {
  const { engine, sid, alex } = activeSession();
  value(engine.assignRole(sid, alex.id, 'left defense', { source: 'manual' }));
  const r = value(engine.assignRole(sid, alex.id, 'right defense', { source: 'participant_report' }));
  assert.equal(r.outcome, 'applied');
});
