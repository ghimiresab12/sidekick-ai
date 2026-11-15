/**
 * HTTP bridge integration tests: real server on 127.0.0.1 (random port), real
 * SidekickCoordinator + engine, Prabin's reasoning module with its MOCK provider (via
 * the production wiring), a controllable mock VisionPort and a fake engine clock.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { createBridge, MAX_FRAME_BYTES, type BridgeLogEntry } from '../../src/bridge/http-bridge.js';
import { SidekickCoordinator } from '../../src/coordinator/coordinator.js';
import type { FrameInput, ReasoningFn, ScreenDescription, VisionPort } from '../../src/coordinator/ports.js';
import { FakeClock, at } from '../../src/mock/demo-scenario.js';

const AGENT = 'agent-token-0123456789-abcdefghijklmnop';
const CONTROL = 'control-token-0123456789-abcdefghijklmn';
const SECRET_TEXT = 'my private phone number is 555-0100';

interface Wiring { createReasoning(mode: string, env: Record<string, string | undefined>): { reasoning: ReasoningFn; label: string } }
const wiringUrl = new URL('../../../src/bridge/reasoning-wiring.mts', import.meta.url).href;
const { createReasoning } = (await import(wiringUrl)) as Wiring;

function gate() {
  let open = true;
  let waiters: Array<() => void> = [];
  return {
    hold() { open = false; },
    release() { open = true; waiters.forEach((w) => w()); waiters = []; },
    wait(): Promise<void> { return open ? Promise.resolve() : new Promise((r) => waiters.push(r)); },
  };
}

/** Wraps a custom VisionPort so tests can still count calls. */
function countingVision(inner: VisionPort, seen: Array<{ captureGeneration: number; observedAt: string; bytes: number; mimeType: string }>): VisionPort {
  return {
    describe(frame, signal) {
      seen.push({ captureGeneration: frame.captureGeneration, observedAt: frame.observedAt, bytes: frame.image.byteLength, mimeType: frame.mimeType });
      return inner.describe(frame, signal);
    },
  };
}

const GAP: ScreenDescription = {
  summary: 'Left defensive zone clearly visible and empty.',
  evidenceQuality: 'clear',
  facts: { leftZoneVisible: true, leftZoneUncovered: true },
};

interface Options { vision?: boolean | VisionPort; frameTimeoutMs?: number; maxFrameBytes?: number }

async function start(options: Options = {}) {
  const clock = new FakeClock();
  clock.set(1);
  const visionGate = gate();
  const seen: Array<{ captureGeneration: number; observedAt: string; bytes: number; mimeType: string }> = [];
  const vision: VisionPort = {
    async describe(frame: FrameInput, signal: AbortSignal) {
      seen.push({ captureGeneration: frame.captureGeneration, observedAt: frame.observedAt, bytes: frame.image.byteLength, mimeType: frame.mimeType });
      await visionGate.wait();
      if (signal.aborted) throw new Error('aborted');
      return GAP;
    },
  };
  let n = 0;
  const coordinator = new SidekickCoordinator({
    reasoning: createReasoning('mock', {}).reasoning,
    ...(options.vision === false ? {} : { vision: typeof options.vision === 'object' ? countingVision(options.vision, seen) : vision }),
    now: clock.now,
    conditionFactKeys: ['leftZoneVisible', 'leftZoneUncovered'],
    engine: { newId: () => `id${++n}` },
  });
  const logs: BridgeLogEntry[] = [];
  const bridge = createBridge({
    coordinator,
    agentToken: AGENT,
    controlToken: CONTROL,
    frameTimeoutMs: options.frameTimeoutMs ?? 2_000,
    ...(options.maxFrameBytes ? { maxFrameBytes: options.maxFrameBytes } : {}),
    onRequestLog: (e) => logs.push(e),
  });
  const { url, port } = await bridge.listen(0);

  async function api(method: string, path: string, opts: { token?: string; json?: unknown; body?: string | Uint8Array; headers?: Record<string, string> } = {}) {
    const headers: Record<string, string> = { ...opts.headers };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    let body = opts.body;
    if (opts.json !== undefined) {
      headers['content-type'] ??= 'application/json';
      body = JSON.stringify(opts.json);
    }
    const res = await fetch(url + path, { method, headers, ...(body !== undefined ? { body } : {}) });
    const text = await res.text();
    return { status: res.status, headers: res.headers, text, body: text ? (JSON.parse(text) as Record<string, unknown>) : undefined };
  }

  /**
   * Raw request for cases fetch cannot express: Host/Origin spoofing, chunked bodies,
   * slow or never-finished uploads, and client disconnects. Chunks are written
   * `chunkDelayMs` apart; writing stops as soon as a response arrives.
   */
  function raw(opts: {
    method: string; path: string; headers?: Record<string, string>;
    chunks?: Buffer[]; chunkDelayMs?: number; end?: boolean; destroyAfterMs?: number;
  }) {
    return new Promise<{ status: number; text: string; elapsedMs: number } | 'destroyed'>((resolve, reject) => {
      const started = Date.now();
      let responded = false;
      const req = httpRequest({ host: '127.0.0.1', port, method: opts.method, path: opts.path, headers: opts.headers }, (res) => {
        responded = true;
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { text += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text, elapsedMs: Date.now() - started }));
        res.on('error', () => {});
      });
      req.on('error', (e) => {
        if (responded) return; // server closed the connection after answering
        if (opts.destroyAfterMs !== undefined) resolve('destroyed');
        else reject(e);
      });
      void (async () => {
        for (const c of opts.chunks ?? []) {
          if (responded || req.destroyed) return;
          req.write(c);
          if (opts.chunkDelayMs) await new Promise((r) => setTimeout(r, opts.chunkDelayMs));
        }
        if (opts.end !== false && !responded && !req.destroyed) req.end();
      })();
      if (opts.destroyAfterMs !== undefined) {
        setTimeout(() => { if (!responded) { req.destroy(); resolve('destroyed'); } }, opts.destroyAfterMs);
      }
    });
  }

  async function activeSession(room = 'room-1') {
    const created = await api('POST', '/v1/sessions', { token: AGENT, json: { externalRef: room } });
    const id = created.body!.sessionId as string;
    coordinator.engine.addParticipant(id, { displayName: 'Alex' });
    coordinator.engine.confirmActivity(id, 'gaming');
    const consent = await api('POST', `/v1/sessions/${id}/consent`, { token: CONTROL, json: { consent: true } });
    assert.equal(consent.status, 200);
    return id;
  }

  const frame = (id: string, generation: number | string, observedAt: string, body: Uint8Array = new Uint8Array([1, 2, 3]), type = 'image/jpeg') =>
    api('POST', `/v1/sessions/${id}/frames`, {
      token: AGENT,
      body,
      headers: { 'content-type': type, 'x-capture-generation': String(generation), 'x-observed-at': observedAt },
    });
  const transcript = (id: string, json: unknown) => api('POST', `/v1/sessions/${id}/transcripts`, { token: AGENT, json });
  const capture = async (id: string) => (await api('GET', `/v1/sessions/${id}/capture`, { token: AGENT })).body!;

  return { clock, coordinator, bridge, url, port, logs, seen, visionGate, api, raw, activeSession, frame, transcript, capture };
}

type Harness = Awaited<ReturnType<typeof start>>;
async function withBridge(options: Options, fn: (h: Harness) => Promise<void>) {
  const h = await start(options);
  try {
    await fn(h);
  } finally {
    h.visionGate.release();
    await h.bridge.close();
  }
}

// ── Success paths ──────────────────────────────────────────────────────────

test('health is public and reveals no session data', () => withBridge({}, async (h) => {
  const r = await h.api('GET', '/v1/health');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true });
  assert.equal(r.headers.get('cache-control'), 'no-store');
}));

test('agent creates an INACTIVE session; same room returns the same session', () => withBridge({}, async (h) => {
  const a = await h.api('POST', '/v1/sessions', { token: AGENT, json: { externalRef: 'room-1' } });
  assert.equal(a.status, 201);
  assert.deepEqual(a.body, { ok: true, sessionId: a.body!.sessionId, status: 'starting', consentGiven: false, captureGeneration: 0, acceptingInput: false });
  const b = await h.api('POST', '/v1/sessions', { token: AGENT, json: { externalRef: 'room-1' } });
  assert.equal(b.status, 200);
  assert.equal(b.body!.sessionId, a.body!.sessionId);
}));

test('transcript → coordinator → role applied; capture metadata preserved', () => withBridge({}, async (h) => {
  const id = await h.activeSession();
  h.clock.set(3);
  const r = await h.transcript(id, { captureGeneration: 1, observedAt: at(2), text: 'Alex is responsible for left defense.' });
  assert.equal(r.status, 202);
  assert.equal(r.body!.captureGeneration, 1);
  assert.equal(r.body!.observedAt, at(2), 'capture time, not processing time');
  await h.coordinator.whenIdle(id);
  const snap = h.coordinator.engine.getSession(id);
  assert.ok(snap.ok);
  assert.equal(snap.value.participants[0]?.role, 'left defense');
}));

test('frame → vision → coordinator; generation and observedAt preserved end to end; card created', () => withBridge({}, async (h) => {
  const id = await h.activeSession();
  h.clock.set(3);
  await h.transcript(id, { captureGeneration: 1, observedAt: at(2), text: 'Alex is responsible for left defense.' });
  await h.coordinator.whenIdle(id);
  h.clock.set(9);
  const observedAt = '2026-11-14T18:00:08.000Z';
  const r = await h.frame(id, 1, observedAt);
  assert.equal(r.status, 200);
  assert.equal(r.body!.captureGeneration, 1);
  assert.equal(r.body!.observedAt, observedAt);
  assert.deepEqual(h.seen.at(-1), { captureGeneration: 1, observedAt, bytes: 3, mimeType: 'image/jpeg' });
  await h.coordinator.whenIdle(id);
  const snap = h.coordinator.engine.getSession(id);
  assert.ok(snap.ok);
  assert.equal(snap.value.recommendations.length, 1);
  assert.equal(snap.value.recommendations[0]!.title, 'Left defense appears exposed');
  const stored = h.coordinator.engine.listObservations(id, { source: 'screen' });
  assert.ok(stored.ok);
  const screen = stored.value[0]!;
  assert.ok(screen.source === 'screen' && screen.frameRef === undefined, 'no image data or reference stored');
}));

test('frames are processed concurrently (agent need not wait for one before sending the next)', () => withBridge({}, async (h) => {
  const id = await h.activeSession();
  h.clock.set(9);
  h.visionGate.hold();
  const a = h.frame(id, 1, at(8));
  const b = h.frame(id, 1, at(8.5));
  while (h.seen.length < 2) await new Promise((r) => setTimeout(r, 5));
  h.visionGate.release();
  assert.deepEqual([(await a).status, (await b).status], [200, 200]);
}));

test('without a configured VisionPort frames return 503 vision_unavailable', () => withBridge({ vision: false }, async (h) => {
  const id = await h.activeSession();
  h.clock.set(9);
  const r = await h.frame(id, 1, at(8));
  assert.deepEqual([r.status, r.body!.error], [503, 'vision_unavailable']);
}));

// ── Authorization ──────────────────────────────────────────────────────────

test('missing or wrong tokens are rejected with 401 before the body is processed', () => withBridge({}, async (h) => {
  // (A trailing space would be stripped by HTTP itself; a doubled separator space is not.)
  for (const token of [undefined, 'wrong-token-but-long-enough-0123456789', ` ${AGENT}`, AGENT.slice(0, -1)]) {
    const r = await h.api('POST', '/v1/sessions', { ...(token ? { token } : {}), body: '{not json', headers: { 'content-type': 'application/json' } });
    assert.equal(r.status, 401, `token ${String(token)}`);
    assert.equal(r.body!.error, 'unauthorized', 'auth is decided before JSON parsing');
    assert.equal(r.headers.get('www-authenticate'), 'Bearer');
  }
  const id = await h.activeSession();
  const big = await h.api('POST', `/v1/sessions/${id}/frames`, {
    body: new Uint8Array(1024 * 1024), headers: { 'content-type': 'image/jpeg', 'x-capture-generation': '1', 'x-observed-at': at(1) },
  });
  assert.equal(big.status, 401);
  assert.equal(h.seen.length, 0, 'vision never called');
}));

test('each token is limited to its role (agent cannot grant consent; control cannot ingest)', () => withBridge({}, async (h) => {
  const created = await h.api('POST', '/v1/sessions', { token: AGENT, json: { externalRef: 'r' } });
  const id = created.body!.sessionId as string;
  const forbidden = [
    await h.api('POST', '/v1/sessions', { token: CONTROL, json: { externalRef: 'x' } }),
    await h.api('POST', `/v1/sessions/${id}/consent`, { token: AGENT, json: { consent: true } }),
    await h.api('POST', `/v1/sessions/${id}/pause`, { token: AGENT }),
    await h.api('DELETE', `/v1/sessions/${id}`, { token: AGENT }),
    await h.transcript(id, { captureGeneration: 1, observedAt: at(1), text: 'x' }).then(() => h.api('POST', `/v1/sessions/${id}/transcripts`, { token: CONTROL, json: {} })),
  ];
  for (const r of forbidden) assert.deepEqual([r.status, r.body!.error], [403, 'forbidden']);
  const snap = h.coordinator.engine.getSession(id);
  assert.ok(snap.ok);
  assert.equal(snap.value.consentGiven, false, 'agent could not self-consent');
  assert.equal((await h.api('GET', `/v1/sessions/${id}/capture`, { token: CONTROL })).status, 200, 'both roles may read capture state');
}));

test('browser Origin and foreign Host headers are refused (no CORS, DNS-rebinding guard)', () => withBridge({}, async (h) => {
  const origin = await h.raw({ method: 'GET', path: '/v1/health', headers: { origin: 'https://evil.example' } });
  assert.ok(origin !== 'destroyed');
  assert.equal(origin.status, 403);
  assert.match(origin.text, /forbidden_origin/);
  const host = await h.raw({ method: 'GET', path: '/v1/health', headers: { host: 'evil.example' } });
  assert.ok(host !== 'destroyed');
  assert.equal(host.status, 403);
  assert.match(host.text, /forbidden_host/);
  const local = await h.raw({ method: 'GET', path: '/v1/health', headers: { host: `localhost:${h.port}` } });
  assert.ok(local !== 'destroyed');
  assert.equal(local.status, 200);
}));

test('unknown routes, wrong methods and malformed session IDs', () => withBridge({}, async (h) => {
  assert.equal((await h.api('GET', '/v1/nope', { token: AGENT })).status, 404);
  const wrong = await h.api('GET', '/v1/sessions', { token: AGENT });
  assert.equal(wrong.status, 405);
  assert.equal(wrong.headers.get('allow'), 'POST');
  assert.equal((await h.api('GET', '/v1/sessions/bad%20id/capture', { token: AGENT })).status, 404);
  assert.equal((await h.api('GET', '/v1/sessions/unknown/capture', { token: AGENT })).body!.error, 'session_not_found');
}));

// ── Malformed input and size limits ────────────────────────────────────────

test('malformed JSON bodies: content type, syntax, unknown keys, size', () => withBridge({}, async (h) => {
  const post = (opts: Parameters<typeof h.api>[2]) => h.api('POST', '/v1/sessions', { token: AGENT, ...opts });
  assert.deepEqual((await post({ body: '{"externalRef":"r"}', headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.deepEqual((await post({ body: '{oops', headers: { 'content-type': 'application/json' } })).body!.error, 'invalid_json');
  assert.equal((await post({ json: { externalRef: 'r', extra: 1 } })).status, 400);
  assert.equal((await post({ json: [] })).status, 400);
  assert.equal((await post({ json: {} })).status, 400);
  const big = await post({ json: { externalRef: 'x'.repeat(20_000) } });
  assert.deepEqual([big.status, big.body!.error], [413, 'payload_too_large']);
}));

test('malformed transcripts: generation type, timestamps, fields', () => withBridge({}, async (h) => {
  const id = await h.activeSession();
  h.clock.set(10);
  const cases: Array<[unknown, number, string]> = [
    [{ captureGeneration: '1', observedAt: at(9), text: 'x' }, 400, 'invalid_generation'],
    [{ captureGeneration: 0, observedAt: at(9), text: 'x' }, 400, 'invalid_generation'],
    [{ captureGeneration: 1, observedAt: 'yesterday', text: 'x' }, 400, 'invalid_timestamp'],
    [{ captureGeneration: 1, observedAt: '2026-02-30T00:00:00Z', text: 'x' }, 400, 'invalid_timestamp'],
    [{ captureGeneration: 1, observedAt: at(16), text: 'x' }, 422, 'timestamp_out_of_range'],
    [{ captureGeneration: 1, observedAt: at(9) }, 400, 'invalid_input'],
    [{ captureGeneration: 1, observedAt: at(9), text: 'x', audio: 'AAAA' }, 400, 'invalid_input'],
  ];
  for (const [json, status, error] of cases) {
    const r = await h.transcript(id, json);
    assert.deepEqual([r.status, r.body!.error], [status, error], JSON.stringify(json));
  }
}));

test('malformed frames are rejected with zero vision calls', () => withBridge({ maxFrameBytes: 1024 }, async (h) => {
  const id = await h.activeSession();
  h.clock.set(10);
  const cases: Array<[Promise<{ status: number; body?: Record<string, unknown> }>, number, string]> = [
    [h.frame(id, 1, at(9), new Uint8Array(2048)), 413, 'payload_too_large'],
    [h.frame(id, 1, at(9), new Uint8Array(0)), 400, 'invalid_input'],
    [h.frame(id, 1, at(9), new Uint8Array([1]), 'image/gif'), 415, 'unsupported_media_type'],
    [h.frame(id, 'abc', at(9)), 400, 'invalid_generation'],
    [h.frame(id, '0', at(9)), 400, 'invalid_generation'],
    [h.frame(id, '1.5', at(9)), 400, 'invalid_generation'],
    [h.frame(id, 1, 'yesterday'), 400, 'invalid_timestamp'],
    [h.frame(id, 1, at(16)), 422, 'timestamp_out_of_range'],
    [h.frame(id, 1, at(-10)), 422, 'timestamp_out_of_range'],
  ];
  for (const [promise, status, error] of cases) {
    const r = await promise;
    assert.deepEqual([r.status, r.body!.error], [status, error]);
  }
  const noMeta = await h.api('POST', `/v1/sessions/${id}/frames`, { token: AGENT, body: new Uint8Array([1]), headers: { 'content-type': 'image/png' } });
  assert.deepEqual([noMeta.status, noMeta.body!.error], [400, 'invalid_generation']);
  assert.equal(h.seen.length, 0);
}));

test('oversized frame without Content-Length (chunked) is cut off while streaming', () => withBridge({ maxFrameBytes: 1024 }, async (h) => {
  const id = await h.activeSession();
  h.clock.set(10);
  const r = await h.raw({
    method: 'POST', path: `/v1/sessions/${id}/frames`,
    headers: { authorization: `Bearer ${AGENT}`, 'content-type': 'image/png', 'transfer-encoding': 'chunked', 'x-capture-generation': '1', 'x-observed-at': at(9) },
    chunks: [Buffer.alloc(600), Buffer.alloc(600)],
  });
  assert.ok(r !== 'destroyed');
  assert.equal(r.status, 413);
  assert.equal(h.seen.length, 0);
}));

test('bridge configuration is validated', () => {
  const coordinator = new SidekickCoordinator({ reasoning: async () => ({ ok: false, error: 'x' }) });
  assert.throws(() => createBridge({ coordinator, agentToken: 'short', controlToken: CONTROL }), RangeError);
  assert.throws(() => createBridge({ coordinator, agentToken: AGENT, controlToken: AGENT }), RangeError);
  assert.throws(() => createBridge({ coordinator, agentToken: AGENT, controlToken: CONTROL, maxFrameBytes: MAX_FRAME_BYTES + 1 }), RangeError);
  assert.throws(() => createBridge({ coordinator, agentToken: AGENT, controlToken: CONTROL, frameTimeoutMs: 0 }), RangeError);
});

// ── Consent, generations, lifecycle ────────────────────────────────────────

test('explicit consent is required and must be exactly {"consent": true}', () => withBridge({}, async (h) => {
  const created = await h.api('POST', '/v1/sessions', { token: AGENT, json: { externalRef: 'r' } });
  const id = created.body!.sessionId as string;
  const before = await h.transcript(id, { captureGeneration: 1, observedAt: at(1), text: 'hi' });
  assert.deepEqual([before.status, before.body!.error], [409, 'consent_required']);
  for (const json of [{}, { consent: 'yes' }, { consent: 1 }, { consent: false }]) {
    const r = await h.api('POST', `/v1/sessions/${id}/consent`, { token: CONTROL, json });
    assert.equal(r.status, 400, JSON.stringify(json));
  }
  const ok = await h.api('POST', `/v1/sessions/${id}/consent`, { token: CONTROL, json: { consent: true } });
  assert.deepEqual([ok.status, ok.body!.status, ok.body!.captureGeneration, ok.body!.acceptingInput], [200, 'active', 1, true]);
  const again = await h.api('POST', `/v1/sessions/${id}/consent`, { token: CONTROL, json: { consent: true } });
  assert.deepEqual([again.status, again.body!.error], [409, 'invalid_transition']);
}));

test('stale generations: pre-pause frames after resume, paused and future generations', () => withBridge({}, async (h) => {
  const id = await h.activeSession();
  h.clock.set(5);
  await h.api('POST', `/v1/sessions/${id}/pause`, { token: CONTROL });
  const resumed = await h.api('POST', `/v1/sessions/${id}/resume`, { token: CONTROL });
  assert.equal(resumed.body!.captureGeneration, 3);
  h.clock.set(6);
  const old = await h.frame(id, 1, at(4));
  assert.deepEqual([old.status, old.body!.error], [409, 'stale_evidence']);
  const paused = await h.frame(id, 2, at(5));
  assert.equal(paused.status, 409);
  const future = await h.frame(id, 4, at(6));
  assert.deepEqual([future.status, future.body!.error], [409, 'invalid_generation']);
  const pausedTranscript = await h.transcript(id, { captureGeneration: 2, observedAt: at(5), text: 'during pause' });
  assert.deepEqual([pausedTranscript.status, pausedTranscript.body!.error], [409, 'invalid_generation']);
  assert.equal(h.seen.length, 0, 'stale frames never reach vision');
  assert.equal((await h.frame(id, 3, at(6))).status, 200);
}));

test('lifecycle: pause → resume → end → discard via control routes', () => withBridge({}, async (h) => {
  const id = await h.activeSession('room-life');
  h.clock.set(5);
  const paused = await h.api('POST', `/v1/sessions/${id}/pause`, { token: CONTROL });
  assert.deepEqual([paused.status, paused.body!.status, paused.body!.acceptingInput, paused.body!.captureGeneration], [200, 'paused', false, 2]);
  const blocked = await h.transcript(id, { captureGeneration: 2, observedAt: at(5), text: 'x' });
  assert.equal(blocked.status, 409);
  assert.equal((await h.capture(id)).acceptingInput, false);
  assert.equal((await h.api('POST', `/v1/sessions/${id}/resume`, { token: CONTROL })).body!.captureGeneration, 3);
  assert.equal((await h.capture(id)).acceptingInput, true);
  const ended = await h.api('POST', `/v1/sessions/${id}/end`, { token: CONTROL });
  assert.deepEqual([ended.body!.status, ended.body!.acceptingInput], ['ended', false]);
  assert.deepEqual((await h.api('POST', `/v1/sessions/${id}/resume`, { token: CONTROL })).status, 409);
  const fresh = await h.api('POST', '/v1/sessions', { token: AGENT, json: { externalRef: 'room-life' } });
  assert.equal(fresh.status, 201, 'an ended room gets a new session');
  assert.notEqual(fresh.body!.sessionId, id);
  assert.equal((await h.api('DELETE', `/v1/sessions/${id}`, { token: CONTROL })).status, 204);
  assert.equal((await h.api('GET', `/v1/sessions/${id}/capture`, { token: AGENT })).status, 404);
  assert.equal((await h.api('DELETE', `/v1/sessions/${id}`, { token: CONTROL })).status, 404);
}));

// ── Timeouts and cancellation ──────────────────────────────────────────────

const screens = (h: Harness, id: string) => {
  const r = h.coordinator.engine.listObservations(id, { source: 'screen' });
  return r.ok ? r.value.length : -1;
};

test('vision exceeding frameTimeoutMs returns 504 and the late result is never stored', () => withBridge({ frameTimeoutMs: 50 }, async (h) => {
  const id = await h.activeSession();
  h.clock.set(9);
  h.visionGate.hold();
  const r = await h.frame(id, 1, at(8));
  assert.deepEqual([r.status, r.body!.error], [504, 'vision_timeout']);
  h.visionGate.release();
  await h.coordinator.whenIdle(id);
  assert.equal(screens(h, id), 0);
}));

test('pause while a frame is in vision returns 409 aborted and stores nothing', () => withBridge({}, async (h) => {
  const id = await h.activeSession();
  h.clock.set(9);
  h.visionGate.hold();
  const pending = h.frame(id, 1, at(8));
  while (h.seen.length < 1) await new Promise((r) => setTimeout(r, 5));
  await h.api('POST', `/v1/sessions/${id}/pause`, { token: CONTROL });
  h.visionGate.release();
  const r = await pending;
  assert.deepEqual([r.status, r.body!.error], [409, 'aborted']);
  assert.equal(screens(h, id), 0);
}));

test('end and discard while a frame is in vision leave no stored frame', () => withBridge({}, async (h) => {
  for (const action of ['end', 'discard'] as const) {
    const id = await h.activeSession(`room-${action}`);
    h.clock.set(9);
    h.visionGate.hold();
    const seenBefore = h.seen.length;
    const pending = h.frame(id, 1, at(8));
    while (h.seen.length === seenBefore) await new Promise((r) => setTimeout(r, 5));
    if (action === 'end') await h.api('POST', `/v1/sessions/${id}/end`, { token: CONTROL });
    else await h.api('DELETE', `/v1/sessions/${id}`, { token: CONTROL });
    h.visionGate.release();
    const r = await pending;
    assert.equal(r.status, 409, action);
    assert.equal(screens(h, id), action === 'end' ? 0 : -1);
  }
}));

test('client disconnect mid-vision cancels the frame; the bridge stays healthy', () => withBridge({}, async (h) => {
  const id = await h.activeSession();
  h.clock.set(9);
  h.visionGate.hold();
  const outcome = await h.raw({
    method: 'POST', path: `/v1/sessions/${id}/frames`,
    headers: { authorization: `Bearer ${AGENT}`, 'content-type': 'image/jpeg', 'content-length': '3', 'x-capture-generation': '1', 'x-observed-at': at(8) },
    chunks: [Buffer.from([1, 2, 3])],
    destroyAfterMs: 50,
  });
  assert.equal(outcome, 'destroyed');
  while (h.seen.length < 1) await new Promise((r) => setTimeout(r, 5));
  await new Promise((r) => setTimeout(r, 20));
  h.visionGate.release();
  await h.coordinator.whenIdle(id);
  assert.equal(screens(h, id), 0, 'cancelled frame not ingested');
  assert.equal((await h.api('GET', '/v1/health')).status, 200);
  assert.equal((await h.capture(id)).status, 'active', 'session state intact');
}));

// ── Privacy ────────────────────────────────────────────────────────────────

test('logs and error bodies contain no transcript text, image bytes, tokens or concrete IDs', () => withBridge({}, async (h) => {
  const id = await h.activeSession();
  h.clock.set(10);
  const failed = await h.transcript(id, { captureGeneration: 1, observedAt: 'bad', text: SECRET_TEXT });
  assert.ok(!failed.text.includes('555'), 'error body never echoes input');
  await h.transcript(id, { captureGeneration: 1, observedAt: at(9), text: SECRET_TEXT });
  await h.frame(id, 1, at(9), new TextEncoder().encode('RAW-IMAGE-BYTES'));
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(h.logs.length > 0);
  for (const entry of h.logs) assert.deepEqual(Object.keys(entry).sort(), ['durationMs', 'method', 'route', 'status']);
  const dump = JSON.stringify(h.logs);
  for (const secret of ['555', 'RAW-IMAGE', AGENT, CONTROL, id]) assert.ok(!dump.includes(secret), `log leaked ${secret.slice(0, 8)}`);
  assert.ok(h.logs.some((e) => e.route === '/v1/sessions/:id/frames'), 'route patterns only');
}));

// ── Round 2 fixes: one deadline across upload + vision; bodyless routes ─────

const frameHeaders = (generation = '1', observedAt = at(8)) => ({
  authorization: `Bearer ${AGENT}`, 'content-type': 'image/jpeg', 'x-capture-generation': generation, 'x-observed-at': observedAt,
});

test('[B2-1] incomplete upload: 504 at the deadline, no vision, nothing stored (original repro)', () => withBridge({ frameTimeoutMs: 50 }, async (h) => {
  const id = await h.activeSession();
  h.clock.set(9);
  const r = await h.raw({
    method: 'POST', path: `/v1/sessions/${id}/frames`,
    headers: { ...frameHeaders(), 'content-length': '3' },
    chunks: [Buffer.from([1])], end: false, // one chunk, body never finished
  });
  assert.ok(r !== 'destroyed');
  assert.equal(r.status, 504);
  assert.match(r.text, /vision_timeout/);
  assert.ok(r.elapsedMs < 1000, `answered at the deadline (${r.elapsedMs} ms)`);
  assert.equal(h.seen.length, 0, 'vision never invoked');
  assert.equal(screens(h, id), 0);
  assert.equal((await h.api('GET', '/v1/health')).status, 200, 'bridge healthy afterwards');
}));

test('[B2-1] slow chunked upload exceeding the deadline is cut off at the deadline', () => withBridge({ frameTimeoutMs: 100 }, async (h) => {
  const id = await h.activeSession();
  h.clock.set(9);
  const r = await h.raw({
    method: 'POST', path: `/v1/sessions/${id}/frames`,
    headers: { ...frameHeaders(), 'transfer-encoding': 'chunked' },
    chunks: Array.from({ length: 20 }, () => Buffer.from([7])), chunkDelayMs: 40,
  });
  assert.ok(r !== 'destroyed');
  assert.equal(r.status, 504);
  assert.ok(r.elapsedMs < 600, `not after the full 800 ms upload (${r.elapsedMs} ms)`);
  assert.equal(h.seen.length, 0);
  assert.equal(screens(h, id), 0);
}));

test('[B2-1] ONE deadline spans upload and vision: slow upload + cancellation-ignoring vision', () =>
  withBridge({ frameTimeoutMs: 200, vision: { describe: () => new Promise(() => {}) } }, async (h) => {
    const id = await h.activeSession();
    h.clock.set(9);
    const r = await h.raw({
      method: 'POST', path: `/v1/sessions/${id}/frames`,
      headers: { ...frameHeaders(), 'content-length': '3' },
      chunks: [Buffer.from([1]), Buffer.from([2]), Buffer.from([3])], chunkDelayMs: 50, // ~100 ms upload
    });
    assert.ok(r !== 'destroyed');
    assert.equal(r.status, 504);
    assert.equal(h.seen.length, 1, 'vision started after the complete upload');
    assert.ok(r.elapsedMs < 400, `total bounded by one 200 ms deadline, not upload + 200 ms (${r.elapsedMs} ms)`);
    assert.equal(screens(h, id), 0);
  }));

test('[B2-1] client disconnect during upload: no vision, nothing stored, no crash', () => withBridge({}, async (h) => {
  const id = await h.activeSession();
  h.clock.set(9);
  const outcome = await h.raw({
    method: 'POST', path: `/v1/sessions/${id}/frames`,
    headers: { ...frameHeaders(), 'content-length': '1000' },
    chunks: [Buffer.alloc(100)], end: false, destroyAfterMs: 30,
  });
  assert.equal(outcome, 'destroyed');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(h.seen.length, 0);
  assert.equal(screens(h, id), 0);
  assert.equal((await h.api('GET', '/v1/health')).status, 200);
  assert.equal((await h.capture(id)).status, 'active');
}));

test('[B2-1] timeout during vision answers exactly once and the late result is dropped', () =>
  withBridge({ frameTimeoutMs: 60, vision: { describe: () => new Promise((r) => setTimeout(() => r(GAP), 150)) } }, async (h) => {
    const id = await h.activeSession();
    h.clock.set(9);
    const r = await h.frame(id, 1, at(8));
    assert.deepEqual([r.status, r.body!.error], [504, 'vision_timeout']);
    await new Promise((res) => setTimeout(res, 200)); // let the slow vision result arrive
    await h.coordinator.whenIdle(id);
    assert.equal(screens(h, id), 0, 'late vision result never stored');
    assert.equal((await h.api('GET', '/v1/health')).status, 200);
  }));

test('[B2-3] bodyless routes reject chunked or non-empty bodies and leave state unchanged', () => withBridge({}, async (h) => {
  const id = await h.activeSession();
  for (const [method, path] of [['POST', 'pause'], ['POST', 'end'], ['DELETE', '']] as const) {
    const url = `/v1/sessions/${id}${path ? `/${path}` : ''}`;
    const chunked = await h.raw({
      method, path: url,
      headers: { authorization: `Bearer ${CONTROL}`, 'transfer-encoding': 'chunked' },
      chunks: [Buffer.from('{}')], end: false, // never finishes: must not stall
    });
    assert.ok(chunked !== 'destroyed');
    assert.equal(chunked.status, 400, `${method} ${url} chunked`);
    assert.match(chunked.text, /unexpected_body/);
    assert.ok(chunked.elapsedMs < 1000, 'answered promptly, not stalled');
    const sized = await h.api(method, url, { token: CONTROL, body: 'x' });
    assert.deepEqual([sized.status, sized.body!.error], [400, 'unexpected_body']);
    assert.equal((await h.capture(id)).status, 'active', 'session state unchanged');
  }
  // Resume path: pause cleanly, then a resume with a body must not resume.
  assert.equal((await h.api('POST', `/v1/sessions/${id}/pause`, { token: CONTROL })).status, 200);
  const resumeWithBody = await h.api('POST', `/v1/sessions/${id}/resume`, { token: CONTROL, body: '{}' });
  assert.deepEqual([resumeWithBody.status, resumeWithBody.body!.error], [400, 'unexpected_body']);
  assert.equal((await h.capture(id)).status, 'paused');
  // Authentication still comes first.
  const anon = await h.api('POST', `/v1/sessions/${id}/resume`, { body: 'x' });
  assert.equal(anon.status, 401);
  assert.equal((await h.api('POST', `/v1/sessions/${id}/resume`, { token: CONTROL })).status, 200, 'bodyless request still works');
}));
