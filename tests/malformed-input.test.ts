import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SidekickEngine } from '../src/engine.js';
import { activeSession, candidate, error, screen, setup, value, gen, propose } from './helpers.js';

const JUNK: unknown[] = [
  null, undefined, 0, -1, Number.NaN, '', '   ', 'x', true, [], [null], {}, { a: 1 },
  () => {}, Symbol('s'), 10n, new Date(), Object.create(null),
];

const describe = (v: unknown): string => {
  try { return typeof v === 'symbol' ? v.toString() : String(v); } catch { return Object.prototype.toString.call(v); }
};

test('[F7] createSession(null) and other junk options return invalid_input', () => {
  const { engine } = setup();
  assert.equal(error(engine.createSession(null as never)), 'invalid_input');
  assert.equal(error(engine.createSession('x' as never)), 'invalid_input');
  assert.equal(error(engine.createSession([] as never)), 'invalid_input');
  assert.equal(error(engine.createSession({ externalRef: 42 } as never)), 'invalid_input');
  assert.ok(value(engine.createSession()).id);
  assert.ok(value(engine.createSession({})).id);
});

test('[F7] constructor tolerates null options', () => {
  assert.ok(new SidekickEngine(null as never).config.cooldownMs);
});

test('[F7] no public method throws on malformed arguments', () => {
  const { engine, clock, sid, alex } = activeSession();
  clock.set(1);
  const obs = screen(engine, sid, 1);
  const r = value(propose(engine, sid)(candidate([obs.id])));
  const recId = r.outcome === 'created' ? r.recommendation.id : '';
  const real = { sid, pid: alex.id, recId, obsId: obs.id };

  type Call = (j: never) => unknown;
  const calls: Record<string, Call> = {
    createSession: (j) => engine.createSession(j),
    startWithConsent: (j) => engine.startWithConsent(j),
    addParticipant: (j) => engine.addParticipant(real.sid, j),
    addParticipantSid: (j) => engine.addParticipant(j, { displayName: 'x' }),
    assignRoleOpts: (j) => engine.assignRole(real.sid, real.pid, 'role', j),
    assignRoleRole: (j) => engine.assignRole(real.sid, real.pid, j, { source: 'manual' }),
    assignRolePid: (j) => engine.assignRole(real.sid, j, 'role', { source: 'manual' }),
    clearRole: (j) => engine.clearRole(real.sid, real.pid, j),
    setGoalText: (j) => engine.setGoal(real.sid, j, { source: 'manual' }),
    setGoalOpts: (j) => engine.setGoal(real.sid, 'goal', j),
    retireGoal: (j) => engine.retireGoal(real.sid, j, { source: 'manual' }),
    recordDecision: (j) => engine.recordDecision(real.sid, j),
    recordDecisionIds: (j) => engine.recordDecision(real.sid, { text: 'x', source: 'manual', sourceObservationIds: j }),
    suggestActivity: (j) => engine.suggestActivity(real.sid, j),
    confirmActivity: (j) => engine.confirmActivity(real.sid, j),
    ingestConversation: (j) => engine.ingestConversation(real.sid, j),
    ingestConversationTime: (j) => engine.ingestConversation(real.sid, { captureGeneration: gen(engine, real.sid),  observedAt: j, text: 'x' }),
    ingestScreen: (j) => engine.ingestScreen(real.sid, j),
    ingestScreenFacts: (j) => engine.ingestScreen(real.sid, { mediaSource: 'screen_share', captureGeneration: gen(engine, real.sid),  observedAt: '2026-11-14T18:00:01Z', summary: 'x', evidenceQuality: 'clear', facts: j }),
    getObservation: (j) => engine.getObservation(real.sid, j),
    getLatestObservation: (j) => engine.getLatestObservation(real.sid, j),
    listObservations: (j) => engine.listObservations(real.sid, j),
    listObservationsSid: (j) => engine.listObservations(j),
    propose: (j) => engine.proposeRecommendation(real.sid, j),
    proposeIds: (j) => propose(engine, real.sid)(candidate(j)),
    proposeContext: (j) => propose(engine, real.sid)(candidate([real.obsId], { contextObservationIds: j })),
    dismiss: (j) => engine.dismiss(real.sid, j),
    resolve: (j) => engine.resolve(real.sid, real.recId, j),
    sweepStale: (j) => engine.sweepStale(j),
    getExplanationContext: (j) => engine.getExplanationContext(real.sid, j),
    requestExplanationOpts: (j) => engine.requestExplanation(real.sid, real.recId, j),
    reportVoiceStatus: (j) => engine.reportVoiceStatus(real.sid, j, 'finished'),
    reportVoiceStatusStatus: (j) => engine.reportVoiceStatus(real.sid, 'x', j),
    cancelExplanation: (j) => engine.cancelExplanation(real.sid, 'x', j),
    getSession: (j) => engine.getSession(j),
    getOverlayState: (j) => engine.getOverlayState(j),
    getTimeline: (j) => engine.getTimeline(j),
    subscribe: (j) => engine.subscribe(real.sid, j),
    pause: (j) => engine.pause(j),
    end: (j) => engine.end(j),
    discard: (j) => engine.discard(j),
  };

  for (const [name, call] of Object.entries(calls)) {
    for (const junk of JUNK) {
      let result: unknown;
      assert.doesNotThrow(() => { result = call(junk as never); }, `${name}(${describe(junk)}) threw`);
      if (name !== 'requestExplanationOpts' || junk !== undefined) {
        // Every call returns a Result object (unsubscribe functions only on valid listeners).
        assert.equal(typeof result, 'object', `${name} returned a Result`);
        assert.ok(result !== null && 'ok' in (result as object), `${name} returned a Result`);
      }
    }
  }
  // Valid state survived the barrage.
  assert.equal(value(engine.getSession(sid)).status, 'active');
});
