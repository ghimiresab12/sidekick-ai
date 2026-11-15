/**
 * Authenticated localhost HTTP bridge: Python LiveKit agent ⇄ SidekickCoordinator.
 *
 * - Binds to 127.0.0.1 only. Rejects browser-originated requests (`Origin`) and
 *   unexpected `Host` headers (DNS rebinding). Never expose it publicly.
 * - Two bearer tokens: the AGENT token may create sessions, read capture state and
 *   ingest; the CONTROL token may grant consent and change the lifecycle. The agent can
 *   never grant consent. Tokens are compared in constant time and never logged.
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
import type { SessionSnapshot } from '../contracts/types.js';
import type { SidekickCoordinator } from '../coordinator/coordinator.js';
import type { FrameInput } from '../coordinator/ports.js';

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
}

export interface Bridge {
  readonly server: Server;
  /** Listens on 127.0.0.1 (port 0 = random). */
  listen(port?: number): Promise<{ port: number; url: string }>;
  close(): Promise<void>;
}

type Role = 'agent' | 'control';
type Handler = (ctx: RequestContext) => Promise<void>;
interface Route {
  pattern: string;
  regex: RegExp;
  /** `bodyless`: any declared body (Content-Length > 0 or Transfer-Encoding) is rejected unread. */
  methods: Partial<Record<string, { roles: Role[] | 'public'; handler: Handler; bodyless?: true }>>;
}
interface RequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  sessionId?: string;
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

  // ── Response helpers ──────────────────────────────────────────────────────

  const send = (res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}) => {
    if (res.headersSent || res.destroyed) return;
    const payload = body === undefined ? '' : JSON.stringify(body);
    res.writeHead(status, {
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
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

  const consentHandler: Handler = async (ctx) => {
    const body = await readJson(ctx, ['consent']);
    if (!body) return;
    if (body.consent !== true) return send(ctx.res, 400, { ok: false, error: 'explicit_consent_required' });
    const r = coordinator.startWithConsent(ctx.sessionId!);
    if (!r.ok) return fail(ctx.res, r.error);
    send(ctx.res, 200, { ok: true, ...lifecycleView(r.value) });
  };

  const lifecycleHandler = (op: 'pause' | 'resume' | 'end'): Handler => async (ctx) => {
    const r = coordinator[op](ctx.sessionId!);
    if (!r.ok) return fail(ctx.res, r.error);
    send(ctx.res, 200, { ok: true, ...lifecycleView(r.value) });
  };

  const discardHandler: Handler = async (ctx) => {
    const r = coordinator.discard(ctx.sessionId!);
    if (!r.ok) return fail(ctx.res, r.error);
    for (const [room, id] of sessionsByRoom) if (id === ctx.sessionId) sessionsByRoom.delete(room);
    send(ctx.res, 204);
  };

  const sessionPath = (suffix: string) => new RegExp(`^/v1/sessions/([^/]+)${suffix}$`);
  const routes: Route[] = [
    { pattern: '/v1/health', regex: /^\/v1\/health$/, methods: { GET: { roles: 'public', bodyless: true, handler: async (ctx) => send(ctx.res, 200, { ok: true }) } } },
    { pattern: '/v1/sessions', regex: /^\/v1\/sessions$/, methods: { POST: { roles: ['agent'], handler: createSessionHandler } } },
    { pattern: '/v1/sessions/:id', regex: sessionPath(''), methods: { DELETE: { roles: ['control'], bodyless: true, handler: discardHandler } } },
    { pattern: '/v1/sessions/:id/capture', regex: sessionPath('/capture'), methods: { GET: { roles: ['agent', 'control'], bodyless: true, handler: captureHandler } } },
    { pattern: '/v1/sessions/:id/transcripts', regex: sessionPath('/transcripts'), methods: { POST: { roles: ['agent'], handler: transcriptHandler } } },
    { pattern: '/v1/sessions/:id/frames', regex: sessionPath('/frames'), methods: { POST: { roles: ['agent'], handler: frameHandler } } },
    { pattern: '/v1/sessions/:id/consent', regex: sessionPath('/consent'), methods: { POST: { roles: ['control'], handler: consentHandler } } },
    { pattern: '/v1/sessions/:id/pause', regex: sessionPath('/pause'), methods: { POST: { roles: ['control'], bodyless: true, handler: lifecycleHandler('pause') } } },
    { pattern: '/v1/sessions/:id/resume', regex: sessionPath('/resume'), methods: { POST: { roles: ['control'], bodyless: true, handler: lifecycleHandler('resume') } } },
    { pattern: '/v1/sessions/:id/end', regex: sessionPath('/end'), methods: { POST: { roles: ['control'], bodyless: true, handler: lifecycleHandler('end') } } },
  ];

  function authenticate(req: IncomingMessage): Role | undefined {
    const header = req.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return undefined;
    const presented = digest(header.slice('Bearer '.length));
    if (timingSafeEqual(presented, agentDigest)) return 'agent';
    if (timingSafeEqual(presented, controlDigest)) return 'control';
    return undefined;
  }

  async function handle(req: IncomingMessage, res: ServerResponse, setRoute: (pattern: string) => void): Promise<void> {
    const host = req.headers.host;
    if (host !== `${BRIDGE_HOST}:${boundPort}` && host !== `localhost:${boundPort}`) {
      return reject(res, 403, 'forbidden_host');
    }
    if (req.headers.origin !== undefined) {
      return reject(res, 403, 'forbidden_origin');
    }
    const path = (req.url ?? '').split('?')[0]!;
    const route = routes.find((r) => r.regex.test(path));
    if (!route) return reject(res, 404, 'not_found');
    setRoute(route.pattern);
    const method = route.methods[req.method ?? ''];
    if (!method) {
      return reject(res, 405, 'method_not_allowed', { allow: Object.keys(route.methods).join(', ') });
    }
    if (method.roles !== 'public') {
      const role = authenticate(req);
      if (!role) {
        return reject(res, 401, 'unauthorized', { 'www-authenticate': 'Bearer' });
      }
      if (!method.roles.includes(role)) {
        return reject(res, 403, 'forbidden');
      }
    }
    if (method.bodyless && hasDeclaredBody(req)) return reject(res, 400, 'unexpected_body');
    const ctx: RequestContext = { req, res };
    const id = route.regex.exec(path)?.[1];
    if (id !== undefined) {
      let decoded: string;
      try {
        decoded = decodeURIComponent(id);
      } catch {
        decoded = '';
      }
      if (!SESSION_ID_RE.test(decoded)) {
        return reject(res, 404, 'session_not_found');
      }
      ctx.sessionId = decoded;
    }
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
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
