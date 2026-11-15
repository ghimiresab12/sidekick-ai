/**
 * Browser pairing and session-scoped UI credentials. In memory only; a restart revokes all.
 *
 * - Pairing codes: 12 characters from a 30-symbol alphabet (~59 bits) drawn with
 *   rejection sampling from `crypto.randomBytes`. One-time, short-lived (default 120 s).
 *   Stored only as SHA-256 digests. Failed redemptions are rate-limited (sliding window).
 * - UI credentials: 32 random bytes (base64url), delivered only as an HttpOnly cookie,
 *   stored only as digests, bound to exactly ONE session, idle-expiring (default 30 min).
 * - Nothing here logs codes or credentials.
 */
import { createHash, randomBytes } from 'node:crypto';

export const UI_COOKIE = 'sidekick_ui';
const ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789'; // no 0/O, 1/I/L, U
const CODE_LENGTH = 12;

export interface UiClient {
  /** Opaque client id (not the credential). Used for voice-request ownership. */
  readonly id: string;
  readonly sessionId: string;
  readonly participantId?: string;
  lastSeenMs: number;
  /** Open live-state streams for this client. */
  openStreams: number;
  /** Pending disconnect-grace timer, if the client currently has no stream. */
  graceTimer?: ReturnType<typeof setTimeout>;
}

export interface UiAuthOptions {
  now?: () => number;
  pairingTtlMs?: number;
  idleTtlMs?: number;
  /** Failed redemptions allowed per window before all redemptions are refused. */
  maxFailures?: number;
  failureWindowMs?: number;
}

export type RedeemResult =
  | { ok: true; client: UiClient; credential: string }
  | { ok: false; error: 'invalid_pairing' | 'pairing_rate_limited' };

const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest('base64url');

function randomCode(): string {
  let out = '';
  while (out.length < CODE_LENGTH) {
    for (const byte of randomBytes(CODE_LENGTH * 2)) {
      if (byte >= 240) continue; // 240 = 30 * 8: keeps the distribution uniform
      out += ALPHABET[byte % ALPHABET.length];
      if (out.length === CODE_LENGTH) break;
    }
  }
  return out;
}

export const PAIRING_CODE_RE = new RegExp(`^[${ALPHABET}]{${CODE_LENGTH}}$`);

export class UiAuth {
  readonly #now: () => number;
  readonly #pairingTtlMs: number;
  readonly #idleTtlMs: number;
  readonly #maxFailures: number;
  readonly #failureWindowMs: number;
  /** code digest → pairing */
  readonly #pairings = new Map<string, { sessionId: string; participantId?: string; expiresAtMs: number }>();
  /** credential digest → client */
  readonly #clients = new Map<string, UiClient>();
  #failures: number[] = [];
  #nextClient = 0;

  constructor(options: UiAuthOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#pairingTtlMs = options.pairingTtlMs ?? 120_000;
    this.#idleTtlMs = options.idleTtlMs ?? 30 * 60_000;
    this.#maxFailures = options.maxFailures ?? 5;
    this.#failureWindowMs = options.failureWindowMs ?? 60_000;
    for (const [name, v] of [['pairingTtlMs', this.#pairingTtlMs], ['idleTtlMs', this.#idleTtlMs], ['failureWindowMs', this.#failureWindowMs]] as const) {
      if (!Number.isSafeInteger(v) || v < 1) throw new RangeError(`${name} must be a positive integer`);
    }
    if (!Number.isSafeInteger(this.#maxFailures) || this.#maxFailures < 1) throw new RangeError('maxFailures must be a positive integer');
  }

  /** Creates a one-time pairing code for one session. The plaintext code is returned once and never stored. */
  createPairing(sessionId: string, participantId?: string): { code: string; expiresAtMs: number } {
    this.#purge();
    const code = randomCode();
    const expiresAtMs = this.#now() + this.#pairingTtlMs;
    this.#pairings.set(digest(code), { sessionId, ...(participantId ? { participantId } : {}), expiresAtMs });
    return { code, expiresAtMs };
  }

  /** Redeems a code exactly once. Malformed, unknown, expired and reused codes all fail identically. */
  redeem(code: unknown): RedeemResult {
    const now = this.#now();
    this.#failures = this.#failures.filter((t) => now - t < this.#failureWindowMs);
    if (this.#failures.length >= this.#maxFailures) return { ok: false, error: 'pairing_rate_limited' };
    const key = typeof code === 'string' && PAIRING_CODE_RE.test(code) ? digest(code) : undefined;
    const pairing = key === undefined ? undefined : this.#pairings.get(key);
    if (key !== undefined) this.#pairings.delete(key); // one-time, even if expired
    if (!pairing || pairing.expiresAtMs <= now) {
      this.#failures.push(now);
      return { ok: false, error: 'invalid_pairing' };
    }
    const credential = randomBytes(32).toString('base64url');
    const client: UiClient = {
      id: `ui-${++this.#nextClient}-${randomBytes(6).toString('hex')}`,
      sessionId: pairing.sessionId,
      ...(pairing.participantId ? { participantId: pairing.participantId } : {}),
      lastSeenMs: now,
      openStreams: 0,
    };
    this.#clients.set(digest(credential), client);
    return { ok: true, client, credential };
  }

  /** Resolves a cookie credential to its client (refreshing idle expiry), or undefined. */
  authenticate(credential: string | undefined): UiClient | undefined {
    if (!credential || credential.length > 128) return undefined;
    const key = digest(credential);
    const client = this.#clients.get(key);
    if (!client) return undefined;
    const now = this.#now();
    if (now - client.lastSeenMs > this.#idleTtlMs && client.openStreams === 0) {
      this.#clients.delete(key);
      return undefined;
    }
    client.lastSeenMs = now;
    return client;
  }

  /**
   * Marks a client as present (M1): called on every stream heartbeat and when a stream
   * closes, so a passive viewer's idle clock restarts from its last live moment.
   */
  touch(client: UiClient): void {
    client.lastSeenMs = this.#now();
  }

  /** Revokes every credential and pending pairing for a session. Returns the revoked clients. */
  revokeSession(sessionId: string): UiClient[] {
    const revoked: UiClient[] = [];
    for (const [key, client] of this.#clients) {
      if (client.sessionId === sessionId) {
        this.#clients.delete(key);
        if (client.graceTimer) clearTimeout(client.graceTimer);
        revoked.push(client);
      }
    }
    for (const [key, p] of this.#pairings) if (p.sessionId === sessionId) this.#pairings.delete(key);
    return revoked;
  }

  /** True while the client is still a valid credential holder (not revoked). */
  isActive(client: UiClient): boolean {
    for (const c of this.#clients.values()) if (c === client) return true;
    return false;
  }

  #purge(): void {
    const now = this.#now();
    for (const [key, p] of this.#pairings) if (p.expiresAtMs <= now) this.#pairings.delete(key);
    for (const [key, c] of this.#clients) {
      if (c.openStreams === 0 && now - c.lastSeenMs > this.#idleTtlMs) this.#clients.delete(key);
    }
  }
}

/** Reads one cookie value from a Cookie header without logging or echoing it. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

export function uiCookie(credential: string): string {
  // No Max-Age: a browser-session cookie; the server enforces idle expiry. Path limits it to the API.
  return `${UI_COOKIE}=${credential}; HttpOnly; SameSite=Strict; Path=/v1`;
}

export function clearedUiCookie(): string {
  return `${UI_COOKIE}=; HttpOnly; SameSite=Strict; Path=/v1; Max-Age=0`;
}
