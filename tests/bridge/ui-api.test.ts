/**
 * Milestone 4: overlay ↔ bridge API. Real HTTP against the production runtime
 * (`createBridgeRuntime`): mock reasoning, Gemini vision with MOCKED HTTP (Prabin's
 * `mockVisionFetch`), a fake engine clock, real timers for pairing/streams, and a
 * network guard proving no external request is attempted.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridgeRuntime, type BridgeRuntime } from '../../src/bridge/runtime.js';
import type { BridgeLogEntry } from '../../src/bridge/http-bridge.js';
import type { OverlayState } from '../../src/contracts/types.js';
import { FakeClock, at } from '../../src/mock/demo-scenario.js';

// ── Network guard ───────────────────────────────────────────────────────────
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

const AGENT = 'agent-token-0123456789-abcdefghijklmnop';
const CONTROL = 'control-token-0123456789-abcdefghijklmn';
const ROLE_LINE = 'Alex is responsible for left defense.';

function uiFixture() {
  const dir = join(mkdtempSync(join(tmpdir(), 'sidekick-ui-api-')), 'dist');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>overlay</title>');
  return dir;
}

interface Opts { ui?: Record<string, number>; scene?: string; uiNow?: () => number }

async function start(opts: Opts = {}) {
  const clock = new FakeClock();
  clock.set(1);
  let scene = opts.scene ?? 'uncovered';
  const logs: BridgeLogEntry[] = [];
  const runtime: BridgeRuntime = await createBridgeRuntime(
    { SIDEKICK_AGENT_TOKEN: AGENT, SIDEKICK_CONTROL_TOKEN: CONTROL, SIDEKICK_VISION: 'gemini', GEMINI_API_KEY: 'test-only-not-a-real-key-000', GEMINI_MODEL: 'gemini-test-model' },
    {
      fetchImpl: (() => mockVisionFetch(scene)()) as typeof fetch,
      now: clock.now,
      uiDir: uiFixture(),
      onRequestLog: (e) => logs.push(e),
      ui: { pairingTtlMs: 2_000, idleTtlMs: 60_000, voiceDisconnectGraceMs: 150, heartbeatMs: 50, maxStreamsPerSession: 4, ...opts.ui, ...(opts.uiNow ? { now: opts.uiNow } : {}) },
    },
  );
  const { url } = await runtime.listen(0);
  const engine = runtime.coordinator.engine;

  type Call = { status: number; body?: Record<string, unknown>; text: string; headers: Headers };
  async function http(method: string, path: string, o: { token?: string; cookie?: string; json?: unknown; body?: Uint8Array | string; headers?: Record<string, string>; origin?: string | null; csrf?: boolean } = {}): Promise<Call> {
    const headers: Record<string, string> = { ...o.headers };
    if (o.token) headers.authorization = `Bearer ${o.token}`;
    if (o.cookie) {
      headers.cookie = o.cookie;
      if (o.origin !== null) headers.origin = o.origin ?? url;
      if (o.csrf !== false) headers['x-sidekick-ui'] = '1';
    } else if (o.origin) headers.origin = o.origin;
    let body = o.body;
    if (o.json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(o.json); }
    const res = await realFetch(url + path, { method, headers, ...(body !== undefined ? { body } : {}) });
    const text = await res.text();
    let parsed: Record<string, unknown> | undefined;
    try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = undefined; }
    return { status: res.status, body: parsed, text, headers: res.headers };
  }

  /** Operator: session for a room (control token). */
  async function session(room = 'room') {
    const r = await http('POST', '/v1/sessions', { token: CONTROL, json: { externalRef: room } });
    return r.body!.sessionId as string;
  }
  const consent = (id: string) => http('POST', `/v1/sessions/${id}/consent`, { token: CONTROL, json: { consent: true, allParticipantsAgreed: true } });

  /** Operator creates a code; the browser redeems it like the overlay would. Returns the cookie. */
  async function pair(id: string, participantId?: string) {
    const created = await http('POST', `/v1/sessions/${id}/pairings`, { token: CONTROL, json: participantId ? { participantId } : {} });
    assert.equal(created.status, 201, created.text);
    const code = created.body!.code as string;
    const redeemed = await http('POST', '/v1/ui/pair', { json: { code }, origin: url, headers: { 'x-sidekick-ui': '1' } });
    assert.equal(redeemed.status, 200, redeemed.text);
    const setCookie = redeemed.headers.getSetCookie()[0]!;
    return { cookie: setCookie.split(';')[0]!, setCookie, code, url: created.body!.url as string, body: redeemed.body! };
  }

  /** Minimal SSE reader over fetch. */
  async function stream(id: string, cookie?: string, token?: string) {
    const ac = new AbortController();
    const headers: Record<string, string> = { ...(cookie ? { cookie } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) };
    const res = await realFetch(`${url}/v1/sessions/${id}/stream`, { headers, signal: ac.signal });
    const events: Array<{ event: string; id?: string; data: string }> = [];
    let ended = false;
    let wake = () => {};
    if (res.ok && res.body) {
      void (async () => {
        const reader = res.body!.getReader();
        let buf = '';
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += new TextDecoder().decode(value);
            let i: number;
            while ((i = buf.indexOf('\n\n')) >= 0) {
              const block = buf.slice(0, i);
              buf = buf.slice(i + 2);
              const lines = block.split('\n').filter((l) => !l.startsWith(':'));
              if (lines.length === 0) continue;
              const ev = { event: 'message', data: '' } as { event: string; id?: string; data: string };
              for (const l of lines) {
                if (l.startsWith('event: ')) ev.event = l.slice(7);
                else if (l.startsWith('id: ')) ev.id = l.slice(4);
                else if (l.startsWith('data: ')) ev.data += l.slice(6);
              }
              events.push(ev);
              wake();
            }
          }
        } catch { /* aborted */ }
        ended = true;
        wake();
      })();
    }
    const states = () => events.filter((e) => e.event === 'state').map((e) => JSON.parse(e.data) as OverlayState);
    async function until(pred: () => boolean, ms = 2_000) {
      const deadline = Date.now() + ms;
      while (!pred()) {
        if (Date.now() > deadline) throw new Error('stream condition not met in time');
        await new Promise<void>((r) => { wake = r; setTimeout(r, 20); });
      }
    }
    return { status: res.status, events, states, until, close: () => ac.abort(), get ended() { return ended; } };
  }

  /** Agent side: transcript + frame (capture generation read from the bridge, as Damius's agent would). */
  async function agentTranscript(id: string, seconds: number, text = ROLE_LINE) {
    clock.set(seconds);
    const cap = await http('GET', `/v1/sessions/${id}/capture`, { token: AGENT });
    return http('POST', `/v1/sessions/${id}/transcripts`, { token: AGENT, json: { captureGeneration: cap.body!.captureGeneration, observedAt: at(seconds), text } });
  }
  async function agentFrame(id: string, seconds: number) {
    clock.set(seconds);
    const cap = await http('GET', `/v1/sessions/${id}/capture`, { token: AGENT });
    return http('POST', `/v1/sessions/${id}/frames`, {
      token: AGENT, body: scenePng(scene),
      headers: { 'content-type': 'image/png', 'x-media-source': 'screen_share', 'x-capture-generation': String(cap.body!.captureGeneration), 'x-observed-at': at(seconds) },
    });
  }
  const recs = (id: string) => { const r = engine.getSession(id); return r.ok ? r.value.recommendations : []; };
  const voice = (id: string) => { const r = engine.getSession(id); return r.ok ? r.value.voiceRequests : []; };
  const idle = (id: string) => runtime.coordinator.whenIdle(id);
  /** Session with Alex registered, gaming confirmed, consent, and one active card. Returns the UI cookie. */
  async function cardReady(room = 'room') {
    const id = await session(room);
    const ui = await pair(id);
    await http('POST', `/v1/sessions/${id}/participants`, { cookie: ui.cookie, json: { displayName: 'Alex' } });
    await http('POST', `/v1/sessions/${id}/activity`, { cookie: ui.cookie, json: { activity: 'gaming' } });
    await consent(id);
    await agentTranscript(id, 2);
    await idle(id);
    await agentFrame(id, 8);
    await idle(id);
    assert.equal(recs(id).length, 1, 'card ready');
    return { id, ui, recId: recs(id)[0]!.id };
  }
  return {
    runtime, clock, engine, logs, url, http, session, consent, pair, stream, agentTranscript, agentFrame, recs, voice, idle, cardReady,
    setScene: (s: string) => { scene = s; },
  };
}
type H = Awaited<ReturnType<typeof start>>;
const withUi = (opts: Opts, fn: (h: H) => Promise<void>) => async () => {
  const h = await start(opts);
  try { await fn(h); } finally { await h.runtime.close(); }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── 1. Pairing security ─────────────────────────────────────────────────────

test('[U1] pairing: operator code → HttpOnly SameSite=Strict session cookie; no secret in the body', withUi({}, async (h) => {
  const id = await h.session();
  const p = await h.pair(id);
  assert.match(p.code, /^[A-Z2-9]{12}$/);
  assert.equal(p.url, `${h.url}/ui/#pair=${p.code}`, 'code travels in the URL fragment');
  for (const attr of ['HttpOnly', 'SameSite=Strict', 'Path=/v1']) assert.ok(p.setCookie.includes(attr), attr);
  assert.deepEqual(p.body, { ok: true, sessionId: id });
  assert.ok(!JSON.stringify(p.body).includes(p.cookie.split('=')[1]!), 'credential only in Set-Cookie');
}));

test('[U1] codes are one-time, expire, and failed attempts are rate-limited', withUi({ ui: { pairingTtlMs: 100, maxPairingFailures: 4 } }, async (h) => {
  const id = await h.session();
  const redeem = (code: string) => h.http('POST', '/v1/ui/pair', { json: { code }, origin: h.url, headers: { 'x-sidekick-ui': '1' } });
  const p = await h.pair(id);
  assert.deepEqual([(await redeem(p.code)).status, (await redeem(p.code)).body!.error], [401, 'invalid_pairing'], 'reuse');
  const expiring = (await h.http('POST', `/v1/sessions/${id}/pairings`, { token: CONTROL, json: {} })).body!.code as string;
  await sleep(150);
  assert.equal((await redeem(expiring)).status, 401, 'expired');
  // 3 failures so far (two reuse attempts — pair() already consumed the code — and one expired);
  // one more trips the limit of 4 for everyone.
  assert.equal((await redeem('AAAAAAAAAAAA')).status, 401);
  const valid = (await h.http('POST', `/v1/sessions/${id}/pairings`, { token: CONTROL, json: {} })).body!.code as string;
  const limited = await redeem(valid);
  assert.deepEqual([limited.status, limited.body!.error], [429, 'pairing_rate_limited']);
}));

test('[U1] pairing requires same Origin and the CSRF header; only the operator can create codes', withUi({}, async (h) => {
  const id = await h.session();
  const code = (await h.http('POST', `/v1/sessions/${id}/pairings`, { token: CONTROL, json: {} })).body!.code as string;
  assert.equal((await h.http('POST', '/v1/ui/pair', { json: { code }, headers: { 'x-sidekick-ui': '1' } })).status, 403, 'no Origin');
  assert.equal((await h.http('POST', '/v1/ui/pair', { json: { code }, origin: h.url })).status, 403, 'no CSRF header');
  assert.equal((await h.http('POST', '/v1/ui/pair', { json: { code }, origin: 'https://evil.example', headers: { 'x-sidekick-ui': '1' } })).body!.error, 'forbidden_origin');
  assert.equal((await h.http('POST', `/v1/sessions/${id}/pairings`, { token: AGENT, json: {} })).status, 403, 'agent');
  const ui = await h.pair(id);
  assert.equal((await h.http('POST', `/v1/sessions/${id}/pairings`, { cookie: ui.cookie, json: {} })).status, 403, 'ui cookie');
  assert.equal((await h.http('POST', `/v1/sessions/${id}/pairings`, { token: CONTROL, json: { participantId: 'nobody' } })).status, 400);
}));

test('[U1] secrets never appear in logs or UI responses', withUi({}, async (h) => {
  const { id, ui } = await h.cardReady();
  const responses = [
    await h.http('GET', `/v1/sessions/${id}/participants`, { cookie: ui.cookie }),
    await h.http('GET', `/v1/sessions/${id}/timeline`, { cookie: ui.cookie }),
    await h.http('GET', '/ui/'),
  ];
  const credential = ui.cookie.split('=')[1]!;
  const dump = JSON.stringify(h.logs) + responses.map((r) => r.text).join('');
  for (const secret of [AGENT, CONTROL, credential, ui.code, 'test-only-not-a-real-key']) assert.ok(!dump.includes(secret), `leaked ${secret.slice(0, 6)}`);
  for (const e of h.logs) assert.deepEqual(Object.keys(e).sort(), ['durationMs', 'method', 'route', 'status']);
}));

// ── 2. Isolation and browser authorization ──────────────────────────────────

test('[U2] a UI cookie is scoped to one session; other sessions look nonexistent', withUi({}, async (h) => {
  const a = await h.session('room-a');
  const b = await h.session('room-b');
  const ui = await h.pair(a);
  for (const [method, path] of [['GET', `/v1/sessions/${b}/participants`], ['GET', `/v1/sessions/${b}/timeline`], ['POST', `/v1/sessions/${b}/pause`], ['DELETE', `/v1/sessions/${b}`]] as const) {
    const r = await h.http(method, path, { cookie: ui.cookie });
    assert.deepEqual([r.status, r.body!.error], [404, 'session_not_found'], `${method} ${path}`);
  }
  assert.equal((await h.stream(b, ui.cookie)).status, 404);
  assert.equal((await h.http('GET', `/v1/sessions/${a}/participants`, { cookie: ui.cookie })).status, 200);
}));

test('[U2] UI cookies cannot use agent routes; bearer tokens are refused from browsers', withUi({}, async (h) => {
  const id = await h.session();
  await h.consent(id);
  const ui = await h.pair(id);
  assert.equal((await h.http('POST', `/v1/sessions/${id}/transcripts`, { cookie: ui.cookie, json: { captureGeneration: 1, observedAt: at(1), text: 'x' } })).status, 403);
  assert.equal((await h.http('GET', `/v1/sessions/${id}/capture`, { cookie: ui.cookie })).status, 403);
  assert.equal((await h.http('POST', `/v1/sessions`, { cookie: ui.cookie, json: { externalRef: 'x' } })).status, 403);
  assert.equal((await h.http('GET', `/v1/sessions/${id}/timeline`, { token: CONTROL, origin: h.url })).body!.error, 'forbidden_origin', 'bearer + Origin');
  const bogus = await h.http('GET', `/v1/sessions/${id}/timeline`, { cookie: 'sidekick_ui=forged' });
  assert.equal(bogus.status, 401);
  assert.match(bogus.headers.getSetCookie()[0]!, /Max-Age=0/, 'forged cookie cleared');
}));

test('[U2] CSRF: state changes need same Origin + X-Sidekick-UI; reads tolerate a missing Origin', withUi({}, async (h) => {
  const id = await h.session();
  const ui = await h.pair(id);
  const add = (o: Parameters<H['http']>[2]) => h.http('POST', `/v1/sessions/${id}/participants`, { cookie: ui.cookie, json: { displayName: 'Sam' }, ...o });
  assert.equal((await add({ origin: null })).body!.error, 'csrf_rejected');
  assert.equal((await add({ csrf: false })).body!.error, 'csrf_rejected');
  assert.equal((await add({ origin: 'https://evil.example' })).body!.error, 'forbidden_origin');
  assert.equal((await h.http('GET', `/v1/sessions/${id}/participants`, { cookie: ui.cookie, origin: null })).status, 200);
  assert.equal(h.engine.getSession(id).ok && (h.engine.getSession(id) as { value: { participants: unknown[] } }).value.participants.length, 0, 'nothing changed');
}));

test('[U2] idle credentials expire', withUi({ ui: { idleTtlMs: 80 } }, async (h) => {
  const id = await h.session();
  const ui = await h.pair(id);
  await sleep(120);
  assert.equal((await h.http('GET', `/v1/sessions/${id}/timeline`, { cookie: ui.cookie })).status, 401);
}));

// ── 3. Consent ──────────────────────────────────────────────────────────────

test('[U3] consent is operator-only and requires the all-participants attestation', withUi({}, async (h) => {
  const id = await h.session();
  const ui = await h.pair(id);
  assert.equal((await h.http('POST', `/v1/sessions/${id}/consent`, { cookie: ui.cookie, json: { consent: true, allParticipantsAgreed: true } })).status, 403, 'a UI click is not group consent');
  const bare = await h.http('POST', `/v1/sessions/${id}/consent`, { token: CONTROL, json: { consent: true } });
  assert.equal(bare.body!.error, 'all_participants_agreement_required');
  const s = await h.stream(id, ui.cookie);
  await s.until(() => s.states().length > 0);
  assert.deepEqual([s.states().at(-1)!.status], ['starting'], 'UI sees that observation is not enabled');
  // Before consent the agent sees acceptingInput=false / generation 0; even a forced send is refused.
  const forced = await h.http('POST', `/v1/sessions/${id}/transcripts`, { token: AGENT, json: { captureGeneration: 1, observedAt: at(1), text: 'hello' } });
  assert.deepEqual([forced.status, forced.body!.error], [409, 'consent_required'], 'no processing before consent');
  assert.equal((await h.http('GET', `/v1/sessions/${id}/capture`, { token: AGENT })).body!.acceptingInput, false);
  assert.equal((await h.consent(id)).status, 200);
  await s.until(() => s.states().at(-1)!.status === 'active');
  s.close();
}));

// ── 4. Participants and activity ────────────────────────────────────────────

test('[U4] participants: UI registers display names only; list has no speaker refs', withUi({}, async (h) => {
  const id = await h.session();
  const ui = await h.pair(id);
  const added = await h.http('POST', `/v1/sessions/${id}/participants`, { cookie: ui.cookie, json: { displayName: 'Alex' } });
  assert.equal(added.status, 201);
  assert.deepEqual(Object.keys(added.body!).sort(), ['displayName', 'id', 'ok']);
  assert.equal((await h.http('POST', `/v1/sessions/${id}/participants`, { cookie: ui.cookie, json: { displayName: 'Sam', externalRef: 'spk-1' } })).status, 400, 'UI cannot set speaker refs');
  assert.equal((await h.http('POST', `/v1/sessions/${id}/participants`, { token: CONTROL, json: { displayName: 'Sam', externalRef: 'spk-1' } })).status, 201, 'operator can');
  const list = await h.http('GET', `/v1/sessions/${id}/participants`, { cookie: ui.cookie });
  assert.deepEqual((list.body!.participants as Array<{ displayName: string }>).map((p) => p.displayName), ['Alex', 'Sam']);
  assert.ok(!list.text.includes('spk-1'));
}));

test('[U4] activity: only gaming; confirming it (and registering a name) re-runs reasoning on existing evidence', withUi({}, async (h) => {
  const id = await h.session();
  const ui = await h.pair(id);
  await h.consent(id);
  await h.agentTranscript(id, 2);        // spoken BEFORE Alex is registered
  await h.idle(id);
  await h.agentFrame(id, 8);             // gap frame BEFORE gaming is confirmed
  await h.idle(id);
  assert.equal(h.recs(id).length, 0, 'no advice yet: activity unconfirmed');
  assert.equal((await h.http('POST', `/v1/sessions/${id}/activity`, { cookie: ui.cookie, json: { activity: 'planning' } })).status, 400);
  h.clock.set(9);
  await h.http('POST', `/v1/sessions/${id}/participants`, { cookie: ui.cookie, json: { displayName: 'Alex' } });
  await h.idle(id);
  const snap = h.engine.getSession(id);
  assert.ok(snap.ok && snap.value.participants[0]!.role === 'left defense', 'registration re-ran reasoning over the earlier utterance');
  const confirmed = await h.http('POST', `/v1/sessions/${id}/activity`, { cookie: ui.cookie, json: { activity: 'gaming' } });
  assert.deepEqual([confirmed.status, confirmed.body!.activityConfirmed], [200, true]);
  await h.idle(id);
  assert.equal(h.recs(id).length, 1, 'card from the existing, still-fresh frame without new input');
}));

test('[U4] confirming activity never revives stale evidence', withUi({}, async (h) => {
  const id = await h.session();
  const ui = await h.pair(id);
  await h.http('POST', `/v1/sessions/${id}/participants`, { cookie: ui.cookie, json: { displayName: 'Alex' } });
  await h.consent(id);
  await h.agentTranscript(id, 2);
  await h.agentFrame(id, 3);
  await h.idle(id);
  h.clock.set(30); // frame is now 27 s old (stale window 15 s)
  await h.http('POST', `/v1/sessions/${id}/activity`, { cookie: ui.cookie, json: { activity: 'gaming' } });
  await h.idle(id);
  assert.equal(h.recs(id).length, 0);
}));

// ── 5. Versioned streams and reconnects ─────────────────────────────────────

test('[U5] stream: immediate snapshot, strictly increasing versions, reconnect returns current state', withUi({}, async (h) => {
  const id = await h.session();
  const ui = await h.pair(id);
  const s1 = await h.stream(id, ui.cookie);
  assert.equal(s1.status, 200);
  await s1.until(() => s1.states().length >= 1);
  await h.http('POST', `/v1/sessions/${id}/participants`, { cookie: ui.cookie, json: { displayName: 'Alex' } });
  await h.consent(id);
  await s1.until(() => s1.states().at(-1)!.status === 'active');
  const versions = s1.states().map((s) => s.version);
  for (let i = 1; i < versions.length; i++) assert.ok(versions[i]! > versions[i - 1]!, `versions ${versions.join(',')}`);
  assert.deepEqual(s1.events.filter((e) => e.event === 'state').map((e) => Number(e.id)), versions, 'SSE id = version');
  s1.close();
  const s2 = await h.stream(id, ui.cookie);
  await s2.until(() => s2.states().length >= 1);
  assert.ok(s2.states()[0]!.version >= versions.at(-1)!, 'reconnect starts at the current version');
  assert.equal(s2.states()[0]!.status, 'active');
  s2.close();
}));

test('[U5] stream auth, operator access, per-session cap and heartbeats', withUi({ ui: { maxStreamsPerSession: 2 } }, async (h) => {
  const id = await h.session();
  const ui = await h.pair(id);
  assert.equal((await h.stream(id)).status, 401);
  const a = await h.stream(id, ui.cookie);
  const b = await h.stream(id, undefined, CONTROL);
  assert.deepEqual([a.status, b.status], [200, 200]);
  const c = await h.stream(id, ui.cookie);
  assert.equal(c.status, 429);
  await sleep(120); // heartbeat 50 ms keeps the stream open
  assert.equal(a.ended, false);
  a.close(); b.close();
  await sleep(30);
  const d = await h.stream(id, ui.cookie);
  assert.equal(d.status, 200, 'slot freed after close');
  d.close();
}));

// ── 6. Recommendations and dismissal ────────────────────────────────────────

test('[U6] the stream shows the card; dismiss updates it; bad ids and bodies are refused', withUi({}, async (h) => {
  const { id, ui, recId } = await h.cardReady();
  const s = await h.stream(id, ui.cookie);
  await s.until(() => s.states().at(-1)?.prominent?.id === recId);
  assert.equal((await h.http('POST', `/v1/sessions/${id}/recommendations/${recId}/dismiss`, { cookie: ui.cookie, body: '{}' })).body!.error, 'unexpected_body');
  assert.equal((await h.http('POST', `/v1/sessions/${id}/recommendations/nope/dismiss`, { cookie: ui.cookie })).status, 404);
  assert.equal((await h.http('POST', `/v1/sessions/${id}/recommendations/${recId}/dismiss`, { cookie: ui.cookie })).status, 200);
  await s.until(() => s.states().at(-1)!.prominent === undefined && s.states().at(-1)!.history[0]?.status === 'dismissed');
  s.close();
}));

// ── 7. Explanations ─────────────────────────────────────────────────────────

test('[U7] explanation text is grounded, quotes no transcript, and returns the voice request', withUi({}, async (h) => {
  const { id, ui, recId } = await h.cardReady();
  const r = await h.http('POST', `/v1/sessions/${id}/recommendations/${recId}/explanation`, { cookie: ui.cookie });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(Object.keys(r.body!).sort(), ['ok', 'refersToEarlierObservation', 'request', 'text']);
  const text = r.body!.text as string;
  assert.match(text, /assigned Alex to left defense/);
  assert.match(text, /The shared screen showed: The full left defensive zone is visible and appears uncovered/);
  assert.ok(!text.includes(ROLE_LINE) && !text.includes('responsible for'), 'no transcript quote');
  assert.equal(r.body!.refersToEarlierObservation, false);
  assert.equal((r.body!.request as { status: string }).status, 'pending');
  assert.equal((await h.http('POST', `/v1/sessions/${id}/recommendations/${recId}/explanation`, { cookie: ui.cookie })).body!.error, 'voice_busy');
  assert.equal((await h.http('POST', `/v1/sessions/${id}/recommendations/${recId}/explanation`, { token: CONTROL })).status, 403, 'explanations are per browser client');
}));

// ── 8. Private voice ownership ──────────────────────────────────────────────

test('[U8] only the requesting client may report on or cancel its voice request', withUi({}, async (h) => {
  const { id, ui, recId } = await h.cardReady();
  const other = await h.pair(id);
  const req = (await h.http('POST', `/v1/sessions/${id}/recommendations/${recId}/explanation`, { cookie: ui.cookie })).body!.request as { id: string };
  for (const [path, json] of [[`/v1/sessions/${id}/voice/${req.id}/status`, { status: 'finished' }], [`/v1/sessions/${id}/voice/${req.id}/cancel`, undefined]] as const) {
    const r = await h.http('POST', path, { cookie: other.cookie, ...(json ? { json } : {}) });
    assert.deepEqual([r.status, r.body!.error], [403, 'not_request_owner']);
  }
  assert.equal((await h.http('POST', `/v1/sessions/${id}/voice/unknown/status`, { cookie: ui.cookie, json: { status: 'finished' } })).status, 404);
  assert.equal((await h.http('POST', `/v1/sessions/${id}/voice/${req.id}/status`, { cookie: ui.cookie, json: { status: 'speaking' } })).status, 400);
  const playing = await h.http('POST', `/v1/sessions/${id}/voice/${req.id}/status`, { cookie: ui.cookie, json: { status: 'playing_locally' } });
  assert.equal((playing.body!.request as { status: string }).status, 'playing_locally');
  const done = await h.http('POST', `/v1/sessions/${id}/voice/${req.id}/status`, { cookie: ui.cookie, json: { status: 'finished' } });
  assert.equal((done.body!.request as { status: string }).status, 'finished');
  assert.equal((await h.http('POST', `/v1/sessions/${id}/voice/${req.id}/cancel`, { cookie: ui.cookie })).status, 404, 'finished request no longer controllable');
  const req2 = (await h.http('POST', `/v1/sessions/${id}/recommendations/${recId}/explanation`, { cookie: other.cookie })).body!.request as { id: string };
  assert.notEqual(req2.id, req.id, 'unique request ids');
  const cancelled = await h.http('POST', `/v1/sessions/${id}/voice/${req2.id}/cancel`, { cookie: other.cookie });
  assert.deepEqual([(cancelled.body!.request as { status: string; cancelReason: string }).status, (cancelled.body!.request as { cancelReason: string }).cancelReason], ['cancelled', 'user']);
}));

// ── 10. Disconnect handling and lifecycle ───────────────────────────────────

test('[U10] a short stream drop does NOT cancel voice; a prolonged absence does (bounded grace)', withUi({ ui: { voiceDisconnectGraceMs: 150 } }, async (h) => {
  const { id, ui, recId } = await h.cardReady();
  let s = await h.stream(id, ui.cookie);
  await s.until(() => s.states().length > 0);
  const req = (await h.http('POST', `/v1/sessions/${id}/recommendations/${recId}/explanation`, { cookie: ui.cookie })).body!.request as { id: string };
  s.close();
  await sleep(50);
  s = await h.stream(id, ui.cookie); // reconnect within grace
  await sleep(200);
  assert.equal(h.voice(id).find((v) => v.id === req.id)!.status, 'pending', 'survived a short drop');
  s.close();
  await sleep(300);
  const v = h.voice(id).find((x) => x.id === req.id)!;
  assert.deepEqual([v.status, v.cancelReason], ['cancelled', 'client_disconnected']);
}));

test('[U10] lifecycle via UI: pause cancels voice, operator-only resume, end, discard revokes cookies and closes streams', withUi({}, async (h) => {
  const { id, ui, recId } = await h.cardReady();
  const s = await h.stream(id, ui.cookie);
  await s.until(() => s.states().length > 0);
  const req = (await h.http('POST', `/v1/sessions/${id}/recommendations/${recId}/explanation`, { cookie: ui.cookie })).body!.request as { id: string };
  assert.equal((await h.http('POST', `/v1/sessions/${id}/pause`, { cookie: ui.cookie })).body!.status, 'paused');
  assert.equal(h.voice(id).find((v) => v.id === req.id)!.cancelReason, 'session_paused');
  const late = await h.http('POST', `/v1/sessions/${id}/voice/${req.id}/status`, { cookie: ui.cookie, json: { status: 'playing_locally' } });
  assert.deepEqual([late.status, late.body!.error], [404, 'voice_request_not_found'], 'late playback refused; ownership pruned after lifecycle cancel');
  assert.equal((await h.http('POST', `/v1/sessions/${id}/resume`, { cookie: ui.cookie })).status, 403, 'M2: a browser cannot resume');
  assert.equal((await h.http('POST', `/v1/sessions/${id}/resume`, { token: CONTROL })).body!.status, 'active', 'the operator can');
  assert.equal((await h.http('POST', `/v1/sessions/${id}/end`, { cookie: ui.cookie })).body!.status, 'ended');
  assert.equal((await h.http('POST', `/v1/sessions/${id}/resume`, { token: CONTROL })).status, 409, 'cannot resume an ended session');
  const gone = await h.http('DELETE', `/v1/sessions/${id}`, { cookie: ui.cookie });
  assert.equal(gone.status, 204);
  assert.match(gone.headers.getSetCookie()[0]!, /Max-Age=0/);
  await s.until(() => s.ended);
  assert.ok(s.events.some((e) => e.event === 'discarded'));
  assert.equal((await h.http('GET', `/v1/sessions/${id}/timeline`, { cookie: ui.cookie })).status, 401, 'cookie revoked');
}));

// ── 9 + 12. Timeline and the complete mock pipeline ─────────────────────────

test('[U12] complete mock pipeline: agent → bridge → Gemini vision (mocked) → card → UI explanation → voice → end → timeline', withUi({}, async (h) => {
  // Operator: session + browser pairing + participant + gaming + consent attestation.
  const id = await h.session('demo-room');
  const ui = await h.pair(id);
  const s = await h.stream(id, ui.cookie);
  await h.http('POST', `/v1/sessions/${id}/participants`, { cookie: ui.cookie, json: { displayName: 'Alex' } });
  await h.http('POST', `/v1/sessions/${id}/activity`, { cookie: ui.cookie, json: { activity: 'gaming' } });
  // The agent creating "its" session for the same room gets the SAME session (single owner).
  const agentSession = await h.http('POST', '/v1/sessions', { token: AGENT, json: { externalRef: 'demo-room' } });
  assert.equal(agentSession.body!.sessionId, id);
  await h.consent(id);
  // Agent: transcript + frame.
  assert.equal((await h.agentTranscript(id, 2)).status, 202);
  await h.idle(id);
  const frame = await h.agentFrame(id, 8);
  assert.equal(frame.status, 200);
  await h.idle(id);
  // Browser: sees the card on the stream, asks for the explanation, plays it locally.
  await s.until(() => s.states().at(-1)?.prominent !== undefined);
  const card = s.states().at(-1)!.prominent!;
  assert.equal(card.title, 'Left defense appears exposed');
  assert.deepEqual(card.relatedParticipants.map((p) => [p.displayName, p.role]), [['Alex', 'left defense']]);
  const script = await h.http('POST', `/v1/sessions/${id}/recommendations/${card.id}/explanation`, { cookie: ui.cookie });
  const requestId = (script.body!.request as { id: string }).id;
  await h.http('POST', `/v1/sessions/${id}/voice/${requestId}/status`, { cookie: ui.cookie, json: { status: 'playing_locally' } });
  await h.http('POST', `/v1/sessions/${id}/voice/${requestId}/status`, { cookie: ui.cookie, json: { status: 'finished' } });
  await h.http('POST', `/v1/sessions/${id}/end`, { cookie: ui.cookie });
  await s.until(() => s.states().at(-1)!.status === 'ended');
  // Review data: evidence-grounded timeline, no transcript text.
  const tl = await h.http('GET', `/v1/sessions/${id}/timeline`, { cookie: ui.cookie });
  assert.equal(tl.status, 200);
  assert.equal(tl.body!.truncated, false);
  const types = (tl.body!.events as Array<{ type: string }>).map((e) => e.type);
  for (const t of ['session_started', 'participant_added', 'activity_confirmed', 'role_updated', 'observation', 'recommendation_created', 'voice_requested', 'voice_finished', 'session_ended']) {
    assert.ok(types.includes(t), t);
  }
  assert.ok(!tl.text.includes(ROLE_LINE), 'timeline carries no transcript text');
  const created = (tl.body!.events as Array<{ type: string; conditionObservationIds?: string[] }>).find((e) => e.type === 'recommendation_created')!;
  assert.deepEqual(created.conditionObservationIds, [frame.body!.observationId], 'card cites the frame as evidence');
  s.close();
}));

test('[U12] no external network call was attempted (Gemini mocked throughout)', () => {
  assert.equal(externalAttempts, 0);
});

// ── Review fixes M1–M5 and safeguards ───────────────────────────────────────

/** Controllable clock for UI credentials (pairing TTLs are measured on it too). */
/** Resolves once the server has processed `count` stream closes (the request log fires on close). */
async function streamsClosed(h: { logs: BridgeLogEntry[] }, count: number) {
  for (let i = 0; i < 200 && h.logs.filter((e) => e.route === '/v1/sessions/:id/stream').length < count; i++) await sleep(10);
  assert.equal(h.logs.filter((e) => e.route === '/v1/sessions/:id/stream').length, count, 'server saw the stream close');
}

function uiClock() {
  let t = 1_000_000;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

test('[M1] a passive viewer with a healthy stream can reconnect after long viewing', async () => {
  const clock = uiClock();
  await withUi({ uiNow: clock.now, ui: { idleTtlMs: 1_000, heartbeatMs: 15 } }, async (h) => {
    const id = await h.session();
    const ui = await h.pair(id);
    const s = await h.stream(id, ui.cookie);
    await s.until(() => s.states().length > 0);
    for (let i = 0; i < 10; i++) { clock.advance(400); await sleep(25); } // 4 s of passive viewing, heartbeats only
    s.close();
    await streamsClosed(h, 1);
    const again = await h.stream(id, ui.cookie);
    assert.equal(again.status, 200, 'reconnect after a blip needs no new pairing');
    again.close();
  })();
});

test('[M1] credentials still expire after idleTtl with no stream and no activity', async () => {
  const clock = uiClock();
  await withUi({ uiNow: clock.now, ui: { idleTtlMs: 1_000, heartbeatMs: 15 } }, async (h) => {
    const id = await h.session();
    const viewer = await h.pair(id);
    const s = await h.stream(id, viewer.cookie);
    await s.until(() => s.states().length > 0);
    s.close();
    await streamsClosed(h, 1);
    clock.advance(1_001); // idle since the stream closed
    assert.equal((await h.stream(id, viewer.cookie)).status, 401, 'not immortal');
    const quiet = await h.pair(id);
    clock.advance(1_001);
    assert.equal((await h.http('GET', '/v1/ui/session', { cookie: quiet.cookie })).status, 401);
    const active = await h.pair(id);
    for (let i = 0; i < 4; i++) { clock.advance(600); assert.equal((await h.http('GET', '/v1/ui/session', { cookie: active.cookie })).status, 200); }
  })();
});

test('[M2] a paired browser may pause but never resume; the operator can', withUi({}, async (h) => {
  const id = await h.session();
  await h.consent(id);
  const ui = await h.pair(id);
  assert.equal((await h.http('POST', `/v1/sessions/${id}/pause`, { cookie: ui.cookie })).body!.status, 'paused');
  const denied = await h.http('POST', `/v1/sessions/${id}/resume`, { cookie: ui.cookie });
  assert.deepEqual([denied.status, denied.body!.error], [403, 'forbidden']);
  const after = h.engine.getSession(id);
  assert.equal(after.ok && after.value.status, 'paused', 'rejected request changed nothing');
  assert.equal((await h.http('POST', `/v1/sessions/${id}/resume`, { token: CONTROL })).body!.status, 'active');
  assert.equal((await h.http('POST', `/v1/sessions/${id}/consent`, { cookie: ui.cookie, json: { consent: true, allParticipantsAgreed: true } })).status, 403, 'consent still operator-only');
}));

test('[M3] duplicate names are rejected across case, whitespace, compatibility and invisible-character variants', withUi({}, async (h) => {
  const id = await h.session();
  const ui = await h.pair(id);
  const add = (displayName: string, token?: string) =>
    h.http('POST', `/v1/sessions/${id}/participants`, token ? { token, json: { displayName } } : { cookie: ui.cookie, json: { displayName } });
  assert.equal((await add('Alex')).status, 201);
  for (const variant of ['alex', 'ALEX', '  Alex  ', 'Alex\u00A0', 'Ａｌｅｘ', 'Al\u200Bex', 'A\u00ADlex']) {
    const r = await add(variant);
    assert.deepEqual([r.status, r.body!.error], [409, 'duplicate_participant'], JSON.stringify(variant));
  }
  assert.equal((await add('ALEX', CONTROL)).body!.error, 'duplicate_participant', 'operator route enforces it too');
  assert.equal((await add('Strauß')).status, 201);
  assert.equal((await add('STRAUSS')).body!.error, 'duplicate_participant', 'Unicode case folding (ß = SS)');
  assert.equal((await add('Alexa')).status, 201, 'genuinely different names are fine');
  const list = (await h.http('GET', `/v1/sessions/${id}/participants`, { cookie: ui.cookie })).body!.participants as unknown[];
  assert.equal(list.length, 3, 'rejected requests added nothing');
}));

test('[M3] the 21st participant is refused and reasoning keeps working at 20', withUi({}, async (h) => {
  const id = await h.session();
  const ui = await h.pair(id);
  const add = (displayName: string) => h.http('POST', `/v1/sessions/${id}/participants`, { cookie: ui.cookie, json: { displayName } });
  assert.equal((await add('Alex')).status, 201);
  for (let i = 1; i < 20; i++) assert.equal((await add(`Player ${String.fromCharCode(64 + i)}`)).status, 201);
  const extra = await add('One Too Many');
  assert.deepEqual([extra.status, extra.body!.error], [409, 'participant_limit_reached']);
  assert.equal(((await h.http('GET', `/v1/sessions/${id}/participants`, { cookie: ui.cookie })).body!.participants as unknown[]).length, 20);
  await h.http('POST', `/v1/sessions/${id}/activity`, { cookie: ui.cookie, json: { activity: 'gaming' } });
  await h.consent(id);
  await h.agentTranscript(id, 2);
  await h.idle(id);
  await h.agentFrame(id, 8);
  await h.idle(id);
  assert.equal(h.recs(id).length, 1, 'advice still produced with the maximum allowed participants');
}));

test('[M4] reload recovery: the cookie alone recovers the session; the code stays consumed', withUi({}, async (h) => {
  const id = await h.session();
  const alex = (await h.http('POST', `/v1/sessions/${id}/participants`, { token: CONTROL, json: { displayName: 'Alex' } })).body!.id as string;
  const ui = await h.pair(id, alex);
  // "Reload": the fragment is gone; only the cookie remains.
  const who = await h.http('GET', '/v1/ui/session', { cookie: ui.cookie });
  assert.deepEqual(who.body, { ok: true, sessionId: id, participantId: alex });
  const s = await h.stream(who.body!.sessionId as string, ui.cookie);
  assert.equal(s.status, 200);
  s.close();
  assert.equal((await h.http('POST', '/v1/ui/pair', { json: { code: ui.code }, origin: h.url, headers: { 'x-sidekick-ui': '1' } })).status, 401, 'code not reusable');
}));

test('[M4] /v1/ui/session rejects missing, malformed, revoked and non-UI credentials and never crosses sessions', withUi({}, async (h) => {
  const a = await h.session('a');
  const b = await h.session('b');
  const uiA = await h.pair(a);
  const uiB = await h.pair(b);
  assert.equal((await h.http('GET', '/v1/ui/session', { cookie: uiA.cookie })).body!.sessionId, a);
  assert.equal((await h.http('GET', '/v1/ui/session', { cookie: uiB.cookie })).body!.sessionId, b);
  assert.equal((await h.http('GET', '/v1/ui/session')).status, 401, 'no cookie');
  for (const cookie of ['sidekick_ui=', 'sidekick_ui=forged', `sidekick_ui=${'x'.repeat(500)}`]) {
    assert.equal((await h.http('GET', '/v1/ui/session', { cookie })).status, 401, cookie.slice(0, 20));
  }
  assert.equal((await h.http('GET', '/v1/ui/session', { token: CONTROL })).status, 403, 'operator token is not a UI session');
  assert.equal((await h.http('GET', '/v1/ui/session', { token: AGENT })).status, 403);
  await h.http('DELETE', `/v1/sessions/${a}`, { token: CONTROL });
  const revoked = await h.http('GET', '/v1/ui/session', { cookie: uiA.cookie });
  assert.equal(revoked.status, 401, 'revoked on discard');
  assert.equal((await h.http('GET', '/v1/ui/session', { cookie: uiB.cookie })).body!.sessionId, b, 'other session unaffected');
}));

test('[M4] expired UI credentials cannot recover a session', async () => {
  const clock = uiClock();
  await withUi({ uiNow: clock.now, ui: { idleTtlMs: 500 } }, async (h) => {
    const id = await h.session();
    const ui = await h.pair(id);
    clock.advance(501);
    assert.equal((await h.http('GET', '/v1/ui/session', { cookie: ui.cookie })).status, 401);
  })();
});

test('[M5] goal, decision and unsafe role wording never reach any browser-facing response', withUi({}, async (h) => {
  const GOAL = 'ZEBRA-GOAL-7731';
  const DECISION = 'ZEBRA-DECISION-4410';
  const ROLE = 'ZEBRA ROLE 5512 duty';
  const LEFT_ROLE = 'left defense ZEBRA 9921'; // matches the tactical rule, but unsafe to display
  const id = await h.session();
  const ui = await h.pair(id);
  const s = await h.stream(id, ui.cookie);
  const bodies: string[] = [];
  const keep = async <R extends { text: string }>(p: Promise<R>) => { const r = await p; bodies.push(r.text); return r; };
  await keep(h.http('POST', `/v1/sessions/${id}/participants`, { cookie: ui.cookie, json: { displayName: 'Alex' } }));
  await keep(h.http('POST', `/v1/sessions/${id}/participants`, { cookie: ui.cookie, json: { displayName: 'Sam' } }));
  await keep(h.http('POST', `/v1/sessions/${id}/activity`, { cookie: ui.cookie, json: { activity: 'gaming' } }));
  await h.consent(id);
  await h.agentTranscript(id, 2, `Alex is responsible for ${LEFT_ROLE}.`);
  await h.agentTranscript(id, 3, `Our goal is to protect ${GOAL} at all costs.`);
  await h.agentTranscript(id, 4, `We decided to ${DECISION} now.`);
  await h.agentTranscript(id, 5, `Sam is responsible for ${ROLE}.`);
  await h.idle(id);
  await h.agentFrame(id, 8);
  await h.idle(id);
  // Raw evidence is preserved internally for reasoning.
  const internal = JSON.stringify(h.engine.getSession(id));
  for (const m of [GOAL, DECISION, ROLE, LEFT_ROLE]) assert.ok(internal.includes(m), `engine still stores ${m}`);
  // Browser-facing surfaces.
  await s.until(() => s.states().at(-1)?.prominent !== undefined);
  const recId = s.states().at(-1)!.prominent!.id;
  await keep(h.http('POST', `/v1/sessions/${id}/recommendations/${recId}/explanation`, { cookie: ui.cookie }));
  const tl = await keep(h.http('GET', `/v1/sessions/${id}/timeline`, { cookie: ui.cookie }));
  await keep(h.http('GET', `/v1/sessions/${id}/participants`, { cookie: ui.cookie }));
  await keep(h.http('GET', '/v1/ui/session', { cookie: ui.cookie }));
  await keep(h.http('POST', `/v1/sessions/${id}/pause`, { cookie: ui.cookie }));
  await sleep(30);
  const sse = s.events.map((e) => e.data).join('\n');
  const everything = bodies.join('\n') + sse;
  for (const marker of ['ZEBRA', GOAL, DECISION, '5512', '9921', 'protect', 'at all costs']) {
    assert.ok(!everything.includes(marker), `browser saw "${marker}"`);
  }
  // Structure is still useful: goal/decision events exist, without wording; Sam's role is a neutral label.
  const events = tl.body!.events as Array<Record<string, unknown>>;
  const goal = events.find((e) => e.type === 'goal_set')!;
  assert.ok(goal && !('text' in goal) && goal.summary === 'Group goal stated');
  const decision = events.find((e) => e.type === 'decision_recorded') as { decision: Record<string, unknown>; summary: string };
  assert.ok(decision && !('text' in decision.decision) && decision.summary === 'Group decision recorded');
  const roles = ((await h.http('GET', `/v1/sessions/${id}/participants`, { cookie: ui.cookie })).body!.participants as Array<{ displayName: string; role?: string }>);
  assert.deepEqual(roles.map((p) => [p.displayName, p.role]), [['Alex', 'assigned role'], ['Sam', 'assigned role']]);
  const card = [...s.states()].reverse().find((st) => st.prominent !== undefined)!.prominent!;
  assert.deepEqual(card.relatedParticipants.map((p) => p.role), ['assigned role'], 'SSE card carries the neutral label');
  s.close();
}));

test('[S] one browser credential cannot exhaust the session stream limit', withUi({ ui: { maxStreamsPerSession: 4, maxStreamsPerClient: 2 } }, async (h) => {
  const id = await h.session();
  const greedy = await h.pair(id);
  const a = await h.stream(id, greedy.cookie);
  const b = await h.stream(id, greedy.cookie);
  const c = await h.stream(id, greedy.cookie);
  assert.deepEqual([a.status, b.status, c.status], [200, 200, 429]);
  const other = await h.pair(id);
  const d = await h.stream(id, other.cookie);
  assert.equal(d.status, 200, 'another device still gets a stream');
  [a, b, d].forEach((x) => x.close());
}));

// ── Codex review: role allowlist, invisible names, terminal voice requests ──

test('[resolution] production runtime: covered frame resolves over HTTP/SSE and cancels private voice', withUi({}, async (h) => {
  const { id, ui, recId } = await h.cardReady();
  const stream = await h.stream(id, ui.cookie);
  try {
    await stream.until(() => stream.states().some((s) => s.prominent?.id === recId));
    const request = await h.http('POST', `/v1/sessions/${id}/recommendations/${recId}/explanation`, { cookie: ui.cookie });
    const requestId = (request.body!.request as { id: string }).id;
    assert.equal((await h.http('POST', `/v1/sessions/${id}/voice/${requestId}/status`, { cookie: ui.cookie, json: { status: 'playing_locally' } })).status, 200);
    await stream.until(() => stream.states().some((s) => s.activeVoiceRequest?.status === 'playing_locally'));
    const before = stream.states().at(-1)!.version;
    h.setScene('covered');
    const frame = await h.agentFrame(id, 9);
    assert.equal(frame.status, 200);
    await h.idle(id);
    await stream.until(() => stream.states().some((s) => s.history.some((r) => r.id === recId && r.status === 'resolved')));
    const state = stream.states().at(-1)!;
    assert.ok(state.version > before);
    assert.equal(state.prominent, undefined);
    assert.equal(state.activeVoiceRequest, undefined);
    assert.deepEqual([h.voice(id)[0]!.status, h.voice(id)[0]!.cancelReason], ['cancelled', 'recommendation_resolved']);
    const timeline = await h.http('GET', `/v1/sessions/${id}/timeline`, { cookie: ui.cookie });
    const events = timeline.body!.events as Array<{ type: string; recommendationId?: string; observationId?: string }>;
    assert.ok(events.some((e) => e.type === 'recommendation_resolved' && e.recommendationId === recId && e.observationId === frame.body!.observationId));
    assert.equal((await h.http('POST', `/v1/sessions/${id}/voice/${requestId}/cancel`, { cookie: ui.cookie })).status, 404);
  } finally { stream.close(); }
}));

test('[R1] arbitrary alphabetic role text ("password banana") never reaches the browser; canonical roles do', withUi({}, async (h) => {
  const SECRET_ROLES = ['password banana', 'hunter two', 'my home address', 'the vault key'];
  const NAMES = ['Sam', 'Lee', 'Kim', 'Ola'];
  const id = await h.session();
  const ui = await h.pair(id);
  const s = await h.stream(id, ui.cookie);
  const bodies: string[] = [];
  const keep = async <R extends { text: string }>(p: Promise<R>) => { const r = await p; bodies.push(r.text); return r; };
  for (const n of ['Alex', ...NAMES]) await keep(h.http('POST', `/v1/sessions/${id}/participants`, { cookie: ui.cookie, json: { displayName: n } }));
  await keep(h.http('POST', `/v1/sessions/${id}/activity`, { cookie: ui.cookie, json: { activity: 'gaming' } }));
  await h.consent(id);
  await h.agentTranscript(id, 2, ROLE_LINE); // Alex → left defense (canonical)
  for (const [i, role] of SECRET_ROLES.entries()) await h.agentTranscript(id, 3 + i, `${NAMES[i]} is responsible for ${role}.`);
  await h.idle(id);
  await h.agentFrame(id, 9);
  await h.idle(id);
  const internal = JSON.stringify(h.engine.getSession(id));
  for (const role of SECRET_ROLES) assert.ok(internal.includes(role), `engine keeps "${role}" for reasoning`);
  await s.until(() => s.states().some((st) => st.prominent !== undefined));
  const recId = [...s.states()].reverse().find((st) => st.prominent !== undefined)!.prominent!.id;
  await keep(h.http('POST', `/v1/sessions/${id}/recommendations/${recId}/explanation`, { cookie: ui.cookie }));
  const parts = await keep(h.http('GET', `/v1/sessions/${id}/participants`, { cookie: ui.cookie }));
  await keep(h.http('GET', `/v1/sessions/${id}/timeline`, { cookie: ui.cookie }));
  await keep(h.http('POST', `/v1/sessions/${id}/end`, { cookie: ui.cookie }));
  await sleep(30);
  const everything = bodies.join('\n') + s.events.map((e) => e.data).join('\n');
  for (const word of ['password', 'banana', 'hunter', 'address', 'vault']) assert.ok(!everything.includes(word), `browser saw "${word}"`);
  const roles = (parts.body!.participants as Array<{ displayName: string; role?: string }>).map((p) => [p.displayName, p.role]);
  assert.deepEqual(roles, [['Alex', 'left defense'], ...NAMES.map((n) => [n, 'assigned role'])]);
  s.close();
}));

test('[R2] invisible-only names are rejected repeatedly without changing the session', withUi({}, async (h) => {
  const id = await h.session();
  const ui = await h.pair(id);
  const add = (displayName: string) => h.http('POST', `/v1/sessions/${id}/participants`, { cookie: ui.cookie, json: { displayName } });
  assert.equal((await add('Alex')).status, 201);
  const before = JSON.stringify(h.engine.getSession(id));
  const timelineBefore = JSON.stringify(h.engine.getTimeline(id));
  for (const name of ['​', '­', '​​', ' ⁠ ', '﻿', '‍‌', '‮', 'ㅤ', '⠀', '͏', '️', '́', '   ']) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await add(name);
      assert.deepEqual([r.status, r.body!.error], [400, 'invalid_participant_name'], JSON.stringify(name));
    }
  }
  assert.equal(JSON.stringify(h.engine.getSession(id)), before, 'session unchanged (participants, version, revisions)');
  assert.equal(JSON.stringify(h.engine.getTimeline(id)), timelineBefore, 'no timeline events');
  assert.equal(((await h.http('GET', `/v1/sessions/${id}/participants`, { cookie: ui.cookie })).body!.participants as unknown[]).length, 1);
}));

test('[R2] the stored display name is the normalized name; legitimate Unicode names are preserved', withUi({}, async (h) => {
  const id = await h.session();
  const ui = await h.pair(id);
  const add = (displayName: string) => h.http('POST', `/v1/sessions/${id}/participants`, { cookie: ui.cookie, json: { displayName } });
  const stored = (await add('  Ｊｏ​ｅ­  ')).body!;
  assert.equal(stored.displayName, 'Joe', 'NFKC, invisible characters removed, trimmed');
  assert.equal((await add('Joe')).body!.error, 'duplicate_participant');
  assert.equal((await add('J⁠o⁠e')).body!.error, 'duplicate_participant');
  for (const name of ['José', 'Zoë Smith', '李小龙', 'Nguyễn Ngọc', 'Мария', 'محمد', 'श्रेया', '🎮 Gamer']) {
    const r = await add(name);
    assert.deepEqual([r.status, r.body!.displayName], [201, name.normalize('NFC')], name);
  }
  const list = (await h.http('GET', `/v1/sessions/${id}/participants`, { cookie: ui.cookie })).body!.participants as Array<{ displayName: string }>;
  assert.equal(list[0]!.displayName, 'Joe', 'normalized name is what is stored and shown');
  const engineNames = (() => { const r = h.engine.getSession(id); return r.ok ? r.value.participants.map((p) => p.displayName) : []; })();
  assert.ok(engineNames.every((n) => !/[​­⁠]/.test(n)), 'engine stores no invisible characters');
}));

test('[R4] finished, failed, cancelled and timed-out voice requests drop ownership and answer 404', withUi({}, async (h) => {
  const { id, ui, recId } = await h.cardReady();
  const explain = async () => (await h.http('POST', `/v1/sessions/${id}/recommendations/${recId}/explanation`, { cookie: ui.cookie })).body!.request as { id: string };
  const statusOf = (rid: string, status: string) => h.http('POST', `/v1/sessions/${id}/voice/${rid}/status`, { cookie: ui.cookie, json: { status } });
  const cancel = (rid: string) => h.http('POST', `/v1/sessions/${id}/voice/${rid}/cancel`, { cookie: ui.cookie });
  const gone = async (rid: string, label: string) => {
    for (const r of [await statusOf(rid, 'playing_locally'), await statusOf(rid, 'finished'), await statusOf(rid, 'failed'), await cancel(rid)]) {
      assert.deepEqual([r.status, r.body!.error], [404, 'voice_request_not_found'], label);
    }
  };
  const a = await explain();
  assert.equal((await statusOf(a.id, 'finished')).status, 200);
  await gone(a.id, 'finished');
  const b = await explain();
  assert.equal((await statusOf(b.id, 'failed')).status, 200);
  await gone(b.id, 'failed');
  const c = await explain();
  assert.equal((await cancel(c.id)).status, 200);
  await gone(c.id, 'cancelled');
  const d = await explain();
  h.clock.set(200); // well past the engine's 60 s voice timeout; no sweep has run yet
  await gone(d.id, 'timed out');
  const v = h.voice(id).find((x) => x.id === d.id)!;
  assert.deepEqual([v.status, v.cancelReason], ['cancelled', 'timeout']);
}));
