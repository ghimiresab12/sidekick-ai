/**
 * The HTTP adapter against the bridge's browser API contract (engineering.md
 * "Integration milestone 4"), with a fake fetch and a fake EventSource. The real bridge
 * is exercised end to end by `npm run e2e:bridge` (see overlay/README.md).
 */
import { describe, expect, it } from 'vitest';
import type { OverlayState } from '../contracts/shared';
import { createHttpBackend, type EventSourceLike, type HttpBackendOptions } from './httpBackend';
import { BackendError, REPAIR_MESSAGE, type ConnectionStatus } from './SidekickBackend';

type Reply = { status: number; body?: unknown } | Error;
interface Call { method: string; url: string; headers: Record<string, string>; body?: unknown; credentials?: string }

class FakeEventSource implements EventSourceLike {
  readyState = 0;
  onerror: ((ev: unknown) => void) | null = null;
  closed = false;
  private listeners = new Map<string, Array<(ev: { data?: string }) => void>>();
  constructor(readonly url: string) {}
  addEventListener(type: string, l: (ev: { data?: string }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), l]);
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
  emit(type: string, data?: unknown) {
    if (type === 'open') this.readyState = 1;
    for (const l of this.listeners.get(type) ?? []) l({ data: data === undefined ? undefined : JSON.stringify(data) });
  }
  fail(readyState: 0 | 2) {
    this.readyState = readyState;
    this.onerror?.({});
  }
}

const state = (version: number, over: Partial<OverlayState> = {}): OverlayState =>
  ({ sessionId: 'S1', version, status: 'active', activity: 'gaming', activityConfirmed: true, history: [], voiceBusy: false, ...over }) as OverlayState;

function harness(routes: Record<string, Reply | Reply[]>, opts: Partial<HttpBackendOptions> & { code?: string | null } = {}) {
  const calls: Call[] = [];
  const sources: FakeEventSource[] = [];
  const timers: Array<() => void> = [];
  let code = opts.code ?? null;
  let cleared = 0;
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    calls.push({
      method,
      url,
      headers: { ...(init.headers as Record<string, string>) },
      body: init.body ? JSON.parse(init.body as string) : undefined,
      credentials: init.credentials,
    });
    const key = `${method} ${url}`;
    const entry = routes[key];
    const reply = Array.isArray(entry) ? entry.shift() : entry;
    if (!reply) throw new Error(`unexpected ${key}`);
    if (reply instanceof Error) throw reply;
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status });
  }) as unknown as typeof fetch;
  const backend = createHttpBackend({
    fetchImpl,
    createEventSource: (url) => {
      const es = new FakeEventSource(url);
      sources.push(es);
      return es;
    },
    readPairCode: () => code,
    clearPairCode: () => {
      cleared += 1;
      code = null;
    },
    setTimer: (fn) => timers.push(fn),
    clearTimer: () => {},
    ...opts,
  });
  const states: OverlayState[] = [];
  const connection: Array<[ConnectionStatus, string | undefined]> = [];
  let discarded = 0;
  const listener = {
    onState: (s: OverlayState) => states.push(s),
    onConnection: (s: ConnectionStatus, d?: string) => connection.push([s, d]),
    onDiscarded: () => (discarded += 1),
  };
  return { backend, calls, sources, timers, states, connection, listener, cleared: () => cleared, discarded: () => discarded };
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};
const SESSION_OK = { status: 200, body: { ok: true, sessionId: 'S1', participantId: 'P1' } };

describe('http backend: pairing and session recovery', () => {
  it('redeems #pair=<code> once, removes the fragment, then opens the same-origin stream', async () => {
    const h = harness({ 'POST /v1/ui/pair': SESSION_OK }, { code: 'ABCDEFGHJKMN' });
    h.backend.connect(h.listener);
    await flush();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({
      method: 'POST',
      url: '/v1/ui/pair',
      body: { code: 'ABCDEFGHJKMN' },
      credentials: 'same-origin',
      headers: { 'X-Sidekick-UI': '1', 'Content-Type': 'application/json' },
    });
    expect(h.cleared()).toBe(1);
    expect(h.sources.map((s) => s.url)).toEqual(['/v1/sessions/S1/stream']);
    h.sources[0]!.emit('open');
    h.sources[0]!.emit('state', state(3));
    expect(h.connection.map((c) => c[0])).toEqual(['connecting', 'connected']);
    expect(h.states.map((s) => s.version)).toEqual([3]);
  });

  it('pairs only once even when React StrictMode connects twice', async () => {
    const h = harness({ 'POST /v1/ui/pair': SESSION_OK }, { code: 'ABCDEFGHJKMN' });
    const first = h.backend.connect(h.listener);
    first();
    h.backend.connect(h.listener);
    await flush();
    expect(h.calls.filter((c) => c.url === '/v1/ui/pair')).toHaveLength(1);
    expect(h.sources).toHaveLength(1); // the first connection was closed before the session resolved
  });

  it('without a code, recovers the session from the HttpOnly cookie (GET /v1/ui/session, no CSRF header)', async () => {
    const h = harness({ 'GET /v1/ui/session': SESSION_OK });
    h.backend.connect(h.listener);
    await flush();
    expect(h.calls[0]!.headers).toEqual({});
    expect(h.sources[0]!.url).toBe('/v1/sessions/S1/stream');
  });

  it('401 (expired, revoked or missing cookie) asks for a new pairing link and opens no stream', async () => {
    const h = harness({ 'GET /v1/ui/session': { status: 401, body: { ok: false, error: 'unauthorized' } } });
    h.backend.connect(h.listener);
    await flush();
    expect(h.connection.at(-1)).toEqual(['unavailable', REPAIR_MESSAGE]);
    expect(h.sources).toHaveLength(0);
  });

  it('an invalid or used pairing code is reported, and the fragment is still removed', async () => {
    const h = harness({ 'POST /v1/ui/pair': { status: 401, body: { ok: false, error: 'invalid_pairing' } } }, { code: 'ABCDEFGHJKMN' });
    h.backend.connect(h.listener);
    await flush();
    expect(h.cleared()).toBe(1);
    expect(h.connection.at(-1)![0]).toBe('unavailable');
    expect(h.connection.at(-1)![1]).toMatch(/new pairing link/);
  });

  it('bridge unreachable → unavailable; "Try again" bootstraps again', async () => {
    const h = harness({ 'GET /v1/ui/session': [new TypeError('Failed to fetch'), SESSION_OK] });
    h.backend.connect(h.listener);
    await flush();
    expect(h.connection.at(-1)![0]).toBe('unavailable');
    h.backend.connect(h.listener);
    await flush();
    expect(h.sources).toHaveLength(1);
  });
});

describe('http backend: live state stream', () => {
  async function connected() {
    const h = harness({ 'GET /v1/ui/session': [SESSION_OK, SESSION_OK, SESSION_OK] });
    const disconnect = h.backend.connect(h.listener);
    await flush();
    h.sources[0]!.emit('open');
    return { ...h, disconnect };
  }

  it('ignores malformed snapshots and snapshots for another session', async () => {
    const h = await connected();
    h.sources[0]!.emit('state', { nope: true });
    h.sources[0]!.emit('state', state(5, { sessionId: 'OTHER' }));
    h.sources[0]!.emit('state', state(6));
    expect(h.states.map((s) => s.version)).toEqual([6]);
  });

  it('event: discarded ends the session and closes the stream', async () => {
    const h = await connected();
    h.sources[0]!.emit('discarded', {});
    expect(h.discarded()).toBe(1);
    expect(h.sources[0]!.closed).toBe(true);
  });

  it('a transient error (browser retrying) shows reconnecting, then connected again', async () => {
    const h = await connected();
    h.sources[0]!.fail(0);
    expect(h.connection.at(-1)![0]).toBe('reconnecting');
    h.sources[0]!.emit('open');
    expect(h.connection.at(-1)![0]).toBe('connected');
    expect(h.sources).toHaveLength(1);
  });

  it('when the browser gives up, it checks the cookie and re-opens the stream with backoff', async () => {
    const h = await connected();
    h.sources[0]!.fail(2);
    expect(h.connection.at(-1)![0]).toBe('reconnecting');
    expect(h.timers).toHaveLength(1);
    h.timers.shift()!();
    await flush();
    expect(h.sources).toHaveLength(2);
    h.sources[1]!.emit('open');
    h.sources[1]!.emit('state', state(9));
    expect(h.connection.at(-1)![0]).toBe('connected');
    expect(h.states.at(-1)!.version).toBe(9);
  });

  it('when the browser gives up and the cookie is gone, it asks to re-pair instead of retrying', async () => {
    const h = harness({ 'GET /v1/ui/session': [SESSION_OK, { status: 401, body: { ok: false, error: 'unauthorized' } }] });
    h.backend.connect(h.listener);
    await flush();
    h.sources[0]!.fail(2);
    h.timers.shift()!();
    await flush();
    expect(h.connection.at(-1)).toEqual(['unavailable', REPAIR_MESSAGE]);
    expect(h.sources).toHaveLength(1);
    expect(h.timers).toHaveLength(0);
  });

  it('gives up after the last backoff step', async () => {
    const h = harness({ 'GET /v1/ui/session': [SESSION_OK, SESSION_OK] }, { reconnectDelaysMs: [10] });
    h.backend.connect(h.listener);
    await flush();
    h.sources[0]!.fail(2);
    h.timers.shift()!();
    await flush();
    h.sources[1]!.fail(2);
    expect(h.connection.at(-1)).toEqual(['unavailable', 'Could not reconnect to the Sidekick bridge.']);
  });

  it('disconnect closes the stream; later events are ignored', async () => {
    const h = await connected();
    h.disconnect();
    expect(h.sources[0]!.closed).toBe(true);
    h.sources[0]!.emit('state', state(7));
    expect(h.states).toHaveLength(0);
  });
});

describe('http backend: commands follow the frontend contract', () => {
  async function ready(extra: Record<string, Reply | Reply[]>) {
    const h = harness({ 'GET /v1/ui/session': SESSION_OK, ...extra });
    h.backend.connect(h.listener);
    await flush();
    h.calls.length = 0;
    return h;
  }

  it('maps every operation to its route; non-GET carries X-Sidekick-UI; never an Authorization header', async () => {
    const VR = { id: 'V1', sessionId: 'S1', recommendationId: 'R1', status: 'pending', requestedAt: 't', updatedAt: 't' };
    const h = await ready({
      'POST /v1/sessions/S1/pause': { status: 200, body: { ok: true } },
      'POST /v1/sessions/S1/end': { status: 200, body: { ok: true } },
      'POST /v1/sessions/S1/recommendations/R1/dismiss': { status: 200, body: { ok: true } },
      'POST /v1/sessions/S1/recommendations/R1/explanation': {
        status: 200,
        body: { ok: true, request: VR, text: 'Explain.', refersToEarlierObservation: false },
      },
      'POST /v1/sessions/S1/voice/V1/status': { status: 200, body: { ok: true, request: VR } },
      'POST /v1/sessions/S1/voice/V1/cancel': { status: 200, body: { ok: true, request: VR } },
      'GET /v1/sessions/S1/timeline': { status: 200, body: { ok: true, events: [], truncated: false } },
      'GET /v1/sessions/S1/participants': { status: 200, body: { ok: true, participants: [{ id: 'P1', displayName: 'Alex' }] } },
      'POST /v1/sessions/S1/participants': { status: 201, body: { ok: true, id: 'P2', displayName: 'José' } },
      'POST /v1/sessions/S1/activity': { status: 200, body: { ok: true } },
      'DELETE /v1/sessions/S1': { status: 204 },
    });
    await h.backend.pauseSession();
    await h.backend.endSession();
    await h.backend.dismiss('R1');
    const script = await h.backend.requestExplanation('R1');
    expect(script).toEqual({ request: VR, text: 'Explain.', refersToEarlierObservation: false });
    await h.backend.reportVoiceStatus('V1', 'playing_locally');
    await h.backend.cancelExplanation('V1');
    expect(await h.backend.getTimeline()).toEqual({ events: [], truncated: false });
    expect(await h.backend.setup!.listParticipants()).toEqual([{ id: 'P1', displayName: 'Alex' }]);
    expect(await h.backend.setup!.addParticipant('  José ')).toEqual({ id: 'P2', displayName: 'José' });
    await h.backend.setup!.confirmGaming();
    await h.backend.discardSession();

    expect(h.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST /v1/sessions/S1/pause',
      'POST /v1/sessions/S1/end',
      'POST /v1/sessions/S1/recommendations/R1/dismiss',
      'POST /v1/sessions/S1/recommendations/R1/explanation',
      'POST /v1/sessions/S1/voice/V1/status',
      'POST /v1/sessions/S1/voice/V1/cancel',
      'GET /v1/sessions/S1/timeline',
      'GET /v1/sessions/S1/participants',
      'POST /v1/sessions/S1/participants',
      'POST /v1/sessions/S1/activity',
      'DELETE /v1/sessions/S1',
    ]);
    for (const c of h.calls) {
      expect(c.credentials).toBe('same-origin');
      expect(Object.keys(c.headers).map((k) => k.toLowerCase())).not.toContain('authorization');
      if (c.method === 'GET') expect(c.headers['X-Sidekick-UI']).toBeUndefined();
      else expect(c.headers['X-Sidekick-UI']).toBe('1');
      // Bodyless routes send no Content-Type; JSON routes send exactly the documented keys.
      if (c.body === undefined) expect(c.headers['Content-Type']).toBeUndefined();
    }
    expect(h.calls.find((c) => c.url.endsWith('/status'))!.body).toEqual({ status: 'playing_locally' });
    expect(h.calls.find((c) => c.method === 'POST' && c.url.endsWith('/participants'))!.body).toEqual({ displayName: '  José ' });
    expect(h.calls.find((c) => c.url.endsWith('/activity'))!.body).toEqual({ activity: 'gaming' });
  });

  it('start and resume are operator-only: rejected locally, nothing is sent', async () => {
    const h = await ready({});
    await expect(h.backend.startSession()).rejects.toMatchObject({ code: 'operator_only' });
    await expect(h.backend.resumeSession()).rejects.toMatchObject({ code: 'operator_only' });
    expect(h.calls).toEqual([]);
    expect(h.backend.capabilities).toEqual({ consent: 'operator', resume: false });
  });

  it('errors become BackendError with the bridge code and HTTP status', async () => {
    const h = await ready({
      'POST /v1/sessions/S1/recommendations/R1/explanation': { status: 409, body: { ok: false, error: 'voice_busy' } },
      'POST /v1/sessions/S1/voice/V9/status': { status: 404, body: { ok: false, error: 'voice_request_not_found' } },
      'POST /v1/sessions/S1/participants': { status: 409, body: { ok: false, error: 'duplicate_participant' } },
      'POST /v1/sessions/S1/pause': new TypeError('Failed to fetch'),
    });
    const e1 = await h.backend.requestExplanation('R1').catch((e: unknown) => e);
    expect(e1).toBeInstanceOf(BackendError);
    expect(e1).toMatchObject({ code: 'voice_busy', httpStatus: 409, message: 'Another explanation is already playing.' });
    await expect(h.backend.reportVoiceStatus('V9', 'finished')).rejects.toMatchObject({ code: 'voice_request_not_found', httpStatus: 404 });
    await expect(h.backend.setup!.addParticipant('Alex')).rejects.toMatchObject({ code: 'duplicate_participant' });
    await expect(h.backend.pauseSession()).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('a malformed explanation is rejected instead of being spoken', async () => {
    const h = await ready({
      'POST /v1/sessions/S1/recommendations/R1/explanation': { status: 200, body: { ok: true, text: 'no request id' } },
    });
    await expect(h.backend.requestExplanation('R1')).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('a 401 on any command stops the stream and asks to re-pair', async () => {
    const h = await ready({ 'POST /v1/sessions/S1/end': { status: 401, body: { ok: false, error: 'unauthorized' } } });
    await expect(h.backend.endSession()).rejects.toMatchObject({ code: 'unauthorized' });
    expect(h.sources[0]!.closed).toBe(true);
    expect(h.connection.at(-1)).toEqual(['unavailable', REPAIR_MESSAGE]);
  });

  it('ids are URL-encoded into paths', async () => {
    const h = await ready({ 'POST /v1/sessions/S1/recommendations/a%2Fb/dismiss': { status: 200, body: { ok: true } } });
    await h.backend.dismiss('a/b');
    expect(h.calls[0]!.url).toBe('/v1/sessions/S1/recommendations/a%2Fb/dismiss');
  });
});
