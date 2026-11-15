/** Coordinator mapping of vision adapter error codes, with cancellation precedence. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SidekickCoordinator } from '../../src/coordinator/coordinator.js';
import type { FrameInput, VisionPort } from '../../src/coordinator/ports.js';

const nowMs = Date.parse('2026-11-15T04:00:00Z');
const coded = (code: string) => Object.assign(new Error(code), { code });

function setup(vision: VisionPort) {
  const c = new SidekickCoordinator({ reasoning: async () => ({ ok: false, error: 'mock' }), vision, now: () => new Date(nowMs) });
  const created = c.createSession();
  assert.ok(created.ok);
  const started = c.startWithConsent(created.value.id);
  assert.ok(started.ok);
  const frame: FrameInput = {
    captureGeneration: started.value.captureGeneration, observedAt: new Date(nowMs).toISOString(),
    image: new Uint8Array([1, 2, 3]), mimeType: 'image/png',
  };
  return { c, sid: created.value.id, frame };
}

for (const [code, expected] of [
  ['invalid_frame', 'invalid_input'],
  ['busy', 'vision_busy'],
  ['timeout', 'vision_timeout'],
  ['provider_error', 'vision_failed'],
  ['invalid_output', 'vision_failed'],
  ['something_else', 'vision_failed'],
] as const) {
  test(`adapter error code ${code} → ${expected}; nothing stored`, async () => {
    const h = setup({ describe: async () => { throw coded(code); } });
    const r = await h.c.ingestFrame(h.sid, h.frame);
    assert.equal(!r.ok && r.error, expected);
    const stored = h.c.engine.listObservations(h.sid);
    assert.ok(stored.ok && stored.value.length === 0);
  });
}

test('errors without a code (or non-Error throws) → vision_failed', async () => {
  for (const thrown of [new Error('x'), 'string', null, { code: 42 }]) {
    const h = setup({ describe: async () => { throw thrown; } });
    const r = await h.c.ingestFrame(h.sid, h.frame);
    assert.equal(!r.ok && r.error, 'vision_failed');
  }
});

test('cancellation wins: an adapter that throws busy/timeout/provider_error AFTER a pause still reports aborted', async () => {
  for (const code of ['busy', 'timeout', 'provider_error', 'invalid_frame']) {
    let fail!: () => void;
    const h = setup({ describe: () => new Promise((_, reject) => { fail = () => reject(coded(code)); }) });
    const pending = h.c.ingestFrame(h.sid, h.frame);
    await new Promise((r) => setTimeout(r, 5));
    h.c.pause(h.sid);
    fail();
    assert.equal(((r) => !r.ok && r.error)(await pending), 'aborted', code);
  }
});

test('cancellation wins over a caller-deadline abort as well', async () => {
  let fail!: () => void;
  const h = setup({ describe: () => new Promise((_, reject) => { fail = () => reject(coded('busy')); }) });
  const controller = new AbortController();
  const pending = h.c.ingestFrame(h.sid, h.frame, { signal: controller.signal });
  controller.abort('timeout');
  fail();
  assert.equal(((r) => !r.ok && r.error)(await pending), 'aborted');
});
