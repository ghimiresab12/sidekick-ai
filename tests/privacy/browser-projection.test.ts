import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CANONICAL_ROLES, ROLE_FALLBACK, projectOverlayState, projectTimelineEvent, projectVoiceRequest, safeRoleLabel } from '../../src/privacy/browser-projection.js';
import type { OverlayState, SessionEvent, VoiceRequest } from '../../src/contracts/types.js';

test('[R1] only canonical demo roles are shown; everything else is "assigned role"', () => {
  for (const [input, label] of [['left defense', 'left defense'], ['Left Defence', 'left defense'], ['left-defense', 'left defense'], ['the left defense', 'left defense'],
    ['  goalie ', 'goalie'], ['Striker', 'striker'], ['Left Defender', 'left defense'], ['centre back', 'center back'], ['Ｌｅｆｔ ｄｅｆｅｎｓｅ', 'left defense']] as const) {
    assert.equal(safeRoleLabel(input), label, input);
  }
  for (const bad of ['password banana', 'hunter two', 'banana', 'left defense password', 'left defense banana', 'ZEBRA ROLE 5512 duty', 'call me at 555 0100',
    'left defense; also my password is hunter2', 'https://x.example', '<script>', '12', 'a'.repeat(33), 'défense gauche', 'left​defense']) {
    assert.equal(safeRoleLabel(bad), ROLE_FALLBACK, bad);
  }
  assert.equal(safeRoleLabel(undefined), undefined);
  for (const label of CANONICAL_ROLES) assert.equal(safeRoleLabel(label), label, 'every canonical label maps to itself');
});

test('[R1] timeline projection rebuilds every summary and drops all free text', () => {
  const base = { id: 'e', sessionId: 's', time: 't', recordedAt: 't' };
  const lookup = { names: new Map([['p1', 'Alex']]), titles: new Map([['r1', 'Left defense appears exposed']]) };
  const SECRET = 'password banana';
  const events = [
    { ...base, type: 'goal_set', goalId: 'g', text: SECRET, source: 'transcript', revision: 1, summary: `Group goal: ${SECRET}` },
    { ...base, type: 'goal_retired', goalId: 'g', source: 'manual', revision: 2, summary: `Goal retired: ${SECRET}` },
    { ...base, type: 'decision_recorded', summary: `Decision: ${SECRET}`, decision: { id: 'd', text: SECRET, decidedAt: 't', recordedAt: 't', source: 'transcript', sourceObservationIds: ['o'], participantIds: [] } },
    { ...base, type: 'role_updated', summary: `Alex assigned role: ${SECRET}`, change: { revision: 1, kind: 'assigned', participantId: 'p1', role: SECRET, previousRole: 'hunter two', effectiveAt: 't', recordedAt: 't', source: 'transcript' } },
    { ...base, type: 'observation', observationId: 'o', source: 'transcript', summary: SECRET },
    { ...base, type: 'participant_added', participantId: 'p1', displayName: 'Alex', summary: SECRET },
    { ...base, type: 'session_paused', summary: SECRET },
    { ...base, type: 'activity_confirmed', activity: 'gaming', summary: SECRET },
    { ...base, type: 'recommendation_created', recommendationId: 'r1', fingerprint: 'f', conditionObservationIds: [], contextObservationIds: [], relatedParticipantIds: [], contextRevision: 1, summary: SECRET },
    { ...base, type: 'recommendation_stale', recommendationId: 'r1', reason: 'role_changed', summary: SECRET },
    { ...base, type: 'voice_finished', recommendationId: 'r1', voiceRequestId: 'v', outcome: 'cancelled', cancelReason: 'timeout', summary: SECRET },
  ] as unknown as SessionEvent[];
  const projected = events.map((e) => projectTimelineEvent({ ...e, futureInternalField: SECRET } as unknown as SessionEvent, lookup));
  const dump = JSON.stringify(projected);
  assert.ok(!dump.includes('password') && !dump.includes('hunter') && !dump.includes('futureInternalField'), dump);
  assert.deepEqual(projected.map((e) => e.summary), [
    'Group goal stated', 'Group goal retired', 'Group decision recorded', 'Alex assigned role: assigned role', 'Speech observed (speaker unverified)',
    'Participant added: Alex', 'Observation paused', 'Activity confirmed: gaming', 'Advice shown: Left defense appears exposed',
    'Related role changed: Left defense appears exposed', 'Explanation cancelled: Left defense appears exposed',
  ]);
});

test('[R1] live state and voice requests are constructed from approved fields only', () => {
  const card = { id: 'r', status: 'active', title: 't', shortAdvice: 'a', urgency: 'normal', createdAt: 'c', lastConditionAt: 'l', evidence: [{ observationId: 'o', kind: 'condition', source: 'screen', observedAt: 'x', extra: 'LEAK' }],
    relatedParticipants: [{ id: 'p', displayName: 'Sam', role: 'password banana', extra: 'LEAK' }], contextChangedSinceCreation: false, canExplain: true, extra: 'LEAK' };
  const state = { sessionId: 's', version: 1, status: 'active', activity: 'gaming', activityConfirmed: true, prominent: card, history: [card], voiceBusy: false, extra: 'LEAK',
    activeVoiceRequest: { requestId: 'v', recommendationId: 'r', status: 'pending', extra: 'LEAK' } } as unknown as OverlayState;
  const out = JSON.stringify(projectOverlayState(state));
  assert.ok(!out.includes('LEAK') && !out.includes('password'), out);
  assert.equal(projectOverlayState(state).prominent!.relatedParticipants[0]!.role, ROLE_FALLBACK);
  const voice = projectVoiceRequest({ id: 'v', sessionId: 's', recommendationId: 'r', status: 'pending', requestedAt: 'a', updatedAt: 'b', extra: 'LEAK' } as unknown as VoiceRequest);
  assert.ok(!JSON.stringify(voice).includes('LEAK'));
});
