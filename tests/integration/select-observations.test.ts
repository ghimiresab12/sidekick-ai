import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SELECTION_LIMITS,
  REASONING_MAX_OBSERVATIONS,
  findSupersedingScreen,
  framesEquivalent,
  selectObservations,
  validateSelectionLimits,
} from '../../src/coordinator/select-observations.js';
import { activeSession, at, gen, say, screen, value } from '../helpers.js';

const STALE = 15_000;

test('includes old role/goal source utterances even outside the transcript window or generation', () => {
  const { engine, clock, sid, alex } = activeSession();
  clock.set(2);
  const role = say(engine, sid, 1, 'Alex is responsible for left defense.');
  const goal = say(engine, sid, 2, 'Our goal is to keep the left covered.');
  value(engine.assignRole(sid, alex.id, 'left defense', { source: 'transcript', sourceObservationId: role.id }));
  value(engine.setGoal(sid, 'Our goal is to keep the left covered.', { source: 'transcript', sourceObservationId: goal.id }));
  value(engine.pause(sid));
  value(engine.resume(sid));
  clock.set(300); // far outside the 60 s transcript window
  const sel = value(selectObservations(engine, value(engine.getSession(sid)), Date.parse(at(300)), STALE));
  assert.deepEqual(sel.observations.map((o) => o.id), [role.id, goal.id]);
});

test('condition candidates: only current-generation screens inside the stale window', () => {
  const { engine, clock, sid } = activeSession();
  clock.set(5);
  const oldGen = screen(engine, sid, 5);
  value(engine.pause(sid));
  value(engine.resume(sid));
  clock.set(40);
  const stale = screen(engine, sid, 20);
  const fresh = screen(engine, sid, 30);
  const sel = value(selectObservations(engine, value(engine.getSession(sid)), Date.parse(at(40)), STALE));
  const ids = sel.observations.map((o) => o.id);
  assert.ok(ids.includes(fresh.id));
  assert.ok(!ids.includes(stale.id) && !ids.includes(oldGen.id));
});

test('caps the batch, dropping the oldest transcripts first, and stays sorted', () => {
  const { engine, clock, sid } = activeSession();
  clock.set(50);
  const talk = Array.from({ length: 10 }, (_, i) => say(engine, sid, 30 + i, `line ${i}`));
  const frame = screen(engine, sid, 45);
  const sel = value(selectObservations(engine, value(engine.getSession(sid)), Date.parse(at(50)), STALE, {
    transcriptWindowMs: 60_000, maxTranscripts: 30, maxScreens: 20, maxBatch: 4,
  }));
  assert.equal(sel.truncated, true);
  assert.deepEqual(sel.observations.map((o) => o.id), [...talk.slice(-3).map((o) => o.id), frame.id]);
});

test('[R3-2] excludes only future-stamped observations and reports the earliest eligibility time', () => {
  const { engine, clock, sid } = activeSession();
  clock.set(10);
  const talk = say(engine, sid, 9, 'eligible now');
  const ready = value(engine.ingestScreen(sid, { captureGeneration: gen(engine, sid), observedAt: at(10), summary: 'ready', evidenceQuality: 'clear' }));
  value(engine.ingestScreen(sid, { captureGeneration: gen(engine, sid), observedAt: at(13), summary: 'later', evidenceQuality: 'clear' }));
  value(engine.ingestScreen(sid, { captureGeneration: gen(engine, sid), observedAt: at(12), summary: 'soon', evidenceQuality: 'clear' }));
  const sel = value(selectObservations(engine, value(engine.getSession(sid)), Date.parse(at(10)), STALE));
  assert.deepEqual(sel.observations.map((o) => o.id), [talk.id, ready.id], 'eligible evidence is processed now');
  assert.equal(sel.nextEligibleAtMs, Date.parse(at(12)), 'earliest future observation');
  const later = value(selectObservations(engine, value(engine.getSession(sid)), Date.parse(at(13)), STALE));
  assert.equal(later.nextEligibleAtMs, undefined);
  assert.equal(later.observations.length, 4);
});

const frame = (engine: Parameters<typeof gen>[0], sid: string, seconds: number, quality: 'clear' | 'partial' | 'unknown', facts?: Record<string, boolean>) =>
  value(engine.ingestScreen(sid, {
    captureGeneration: gen(engine, sid), observedAt: at(seconds), summary: 'frame', evidenceQuality: quality, ...(facts ? { facts } : {}),
  }));

test('[R3-1] newer disagreeing, unclear or fact-less frames supersede; agreeing frames and transcripts do not', () => {
  const { engine, clock, sid } = activeSession();
  clock.set(20);
  const gap = { leftZoneVisible: true, leftZoneUncovered: true };
  const batchFrame = frame(engine, sid, 8, 'clear', gap);
  const batch = [batchFrame];
  const check = () => value(findSupersedingScreen(engine, sid, gen(engine, sid), batch, Date.parse(at(20))));
  assert.equal(check(), undefined);
  say(engine, sid, 9, 'newer speech');
  assert.equal(check(), undefined, 'transcripts never supersede condition evidence');
  frame(engine, sid, 7, 'clear', { leftZoneVisible: true, leftZoneUncovered: false });
  assert.equal(check(), undefined, 'an OLDER late frame does not supersede');
  frame(engine, sid, 9, 'clear', gap);
  assert.equal(check(), undefined, 'a newer agreeing frame adds no new information');
  const unknown = frame(engine, sid, 10, 'unknown', gap);
  assert.equal(check()?.id, unknown.id, 'unknown quality is treated conservatively');
});

test('[R3-1] covered frame supersedes; a future-stamped frame does not (not yet eligible)', () => {
  const { engine, clock, sid } = activeSession();
  clock.set(10);
  const batch = [frame(engine, sid, 8, 'clear', { leftZoneVisible: true, leftZoneUncovered: true })];
  const future = frame(engine, sid, 12, 'clear', { leftZoneVisible: true, leftZoneUncovered: false });
  assert.equal(value(findSupersedingScreen(engine, sid, gen(engine, sid), batch, Date.parse(at(10)))), undefined);
  assert.equal(value(findSupersedingScreen(engine, sid, gen(engine, sid), batch, Date.parse(at(12))))?.id, future.id);
  const factless = frame(engine, sid, 9, 'clear');
  assert.equal(value(findSupersedingScreen(engine, sid, gen(engine, sid), batch, Date.parse(at(10))))?.id, factless.id);
});

test('selection limits are validated against the reasoning maximum of 100', () => {
  assert.equal(REASONING_MAX_OBSERVATIONS, 100);
  assert.doesNotThrow(() => validateSelectionLimits({ ...DEFAULT_SELECTION_LIMITS }));
  for (const bad of [{ maxBatch: 101 }, { maxBatch: 0 }, { maxScreens: 1.5 }, { maxTranscripts: 101 }, { transcriptWindowMs: -1 }]) {
    assert.throws(() => validateSelectionLimits({ ...DEFAULT_SELECTION_LIMITS, ...bad }), RangeError, JSON.stringify(bad));
  }
});

test('[R4-2] future frames beyond maxScreens cannot crowd out eligible frames or context', () => {
  const { engine, clock, sid, alex } = activeSession();
  clock.set(10);
  const role = say(engine, sid, 1, 'Alex is responsible for left defense.');
  value(engine.assignRole(sid, alex.id, 'left defense', { source: 'transcript', sourceObservationId: role.id }));
  const eligible = [8, 9, 10].map((s) => value(engine.ingestScreen(sid, {
    captureGeneration: gen(engine, sid), observedAt: at(s), summary: 'eligible', evidenceQuality: 'clear' })));
  for (let i = 0; i < 40; i++) {
    value(engine.ingestScreen(sid, { captureGeneration: gen(engine, sid), observedAt: at(10.1 + i * 0.1), summary: 'future', evidenceQuality: 'clear' }));
  }
  const sel = value(selectObservations(engine, value(engine.getSession(sid)), Date.parse(at(10)), STALE, {
    ...DEFAULT_SELECTION_LIMITS, maxScreens: 20,
  }));
  const ids = sel.observations.map((o) => o.id);
  for (const o of [role, ...eligible]) assert.ok(ids.includes(o.id), 'eligible evidence selected');
  assert.ok(sel.observations.every((o) => Date.parse(o.observedAt) <= Date.parse(at(10))), 'nothing future-stamped');
  assert.equal(sel.nextEligibleAtMs, Date.parse(at(10.1)), 'earliest future observation drives the deadline');
});

const screenObs = (summary: string, facts?: Record<string, boolean>, evidenceQuality: 'clear' | 'unknown' = 'clear') => ({
  id: summary, sessionId: 's', captureGeneration: 1, source: 'screen' as const, observedAt: at(1), receivedAt: at(1),
  summary, evidenceQuality, ...(facts ? { facts } : {}),
});

test('[R4-1] framesEquivalent: partial or empty facts never make contradictory summaries agree', () => {
  const MVP = ['leftZoneVisible', 'leftZoneUncovered'];
  const empty = screenObs('Left zone clearly empty', { leftZoneVisible: true });
  const covered = screenObs('Left zone clearly covered', { leftZoneVisible: true });
  assert.equal(framesEquivalent(empty, covered, []), false, 'identical partial facts, different summaries');
  assert.equal(framesEquivalent(empty, covered, MVP), false, 'partial facts do not satisfy the condition keys');
  assert.equal(framesEquivalent(screenObs('a', {}), screenObs('b', {}), MVP), false, 'empty facts');
  assert.equal(framesEquivalent(screenObs('a'), screenObs('b'), MVP), false, 'no facts');
  assert.equal(framesEquivalent(screenObs('Same  scene', { x: true }), screenObs('same scene', { x: true }), []), true,
    'identical (normalized) summary + identical facts');
  assert.equal(framesEquivalent(screenObs('Same'), screenObs('same'), []), true, 'identical summary, no facts on either');
  assert.equal(framesEquivalent(screenObs('same', { x: true }), screenObs('same', { x: false }), []), false, 'same text, different facts');
  const full = { leftZoneVisible: true, leftZoneUncovered: true };
  assert.equal(framesEquivalent(screenObs('Zone empty', full), screenObs('Nobody on the left', full), MVP), true,
    'complete structured condition, different wording');
  assert.equal(framesEquivalent(screenObs('Zone empty', full), screenObs('Zone empty', full, 'unknown'), MVP), false, 'unclear never agrees');
});
