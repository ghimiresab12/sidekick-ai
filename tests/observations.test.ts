import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIsoTime } from '../src/contracts/validate.js';
import { activeSession, at, error, screen, value, gen } from './helpers.js';

test('parseIsoTime accepts ISO timestamps with timezone and rejects everything else', () => {
  assert.equal(parseIsoTime('2026-11-14T18:00:00Z'), Date.parse('2026-11-14T18:00:00Z'));
  assert.equal(parseIsoTime('2026-11-14T18:00:00.123+05:45'), Date.parse('2026-11-14T18:00:00.123+05:45'));
  for (const bad of ['2026-11-14T18:00:00', '2026-11-14', '2026-02-30T00:00:00Z', '2026-13-01T00:00:00Z',
    '2026-11-14T24:00:00Z', 'yesterday', '', 1731607200000, null, undefined]) {
    assert.equal(parseIsoTime(bad), undefined, `should reject ${String(bad)}`);
  }
  assert.ok(parseIsoTime('2028-02-29T00:00:00Z'), 'leap day is valid');
});

test('conversation input: speaker matched only via verified externalRef', () => {
  const { engine, clock, sid, alex } = activeSession();
  clock.set(1);
  const known = value(engine.ingestConversation(sid, { captureGeneration: gen(engine, sid),  observedAt: at(1), text: 'I got left', speakerRef: 'spk-alex' }));
  assert.equal(known.speakerParticipantId, alex.id);
  const unknown = value(engine.ingestConversation(sid, { captureGeneration: gen(engine, sid),  observedAt: at(1), text: 'who?', speakerRef: 'spk-unknown' }));
  assert.equal(unknown.speakerParticipantId, undefined);
  const none = value(engine.ingestConversation(sid, { captureGeneration: gen(engine, sid),  observedAt: at(1), text: 'no ref' }));
  assert.equal(none.speakerParticipantId, undefined);
  assert.equal(none.source, 'transcript');
  assert.equal(none.sessionId, sid);
});

test('observedAt is normalized to UTC; receivedAt uses the engine clock', () => {
  const { engine, clock, sid } = activeSession();
  clock.set(10);
  const obs = value(engine.ingestConversation(sid, { captureGeneration: gen(engine, sid),  observedAt: '2026-11-14T23:45:08.000+05:45', text: 'hi' }));
  assert.equal(obs.observedAt, at(8));
  assert.equal(obs.receivedAt, at(10));
});

test('rejects invalid, future and pre-consent timestamps', () => {
  const { engine, clock, sid } = activeSession();
  clock.set(100);
  const send = (observedAt: string) => engine.ingestScreen(sid, { captureGeneration: gen(engine, sid),  observedAt, summary: 's', evidenceQuality: 'clear' });
  assert.equal(error(send('not-a-time')), 'invalid_timestamp');
  assert.equal(error(send('2026-02-30T00:00:00Z')), 'invalid_timestamp');
  assert.equal(error(send(at(106))), 'timestamp_out_of_range', 'beyond 5s skew into the future');
  assert.ok(value(send(at(104))), 'within skew is accepted');
  assert.equal(error(send(at(-6))), 'timestamp_out_of_range', 'before session start');
});

test('rejects malformed screen input, inline media and oversized text', () => {
  const { engine, clock, sid } = activeSession();
  clock.set(1);
  const base = { captureGeneration: gen(engine, sid), observedAt: at(1), summary: 'ok', evidenceQuality: 'clear' as const };
  assert.equal(error(engine.ingestScreen(sid, { ...base, evidenceQuality: 'certain' as never })), 'invalid_input');
  assert.equal(error(engine.ingestScreen(sid, { ...base, summary: '' })), 'invalid_input');
  assert.equal(error(engine.ingestScreen(sid, { ...base, summary: 'x'.repeat(501) })), 'invalid_input');
  assert.equal(error(engine.ingestScreen(sid, { ...base, frameRef: 'data:image/png;base64,AAAA' })), 'invalid_input');
  assert.equal(error(engine.ingestScreen(sid, { ...base, facts: { nested: { a: 1 } } as never })), 'invalid_input');
  assert.equal(error(engine.ingestScreen(sid, null as never)), 'invalid_input');
  assert.equal(error(engine.ingestConversation(sid, { captureGeneration: gen(engine, sid),  observedAt: at(1), text: 'x'.repeat(1001) })), 'invalid_input');
});

test('late, out-of-order observations are stored but do not become "latest"', () => {
  const { engine, clock, sid } = activeSession();
  clock.set(20);
  const newer = screen(engine, sid, 19);
  const older = screen(engine, sid, 12); // arrives after `newer`
  const latest = value(engine.getLatestObservation(sid, 'screen'));
  assert.equal(latest?.id, newer.id);
  assert.ok(value(engine.getObservation(sid, older.id)));
  const obsIds = value(engine.getTimeline(sid)).flatMap((e) => (e.type === 'observation' ? [e.observationId] : []));
  assert.deepEqual(obsIds, [older.id, newer.id], 'timeline uses source time');
});

test('observation limit bounds memory and is surfaced', () => {
  const { engine, clock, sid } = activeSession({ maxObservations: 2 });
  clock.set(1);
  screen(engine, sid, 1);
  screen(engine, sid, 1);
  assert.equal(error(engine.ingestScreen(sid, { captureGeneration: gen(engine, sid),  observedAt: at(1), summary: 's', evidenceQuality: 'clear' })), 'observation_limit_reached');
  assert.equal(value(engine.getSession(sid)).observationLimitReached, true);
});

test('returned observations are copies; mutating them does not change engine state', () => {
  const { engine, clock, sid } = activeSession();
  clock.set(1);
  const obs = screen(engine, sid, 1);
  (obs as { summary: string }).summary = 'tampered';
  const stored = value(engine.getObservation(sid, obs.id));
  assert.equal(stored.source === 'screen' ? stored.summary : '', 'Left zone empty');
});
