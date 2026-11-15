/**
 * HTTP backend: the overlay as a CLIENT of the Node bridge's browser API
 * (docs/engineering.md "Integration milestone 4", "Frontend contract"). The bridge
 * process is the single owner of the engine, the coordinator and session state; this
 * file holds no session logic of its own.
 *
 * Startup: `#pair=<code>` in the URL → `POST /v1/ui/pair` (the fragment is removed
 * afterwards), otherwise `GET /v1/ui/session` (the HttpOnly cookie alone recovers the
 * session after a reload). `401` anywhere means "ask the operator for a new pairing link".
 *
 * Live state: same-origin `EventSource` on `/v1/sessions/:id/stream` (`event: state`
 * carries a projected `OverlayState`; `event: discarded` ends the session). Versions that
 * do not increase are dropped by the session reducer.
 *
 * Requests: `credentials: 'same-origin'`; every non-GET carries `X-Sidekick-UI: 1` and
 * either a JSON body or none. Errors are `{ ok: false, error }` → `BackendError(code)`.
 *
 * This is the ONLY overlay file allowed to use the network (privacyBoundary.test.ts).
 * It never sees a bearer token; the bridge refuses bearer requests from browsers.
 */
import type { BrowserSessionTimeline, ExplanationScript, OverlayState } from '../contracts/shared';
import {
  BackendError,
  REPAIR_MESSAGE,
  type BackendCapabilities,
  type BackendErrorCode,
  type BackendLabel,
  type BackendListener,
  type BrowserParticipant,
  type LocalVoiceStatus,
  type SidekickBackend,
} from './SidekickBackend';

/** The subset of `EventSource` this adapter uses (injectable for tests). */
export interface EventSourceLike {
  readonly readyState: number;
  onerror: ((ev: unknown) => void) | null;
  addEventListener(type: string, listener: (ev: { data?: string }) => void): void;
  close(): void;
}

const ES_CLOSED = 2;

export interface HttpBackendOptions {
  /** Origin prefix for API calls. Default '' (same origin, as served by the bridge at /ui/). */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  createEventSource?: (url: string) => EventSourceLike;
  /** Returns the one-time pairing code from the URL fragment, if any. */
  readPairCode?: () => string | null;
  /** Removes the pairing fragment from the address bar and history. */
  clearPairCode?: () => void;
  /** Delays between stream re-open attempts after the browser gave up. */
  reconnectDelaysMs?: readonly number[];
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export const HTTP_LABEL: BackendLabel = {
  title: 'Local Sidekick bridge',
  detail:
    'Session state comes from the Sidekick bridge on this computer (localhost only) · live Chert/FaceTime capture is not verified · voice plays on this device only, never into the call · companion panel, not a native overlay',
  syntheticInput: false,
};

const HTTP_CAPABILITIES: BackendCapabilities = { consent: 'operator', resume: false };

const DEFAULT_DELAYS = [500, 1_000, 2_000, 4_000, 8_000, 8_000, 8_000, 8_000];

const PAIR_FRAGMENT = /^#pair=([A-Za-z0-9]{1,64})$/;

function defaultReadPairCode(): string | null {
  const m = PAIR_FRAGMENT.exec(globalThis.location?.hash ?? '');
  return m ? m[1]! : null;
}

function defaultClearPairCode(): void {
  const loc = globalThis.location;
  if (loc && loc.hash) globalThis.history?.replaceState(null, '', loc.pathname + loc.search);
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

function isOverlayState(v: unknown, sessionId: string): v is OverlayState {
  return (
    isObject(v) &&
    v.sessionId === sessionId &&
    typeof v.version === 'number' &&
    typeof v.status === 'string' &&
    Array.isArray(v.history)
  );
}

function isScript(v: Json): boolean {
  const r = v.request;
  return (
    isObject(r) &&
    typeof r.id === 'string' &&
    typeof r.recommendationId === 'string' &&
    typeof r.status === 'string' &&
    typeof v.text === 'string' &&
    typeof v.refersToEarlierObservation === 'boolean'
  );
}

export function createHttpBackend(options: HttpBackendOptions = {}): SidekickBackend {
  const base = options.baseUrl ?? '';
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const createEventSource = options.createEventSource ?? ((url: string) => new EventSource(url) as unknown as EventSourceLike);
  const readPairCode = options.readPairCode ?? defaultReadPairCode;
  const clearPairCode = options.clearPairCode ?? defaultClearPairCode;
  const delays = options.reconnectDelaysMs ?? DEFAULT_DELAYS;
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  /** One bootstrap per backend instance (React StrictMode connects twice; a code is one-time). */
  let sessionPromise: Promise<{ sessionId: string; participantId?: string }> | null = null;
  /** Called when any request answers 401: the active connection must stop and ask to re-pair. */
  let onUnauthorized: (() => void) | null = null;
  let discarded = false;

  async function request(method: 'GET' | 'POST' | 'DELETE', path: string, body?: Json): Promise<Json | undefined> {
    const headers: Record<string, string> = {};
    if (method !== 'GET') headers['X-Sidekick-UI'] = '1';
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let res: Response;
    try {
      res = await fetchImpl(base + path, {
        method,
        headers,
        credentials: 'same-origin',
        cache: 'no-store',
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new BackendError('unavailable');
    }
    if (res.status === 204) return undefined;
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      json = undefined;
    }
    if (!res.ok || !isObject(json) || json.ok !== true) {
      const code = (isObject(json) && typeof json.error === 'string' ? json.error : res.ok ? 'invalid_response' : 'unknown_error') as BackendErrorCode;
      if (res.status === 401) {
        sessionPromise = null;
        onUnauthorized?.();
      }
      throw new BackendError(code, undefined, res.status);
    }
    return json;
  }

  async function bootstrap(): Promise<{ sessionId: string; participantId?: string }> {
    const code = readPairCode();
    let body: Json | undefined;
    if (code) {
      try {
        body = await request('POST', '/v1/ui/pair', { code });
      } finally {
        clearPairCode(); // one-time code: never left in the address bar or reused on reload
      }
    } else {
      body = await request('GET', '/v1/ui/session');
    }
    if (!body || typeof body.sessionId !== 'string') throw new BackendError('invalid_response');
    return {
      sessionId: body.sessionId,
      ...(typeof body.participantId === 'string' ? { participantId: body.participantId } : {}),
    };
  }

  function ensureSession() {
    if (!sessionPromise) {
      const p = bootstrap();
      sessionPromise = p;
      p.catch(() => {
        if (sessionPromise === p) sessionPromise = null; // allow "Try again"
      });
    }
    return sessionPromise;
  }

  const sessionPath = async (suffix = '') => `/v1/sessions/${encodeURIComponent((await ensureSession()).sessionId)}${suffix}`;
  const seg = encodeURIComponent;

  return {
    label: HTTP_LABEL,
    capabilities: HTTP_CAPABILITIES,

    connect(listener: BackendListener) {
      let closed = false;
      let source: EventSourceLike | undefined;
      let timer: unknown;
      let attempt = 0;
      let connected = false;

      const status = (s: 'connected' | 'reconnecting' | 'unavailable', detail?: string) => {
        if (closed) return;
        connected = s === 'connected';
        listener.onConnection(s, detail);
      };
      const closeSource = () => {
        source?.close();
        source = undefined;
      };
      const stop = () => {
        closed = true;
        closeSource();
        if (timer !== undefined) clearTimer(timer);
        timer = undefined;
        if (onUnauthorized === handleUnauthorized) onUnauthorized = null;
      };
      const handleUnauthorized = () => {
        if (closed) return;
        closeSource();
        status('unavailable', REPAIR_MESSAGE);
      };
      onUnauthorized = handleUnauthorized;

      if (discarded) {
        listener.onConnection('unavailable', 'This session was discarded.');
        return () => {};
      }
      listener.onConnection('connecting');

      const scheduleReopen = (sessionId: string) => {
        if (closed) return;
        const delay = delays[attempt];
        if (delay === undefined) {
          status('unavailable', 'Could not reconnect to the Sidekick bridge.');
          return;
        }
        attempt += 1;
        timer = setTimer(() => {
          timer = undefined;
          void diagnoseAndReopen(sessionId);
        }, delay);
      };

      /** The browser gave up on the stream (non-200 answer). Find out whether re-pairing is needed. */
      const diagnoseAndReopen = async (sessionId: string) => {
        if (closed) return;
        try {
          const s = await request('GET', '/v1/ui/session');
          if (closed) return;
          if (s?.sessionId !== sessionId) {
            status('unavailable', 'This device is now paired with a different session. Reload the page.');
            return;
          }
          open(sessionId);
        } catch (e) {
          if (closed) return;
          if (e instanceof BackendError && e.code === 'unauthorized') return; // handled: re-pair message shown
          if (e instanceof BackendError && e.code === 'unavailable') return scheduleReopen(sessionId);
          status('unavailable', e instanceof Error ? e.message : undefined);
        }
      };

      const open = (sessionId: string) => {
        if (closed) return;
        const es = createEventSource(`${base}/v1/sessions/${seg(sessionId)}/stream`);
        source = es;
        es.addEventListener('open', () => {
          if (source !== es) return;
          attempt = 0;
          status('connected');
        });
        es.addEventListener('state', (ev) => {
          if (source !== es || closed) return;
          let parsed: unknown;
          try {
            parsed = JSON.parse(ev.data ?? '');
          } catch {
            parsed = undefined;
          }
          if (!isOverlayState(parsed, sessionId)) return; // never apply a malformed or foreign snapshot
          if (!connected) status('connected');
          listener.onState(parsed);
        });
        es.addEventListener('discarded', () => {
          if (source !== es || closed) return;
          closeSource();
          discarded = true;
          listener.onDiscarded?.();
        });
        es.onerror = () => {
          if (source !== es || closed) return;
          if (es.readyState !== ES_CLOSED) {
            // The browser is retrying by itself (network blip, bridge restart).
            status('reconnecting');
            return;
          }
          closeSource();
          status('reconnecting');
          scheduleReopen(sessionId);
        };
      };

      ensureSession().then(
        ({ sessionId }) => open(sessionId),
        (e: unknown) => {
          if (closed) return;
          if (e instanceof BackendError && e.code === 'unauthorized') return status('unavailable', REPAIR_MESSAGE);
          status('unavailable', e instanceof Error ? e.message : undefined);
        },
      );

      return stop;
    },

    async startSession() {
      throw new BackendError('operator_only', 'Only the operator can start observation, after everyone agrees.');
    },
    async pauseSession() {
      await request('POST', await sessionPath('/pause'));
    },
    async resumeSession() {
      throw new BackendError('operator_only', 'Only the operator can resume observation.');
    },
    async endSession() {
      await request('POST', await sessionPath('/end'));
    },
    async discardSession() {
      await request('DELETE', await sessionPath());
      discarded = true;
    },

    async dismiss(recommendationId) {
      await request('POST', await sessionPath(`/recommendations/${seg(recommendationId)}/dismiss`));
    },

    async requestExplanation(recommendationId): Promise<ExplanationScript> {
      const body = await request('POST', await sessionPath(`/recommendations/${seg(recommendationId)}/explanation`));
      if (!body || !isScript(body)) throw new BackendError('invalid_response');
      return {
        request: body.request as ExplanationScript['request'],
        text: body.text as string,
        refersToEarlierObservation: body.refersToEarlierObservation as boolean,
      };
    },
    async reportVoiceStatus(requestId, status: LocalVoiceStatus) {
      await request('POST', await sessionPath(`/voice/${seg(requestId)}/status`), { status });
    },
    async cancelExplanation(requestId) {
      await request('POST', await sessionPath(`/voice/${seg(requestId)}/cancel`));
    },

    async getTimeline(): Promise<BrowserSessionTimeline> {
      const body = await request('GET', await sessionPath('/timeline'));
      if (!body || !Array.isArray(body.events) || typeof body.truncated !== 'boolean') throw new BackendError('invalid_response');
      return { events: body.events as BrowserSessionTimeline['events'], truncated: body.truncated };
    },

    setup: {
      async listParticipants(): Promise<BrowserParticipant[]> {
        const body = await request('GET', await sessionPath('/participants'));
        if (!body || !Array.isArray(body.participants)) throw new BackendError('invalid_response');
        return body.participants as BrowserParticipant[];
      },
      async addParticipant(displayName: string): Promise<BrowserParticipant> {
        const body = await request('POST', await sessionPath('/participants'), { displayName });
        if (!body || typeof body.id !== 'string' || typeof body.displayName !== 'string') throw new BackendError('invalid_response');
        return { id: body.id, displayName: body.displayName };
      },
      async confirmGaming() {
        await request('POST', await sessionPath('/activity'), { activity: 'gaming' });
      },
    },
  };
}
