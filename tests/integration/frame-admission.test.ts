import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SidekickCoordinator } from '../../src/coordinator/coordinator.js';
import type { FrameInput, ReasoningFn } from '../../src/coordinator/ports.js';

const startMs = Date.parse('2026-11-15T04:00:00Z');
const reasoning: ReasoningFn = async () => ({ ok: false, error: 'mock' });

function setup(maxFrameBytes?: number, skew = 5000) {
  let calls = 0;
  const c = new SidekickCoordinator({
    reasoning, maxFrameBytes, now: () => new Date(startMs),
    engine: { maxClockSkewMs: skew },
    vision: { async describe() { calls++; return { summary: 'Synthetic frame', evidenceQuality: 'unknown' }; } },
  });
  const created = c.createSession();
  assert.ok(created.ok);
  const session = c.startWithConsent(created.value.id);
  assert.ok(session.ok);
  const frame: FrameInput = {
    mediaSource: 'screen_share', captureGeneration: session.value.captureGeneration,
    observedAt: new Date(startMs).toISOString(), image: new Uint8Array([1]), mimeType: 'image/png',
  };
  return { c, sid: created.value.id, frame, calls: () => calls };
}

for (const observedAt of ['invalid', '2026-02-30T04:00:00Z', '2026-11-15T04:00:00', '', undefined, 123]) {
  test(`invalid frame timestamp ${String(observedAt)} never reaches vision`, async () => {
    const h = setup();
    const result = await h.c.ingestFrame(h.sid, { ...h.frame, observedAt } as FrameInput);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error, 'invalid_timestamp');
    assert.equal(h.calls(), 0);
    const observations = h.c.engine.listObservations(h.sid);
    assert.ok(observations.ok);
    assert.equal(observations.value.length, 0);
  });
}

for (const skew of [0, 2000, 5000]) {
  for (const direction of [-1, 1]) {
    test(`frame outside ${skew} ms skew (${direction}) never reaches vision`, async () => {
      const h = setup(undefined, skew);
      h.frame.observedAt = new Date(startMs + direction * (skew + 1)).toISOString();
      const result = await h.c.ingestFrame(h.sid, h.frame);
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error, 'timestamp_out_of_range');
      assert.equal(h.calls(), 0);
    });
    test(`frame exactly at ${skew} ms skew (${direction}) preserves metadata`, async () => {
      const h = setup(undefined, skew);
      h.frame.observedAt = new Date(startMs + direction * skew).toISOString();
      const result = await h.c.ingestFrame(h.sid, h.frame);
      assert.ok(result.ok);
      assert.equal(h.calls(), 1);
      assert.equal(result.value.observedAt, h.frame.observedAt);
      assert.equal(result.value.captureGeneration, h.frame.captureGeneration);
      h.c.end(h.sid); // Cancel any future-evidence deadline.
      await h.c.whenIdle(h.sid);
    });
  }
}

for (const limit of [NaN, Infinity, -Infinity, -1, 0, 1.5, 5 * 1024 * 1024 + 1, Number.MAX_SAFE_INTEGER, null, '1024']) {
  test(`rejects invalid frame budget ${String(limit)}`, () => {
    assert.throws(() => setup(limit as number), /maxFrameBytes/);
  });
}

for (const limit of [1, 1024, 5 * 1024 * 1024]) {
  test(`enforces exact ${limit}-byte frame budget before vision`, async () => {
    const h = setup(limit);
    h.frame.image = new Uint8Array(limit + 1);
    const oversized = await h.c.ingestFrame(h.sid, h.frame);
    assert.equal(oversized.ok, false);
    if (!oversized.ok) assert.equal(oversized.error, 'invalid_input');
    assert.equal(h.calls(), 0);
    h.frame.image = new Uint8Array(limit);
    assert.ok((await h.c.ingestFrame(h.sid, h.frame)).ok);
    assert.equal(h.calls(), 1);
    await h.c.whenIdle(h.sid);
  });
}

test('default frame budget rejects images larger than 5 MiB before vision', async () => {
  const h = setup();
  h.frame.image = new Uint8Array(5 * 1024 * 1024 + 1);
  assert.equal((await h.c.ingestFrame(h.sid, h.frame)).ok, false);
  assert.equal(h.calls(), 0);
});
