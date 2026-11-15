import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SidekickEngine } from '../src/engine.js';
import { activeSession, at, candidate, error, screen, setup, value, gen, propose } from './helpers.js';

test('new session starts in `starting` without consent', () => {
  const { engine } = setup();
  const s = value(engine.createSession({ externalRef: 'call-1' }));
  assert.equal(s.status, 'starting');
  assert.equal(s.consentGiven, false);
  assert.equal(s.externalRef, 'call-1');
});

test('observations and recommendations are rejected until consent', () => {
  const { engine } = setup();
  const sid = value(engine.createSession()).id;
  assert.equal(error(engine.ingestConversation(sid, { captureGeneration: gen(engine, sid),  observedAt: at(0), text: 'hi' })), 'consent_required');
  assert.equal(
    error(engine.ingestScreen(sid, { mediaSource: 'screen_share', captureGeneration: gen(engine, sid),  observedAt: at(0), summary: 'x', evidenceQuality: 'clear' })),
    'consent_required',
  );
  assert.equal(error(propose(engine, sid)(candidate(['nope']))), 'consent_required');
  assert.equal(value(engine.getSession(sid)).observationCount, 0);
});

test('startWithConsent activates once; restarting is an invalid transition', () => {
  const { engine } = setup();
  const sid = value(engine.createSession()).id;
  const s = value(engine.startWithConsent(sid));
  assert.equal(s.status, 'active');
  assert.equal(s.consentGiven, true);
  assert.ok(s.startedAt);
  assert.equal(error(engine.startWithConsent(sid)), 'invalid_transition');
});

test('pause blocks ingest, marks active cards stale, resume re-enables ingest', () => {
  const { engine, clock, sid } = activeSession();
  clock.set(1);
  const obs = screen(engine, sid, 1);
  const rec = value(propose(engine, sid)(candidate([obs.id])));
  assert.equal(rec.outcome, 'created');

  value(engine.pause(sid));
  assert.equal(value(engine.getSession(sid)).recommendations[0]?.status, 'stale');
  assert.equal(
    error(engine.ingestScreen(sid, { mediaSource: 'screen_share', captureGeneration: gen(engine, sid),  observedAt: at(1), summary: 'x', evidenceQuality: 'clear' })),
    'session_not_active',
  );

  clock.set(5);
  value(engine.resume(sid));
  clock.set(6);
  screen(engine, sid, 6);
});

test('observations captured during a pause are rejected even if delivered after resume', () => {
  const { engine, clock, sid } = activeSession();
  clock.set(10);
  value(engine.pause(sid));
  const pausedGeneration = gen(engine, sid); // what an adapter would stamp while paused
  clock.set(20);
  value(engine.resume(sid));
  clock.set(21);
  assert.equal(
    error(engine.ingestScreen(sid, { mediaSource: 'screen_share', captureGeneration: pausedGeneration, observedAt: at(15), summary: 'late', evidenceQuality: 'clear' })),
    'invalid_generation',
  );
});

test('end stops processing permanently and keeps the timeline', () => {
  const { engine, clock, sid } = activeSession();
  clock.set(1);
  screen(engine, sid, 1);
  value(engine.end(sid));
  assert.equal(error(engine.ingestScreen(sid, { mediaSource: 'screen_share', captureGeneration: gen(engine, sid),  observedAt: at(1), summary: 'x', evidenceQuality: 'clear' })), 'session_not_active');
  assert.equal(error(engine.resume(sid)), 'invalid_transition');
  assert.equal(error(engine.startWithConsent(sid)), 'invalid_transition');
  assert.equal(error(engine.addParticipant(sid, { displayName: 'Late' })), 'session_not_active');
  const types = value(engine.getTimeline(sid)).map((e) => e.type);
  assert.ok(types.includes('session_ended'));
  assert.ok(types.includes('observation'));
});

test('discard removes all session data and subscriptions', () => {
  const { engine, clock, sid } = activeSession();
  let calls = 0;
  value(engine.subscribe(sid, () => calls++));
  clock.set(1);
  screen(engine, sid, 1);
  const before = calls;
  value(engine.discard(sid));
  assert.equal(error(engine.getSession(sid)), 'session_not_found');
  assert.equal(error(engine.getTimeline(sid)), 'session_not_found');
  assert.equal(error(engine.getOverlayState(sid)), 'session_not_found');
  assert.equal(error(engine.ingestScreen(sid, { mediaSource: 'screen_share', captureGeneration: gen(engine, sid),  observedAt: at(1), summary: 'x', evidenceQuality: 'clear' })), 'session_not_found');
  assert.equal(error(engine.discard(sid)), 'session_not_found');
  assert.equal(calls, before, 'no notifications after discard');
});

test('sessions are isolated: IDs from one session do not work in another', () => {
  const { engine, clock, sid, alex } = activeSession();
  const other = value(engine.createSession()).id;
  value(engine.startWithConsent(other));
  clock.set(1);
  const obs = screen(engine, sid, 1);
  assert.equal(error(propose(engine, other)(candidate([obs.id]))), 'evidence_not_found');
  assert.equal(error(engine.assignRole(other, alex.id, 'striker', { source: 'manual' })), 'participant_not_found');
  assert.equal(error(engine.requestExplanation(other, 'x')), 'recommendation_not_found');
  const rec = value(propose(engine, sid)(candidate([obs.id])));
  assert.equal(rec.outcome, 'created');
  if (rec.outcome !== 'created') return;
  assert.equal(error(engine.dismiss(other, rec.recommendation.id)), 'recommendation_not_found');
  assert.equal(error(engine.getExplanationContext(other, rec.recommendation.id)), 'recommendation_not_found');
});

test('unknown session IDs return session_not_found', () => {
  const { engine } = setup();
  assert.equal(error(engine.getSession('missing')), 'session_not_found');
  assert.equal(error(engine.pause('missing')), 'session_not_found');
});

test('activity is only applied after confirmation', () => {
  const { engine, sid } = activeSession();
  let s = value(engine.suggestActivity(sid, 'gaming'));
  assert.equal(s.activity, 'unconfirmed');
  assert.equal(s.suggestedActivity, 'gaming');
  s = value(engine.confirmActivity(sid, 'gaming'));
  assert.equal(s.activity, 'gaming');
  assert.equal(s.activityConfirmed, true);
  assert.equal(s.suggestedActivity, undefined);
  assert.equal(error(engine.confirmActivity(sid, 'unconfirmed')), 'invalid_input');
});

test('thresholds are configurable and invalid config is rejected', () => {
  const engine = new SidekickEngine({ cooldownMs: 1000, staleAfterMs: 2000 });
  assert.equal(engine.config.cooldownMs, 1000);
  assert.equal(engine.config.staleAfterMs, 2000);
  assert.equal(engine.config.maxClockSkewMs, 5000);
  assert.throws(() => new SidekickEngine({ staleAfterMs: -1 }), RangeError);
  assert.throws(() => new SidekickEngine({ cooldownMs: Number.NaN }), RangeError);
  assert.throws(() => new SidekickEngine({ maxObservations: 0 }), RangeError);
  assert.throws(() => new SidekickEngine({ maxTimelineEvents: 1.5 }), RangeError);
  assert.equal(new SidekickEngine({ voiceRequestTimeoutMs: 1 }).config.voiceRequestTimeoutMs, 1);
});
