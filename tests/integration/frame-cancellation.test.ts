/** Frame cancellation must not depend on the vision adapter honouring its AbortSignal. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SidekickCoordinator } from '../../src/coordinator/coordinator.js';
import type { FrameInput, VisionPort } from '../../src/coordinator/ports.js';

const nowMs = Date.parse('2026-11-15T04:00:00Z');
/** Never resolves and ignores the signal — the worst-case adapter. */
const stuckVision: VisionPort = { describe: () => new Promise(() => {}) };

function setup() {
  const c = new SidekickCoordinator({ reasoning: async () => ({ ok: false, error: 'mock' }), vision: stuckVision, now: () => new Date(nowMs) });
  const created = c.createSession();
  assert.ok(created.ok);
  const started = c.startWithConsent(created.value.id);
  assert.ok(started.ok);
  const frame: FrameInput = {
    mediaSource: 'screen_share', captureGeneration: started.value.captureGeneration, observedAt: new Date(nowMs).toISOString(),
    image: new Uint8Array([1]), mimeType: 'image/png',
  };
  return { c, sid: created.value.id, frame };
}

const within = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`still pending after ${ms} ms`)), ms))]);

test('caller abort returns promptly even if vision never resolves; nothing is stored', async () => {
  const { c, sid, frame } = setup();
  const controller = new AbortController();
  const pending = c.ingestFrame(sid, frame, { signal: controller.signal });
  setTimeout(() => controller.abort('timeout'), 10);
  const r = await within(pending, 1000);
  assert.deepEqual(r, { ok: false, error: 'aborted' });
  const stored = c.engine.listObservations(sid);
  assert.ok(stored.ok && stored.value.length === 0);
});

test('pause returns an in-flight frame promptly even if vision never resolves', async () => {
  const { c, sid, frame } = setup();
  const pending = c.ingestFrame(sid, frame);
  await new Promise((r) => setTimeout(r, 5));
  c.pause(sid);
  assert.deepEqual(await within(pending, 1000), { ok: false, error: 'aborted' });
  await within(c.whenIdle(sid), 1000);
});

test('an already-aborted caller signal never reaches vision', async () => {
  const { c, sid, frame } = setup();
  let calls = 0;
  const counting = new SidekickCoordinator({
    reasoning: async () => ({ ok: false, error: 'mock' }), now: () => new Date(nowMs),
    vision: { describe: async () => { calls++; return { summary: 's', evidenceQuality: 'clear' }; } },
  });
  void c; void sid;
  const created = counting.createSession();
  assert.ok(created.ok);
  assert.ok(counting.startWithConsent(created.value.id).ok);
  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(await counting.ingestFrame(created.value.id, frame, { signal: controller.signal }), { ok: false, error: 'aborted' });
  assert.equal(calls, 0);
});
