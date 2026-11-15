/**
 * Milestone 3: Gemini vision ↔ HTTP bridge, end to end through the PRODUCTION runtime
 * (`createBridgeRuntime`) with Gemini HTTP mocked by Prabin's `mockVisionFetch` and
 * `scenePng` fixtures. A network guard fails any non-loopback request, and the last test
 * asserts that no real Gemini (or other external) call was attempted.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { createBridgeRuntime, RuntimeConfigError, type BridgeRuntime } from '../../src/bridge/runtime.js';
import type { BridgeLogEntry } from '../../src/bridge/http-bridge.js';
import { SidekickCoordinator } from '../../src/coordinator/coordinator.js';
import type { ScreenDescription, VisionPort } from '../../src/coordinator/ports.js';
import type { Observation } from '../../src/contracts/types.js';

// ── Network guard (installed before anything can call fetch) ───────────────
const realFetch = globalThis.fetch;
let externalAttempts = 0;
globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith('http://127.0.0.1:')) {
    externalAttempts += 1;
    return Promise.reject(new Error('external network blocked in tests'));
  }
  return realFetch(input, init);
}) as typeof fetch;

const root = (p: string) => new URL(`../../../${p}`, import.meta.url).href;
const { mockVisionFetch } = (await import(root('examples/vision-demo.mjs'))) as { mockVisionFetch(scene: string): () => Promise<Response> };
const { scenePng } = (await import(root('examples/vision-fixtures.mjs'))) as { scenePng(scene: string): Uint8Array };
const { interpretVision, createGeminiVision, VISION_FACT_KEYS, VISION_PROFILE } = (await import(root('src/adapters/model/gemini-vision.mts'))) as {
  interpretVision(v: unknown): ScreenDescription;
  createGeminiVision(o: Record<string, unknown>): VisionPort;
  VISION_FACT_KEYS: readonly string[];
  VISION_PROFILE: string;
};

const AGENT = 'agent-token-0123456789-abcdefghijklmnop';
const CONTROL = 'control-token-0123456789-abcdefghijklmn';
const KEY = 'test-only-not-a-real-gemini-key-0000';
const ENV = {
  SIDEKICK_AGENT_TOKEN: AGENT, SIDEKICK_CONTROL_TOKEN: CONTROL,
  SIDEKICK_VISION: 'gemini', GEMINI_API_KEY: KEY, GEMINI_MODEL: 'gemini-test-model',
};
const SCENE_ANSWERS: Record<string, unknown> = {
  uncovered: { scene: 'controlled_soccer', zoneVisibility: 'full', coverage: 'uncovered' },
  covered: { scene: 'controlled_soccer', zoneVisibility: 'full', coverage: 'covered' },
  obscured: { scene: 'controlled_soccer', zoneVisibility: 'partial', coverage: 'unknown' },
  unrelated: { scene: 'unrelated_or_uncertain', zoneVisibility: 'not_visible', coverage: 'unknown' },
};

interface StubCall { url: string; apiKey: string | null; body: { contents: Array<{ parts: Array<{ inlineData?: { mimeType: string; data: string } }> }> }; signal: AbortSignal | undefined }

/** Gemini HTTP stand-in. Default behaviour delegates to Prabin's mockVisionFetch(scene). */
class GeminiStub {
  calls: StubCall[] = [];
  respond: (call: StubCall) => Promise<Response> = () => mockVisionFetch('uncovered')();
  fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const call: StubCall = { url: String(input), apiKey: headers.get('x-goog-api-key'), body: JSON.parse(String(init?.body)), signal: init?.signal ?? undefined };
    this.calls.push(call);
    return this.respond(call);
  }) as typeof fetch;
  scene(scene: string) { this.respond = () => mockVisionFetch(scene)(); }
  /** Never answers until released; resolves with `scene` afterwards. */
  hold(scene = 'uncovered') {
    let release!: () => void;
    this.respond = () => new Promise((resolve) => { release = () => resolve(mockVisionFetch(scene)()); });
    return () => release();
  }
}

async function start(env: Record<string, string> = {}, frameTimeoutMs = 2_000) {
  const stub = new GeminiStub();
  const logs: BridgeLogEntry[] = [];
  const runtime: BridgeRuntime = await createBridgeRuntime({ ...ENV, ...env }, { fetchImpl: stub.fetch, frameTimeoutMs, onRequestLog: (e) => logs.push(e) });
  const { url, port } = await runtime.listen(0);
  const engine = runtime.coordinator.engine;

  async function api(method: string, path: string, opts: { token?: string; json?: unknown; body?: Uint8Array | string; headers?: Record<string, string> } = {}) {
    const headers: Record<string, string> = { ...opts.headers };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    let body = opts.body;
    if (opts.json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(opts.json); }
    const res = await realFetch(url + path, { method, headers, ...(body !== undefined ? { body } : {}) });
    const text = await res.text();
    return { status: res.status, text, body: text ? (JSON.parse(text) as Record<string, unknown>) : undefined };
  }
  async function session(room = 'room') {
    const created = await api('POST', '/v1/sessions', { token: AGENT, json: { externalRef: room } });
    const id = created.body!.sessionId as string;
    engine.addParticipant(id, { displayName: 'Alex' });
    engine.confirmActivity(id, 'gaming');
    const consent = await api('POST', `/v1/sessions/${id}/consent`, { token: CONTROL, json: { consent: true, allParticipantsAgreed: true } });
    return { id, generation: consent.body!.captureGeneration as number };
  }
  const frame = (id: string, image: Uint8Array, o: { mime?: string; generation?: number | string; observedAt?: string } = {}) =>
    api('POST', `/v1/sessions/${id}/frames`, {
      token: AGENT, body: image,
      headers: { 'content-type': o.mime ?? 'image/png', 'x-media-source': 'screen_share', 'x-capture-generation': String(o.generation ?? 1), 'x-observed-at': o.observedAt ?? new Date().toISOString() },
    });
  const screens = (id: string): Observation[] => {
    const r = engine.listObservations(id, { source: 'screen' });
    return r.ok ? r.value : [];
  };
  const recs = (id: string) => {
    const r = engine.getSession(id);
    return r.ok ? r.value.recommendations : [];
  };
  return { runtime, stub, logs, url, port, engine, api, session, frame, screens, recs };
}
type H = Awaited<ReturnType<typeof start>>;
async function withRuntime(fn: (h: H) => Promise<void>, env: Record<string, string> = {}, frameTimeoutMs?: number) {
  const h = await start(env, frameTimeoutMs);
  try { await fn(h); } finally { await h.runtime.close(); }
}
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

// ── Valid frames: all four scenes through the real adapter ─────────────────

for (const scene of ['uncovered', 'covered', 'obscured', 'unrelated']) {
  test(`[V] ${scene} frame → Gemini vision (mocked HTTP) → normalized observation`, () => withRuntime(async (h) => {
    h.stub.scene(scene);
    const { id, generation } = await h.session();
    await h.api('POST', `/v1/sessions/${id}/transcripts`, {
      token: AGENT, json: { captureGeneration: generation, observedAt: new Date().toISOString(), text: 'Alex is responsible for left defense.' },
    });
    await h.runtime.coordinator.whenIdle(id);
    const observedAt = new Date().toISOString();
    const image = scenePng(scene);
    const r = await h.frame(id, image, { generation, observedAt });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body!.captureGeneration, generation, 'capture generation preserved');
    assert.equal(r.body!.observedAt, observedAt, 'capture time preserved, not processing time');
    await h.runtime.coordinator.whenIdle(id);

    const expected = interpretVision(SCENE_ANSWERS[scene]); // Prabin's own normalisation
    const [stored] = h.screens(id);
    assert.ok(stored && stored.source === 'screen');
    assert.equal(stored.summary, expected.summary);
    assert.equal(stored.evidenceQuality, expected.evidenceQuality);
    assert.deepEqual(stored.facts, expected.facts);
    assert.equal(stored.observedAt, observedAt);
    assert.equal(stored.captureGeneration, generation);
    assert.equal(stored.frameRef, undefined, 'no image data or reference kept');
    assert.equal(h.recs(id).length, scene === 'uncovered' ? 1 : 0);

    // The request Gemini received: exact uploaded bytes, model in URL, key only in the header.
    assert.equal(h.stub.calls.length, 1);
    const call = h.stub.calls[0]!;
    assert.match(call.url, /\/models\/gemini-test-model:generateContent$/);
    assert.ok(!call.url.includes(KEY));
    assert.equal(call.apiKey, KEY);
    const inline = call.body.contents[0]!.parts.find((p) => p.inlineData)!.inlineData!;
    assert.deepEqual(inline, { mimeType: 'image/png', data: Buffer.from(image).toString('base64') });
  }));
}

test('[V] conditionFactKeys come from Prabin\'s VISION_FACT_KEYS', async () => {
  const mod = (await import(root('src/bridge/vision-wiring.mts'))) as { createVision(m: string, e: Record<string, string>, o: { timeoutMs: number }): { conditionFactKeys: readonly string[]; label: string } };
  const wired = mod.createVision('gemini', ENV, { timeoutMs: 1000 });
  assert.equal(wired.conditionFactKeys, VISION_FACT_KEYS, 'same array object, not a copy');
  assert.match(wired.label, new RegExp(VISION_PROFILE));
});

// ── Invalid images and bridge-level rejects: Gemini never called ───────────

test('[V] invalid image data → 400 invalid_input; Gemini never called; nothing stored', () => withRuntime(async (h) => {
  const { id, generation } = await h.session();
  const png = scenePng('uncovered');
  for (const [image, mime] of [
    [png, 'image/jpeg'],                                    // signature/MIME mismatch
    [new Uint8Array(40).fill(7), 'image/png'],              // not an image
    [new Uint8Array([137, 80, 78, 71, 13]), 'image/png'],   // truncated (< 12 bytes)
  ] as const) {
    const r = await h.frame(id, image, { mime, generation });
    assert.deepEqual([r.status, r.body!.error], [400, 'invalid_input']);
  }
  assert.equal(h.stub.calls.length, 0);
  assert.equal(h.screens(id).length, 0);
}));

test('[V] wrong type, oversized, bad timestamp and stale generation never reach Gemini', () => withRuntime(async (h) => {
  const { id, generation } = await h.session();
  const png = scenePng('uncovered');
  assert.equal((await h.frame(id, png, { mime: 'image/gif', generation })).status, 415);
  // Oversized: declare > 5 MiB and send no body; the bridge must answer from the header alone.
  const oversized = await new Promise<number>((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1', port: h.port, method: 'POST', path: `/v1/sessions/${id}/frames`,
      headers: { authorization: `Bearer ${AGENT}`, 'content-type': 'image/png', 'content-length': String(5 * 1024 * 1024 + 1), 'x-media-source': 'screen_share', 'x-capture-generation': String(generation), 'x-observed-at': new Date().toISOString() },
    }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on('error', reject);
    req.flushHeaders();
  });
  assert.equal(oversized, 413);
  assert.equal((await h.frame(id, png, { generation, observedAt: 'yesterday' })).status, 400);
  await h.api('POST', `/v1/sessions/${id}/pause`, { token: CONTROL });
  await h.api('POST', `/v1/sessions/${id}/resume`, { token: CONTROL });
  const stale = await h.frame(id, png, { generation });
  assert.deepEqual([stale.status, stale.body!.error], [409, 'stale_evidence']);
  assert.equal(h.stub.calls.length, 0);
  assert.equal(h.screens(id).length, 0);
}));

// ── Provider errors (provider 429 is NOT local vision_busy) ─────────────────

test('[V] provider HTTP errors, including 429, → 502 vision_failed without leaking provider text', () => withRuntime(async (h) => {
  const { id, generation } = await h.session();
  for (const status of [400, 401, 429, 500, 503]) {
    h.stub.respond = async () => new Response('PROVIDER-SECRET-BODY', { status });
    const r = await h.frame(id, scenePng('uncovered'), { generation });
    assert.deepEqual([r.status, r.body!.error], [502, 'vision_failed'], `provider ${status}`);
    assert.ok(!r.text.includes('PROVIDER-SECRET'));
  }
  assert.equal(h.screens(id).length, 0);
}));

test('[V] malformed or contradictory model output → 502 vision_failed; nothing stored', () => withRuntime(async (h) => {
  const { id, generation } = await h.session();
  const bodies = [
    { candidates: [] },
    { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: '{}' }] } }] },
    { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'not json' }] } }] },
    { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({ scene: 'unrelated_or_uncertain', zoneVisibility: 'full', coverage: 'uncovered' }) }] } }] },
  ];
  for (const body of bodies) {
    h.stub.respond = async () => Response.json(body);
    const r = await h.frame(id, scenePng('uncovered'), { generation });
    assert.deepEqual([r.status, r.body!.error], [502, 'vision_failed'], JSON.stringify(body).slice(0, 60));
  }
  assert.equal(h.screens(id).length, 0);
  assert.equal(h.recs(id).length, 0);
}));

// ── Local busy, timeouts, cancellation ──────────────────────────────────────

test('[V] a second concurrent frame → 429 vision_busy (local limit); the first still succeeds', () => withRuntime(async (h) => {
  const { id, generation } = await h.session();
  const release = h.stub.hold('uncovered');
  const first = h.frame(id, scenePng('uncovered'), { generation });
  while (h.stub.calls.length < 1) await tick(5);
  const second = await h.frame(id, scenePng('uncovered'), { generation });
  assert.deepEqual([second.status, second.body!.error], [429, 'vision_busy']);
  assert.equal(h.stub.calls.length, 1, 'busy request never reached Gemini');
  release();
  assert.equal((await first).status, 200);
}));

test('[V] Gemini never answering → 504 vision_timeout at the bridge deadline; provider request aborted', () => withRuntime(async (h) => {
  const { id, generation } = await h.session();
  h.stub.respond = () => new Promise(() => {});
  const started = Date.now();
  const r = await h.frame(id, scenePng('uncovered'), { generation });
  assert.deepEqual([r.status, r.body!.error], [504, 'vision_timeout']);
  assert.ok(Date.now() - started < 1_000, 'bounded by the 150 ms deadline');
  assert.equal(h.stub.calls[0]!.signal?.aborted, true, 'Gemini HTTP request was cancelled');
  await tick(50);
  assert.equal(h.screens(id).length, 0);
}, {}, 150));

test('[V] adapter-own timeout (shorter than the caller\'s) maps to vision_timeout', async () => {
  const coordinator = new SidekickCoordinator({
    reasoning: async () => ({ ok: false, error: 'mock' }),
    vision: createGeminiVision({ apiKey: KEY, model: 'gemini-test-model', profile: VISION_PROFILE, timeoutMs: 30, fetchImpl: (() => new Promise(() => {})) as typeof fetch }),
  });
  const created = coordinator.createSession();
  assert.ok(created.ok);
  const started = coordinator.startWithConsent(created.value.id);
  assert.ok(started.ok);
  const r = await coordinator.ingestFrame(created.value.id, {
    mediaSource: 'screen_share', captureGeneration: started.value.captureGeneration, observedAt: new Date().toISOString(), image: scenePng('uncovered'), mimeType: 'image/png',
  });
  assert.equal(!r.ok && r.error, 'vision_timeout');
});

for (const action of ['pause', 'end', 'discard'] as const) {
  test(`[V] ${action} during the Gemini call → 409 aborted, request cancelled, no late observation or card`, () => withRuntime(async (h) => {
    const { id, generation } = await h.session();
    await h.api('POST', `/v1/sessions/${id}/transcripts`, {
      token: AGENT, json: { captureGeneration: generation, observedAt: new Date().toISOString(), text: 'Alex is responsible for left defense.' },
    });
    await h.runtime.coordinator.whenIdle(id);
    const release = h.stub.hold('uncovered');
    const pending = h.frame(id, scenePng('uncovered'), { generation });
    while (h.stub.calls.length < 1) await tick(5);
    if (action === 'discard') await h.api('DELETE', `/v1/sessions/${id}`, { token: CONTROL });
    else await h.api('POST', `/v1/sessions/${id}/${action}`, { token: CONTROL });
    release(); // Gemini "answers" late
    const r = await pending;
    assert.deepEqual([r.status, r.body!.error], [409, 'aborted'], 'not misreported as a provider failure');
    assert.equal(h.stub.calls[0]!.signal?.aborted, true);
    await tick(50);
    if (action === 'pause') {
      await h.api('POST', `/v1/sessions/${id}/resume`, { token: CONTROL });
      await h.runtime.coordinator.whenIdle(id);
    }
    if (action !== 'discard') {
      assert.equal(h.screens(id).length, 0, 'no late observation');
      assert.equal(h.recs(id).length, 0, 'no late recommendation');
    } else {
      assert.equal(h.engine.getSession(id).ok, false);
    }
  }));
}

test('[V] client disconnect during the Gemini call cancels it; nothing stored', () => withRuntime(async (h) => {
  const { id, generation } = await h.session();
  const release = h.stub.hold('uncovered');
  const image = Buffer.from(scenePng('uncovered'));
  await new Promise<void>((resolve) => {
    const req = httpRequest({
      host: '127.0.0.1', port: h.port, method: 'POST', path: `/v1/sessions/${id}/frames`,
      headers: { authorization: `Bearer ${AGENT}`, 'content-type': 'image/png', 'content-length': String(image.length), 'x-media-source': 'screen_share', 'x-capture-generation': String(generation), 'x-observed-at': new Date().toISOString() },
    });
    req.on('error', () => resolve());
    req.end(image);
    void (async () => { while (h.stub.calls.length < 1) await tick(5); req.destroy(); resolve(); })();
  });
  await tick(30);
  assert.equal(h.stub.calls[0]!.signal?.aborted, true);
  release();
  await tick(30);
  assert.equal(h.screens(id).length, 0);
  assert.equal((await h.api('GET', '/v1/health')).status, 200);
}));

test('[V] a slow Gemini response never changes capture time', () => withRuntime(async (h) => {
  const { id, generation } = await h.session();
  h.stub.respond = () => new Promise((r) => setTimeout(() => r(mockVisionFetch('covered')()), 250));
  const observedAt = new Date().toISOString();
  const r = await h.frame(id, scenePng('covered'), { generation, observedAt });
  assert.equal(r.status, 200);
  assert.equal(h.screens(id)[0]!.observedAt, observedAt);
  assert.ok(Date.parse(h.screens(id)[0]!.receivedAt) >= Date.parse(observedAt));
}));

// ── Configuration and credentials ──────────────────────────────────────────

test('[V] SIDEKICK_VISION=gemini without credentials fails to start (no fallback, no key in message)', async () => {
  for (const env of [{ GEMINI_API_KEY: '' }, { GEMINI_API_KEY: '   ' }, { GEMINI_MODEL: '' }, { GEMINI_MODEL: 'not-a-gemini-model' }]) {
    await assert.rejects(createBridgeRuntime({ ...ENV, ...env }), (e: unknown) => {
      assert.ok(e instanceof RuntimeConfigError);
      assert.match(e.message, /SIDEKICK_VISION/);
      assert.ok(!e.message.includes(KEY));
      return true;
    }, JSON.stringify(env));
  }
  await assert.rejects(createBridgeRuntime({ ...ENV, SIDEKICK_VISION: 'mock' }), RuntimeConfigError);
});

test('[V] default configuration: no vision, frames → 503, Gemini never called', () => withRuntime(async (h) => {
  const { id, generation } = await h.session();
  const r = await h.frame(id, scenePng('uncovered'), { generation });
  assert.deepEqual([r.status, r.body!.error], [503, 'vision_unavailable']);
  assert.equal(h.stub.calls.length, 0);
  assert.match(h.runtime.labels.vision, /not configured/);
  assert.match(h.runtime.labels.reasoning, /MOCK/);
}, { SIDEKICK_VISION: '' }));

test('[V] logs, responses and labels never contain the key, image data or summaries', () => withRuntime(async (h) => {
  const { id, generation } = await h.session();
  const image = scenePng('uncovered');
  const r = await h.frame(id, image, { generation });
  await tick(20);
  const dump = JSON.stringify([h.logs, r.body, h.runtime.labels]);
  for (const secret of [KEY, Buffer.from(image).toString('base64').slice(0, 40), 'appears uncovered', AGENT, CONTROL]) {
    assert.ok(!dump.includes(secret), `leaked ${secret.slice(0, 10)}`);
  }
  for (const entry of h.logs) assert.deepEqual(Object.keys(entry).sort(), ['durationMs', 'method', 'route', 'status']);
}));

test('[V] no real Gemini or other external network call was attempted by this suite', () => {
  assert.equal(externalAttempts, 0);
});
