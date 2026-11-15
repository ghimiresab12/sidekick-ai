/**
 * Authenticated localhost HTTP bridge: Python LiveKit agent ⇄ SidekickCoordinator.
 *
 * - Binds to 127.0.0.1 only. Rejects browser-originated requests (`Origin`) and
 *   unexpected `Host` headers (DNS rebinding). Never expose it publicly.
 * - Two bearer tokens: the AGENT token may create sessions, read capture state and
 *   ingest; the CONTROL token may grant consent and change the lifecycle. The agent can
 *   never grant consent. Tokens are compared in constant time and never logged. Bearer
 *   requests carrying an `Origin` header are always refused: tokens never come from browsers.
 * - Browser UI (milestone 4): served same-origin at `/ui/`, paired with a one-time code
 *   (`POST /v1/sessions/:id/pairings` → `POST /v1/ui/pair`), then authenticated by a
 *   session-scoped HttpOnly SameSite=Strict cookie. UI state changes require the bridge's
 *   own `Origin` plus `X-Sidekick-UI: 1` (CSRF). A UI cookie is valid for exactly one
 *   session; any other session id answers 404. Discard revokes all of a session's UI cookies.
 *   UI cookies may pause/end/discard but never consent or resume (operator only). Every
 *   browser-facing body is privacy-projected (src/privacy/browser-projection.ts): no goal,
 *   decision or unsafe role wording leaves the server.
 * - Authentication, routing, content type and declared size are checked from headers
 *   BEFORE any body is read. Bodies are size-capped while streaming.
 * - All writes go through the coordinator; the engine is only read (capture state).
 * - Nothing is persisted or logged: no transcript text, image bytes, headers or tokens.
 *   The optional log hook receives only method, route pattern, status and duration.
 * - Frame capture metadata (`X-Capture-Generation`, `X-Observed-At`) is read from headers
 *   before the body and passed through unchanged. Frame processing is bounded by
 *   `frameTimeoutMs` and cancelled on client disconnect, pause, end or discard; a
 *   cancelled frame is never ingested.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { BrowserSessionTimeline, ExplanationScript, SessionSnapshot, VoiceRequest } from '../contracts/types.js';
import type { SidekickCoordinator } from '../coordinator/coordinator.js';
import type { FrameInput } from '../coordinator/ports.js';
import { buildExplanationText } from '../explanations/explanation-text.js';
import { projectOverlayState, projectParticipant, projectTimelineEvent, projectVoiceRequest } from '../privacy/browser-projection.js';
import { openStateStream, type StateStream } from './sse.js';
import { createStaticUi, UI_SECURITY_HEADERS, type StaticUiLimits } from './static-ui.js';
import { clearedUiCookie, readCookie, UI_COOKIE, uiCookie, UiAuth, type UiClient } from './ui-auth.js';

export const BRIDGE_HOST = '127.0.0.1';
export const MAX_FRAME_BYTES = 5 * 1024 * 1024; // coordinator hard ceiling
const MIN_TOKEN_LENGTH = 32;
const FRAME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const GENERATION_RE = /^[1-9][0-9]{0,15}$/;

export interface BridgeLogEntry {
  method: string;
  /** Route pattern (e.g. `/v1/sessions/:id/frames`), never the concrete path or query. */
  route: string;
  status: number;
  durationMs: number;
}

export interface BridgeOptions {
  coordinator: SidekickCoordinator;
  agentToken: string;
  controlToken: string;
  /** Frame body limit in bytes (1 … 5 MiB). Keep ≤ the coordinator's `maxFrameBytes`. */
  maxFrameBytes?: number;
  /** JSON body limit in bytes. Default 16 KiB. */
  maxJsonBytes?: number;
  /** Upper bound for one frame request's vision processing. Default 10 s. */
  frameTimeoutMs?: number;
  /** Content-free request log hook. */
  onRequestLog?: (entry: BridgeLogEntry) => void;
  /**
   * Built overlay directory served at `/ui/` (e.g. `overlay/dist`). Loaded ONCE into an
   * immutable in-memory snapshot when the bridge is created; an invalid or unsafe directory
   * throws `StaticUiError`. Unset → `/ui/` answers 404.
   */
  uiDir?: string;
  /** Snapshot bounds (defaults: 10 MiB per file, 64 MiB total, 2000 files, depth 16). */
  uiLimits?: Partial<StaticUiLimits>;
  /** Extra allowed browser origin for UI development (exactly `http://localhost:<port>` or `http://127.0.0.1:<port>`). */
  uiDevOrigin?: string;
  ui?: {
    pairingTtlMs?: number;
    idleTtlMs?: number;
    maxPairingFailures?: number;
    pairingFailureWindowMs?: number;
    /** A client's private voice request is cancelled only after it has had no live stream for this long. */
    voiceDisconnectGraceMs?: number;
    heartbeatMs?: number;
    maxStreamsPerSession?: number;
    /** Concurrent streams one browser credential may hold (so one tab cannot exhaust the session cap). */
    maxStreamsPerClient?: number;
    now?: () => number;
  };
}

export interface Bridge {
  readonly server: Server;
  /** Static UI snapshot size (0/0 when no UI is configured). */
  readonly uiFiles: number;
  readonly uiBytes: number;
  /** Listens on 127.0.0.1 (port 0 = random). */
  listen(port?: number): Promise<{ port: number; url: string }>;
  close(): Promise<void>;
}

type Role = 'agent' | 'control' | 'ui';
type Principal = { kind: 'agent' } | { kind: 'control' } | { kind: 'ui'; client: UiClient };
type Handler = (ctx: RequestContext) => Promise<void>;
interface Route {
  pattern: string;
  regex: RegExp;
  /** `bodyless`: any declared body (Content-Length > 0 or Transfer-Encoding) is rejected unread. */
  /**
   * `public`: no credential. `pair`: no credential, but browser CSRF rules apply.
   * `bodyless`: any declared body (Content-Length > 0 or Transfer-Encoding) is rejected unread.
   */
  methods: Partial<Record<string, { roles: Role[] | 'public' | 'pair'; handler: Handler; bodyless?: true }>>;
}
interface RequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  principal?: Principal;
  sessionId?: string;
  /** Second path id (recommendation id or voice request id). */
  itemId?: string;
}

/** Coordinator/engine error codes → HTTP status. Bodies carry the code only. */
const STATUS: Record<string, number> = {
  invalid_input: 400,
  invalid_timestamp: 400,
  participant_not_found: 400,
  goal_not_found: 400,
  evidence_not_found: 400,
  session_not_found: 404,
  recommendation_not_found: 404,
  voice_request_not_found: 404,
  invalid_pairing: 401,
  voice_busy: 409,
  pairing_rate_limited: 429,
  too_many_streams: 429,
  participant_limit_reached: 409,
  duplicate_participant: 409,
  invalid_participant_name: 400,
  consent_required: 409,
  session_not_active: 409,
  invalid_transition: 409,
  invalid_generation: 409,
  stale_evidence: 409,
  stale_context: 409,
  aborted: 409,
  timestamp_out_of_range: 422,
  observation_limit_reached: 429,
  vision_busy: 429,
  vision_failed: 502,
  vision_unavailable: 503,
  vision_timeout: 504,
};

/** True if the request declares a body: chunked/other transfer coding, or Content-Length > 0. */
const hasDeclaredBody = (req: IncomingMessage) =>
  req.headers['transfer-encoding'] !== undefined ||
  (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0');
const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const mediaType = (header: string | undefined) => (header ?? '').split(';')[0]!.trim().toLowerCase();

function validateToken(name: string, token: unknown): string {
  if (typeof token !== 'string' || token.length < MIN_TOKEN_LENGTH || token.trim() !== token) {
    throw new RangeError(`${name} must be a string of at least ${MIN_TOKEN_LENGTH} characters without surrounding whitespace`);
  }
  return token;
}

function lifecycleView(s: SessionSnapshot) {
  return {
    sessionId: s.id,
    status: s.status,
    consentGiven: s.consentGiven,
    captureGeneration: s.captureGeneration,
    acceptingInput: s.status === 'active',
  };
}

export function createBridge(options: BridgeOptions): Bridge {
  const coordinator = options.coordinator;
  if (!coordinator) throw new TypeError('coordinator is required');
  const agentDigest = digest(validateToken('agentToken', options.agentToken));
  const controlDigest = digest(validateToken('controlToken', options.controlToken));
  if (timingSafeEqual(agentDigest, controlDigest)) throw new RangeError('agentToken and controlToken must differ');
  const maxFrameBytes = options.maxFrameBytes ?? MAX_FRAME_BYTES;
  if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1 || maxFrameBytes > MAX_FRAME_BYTES) {
    throw new RangeError(`maxFrameBytes must be an integer from 1 to ${MAX_FRAME_BYTES}`);
  }
  const maxJsonBytes = options.maxJsonBytes ?? 16 * 1024;
  if (!Number.isSafeInteger(maxJsonBytes) || maxJsonBytes < 1 || maxJsonBytes > 1024 * 1024) {
    throw new RangeError('maxJsonBytes must be an integer from 1 to 1 MiB');
  }
  const frameTimeoutMs = options.frameTimeoutMs ?? 10_000;
  if (!Number.isSafeInteger(frameTimeoutMs) || frameTimeoutMs < 1 || frameTimeoutMs > 120_000) {
    throw new RangeError('frameTimeoutMs must be an integer from 1 to 120000');
  }
  const log = options.onRequestLog ?? (() => {});
  /** Routing index only (room → session); the engine remains the owner of session state. */
  const sessionsByRoom = new Map<string, string>();
  let boundPort = 0;
  const uiOpts = options.ui ?? {};
  const uiAuth = new UiAuth({
    ...(uiOpts.now ? { now: uiOpts.now } : {}),
    ...(uiOpts.pairingTtlMs !== undefined ? { pairingTtlMs: uiOpts.pairingTtlMs } : {}),
    ...(uiOpts.idleTtlMs !== undefined ? { idleTtlMs: uiOpts.idleTtlMs } : {}),
    ...(uiOpts.maxPairingFailures !== undefined ? { maxFailures: uiOpts.maxPairingFailures } : {}),
    ...(uiOpts.pairingFailureWindowMs !== undefined ? { failureWindowMs: uiOpts.pairingFailureWindowMs } : {}),
  });
  const voiceGraceMs = uiOpts.voiceDisconnectGraceMs ?? 15_000;
  const heartbeatMs = uiOpts.heartbeatMs ?? 15_000;
  const maxStreamsPerSession = uiOpts.maxStreamsPerSession ?? 8;
  const maxStreamsPerClient = uiOpts.maxStreamsPerClient ?? 2;
  for (const [name, v] of [['voiceDisconnectGraceMs', voiceGraceMs], ['heartbeatMs', heartbeatMs], ['maxStreamsPerSession', maxStreamsPerSession], ['maxStreamsPerClient', maxStreamsPerClient]] as const) {
    if (!Number.isSafeInteger(v) || v < 1) throw new RangeError(`${name} must be a positive integer`);
  }
  if (options.uiDevOrigin !== undefined && !/^http:\/\/(localhost|127\.0\.0\.1):\d{1,5}$/.test(options.uiDevOrigin)) {
    throw new RangeError('uiDevOrigin must be http://localhost:<port> or http://127.0.0.1:<port>');
  }
  const staticUi = createStaticUi(options.uiDir, options.uiLimits ? { limits: options.uiLimits } : {});
  /** Live state streams per session (for discard notification and the per-session cap). */
  const streams = new Map<string, Set<StateStream>>();
  /** Private voice request ownership: requestId → owning UI client. */
  const voiceOwners = new Map<string, { clientId: string; sessionId: string }>();
  const selfOrigins = () => new Set([`http://${BRIDGE_HOST}:${boundPort}`, `http://localhost:${boundPort}`, ...(options.uiDevOrigin ? [options.uiDevOrigin] : [])]);
  const ID_RE = SESSION_ID_RE;

  // ── Response helpers ──────────────────────────────────────────────────────

  const send = (res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}) => {
    if (res.headersSent || res.destroyed) return;
    const payload = body === undefined ? '' : JSON.stringify(body);
    res.writeHead(status, {
      ...UI_SECURITY_HEADERS,
      ...(body === undefined ? {} : { 'content-type': 'application/json; charset=utf-8' }),
      'content-length': String(Buffer.byteLength(payload)),
      ...headers,
    });
    res.end(payload);
  };
  /** Rejects without reading the body; the connection is closed afterwards. */
  const reject = (res: ServerResponse, status: number, error: string, headers: Record<string, string> = {}) =>
    send(res, status, { ok: false, error }, { connection: 'close', ...headers });
  const fail = (res: ServerResponse, error: string) => send(res, STATUS[error] ?? 400, { ok: false, error });

  // ── Body reading ──────────────────────────────────────────────────────────

  type BodyResult = { ok: true; body: Buffer } | { ok: false; error: 'payload_too_large' | 'aborted' };

  /**
   * Streams the body up to `limit` bytes. Stops reading and releases buffered chunks as
   * soon as the limit is exceeded, the client disconnects, or `signal` aborts (deadline).
   * Settles exactly once; all listeners are removed afterwards.
   */
  function readBody(req: IncomingMessage, limit: number, signal?: AbortSignal): Promise<BodyResult> {
    return new Promise((resolve) => {
      let chunks: Buffer[] = [];
      let size = 0;
      let done = false;
      const finish = (r: BodyResult) => {
        if (done) return;
        done = true;
        req.off('data', onData).off('end', onEnd).off('error', onAbort).off('aborted', onAbort);
        signal?.removeEventListener('abort', onSignal);
        if (!r.ok) {
          chunks = []; // release buffered image data immediately
          req.pause();
        }
        resolve(r);
      };
      const onData = (chunk: Buffer) => {
        size += chunk.length;
        if (size > limit) return finish({ ok: false, error: 'payload_too_large' });
        chunks.push(chunk);
      };
      const onEnd = () => finish({ ok: true, body: Buffer.concat(chunks, size) });
      const onAbort = () => finish({ ok: false, error: 'aborted' });
      const onSignal = () => finish({ ok: false, error: 'aborted' });
      if (signal?.aborted) return finish({ ok: false, error: 'aborted' });
      signal?.addEventListener('abort', onSignal, { once: true });
      req.on('data', onData).on('end', onEnd).on('error', onAbort).on('aborted', onAbort);
    });
  }

  /** Header-only checks shared by body-carrying routes. Returns false if already rejected. */
  function precheckBody(ctx: RequestContext, allowed: (type: string) => boolean, limit: number): boolean {
    const type = mediaType(ctx.req.headers['content-type']);
    if (!allowed(type)) {
      reject(ctx.res, 415, 'unsupported_media_type');
      return false;
    }
    const declared = ctx.req.headers['content-length'];
    if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
      reject(ctx.res, 413, 'payload_too_large');
      return false;
    }
    return true;
  }

  async function readJson(ctx: RequestContext, allowedKeys: string[]): Promise<Record<string, unknown> | undefined> {
    if (!precheckBody(ctx, (t) => t === 'application/json', maxJsonBytes)) return undefined;
    const body = await readBody(ctx.req, maxJsonBytes);
    if (!body.ok) {
      if (body.error === 'payload_too_large') reject(ctx.res, 413, 'payload_too_large');
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.body.toString('utf8'));
    } catch {
      send(ctx.res, 400, { ok: false, error: 'invalid_json' });
      return undefined;
    }
    if (!isObject(parsed) || Object.keys(parsed).some((k) => !allowedKeys.includes(k))) {
      send(ctx.res, 400, { ok: false, error: 'invalid_input' });
      return undefined;
    }
    return parsed;
  }

  const sessionOr404 = (ctx: RequestContext) => {
    const snap = coordinator.engine.getSession(ctx.sessionId!);
    if (!snap.ok) {
      fail(ctx.res, snap.error);
      return undefined;
    }
    return snap.value;
  };

  // ── Handlers ──────────────────────────────────────────────────────────────

  const createSessionHandler: Handler = async (ctx) => {
    const body = await readJson(ctx, ['externalRef']);
    if (!body) return;
    if (typeof body.externalRef !== 'string') return fail(ctx.res, 'invalid_input');
    const existingId = sessionsByRoom.get(body.externalRef);
    if (existingId !== undefined) {
      const existing = coordinator.engine.getSession(existingId);
      if (existing.ok && existing.value.status !== 'ended') return send(ctx.res, 200, { ok: true, ...lifecycleView(existing.value) });
      sessionsByRoom.delete(body.externalRef);
    }
    const created = coordinator.createSession({ externalRef: body.externalRef });
    if (!created.ok) return fail(ctx.res, created.error);
    sessionsByRoom.set(body.externalRef, created.value.id);
    send(ctx.res, 201, { ok: true, ...lifecycleView(created.value) });
  };

  const captureHandler: Handler = async (ctx) => {
    const snap = sessionOr404(ctx);
    if (snap) send(ctx.res, 200, { ok: true, ...lifecycleView(snap) });
  };

  const transcriptHandler: Handler = async (ctx) => {
    const body = await readJson(ctx, ['captureGeneration', 'observedAt', 'text', 'speakerRef']);
    if (!body) return;
    if (!Number.isSafeInteger(body.captureGeneration) || (body.captureGeneration as number) < 1) {
      return send(ctx.res, 400, { ok: false, error: 'invalid_generation' });
    }
    const input = {
      captureGeneration: body.captureGeneration as number,
      observedAt: body.observedAt as string,
      text: body.text as string,
      ...(body.speakerRef !== undefined ? { speakerRef: body.speakerRef as string } : {}),
    };
    const r = coordinator.ingestConversation(ctx.sessionId!, input);
    if (!r.ok) return fail(ctx.res, r.error);
    send(ctx.res, 202, { ok: true, observationId: r.value.id, captureGeneration: r.value.captureGeneration, observedAt: r.value.observedAt });
  };

  const frameHandler: Handler = async (ctx) => {
    // Capture metadata comes from headers and is fixed before the body is read.
    const generationHeader = ctx.req.headers['x-capture-generation'];
    const observedAt = ctx.req.headers['x-observed-at'];
    if (typeof generationHeader !== 'string' || !GENERATION_RE.test(generationHeader)) {
      return reject(ctx.res, 400, 'invalid_generation');
    }
    if (typeof observedAt !== 'string' || observedAt.length === 0 || observedAt.length > 64) {
      return reject(ctx.res, 400, 'invalid_timestamp');
    }
    const captureGeneration = Number(generationHeader);
    const mimeType = mediaType(ctx.req.headers['content-type']) as FrameInput['mimeType'];
    if (!precheckBody(ctx, (t) => FRAME_TYPES.has(t), maxFrameBytes)) return;

    // ONE deadline for the whole request: body upload + vision.
    const cancel = new AbortController();
    const onClose = () => {
      if (!ctx.res.writableFinished) cancel.abort('client_disconnected');
    };
    ctx.res.on('close', onClose);
    const timer = setTimeout(() => cancel.abort('timeout'), frameTimeoutMs);
    const timedOut = () => cancel.signal.aborted && cancel.signal.reason === 'timeout';
    try {
      const body = await readBody(ctx.req, maxFrameBytes, cancel.signal);
      if (!body.ok) {
        if (body.error === 'payload_too_large') return reject(ctx.res, 413, 'payload_too_large');
        // Deadline hit mid-upload: answer and close (the body was not fully read).
        if (timedOut()) return reject(ctx.res, 504, 'vision_timeout');
        return; // client disconnected: nothing to answer; listeners already cleaned up
      }
      if (cancel.signal.aborted) return timedOut() ? reject(ctx.res, 504, 'vision_timeout') : undefined;
      if (body.body.length === 0) return fail(ctx.res, 'invalid_input');
      const r = await coordinator.ingestFrame(
        ctx.sessionId!,
        { captureGeneration, observedAt, image: new Uint8Array(body.body.buffer, body.body.byteOffset, body.body.byteLength), mimeType },
        { signal: cancel.signal },
      );
      if (timedOut()) return send(ctx.res, 504, { ok: false, error: 'vision_timeout' });
      if (cancel.signal.aborted) return; // disconnected while vision ran; frame was not ingested
      if (!r.ok) return fail(ctx.res, r.error);
      send(ctx.res, 200, { ok: true, observationId: r.value.id, captureGeneration: r.value.captureGeneration, observedAt: r.value.observedAt });
    } finally {
      clearTimeout(timer);
      ctx.res.off('close', onClose);
    }
  };

  /**
   * Operator-only. Session-level consent for the MVP: the operator must explicitly attest
   * that ALL participants agreed. A single UI click is never treated as group consent.
   */
  const consentHandler: Handler = async (ctx) => {
    const body = await readJson(ctx, ['consent', 'allParticipantsAgreed']);
    if (!body) return;
    if (body.consent !== true) return send(ctx.res, 400, { ok: false, error: 'explicit_consent_required' });
    if (body.allParticipantsAgreed !== true) {
      return send(ctx.res, 400, { ok: false, error: 'all_participants_agreement_required' });
    }
    const r = coordinator.startWithConsent(ctx.sessionId!);
    if (!r.ok) return fail(ctx.res, r.error);
    send(ctx.res, 200, { ok: true, ...lifecycleView(r.value) });
  };

  const lifecycleHandler = (op: 'pause' | 'resume' | 'end'): Handler => async (ctx) => {
    const r = coordinator[op](ctx.sessionId!);
    if (!r.ok) return fail(ctx.res, r.error);
    pruneVoiceOwners(ctx.sessionId!); // pause/end cancel live explanations
    send(ctx.res, 200, { ok: true, ...lifecycleView(r.value) });
  };

  const discardHandler: Handler = async (ctx) => {
    const sid = ctx.sessionId!;
    const r = coordinator.discard(sid);
    if (!r.ok) return fail(ctx.res, r.error);
    for (const [room, id] of sessionsByRoom) if (id === sid) sessionsByRoom.delete(room);
    // Revoke every UI credential of the session and tell its live streams it is gone.
    uiAuth.revokeSession(sid);
    for (const stream of [...(streams.get(sid) ?? [])]) stream.discarded();
    streams.delete(sid);
    for (const [requestId, owner] of voiceOwners) if (owner.sessionId === sid) voiceOwners.delete(requestId);
    send(ctx.res, 204, undefined, ctx.principal?.kind === 'ui' ? { 'set-cookie': clearedUiCookie() } : {});
  };

  // ── UI handlers (milestone 4) ─────────────────────────────────────────────

  const uiClient = (ctx: RequestContext) => (ctx.principal?.kind === 'ui' ? ctx.principal.client : undefined);

  /**
   * Drops ownership records whose request is no longer live (finished, failed, cancelled by
   * the user, by pause/end/timeout, or gone with the session). One snapshot per session.
   */
  function pruneVoiceOwners(sessionId: string): void {
    const snap = coordinator.engine.getSession(sessionId);
    const live = new Set(
      snap.ok ? snap.value.voiceRequests.filter((v) => v.status === 'pending' || v.status === 'playing_locally').map((v) => v.id) : [],
    );
    for (const [id, owner] of voiceOwners) if (owner.sessionId === sessionId && !live.has(id)) voiceOwners.delete(id);
  }
  const ownsLiveVoice = (client: UiClient) => {
    pruneVoiceOwners(client.sessionId);
    return [...voiceOwners.values()].some((o) => o.clientId === client.id);
  };

  /**
   * Bounded disconnect handling: a client's private voice request is cancelled
   * (`client_disconnected`) only after the client has had NO live stream and no
   * authenticated request for `voiceDisconnectGraceMs`. Short reconnects never cancel.
   */
  function armGrace(client: UiClient): void {
    if (client.graceTimer) clearTimeout(client.graceTimer);
    delete client.graceTimer;
    if (client.openStreams > 0 || !ownsLiveVoice(client)) return;
    client.graceTimer = setTimeout(() => {
      delete client.graceTimer;
      if (client.openStreams > 0 || !uiAuth.isActive(client)) return;
      pruneVoiceOwners(client.sessionId);
      for (const [requestId, owner] of voiceOwners) {
        if (owner.clientId === client.id) coordinator.cancelExplanation(owner.sessionId, requestId, 'client_disconnected');
      }
      pruneVoiceOwners(client.sessionId);
    }, voiceGraceMs);
    client.graceTimer.unref?.();
  }

  /** M4: page-reload recovery. Resolves the session purely from the HttpOnly cookie. */
  const uiSessionHandler: Handler = async (ctx) => {
    const client = uiClient(ctx)!;
    const snap = coordinator.engine.getSession(client.sessionId);
    if (!snap.ok) {
      uiAuth.revokeSession(client.sessionId);
      return reject(ctx.res, 401, 'unauthorized', { 'set-cookie': clearedUiCookie() });
    }
    send(ctx.res, 200, { ok: true, sessionId: client.sessionId, ...(client.participantId ? { participantId: client.participantId } : {}) });
  };

  const createPairingHandler: Handler = async (ctx) => {
    const body = await readJson(ctx, ['participantId']);
    if (!body) return;
    const snap = sessionOr404(ctx);
    if (!snap) return;
    const participantId = body.participantId;
    if (participantId !== undefined && (typeof participantId !== 'string' || !snap.participants.some((p) => p.id === participantId))) {
      return fail(ctx.res, 'participant_not_found');
    }
    const { code, expiresAtMs } = uiAuth.createPairing(snap.id, participantId as string | undefined);
    // The code is returned once to the trusted operator; it is never logged or stored in plaintext.
    send(ctx.res, 201, {
      ok: true, code, expiresAt: new Date(expiresAtMs).toISOString(),
      url: `http://${BRIDGE_HOST}:${boundPort}/ui/#pair=${code}`,
    });
  };

  const pairHandler: Handler = async (ctx) => {
    const body = await readJson(ctx, ['code']);
    if (!body) return;
    const r = uiAuth.redeem(body.code);
    if (!r.ok) return fail(ctx.res, r.error);
    const snap = coordinator.engine.getSession(r.client.sessionId);
    if (!snap.ok) {
      uiAuth.revokeSession(r.client.sessionId);
      return fail(ctx.res, 'invalid_pairing');
    }
    send(ctx.res, 200, { ok: true, sessionId: r.client.sessionId, ...(r.client.participantId ? { participantId: r.client.participantId } : {}) }, {
      'set-cookie': uiCookie(r.credential),
    });
  };

  const streamHandler: Handler = async (ctx) => {
    const sid = ctx.sessionId!;
    if (!sessionOr404(ctx)) return;
    const set = streams.get(sid) ?? new Set<StateStream>();
    if (set.size >= maxStreamsPerSession) return fail(ctx.res, 'too_many_streams');
    const client = uiClient(ctx);
    if (client && client.openStreams >= maxStreamsPerClient) return fail(ctx.res, 'too_many_streams');
    let unsubscribe: () => void = () => {};
    const stream = openStateStream(ctx.res, {
      heartbeatMs,
      // M1: a healthy stream is presence; the idle clock restarts from its last heartbeat.
      onHeartbeat: () => { if (client) uiAuth.touch(client); },
      onClose: () => {
        unsubscribe();
        set.delete(stream);
        if (set.size === 0) streams.delete(sid);
        if (client) {
          uiAuth.touch(client);
          client.openStreams = Math.max(0, client.openStreams - 1);
          armGrace(client);
        }
      },
    });
    set.add(stream);
    streams.set(sid, set);
    if (client) {
      client.openStreams += 1;
      armGrace(client); // clears any pending grace timer
    }
    // The engine delivers the current state when subscribe returns, then every newer version.
    // M5: browsers only ever receive the projected state (safe role labels).
    const sub = coordinator.engine.subscribe(sid, (state) => {
      if (state.activeVoiceRequest === undefined) pruneVoiceOwners(sid); // terminal requests drop ownership promptly
      stream.send(projectOverlayState(state));
    });
    if (sub.ok) unsubscribe = sub.value;
    else stream.close();
  };

  const participantsListHandler: Handler = async (ctx) => {
    const snap = sessionOr404(ctx);
    if (!snap) return;
    send(ctx.res, 200, {
      ok: true,
      participants: snap.participants.map(projectParticipant),
    });
  };

  const participantsAddHandler: Handler = async (ctx) => {
    const control = ctx.principal?.kind === 'control';
    const body = await readJson(ctx, control ? ['displayName', 'externalRef'] : ['displayName']);
    if (!body) return;
    const r = coordinator.addParticipant(ctx.sessionId!, {
      displayName: body.displayName as string,
      ...(body.externalRef !== undefined ? { externalRef: body.externalRef as string } : {}),
    });
    if (!r.ok) return fail(ctx.res, r.error);
    send(ctx.res, 201, { ok: true, id: r.value.id, displayName: r.value.displayName });
  };

  const activityHandler: Handler = async (ctx) => {
    const body = await readJson(ctx, ['activity']);
    if (!body) return;
    if (body.activity !== 'gaming') return fail(ctx.res, 'invalid_input'); // MVP: gaming only
    const r = coordinator.confirmActivity(ctx.sessionId!, 'gaming');
    if (!r.ok) return fail(ctx.res, r.error);
    send(ctx.res, 200, { ok: true, ...lifecycleView(r.value), activity: r.value.activity, activityConfirmed: r.value.activityConfirmed });
  };

  const dismissHandler: Handler = async (ctx) => {
    const r = coordinator.dismiss(ctx.sessionId!, ctx.itemId!);
    if (!r.ok) return fail(ctx.res, r.error);
    send(ctx.res, 200, { ok: true });
  };

  const explanationHandler: Handler = async (ctx) => {
    const client = uiClient(ctx)!;
    const r = coordinator.requestExplanation(ctx.sessionId!, ctx.itemId!, client.participantId ? { requesterParticipantId: client.participantId } : undefined);
    if (!r.ok) return fail(ctx.res, r.error);
    pruneVoiceOwners(ctx.sessionId!);
    voiceOwners.set(r.value.request.id, { clientId: client.id, sessionId: ctx.sessionId! });
    const script: ExplanationScript = {
      request: projectVoiceRequest(r.value.request),
      text: buildExplanationText(r.value.context),
      refersToEarlierObservation: r.value.context.isStale,
    };
    armGrace(client);
    send(ctx.res, 200, { ok: true, ...script });
  };

  /**
   * Only the client that requested an explanation may report on or cancel it. Any request
   * that is no longer live (finished, failed, cancelled, timed out — swept first so an
   * expired request is recognised now — or gone with the session) answers
   * `404 voice_request_not_found`, never a 409 or another error.
   */
  function ownedRequest(ctx: RequestContext): boolean {
    coordinator.engine.sweepStale(ctx.sessionId!);
    pruneVoiceOwners(ctx.sessionId!);
    const owner = voiceOwners.get(ctx.itemId!);
    const client = uiClient(ctx)!;
    if (!owner || owner.sessionId !== ctx.sessionId) {
      fail(ctx.res, 'voice_request_not_found');
      return false;
    }
    if (owner.clientId !== client.id) {
      reject(ctx.res, 403, 'not_request_owner');
      return false;
    }
    return true;
  }
  const finishVoice = (ctx: RequestContext, request: VoiceRequest) => {
    if (request.status !== 'pending' && request.status !== 'playing_locally') voiceOwners.delete(request.id);
    pruneVoiceOwners(ctx.sessionId!);
    armGrace(uiClient(ctx)!);
    send(ctx.res, 200, { ok: true, request: projectVoiceRequest(request) });
  };

  const voiceStatusHandler: Handler = async (ctx) => {
    const body = await readJson(ctx, ['status']);
    if (!body) return;
    if (!ownedRequest(ctx)) return;
    const status = body.status;
    if (status !== 'playing_locally' && status !== 'finished' && status !== 'failed') return fail(ctx.res, 'invalid_input');
    const r = coordinator.reportVoiceStatus(ctx.sessionId!, ctx.itemId!, status);
    if (!r.ok) return fail(ctx.res, r.error);
    finishVoice(ctx, r.value);
  };

  const voiceCancelHandler: Handler = async (ctx) => {
    if (!ownedRequest(ctx)) return;
    const r = coordinator.cancelExplanation(ctx.sessionId!, ctx.itemId!, 'user');
    if (!r.ok) return fail(ctx.res, r.error);
    finishVoice(ctx, r.value);
  };

  const timelineHandler: Handler = async (ctx) => {
    const snap = sessionOr404(ctx);
    if (!snap) return;
    const events = coordinator.engine.getTimeline(snap.id);
    if (!events.ok) return fail(ctx.res, events.error);
    // M5: explicit browser projection — no goal/decision wording, rebuilt summaries, safe roles.
    const lookup = {
      names: new Map(snap.participants.map((p) => [p.id, p.displayName])),
      titles: new Map(snap.recommendations.map((r) => [r.id, r.title])),
    };
    const timeline: BrowserSessionTimeline = {
      events: events.value.map((e) => projectTimelineEvent(e, lookup)),
      truncated: snap.timelineTruncated,
    };
    send(ctx.res, 200, { ok: true, ...timeline });
  };

  const sessionPath = (suffix: string) => new RegExp(`^/v1/sessions/([^/]+)${suffix}$`);
  const routes: Route[] = [
    { pattern: '/v1/health', regex: /^\/v1\/health$/, methods: { GET: { roles: 'public', bodyless: true, handler: async (ctx) => send(ctx.res, 200, { ok: true }) } } },
    { pattern: '/v1/ui/pair', regex: /^\/v1\/ui\/pair$/, methods: { POST: { roles: 'pair', handler: pairHandler } } },
    { pattern: '/v1/ui/session', regex: /^\/v1\/ui\/session$/, methods: { GET: { roles: ['ui'], bodyless: true, handler: uiSessionHandler } } },
    { pattern: '/v1/sessions', regex: /^\/v1\/sessions$/, methods: { POST: { roles: ['agent', 'control'], handler: createSessionHandler } } },
    { pattern: '/v1/sessions/:id', regex: sessionPath(''), methods: { DELETE: { roles: ['control', 'ui'], bodyless: true, handler: discardHandler } } },
    { pattern: '/v1/sessions/:id/pairings', regex: sessionPath('/pairings'), methods: { POST: { roles: ['control'], handler: createPairingHandler } } },
    { pattern: '/v1/sessions/:id/stream', regex: sessionPath('/stream'), methods: { GET: { roles: ['ui', 'control'], bodyless: true, handler: streamHandler } } },
    {
      pattern: '/v1/sessions/:id/participants', regex: sessionPath('/participants'), methods: {
        GET: { roles: ['ui', 'control'], bodyless: true, handler: participantsListHandler },
        POST: { roles: ['ui', 'control'], handler: participantsAddHandler },
      },
    },
    { pattern: '/v1/sessions/:id/activity', regex: sessionPath('/activity'), methods: { POST: { roles: ['ui', 'control'], handler: activityHandler } } },
    { pattern: '/v1/sessions/:id/recommendations/:rid/dismiss', regex: sessionPath('/recommendations/([^/]+)/dismiss'), methods: { POST: { roles: ['ui', 'control'], bodyless: true, handler: dismissHandler } } },
    { pattern: '/v1/sessions/:id/recommendations/:rid/explanation', regex: sessionPath('/recommendations/([^/]+)/explanation'), methods: { POST: { roles: ['ui'], bodyless: true, handler: explanationHandler } } },
    { pattern: '/v1/sessions/:id/voice/:requestId/status', regex: sessionPath('/voice/([^/]+)/status'), methods: { POST: { roles: ['ui'], handler: voiceStatusHandler } } },
    { pattern: '/v1/sessions/:id/voice/:requestId/cancel', regex: sessionPath('/voice/([^/]+)/cancel'), methods: { POST: { roles: ['ui'], bodyless: true, handler: voiceCancelHandler } } },
    { pattern: '/v1/sessions/:id/timeline', regex: sessionPath('/timeline'), methods: { GET: { roles: ['ui', 'control'], bodyless: true, handler: timelineHandler } } },
    { pattern: '/v1/sessions/:id/capture', regex: sessionPath('/capture'), methods: { GET: { roles: ['agent', 'control'], bodyless: true, handler: captureHandler } } },
    { pattern: '/v1/sessions/:id/transcripts', regex: sessionPath('/transcripts'), methods: { POST: { roles: ['agent'], handler: transcriptHandler } } },
    { pattern: '/v1/sessions/:id/frames', regex: sessionPath('/frames'), methods: { POST: { roles: ['agent'], handler: frameHandler } } },
    { pattern: '/v1/sessions/:id/consent', regex: sessionPath('/consent'), methods: { POST: { roles: ['control'], handler: consentHandler } } },
    { pattern: '/v1/sessions/:id/pause', regex: sessionPath('/pause'), methods: { POST: { roles: ['control', 'ui'], bodyless: true, handler: lifecycleHandler('pause') } } },
    { pattern: '/v1/sessions/:id/resume', regex: sessionPath('/resume'), methods: { POST: { roles: ['control'], bodyless: true, handler: lifecycleHandler('resume') } } },
    { pattern: '/v1/sessions/:id/end', regex: sessionPath('/end'), methods: { POST: { roles: ['control', 'ui'], bodyless: true, handler: lifecycleHandler('end') } } },
  ];

  function bearerRole(req: IncomingMessage): 'agent' | 'control' | undefined {
    const header = req.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return undefined;
    const presented = digest(header.slice('Bearer '.length));
    if (timingSafeEqual(presented, agentDigest)) return 'agent';
    if (timingSafeEqual(presented, controlDigest)) return 'control';
    return undefined;
  }

  const decodeId = (raw: string | undefined) => {
    if (raw === undefined) return undefined;
    try {
      const d = decodeURIComponent(raw);
      return ID_RE.test(d) ? d : '';
    } catch {
      return '';
    }
  };

  async function handle(req: IncomingMessage, res: ServerResponse, setRoute: (pattern: string) => void): Promise<void> {
    const host = req.headers.host;
    if (host !== `${BRIDGE_HOST}:${boundPort}` && host !== `localhost:${boundPort}`) {
      return reject(res, 403, 'forbidden_host');
    }
    const origin = req.headers.origin;
    const sameOrigin = origin !== undefined && selfOrigins().has(origin);
    // Foreign origins are refused everywhere; same-origin is allowed only for the UI below.
    if (origin !== undefined && !sameOrigin) return reject(res, 403, 'forbidden_origin');
    const path = (req.url ?? '').split('?')[0]!;
    if (path === '/ui' || path.startsWith('/ui/')) {
      setRoute('/ui/*');
      await staticUi.handle(req, res, path);
      return;
    }
    const route = routes.find((r) => r.regex.test(path));
    if (!route) return reject(res, 404, 'not_found');
    setRoute(route.pattern);
    const method = route.methods[req.method ?? ''];
    if (!method) {
      return reject(res, 405, 'method_not_allowed', { allow: Object.keys(route.methods).join(', ') });
    }

    // ── Who is calling? Bearer token (server processes) or UI cookie (browser).
    let principal: Principal | undefined;
    if (req.headers.authorization !== undefined) {
      // Server tokens never come from browsers: any Origin on a bearer request is refused.
      if (origin !== undefined) return reject(res, 403, 'forbidden_origin');
      const role = bearerRole(req);
      if (!role) return reject(res, 401, 'unauthorized', { 'www-authenticate': 'Bearer' });
      principal = { kind: role };
    } else {
      const credential = readCookie(req.headers.cookie, UI_COOKIE);
      if (credential !== undefined) {
        const client = uiAuth.authenticate(credential);
        if (!client) return reject(res, 401, 'unauthorized', { 'set-cookie': clearedUiCookie() });
        principal = { kind: 'ui', client };
      }
    }
    const browser = principal?.kind === 'ui' || method.roles === 'pair';
    // CSRF: browser state changes need the bridge's own Origin AND the custom header
    // (a cross-site page cannot set it without a CORS preflight, which is never granted).
    if (browser && req.method !== 'GET' && req.method !== 'HEAD' && (!sameOrigin || req.headers['x-sidekick-ui'] !== '1')) {
      return reject(res, 403, 'csrf_rejected');
    }
    if (method.roles !== 'public' && method.roles !== 'pair') {
      if (!principal) return reject(res, 401, 'unauthorized', { 'www-authenticate': 'Bearer' });
      if (!method.roles.includes(principal.kind)) return reject(res, 403, 'forbidden');
    }
    if (method.bodyless && hasDeclaredBody(req)) return reject(res, 400, 'unexpected_body');

    const ctx: RequestContext = { req, res, ...(principal ? { principal } : {}) };
    const match = route.regex.exec(path)!;
    const sessionId = decodeId(match[1]);
    const itemId = decodeId(match[2]);
    if (sessionId === '') return reject(res, 404, 'session_not_found');
    if (itemId === '') return reject(res, 404, 'not_found');
    if (sessionId !== undefined) {
      // A UI credential is scoped to exactly one session; anything else looks like it does not exist.
      if (principal?.kind === 'ui' && principal.client.sessionId !== sessionId) return reject(res, 404, 'session_not_found');
      ctx.sessionId = sessionId;
    }
    if (itemId !== undefined) ctx.itemId = itemId;
    if (principal?.kind === 'ui') armGrace(principal.client); // any authenticated request counts as presence
    await method.handler(ctx);
  }

  const server = createServer((req, res) => {
    // Late stream errors (e.g. ECONNRESET after we stopped reading) must never crash the process.
    req.on('error', () => {});
    res.on('error', () => {});
    const started = process.hrtime.bigint();
    let pattern = 'unmatched';
    res.on('close', () =>
      log({ method: req.method ?? '', route: pattern, status: res.statusCode, durationMs: Number(process.hrtime.bigint() - started) / 1e6 }));
    handle(req, res, (p) => { pattern = p; })
      .catch(() => {
        send(res, 500, { ok: false, error: 'internal_error' });
      });
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = Math.max(30_000, frameTimeoutMs + 5_000);
  server.maxHeadersCount = 50;

  return {
    uiFiles: staticUi.files,
    uiBytes: staticUi.totalBytes,
    server,
    listen(port = 0) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, BRIDGE_HOST, () => {
          server.off('error', reject);
          boundPort = (server.address() as AddressInfo).port;
          resolve({ port: boundPort, url: `http://${BRIDGE_HOST}:${boundPort}` });
        });
      });
    },
    close() {
      for (const set of streams.values()) for (const stream of [...set]) stream.close();
      streams.clear();
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
