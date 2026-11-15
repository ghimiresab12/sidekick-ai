/**
 * REGRESSION (Codex review): an explanation is playing, the SSE stream drops briefly, the
 * browser stops speaking, but the bridge still holds the request as `playing_locally`. After
 * a quick reconnect (within the bridge's disconnect grace) the next explanation failed with
 * `voice_busy` until the engine's 60 s timeout.
 *
 * Runs the REAL seam: the bridge's HTTP server (`createBridge`) over the real coordinator and
 * engine (mock reasoning), the overlay's real `httpBackend`, the real voice controller and the
 * same connection → voice rule App.tsx uses (`syncVoiceWithConnection`). Only what a browser
 * provides is simulated: the cookie jar and Origin header, `EventSource` (with the browser's
 * automatic retry), the network going offline, and the speech engine.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { SidekickCoordinator } from '../../../src/coordinator/coordinator';
import { reason } from '../../../src/reasoning/reason.mts';
import { createMockProvider } from '../../../src/adapters/model/mock.mts';
import type { OverlayState, VoiceRequest } from '../contracts/shared';
import { createHttpBackend, type EventSourceLike } from '../backend/httpBackend';
import { BackendError, type ConnectionStatus, type SidekickBackend } from '../backend/SidekickBackend';
import type { SpeakHandlers, VoiceLike } from './speechService';
import { CONNECTION_LOST_REASON, createVoiceController, syncVoiceWithConnection, type VoiceController } from './voiceController';

// Loaded by URL so the overlay's type-check does not pull the bridge's Node-only modules in.
const BRIDGE_MODULE = new URL('../../../src/bridge/http-bridge.ts', import.meta.url).href;
interface BridgeLike {
  server: { closeAllConnections(): void };
  listen(port?: number): Promise<{ port: number; url: string }>;
  close(): Promise<void>;
}
type CreateBridge = (options: Record<string, unknown>) => BridgeLike;

const AGENT = 'agent-token-0123456789-abcdefghijklmnop';
const CONTROL = 'control-token-0123456789-abcdefghijklmn';
const VOICE: VoiceLike = { name: 'Local', lang: 'en-US', localService: true, default: true };

/** The browser: one cookie jar, same-origin Origin header, and a switch to go offline. */
function browser(origin: string) {
  let cookie = '';
  const net = { offline: false };
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    if (net.offline) throw new TypeError('Failed to fetch');
    const url = String(input);
    const headers = new Headers(init.headers);
    if (cookie) headers.set('cookie', cookie);
    if ((init.method ?? 'GET') !== 'GET') headers.set('origin', origin); // browsers send Origin on same-origin POST
    const res = await fetch(url.startsWith('http') ? url : origin + url, { ...init, headers });
    const set = res.headers.getSetCookie()[0];
    if (set) cookie = set.split(';')[0]!.endsWith('=') ? '' : set.split(';')[0]!;
    return res;
  }) as typeof fetch;

  /** Minimal EventSource over fetch, retrying like a browser after a network error. */
  class FetchEventSource implements EventSourceLike {
    readyState = 0;
    onerror: ((ev: unknown) => void) | null = null;
    private listeners = new Map<string, Array<(ev: { data?: string }) => void>>();
    private abort = new AbortController();
    private closed = false;
    constructor(private readonly url: string) {
      void this.run();
    }
    addEventListener(type: string, l: (ev: { data?: string }) => void) {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), l]);
    }
    close() {
      this.closed = true;
      this.readyState = 2;
      this.abort.abort();
    }
    private emit(type: string, data?: string) {
      for (const l of this.listeners.get(type) ?? []) l({ data });
    }
    private async run(): Promise<void> {
      while (!this.closed) {
        this.abort = new AbortController();
        try {
          const res = await fetchImpl(this.url, { signal: this.abort.signal });
          if (res.status !== 200 || !res.body) {
            this.readyState = 2; // browsers give up on non-200 answers
            this.onerror?.({});
            return;
          }
          this.readyState = 1;
          this.emit('open');
          const reader = res.body.getReader();
          let buf = '';
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += new TextDecoder().decode(value);
            let i: number;
            while ((i = buf.indexOf('\n\n')) >= 0) {
              const block = buf.slice(0, i);
              buf = buf.slice(i + 2);
              let event = 'message';
              let data = '';
              for (const line of block.split('\n')) {
                if (line.startsWith('event: ')) event = line.slice(7);
                else if (line.startsWith('data: ')) data += line.slice(6);
              }
              if (data) this.emit(event, data);
            }
          }
        } catch {
          /* network error or close() */
        }
        if (this.closed) return;
        this.readyState = 0; // a browser retries by itself
        this.onerror?.({});
        await new Promise((r) => setTimeout(r, 30));
      }
    }
  }
  return { fetchImpl, net, createEventSource: (url: string) => new FetchEventSource(url) };
}

/** Speech engine: records what is spoken and stopped; tests drive start/end. */
function speech() {
  const utterances: SpeakHandlers[] = [];
  let cancels = 0;
  const player = {
    speak: (_chunks: string[], _voice: VoiceLike, h: SpeakHandlers) => {
      utterances.push(h);
    },
    cancel: () => {
      cancels += 1;
    },
  };
  return { player, utterances, cancels: () => cancels };
}

async function until(pred: () => boolean, label: string, ms = 3_000) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

let cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanup.reverse()) await c();
  cleanup = [];
});

async function setup() {
  const { createBridge } = (await import(/* @vite-ignore */ BRIDGE_MODULE)) as { createBridge: CreateBridge };
  const provider = createMockProvider();
  const coordinator = new SidekickCoordinator({
    reasoning: (request, signal) => reason(request, provider, { signal }),
    conditionFactKeys: ['leftZoneVisible', 'leftZoneUncovered'],
  });
  // A long grace: the reconnect happens well inside it, as in the reported bug.
  const bridge = createBridge({ coordinator, agentToken: AGENT, controlToken: CONTROL, ui: { voiceDisconnectGraceMs: 60_000, heartbeatMs: 100 } });
  const { url } = await bridge.listen(0);
  cleanup.push(() => bridge.close());
  const engine = coordinator.engine;

  // 1. Start a session (operator role) with one live card.
  const sessionId = (coordinator.createSession() as { ok: true; value: { id: string } }).value.id;
  coordinator.addParticipant(sessionId, { displayName: 'Alex' });
  coordinator.confirmActivity(sessionId, 'gaming');
  expect(coordinator.startWithConsent(sessionId).ok).toBe(true);
  const gen = () => (engine.getSession(sessionId) as { ok: true; value: { captureGeneration: number } }).value.captureGeneration;
  coordinator.ingestConversation(sessionId, { captureGeneration: gen(), observedAt: new Date().toISOString(), text: 'Alex is responsible for left defense.' });
  await coordinator.whenIdle(sessionId);
  coordinator.ingestScreen(sessionId, {
    captureGeneration: gen(),
    observedAt: new Date().toISOString(),
    summary: 'The left defensive zone appears uncovered.',
    evidenceQuality: 'clear',
    facts: { leftZoneVisible: true, leftZoneUncovered: true },
  });
  await coordinator.whenIdle(sessionId);

  const pairing = await fetch(`${url}/v1/sessions/${sessionId}/pairings`, {
    method: 'POST',
    headers: { authorization: `Bearer ${CONTROL}`, 'content-type': 'application/json' },
    body: '{}',
  });
  let code: string | null = ((await pairing.json()) as { code: string }).code;

  // The overlay: real httpBackend + real voice controller, wired like App.tsx.
  const b = browser(url);
  const backend: SidekickBackend = createHttpBackend({
    baseUrl: url,
    fetchImpl: b.fetchImpl,
    createEventSource: b.createEventSource,
    readPairCode: () => code,
    clearPairCode: () => (code = null),
    reconnectDelaysMs: [30, 30, 30, 30, 30],
  });
  const sp = speech();
  const controller: VoiceController = createVoiceController({
    requestExplanation: (id) => backend.requestExplanation(id),
    reportStatus: (id, status) => backend.reportVoiceStatus(id, status),
    cancel: (id) => backend.cancelExplanation(id),
    isSpeechAvailable: () => true,
    findLocalVoice: async () => VOICE,
    getPlayer: () => sp.player,
  });
  const ui = { state: undefined as OverlayState | undefined, connection: 'connecting' as ConnectionStatus };
  const glue = () => {
    controller.syncActiveRequest(ui.state?.activeVoiceRequest);
    syncVoiceWithConnection(controller, ui.connection === 'connected', ui.state?.activeVoiceRequest);
  };
  const disconnect = backend.connect({
    onState: (s) => {
      if (!ui.state || s.version > ui.state.version) ui.state = s; // the reducer's version rule
      glue();
    },
    onConnection: (c) => {
      ui.connection = c;
      glue();
    },
  });
  cleanup.push(disconnect);
  await until(() => ui.connection === 'connected' && !!ui.state?.prominent, 'paired, connected, card shown');

  const serverVoice = (id: string): VoiceRequest | undefined => {
    const snap = engine.getSession(sessionId);
    return snap.ok ? snap.value.voiceRequests.find((v) => v.id === id) : undefined;
  };
  return { bridge, engine, sessionId, backend, controller, sp, ui, net: b.net, serverVoice };
}

describe('voice recovery after an SSE disconnection (real bridge ↔ overlay seam)', () => {
  it('disconnect during playback → speech stops, request ends on the server, new explanation works after reconnect', async () => {
    const t = await setup();
    const card = t.ui.state!.prominent!;

    // 2–3. Request an explanation; playback starts and the server sees playing_locally.
    await t.controller.explain(card.id);
    const first = t.controller.getState().requestId!;
    t.sp.utterances[0]!.onStart();
    await until(() => t.serverVoice(first)?.status === 'playing_locally', 'server: first request playing');
    await until(() => t.ui.state?.activeVoiceRequest?.requestId === first, 'stream shows first request active');
    expect(t.controller.getState().status).toBe('speaking');

    // 4. SSE disconnects, and the network stays down for a moment (reports cannot get through yet).
    t.net.offline = true;
    t.bridge.server.closeAllConnections();
    await until(() => t.ui.connection !== 'connected', 'overlay notices the disconnect');

    // 5. Browser speech is stopped, the text stays readable, nothing is restarted.
    expect(t.sp.cancels()).toBeGreaterThan(0);
    expect(t.controller.getState()).toMatchObject({ status: 'failed', requestId: first });
    expect(t.controller.getState().fallback?.reason).toBe(CONNECTION_LOST_REASON);
    expect(t.serverVoice(first)?.status).toBe('playing_locally'); // the server has not heard yet
    await until(() => t.controller.pendingReports().includes(first), 'interruption report queued for retry');

    // 7. Reconnect: the stream restores the state, and the queued report is re-sent.
    t.net.offline = false;
    await until(() => t.ui.connection === 'connected', 'reconnected');

    // 6. The interrupted request is ended on the server with the existing contract (failed).
    await until(() => t.serverVoice(first)?.status === 'failed', 'server: first request failed');
    await until(() => t.ui.state?.activeVoiceRequest === undefined && t.ui.state?.voiceBusy === false, 'no active request');
    expect(t.controller.pendingReports()).toEqual([]);
    expect(t.sp.utterances).toHaveLength(1); // reconnecting never restarted speech
    await until(() => t.ui.state?.prominent?.canExplain === true, 'card explainable again');

    // 8–10. A new explanation succeeds: no voice_busy.
    await t.controller.explain(card.id);
    const second = t.controller.getState().requestId!;
    expect(second).not.toBe(first);
    expect(t.controller.getState().status).toBe('preparing');
    expect(t.controller.getState().fallback).toBeNull();
    t.sp.utterances[1]!.onStart();
    expect(t.controller.getState().status).toBe('speaking');
    await until(() => t.serverVoice(second)?.status === 'playing_locally', 'server: second request playing');

    // 11. Late events from the first request do not touch the second.
    t.sp.utterances[0]!.onEnd(); // a late speech callback from the interrupted utterance
    t.sp.utterances[0]!.onError('interrupted');
    await expect(t.backend.reportVoiceStatus(first, 'finished')).rejects.toBeInstanceOf(BackendError); // late report
    await expect(t.backend.cancelExplanation(first)).rejects.toMatchObject({ code: 'voice_request_not_found' });
    expect(t.controller.getState()).toMatchObject({ status: 'speaking', requestId: second });
    expect(t.serverVoice(second)?.status).toBe('playing_locally');
    await until(() => t.ui.state?.activeVoiceRequest?.requestId === second, 'stream shows second request');

    // The second explanation completes normally.
    t.sp.utterances[1]!.onEnd();
    await until(() => t.serverVoice(second)?.status === 'finished', 'server: second request finished');
  });

  it('a brief drop with the network still up ends the request immediately (no retry needed)', async () => {
    const t = await setup();
    const card = t.ui.state!.prominent!;
    await t.controller.explain(card.id);
    const first = t.controller.getState().requestId!;
    t.sp.utterances[0]!.onStart();
    await until(() => t.serverVoice(first)?.status === 'playing_locally', 'playing');

    t.bridge.server.closeAllConnections();
    await until(() => t.serverVoice(first)?.status === 'failed', 'server: failed after the drop');
    await until(() => t.ui.connection === 'connected' && t.ui.state?.prominent?.canExplain === true, 'reconnected, explainable');
    await t.controller.explain(card.id);
    expect(t.controller.getState().status).toBe('preparing');
    expect(t.controller.getState().requestId).not.toBe(first);
  });

  it('manual Stop still cancels with reason user, acknowledged by the server', async () => {
    const t = await setup();
    await t.controller.explain(t.ui.state!.prominent!.id);
    const id = t.controller.getState().requestId!;
    t.sp.utterances[0]!.onStart();
    t.controller.stop();
    await until(() => t.serverVoice(id)?.status === 'cancelled', 'server: cancelled');
    expect(t.serverVoice(id)?.cancelReason).toBe('user');
    expect(t.controller.pendingReports()).toEqual([]);
  });

  it('WITHOUT the fix (silence only, as before), the same sequence ends in voice_busy', async () => {
    const t = await setup();
    const card = t.ui.state!.prominent!;
    await t.controller.explain(card.id);
    const first = t.controller.getState().requestId!;
    t.sp.utterances[0]!.onStart();
    await until(() => t.serverVoice(first)?.status === 'playing_locally', 'playing');
    // The old App.tsx behaviour: silence locally, report nothing.
    t.controller.reset();
    t.bridge.server.closeAllConnections();
    await until(() => t.ui.connection === 'connected', 'reconnected');
    expect(t.serverVoice(first)?.status).toBe('playing_locally');
    await expect(t.backend.requestExplanation(card.id)).rejects.toMatchObject({ code: 'voice_busy', httpStatus: 409 });
  });
});
