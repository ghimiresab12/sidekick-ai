/**
 * Same-origin static UI for the built overlay (`overlay/dist` by default), mounted at `/ui/`.
 *
 * SECURITY MODEL (trusted build directory at startup; see docs/engineering.md):
 *
 * 1. Trusted startup loading. Every approved asset is read ONCE, synchronously, when the
 *    bridge is created, before it can accept a request. The configured directory and its
 *    parents are TRUSTED during this load: no untrusted process may modify the build tree
 *    while the snapshot is built. This loader does NOT use descriptor-anchored traversal
 *    and does NOT guarantee safety against a process that concurrently swaps directories
 *    or symlinks during loading.
 * 2. Rejection of unsafe assets encountered during normal loading (explicit `StaticUiError`
 *    startup error): a missing directory, a non-directory or no `index.html`; any symbolic
 *    link, hard-linked asset (nlink > 1), FIFO, socket or device below the root; on POSIX,
 *    any directory or file not owned by the bridge's user or group/world-writable; size,
 *    count or depth limits exceeded. Hidden entries, source maps and unsupported
 *    extensions are never loaded. As extra, best-effort hardening (NOT a race-freedom
 *    guarantee), files are opened with O_NOFOLLOW, and inode identities are compared before
 *    and after reading; a change that is noticed aborts startup.
 * 3. Request-time filesystem isolation. After startup, requests are answered only from the
 *    immutable in-memory map; the request path never resolves, opens or reads a filesystem
 *    path, so later changes to the build directory cannot change what is served.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync, type Stats } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, resolve } from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
};

export interface StaticUiLimits {
  /** Largest single asset. Default 10 MiB. */
  maxFileBytes: number;
  /** Total snapshot size. Default 64 MiB. */
  maxTotalBytes: number;
  /** Number of assets. Default 2000. */
  maxFiles: number;
  /** Directory nesting below the root. Default 16. */
  maxDepth: number;
}
export const DEFAULT_STATIC_LIMITS: StaticUiLimits = Object.freeze({
  maxFileBytes: 10 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxFiles: 2000,
  maxDepth: 16,
});

export interface StaticUiOptions {
  limits?: Partial<StaticUiLimits>;
  /** TEST ONLY: called after a file's pre-open checks, immediately before it is opened. */
  beforeOpen?: (relativePath: string) => void;
}

/** The UI directory is missing, invalid or unsafe. The message names a relative path at most, never content. */
export class StaticUiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaticUiError';
  }
}

/** Security headers for every UI response (also applied to API responses served to the UI). */
export const UI_SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), display-capture=()',
  'cache-control': 'no-store',
};

interface Asset { readonly body: Buffer; readonly type: string }
export interface StaticSnapshot {
  readonly files: number;
  readonly totalBytes: number;
  get(path: string): Asset | undefined;
}

const sameInode = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;
const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;

/** POSIX: owned by the bridge's user and not writable by group/others. No-op where uids don't exist. */
function checkIntegrity(info: Stats, rel: string): void {
  if (uid === undefined) return;
  if (info.uid !== uid) throw new StaticUiError(`UI path not owned by the bridge user: ${rel || '.'}`);
  if ((info.mode & 0o022) !== 0) throw new StaticUiError(`UI path is group- or world-writable: ${rel || '.'}`);
}

/**
 * Reads the approved assets of `rootDir` into an immutable in-memory snapshot, or throws
 * `StaticUiError`. Synchronous by design: nothing can be served before it completes.
 */
export function loadStaticSnapshot(rootDir: string, options: StaticUiOptions = {}): StaticSnapshot {
  const limits: StaticUiLimits = { ...DEFAULT_STATIC_LIMITS, ...options.limits };
  for (const [name, v] of Object.entries(limits)) {
    if (!Number.isSafeInteger(v) || v < 1) throw new RangeError(`static UI ${name} must be a positive integer`);
  }
  let root: string;
  try {
    root = realpathSync(resolve(rootDir));
  } catch {
    throw new StaticUiError('UI directory not found');
  }
  const rootInfo = lstatSync(root, { throwIfNoEntry: false });
  if (!rootInfo) throw new StaticUiError('UI directory not found');
  if (!rootInfo.isDirectory()) throw new StaticUiError('UI path is not a directory');

  const assets = new Map<string, Asset>();
  let totalBytes = 0;
  /** Ancestor chain of the directory being walked: absolute path + identity recorded on entry. */
  type Dir = { abs: string; info: Stats };

  const verifyChain = (chain: Dir[], rel: string) => {
    for (const d of chain) {
      const now = lstatSync(d.abs, { throwIfNoEntry: false });
      if (!now || now.isSymbolicLink() || !now.isDirectory() || !sameInode(now, d.info)) {
        throw new StaticUiError(`UI directory changed while loading: ${rel}`);
      }
    }
  };

  const readAsset = (abs: string, rel: string, chain: Dir[], before: Stats): Buffer => {
    options.beforeOpen?.(rel);
    let fd: number;
    try {
      fd = openSync(abs, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    } catch {
      throw new StaticUiError(`UI asset could not be opened safely: ${rel}`);
    }
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || info.nlink !== 1 || !sameInode(info, before)) throw new StaticUiError(`UI asset changed while loading: ${rel}`);
      checkIntegrity(info, rel);
      if (info.size > limits.maxFileBytes) throw new StaticUiError(`UI asset exceeds ${limits.maxFileBytes} bytes: ${rel}`);
      if (totalBytes + info.size > limits.maxTotalBytes) throw new StaticUiError(`UI snapshot exceeds ${limits.maxTotalBytes} bytes`);
      // Read at most size + 1 bytes: growth during the read is detected, never unbounded.
      const buffer = Buffer.alloc(info.size + 1);
      let read = 0;
      for (;;) {
        const n = readSync(fd, buffer, read, buffer.length - read, read);
        if (n === 0) break;
        read += n;
        if (read > info.size) throw new StaticUiError(`UI asset changed while loading: ${rel}`);
      }
      if (read !== info.size) throw new StaticUiError(`UI asset changed while loading: ${rel}`);
      // Best-effort consistency check (not a race-freedom guarantee): path and ancestors unchanged since walked.
      const after = lstatSync(abs, { throwIfNoEntry: false });
      if (!after || after.isSymbolicLink() || !sameInode(after, info)) throw new StaticUiError(`UI asset changed while loading: ${rel}`);
      verifyChain(chain, rel);
      return buffer.subarray(0, read);
    } finally {
      closeSync(fd);
    }
  };

  const walk = (chain: Dir[], relDir: string, depth: number) => {
    const dir = chain[chain.length - 1]!;
    if (depth > limits.maxDepth) throw new StaticUiError(`UI directory nesting exceeds ${limits.maxDepth}: ${relDir}`);
    const names = readdirSync(dir.abs).sort();
    verifyChain(chain, relDir || '.');
    for (const name of names) {
      if (name.startsWith('.')) continue; // hidden files and directories are never loaded
      const rel = relDir ? `${relDir}/${name}` : name;
      if (name.includes('\\') || name.includes('\0')) throw new StaticUiError(`UI path has an unsupported name: ${rel}`);
      const abs = join(dir.abs, name);
      const info = lstatSync(abs);
      if (info.isSymbolicLink()) throw new StaticUiError(`UI directory contains a symbolic link: ${rel}`);
      if (info.isDirectory()) {
        checkIntegrity(info, rel);
        walk([...chain, { abs, info }], rel, depth + 1);
        continue;
      }
      if (!info.isFile()) throw new StaticUiError(`UI directory contains a special file: ${rel}`);
      const type = TYPES[extname(name).toLowerCase()];
      if (!type) continue; // source maps, sources, env files and unknown types are never loaded
      if (info.nlink !== 1) throw new StaticUiError(`UI asset is hard-linked: ${rel}`);
      if (assets.size >= limits.maxFiles) throw new StaticUiError(`UI snapshot exceeds ${limits.maxFiles} files`);
      const body = readAsset(abs, rel, chain, info);
      totalBytes += body.length;
      assets.set(rel, Object.freeze({ body, type }));
    }
  };

  try {
    checkIntegrity(rootInfo, '');
    walk([{ abs: root, info: rootInfo }], '', 0);
  } catch (error) {
    if (error instanceof StaticUiError) throw error;
    // Any filesystem error mid-walk (entry vanished, permission denied, …) fails closed, explicitly.
    throw new StaticUiError('UI directory changed or could not be read while loading');
  }
  if (!assets.has('index.html')) throw new StaticUiError('UI directory has no index.html');
  return Object.freeze({
    files: assets.size,
    totalBytes,
    get: (path: string) => assets.get(path),
  });
}

export interface StaticUi {
  /** Number of assets and bytes held in memory (0 when no UI is configured). */
  readonly files: number;
  readonly totalBytes: number;
  /** Handles `/ui` and `/ui/...`. Returns false if the path is not a UI path. */
  handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean>;
}

/** Builds the UI handler. Loads the snapshot now (throws `StaticUiError`); unset dir → `/ui/` answers 404. */
export function createStaticUi(rootDir: string | undefined, options: StaticUiOptions = {}): StaticUi {
  const snapshot = rootDir === undefined ? undefined : loadStaticSnapshot(rootDir, options);
  const send = (res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}) => {
    res.writeHead(status, { ...UI_SECURITY_HEADERS, 'content-type': 'text/plain; charset=utf-8', ...headers });
    res.end(body);
  };
  return {
    files: snapshot?.files ?? 0,
    totalBytes: snapshot?.totalBytes ?? 0,
    async handle(req, res, path) {
      if (path !== '/ui' && !path.startsWith('/ui/')) return false;
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        send(res, 405, 'method not allowed', { allow: 'GET, HEAD' });
        return true;
      }
      if (path === '/ui') {
        res.writeHead(308, { ...UI_SECURITY_HEADERS, location: '/ui/' });
        res.end();
        return true;
      }
      if (!snapshot) {
        send(res, 404, 'ui not built');
        return true;
      }
      let rel: string;
      try {
        rel = decodeURIComponent(path.slice('/ui/'.length));
      } catch {
        send(res, 400, 'bad path');
        return true;
      }
      if (rel === '') rel = 'index.html';
      // Map lookup only: keys are exact snapshot paths, so traversal or aliasing cannot match.
      const asset = snapshot.get(rel);
      if (!asset) {
        send(res, 404, 'not found');
        return true;
      }
      res.writeHead(200, { ...UI_SECURITY_HEADERS, 'content-type': asset.type, 'content-length': String(asset.body.length) });
      res.end(req.method === 'HEAD' ? undefined : asset.body);
      return true;
    },
  };
}
