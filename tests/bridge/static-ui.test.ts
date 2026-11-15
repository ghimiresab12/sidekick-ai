import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, linkSync, mkdtempSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridge, type BridgeOptions } from '../../src/bridge/http-bridge.js';
import { createBridgeRuntime, RuntimeConfigError } from '../../src/bridge/runtime.js';
import { loadStaticSnapshot, StaticUiError } from '../../src/bridge/static-ui.js';
import { SidekickCoordinator } from '../../src/coordinator/coordinator.js';

const AGENT = 'agent-token-0123456789-abcdefghijklmnop';
const CONTROL = 'control-token-0123456789-abcdefghijklmn';
const SECRET = 'OUTSIDE-SECRET-MARKER-31337';
const POSIX = typeof process.getuid === 'function';

/** A realistic Vite build plus private files that must never be loaded. Returns { root, dist }. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'sidekick-ui-'));
  const dist = join(root, 'dist');
  mkdirSync(join(dist, 'assets', 'fonts'), { recursive: true });
  mkdirSync(join(dist, '.vite'), { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<!doctype html><script type="module" src="/ui/assets/index-Bq3x9.js"></script>');
  writeFileSync(join(dist, 'assets', 'index-Bq3x9.js'), 'console.log("app")');
  writeFileSync(join(dist, 'assets', 'index-D4f1a.css'), 'body{margin:0}');
  writeFileSync(join(dist, 'assets', 'fonts', 'inter-latin.woff2'), Buffer.from([0x77, 0x4f, 0x46, 0x32]));
  writeFileSync(join(dist, 'assets', 'logo-9a8b.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  writeFileSync(join(dist, 'assets', 'icon-1c2d.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(join(dist, 'favicon.ico'), Buffer.from([0, 0, 1, 0]));
  writeFileSync(join(dist, 'manifest.json'), '{"name":"sidekick"}');
  // Never loaded:
  writeFileSync(join(dist, 'assets', 'index-Bq3x9.js.map'), '{"sources":["src/App.tsx"]}');
  writeFileSync(join(dist, '.env'), `SIDEKICK_CONTROL_TOKEN=${CONTROL}`);
  writeFileSync(join(dist, '.vite', 'manifest.json'), `{"leak":"${SECRET}"}`);
  writeFileSync(join(dist, 'App.tsx'), `export const token = "${CONTROL}";`);
  writeFileSync(join(dist, 'notes.txt'), SECRET);
  writeFileSync(join(root, 'secret.txt'), SECRET);
  const outside = join(root, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'index-Bq3x9.js'), `/* ${SECRET} */`);
  writeFileSync(join(outside, 'index.html'), SECRET);
  return { root, dist, outside };
}

function bridgeFor(uiDir?: string, extra: Partial<BridgeOptions> = {}) {
  return createBridge({
    coordinator: new SidekickCoordinator({ reasoning: async () => ({ ok: false, error: 'x' }) }),
    agentToken: AGENT, controlToken: CONTROL, ...(uiDir ? { uiDir } : {}), ...extra,
  });
}
async function start(uiDir?: string) {
  const bridge = bridgeFor(uiDir);
  const { url, port } = await bridge.listen(0);
  return { bridge, url, port };
}
const get = (url: string, init: RequestInit = {}) => fetch(url, { redirect: 'manual', ...init });
function trySymlink(target: string, path: string, type?: 'dir' | 'file'): boolean {
  try { symlinkSync(target, path, type); return true; } catch { return false; }
}
const rejects = (fn: () => unknown, pattern: RegExp) => assert.throws(fn, (e: unknown) => e instanceof StaticUiError && pattern.test(e.message));

// ── Serving ──────────────────────────────────────────────────────────────────

test('[S] ordinary nested Vite assets are served with correct MIME types and security headers', async () => {
  const { dist } = fixture();
  const { bridge, url } = await start(dist);
  try {
    const expected: Array<[string, string]> = [
      ['/ui/', 'text/html; charset=utf-8'],
      ['/ui/index.html', 'text/html; charset=utf-8'],
      ['/ui/assets/index-Bq3x9.js', 'text/javascript; charset=utf-8'],
      ['/ui/assets/index-D4f1a.css', 'text/css; charset=utf-8'],
      ['/ui/assets/fonts/inter-latin.woff2', 'font/woff2'],
      ['/ui/assets/logo-9a8b.svg', 'image/svg+xml'],
      ['/ui/assets/icon-1c2d.png', 'image/png'],
      ['/ui/favicon.ico', 'image/x-icon'],
      ['/ui/manifest.json', 'application/json; charset=utf-8'],
    ];
    for (const [path, type] of expected) {
      const r = await get(url + path);
      assert.deepEqual([r.status, r.headers.get('content-type')], [200, type], path);
      const csp = r.headers.get('content-security-policy')!;
      for (const directive of ["default-src 'none'", "script-src 'self'", "connect-src 'self'", "frame-ancestors 'none'", "base-uri 'none'"]) assert.ok(csp.includes(directive), `${path}: ${directive}`);
      assert.equal(r.headers.get('x-frame-options'), 'DENY');
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
      assert.equal(r.headers.get('cache-control'), 'no-store');
      assert.match(r.headers.get('permissions-policy')!, /microphone=\(\)/);
      assert.equal(Number(r.headers.get('content-length')), (await r.arrayBuffer()).byteLength);
    }
    assert.equal(await (await get(`${url}/ui/assets/index-Bq3x9.js`)).text(), 'console.log("app")');
    const redirect = await get(`${url}/ui`);
    assert.deepEqual([redirect.status, redirect.headers.get('location')], [308, '/ui/']);
    const head = await get(`${url}/ui/`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    assert.deepEqual([bridge.uiFiles, bridge.uiBytes > 0], [8, true]);
  } finally { await bridge.close(); }
});

test('[S] hidden files, source maps, sources, unknown types, traversal and non-GET are refused; private files never enter memory', async () => {
  const { dist } = fixture();
  const snapshot = loadStaticSnapshot(dist);
  for (const rel of ['.env', '.vite/manifest.json', 'assets/index-Bq3x9.js.map', 'App.tsx', 'notes.txt']) assert.equal(snapshot.get(rel), undefined, rel);
  const { bridge, url, port } = await start(dist);
  try {
    for (const path of ['/ui/.env', '/ui/.vite/manifest.json', '/ui/assets/index-Bq3x9.js.map', '/ui/App.tsx', '/ui/notes.txt', '/ui/%2e%2e/secret.txt',
      '/ui/assets/..%2f..%2fsecret.txt', '/ui/nope.html', '/ui/assets/', '/ui/a%00.js', '/ui//index.html', '/ui/ASSETS/index-Bq3x9.js']) {
      const r = await get(url + path);
      const body = await r.text();
      assert.ok(r.status === 404 || r.status === 400, `${path} → ${r.status}`);
      assert.ok(!body.includes(CONTROL) && !body.includes(SECRET), `${path} leaked`);
    }
    // Raw request so the client cannot normalise "../" away.
    const raw = await new Promise<number>((resolve) => {
      httpRequest({ host: '127.0.0.1', port, path: '/ui/../secret.txt' }, (res) => { res.resume(); resolve(res.statusCode!); }).end();
    });
    assert.notEqual(raw, 200);
    assert.equal((await get(`${url}/ui/`, { method: 'POST' })).status, 405);
    assert.equal((await get(`${url}/ui/`, { headers: { origin: 'https://evil.example' } })).status, 403);
  } finally { await bridge.close(); }
});

// ── Request-time filesystem isolation (after startup, requests never touch the filesystem) ──

test('[R3] request-time isolation: modifying, replacing or deleting the build directory after startup cannot change what is served', async (t) => {
  const { dist, outside } = fixture();
  const { bridge, url } = await start(dist);
  try {
    // 1. Replace assets/ with a REAL directory holding different content.
    renameSync(join(dist, 'assets'), join(dist, 'assets.orig'));
    mkdirSync(join(dist, 'assets'));
    writeFileSync(join(dist, 'assets', 'index-Bq3x9.js'), `/* ${SECRET} */`);
    writeFileSync(join(dist, 'assets', 'new-after-start.js'), SECRET);
    writeFileSync(join(dist, 'index.html'), SECRET);
    const js = await get(`${url}/ui/assets/index-Bq3x9.js`);
    assert.deepEqual([js.status, await js.text()], [200, 'console.log("app")'], 'served from the snapshot');
    assert.equal(await (await get(`${url}/ui/`)).text(), '<!doctype html><script type="module" src="/ui/assets/index-Bq3x9.js"></script>');
    assert.equal((await get(`${url}/ui/assets/new-after-start.js`)).status, 404, 'files added after startup are never served');
    // 2. Replace assets/ with a SYMLINK to an outside directory.
    rmSync(join(dist, 'assets'), { recursive: true });
    if (!trySymlink(outside, join(dist, 'assets'), 'dir')) return t.skip('symlinks unavailable on this platform');
    const again = await get(`${url}/ui/assets/index-Bq3x9.js`);
    assert.deepEqual([again.status, await again.text()], [200, 'console.log("app")']);
    // 3. Delete the whole build: still served from memory.
    rmSync(dist, { recursive: true, force: true });
    assert.equal((await get(`${url}/ui/assets/fonts/inter-latin.woff2`)).status, 200);
  } finally { await bridge.close(); }
});

test('[R3] the loaded in-memory snapshot is unchanged after the build directory is modified or removed', () => {
  const { dist } = fixture();
  const snapshot = loadStaticSnapshot(dist);
  const paths = ['index.html', 'assets/index-Bq3x9.js', 'assets/index-D4f1a.css', 'assets/fonts/inter-latin.woff2', 'manifest.json'];
  const before = paths.map((p) => snapshot.get(p)!.body.toString('base64'));
  const [files, bytes] = [snapshot.files, snapshot.totalBytes];
  writeFileSync(join(dist, 'index.html'), SECRET);                // modified in place
  writeFileSync(join(dist, 'assets', 'index-Bq3x9.js'), SECRET);
  writeFileSync(join(dist, 'assets', 'added-later.js'), SECRET);   // added
  assert.deepEqual(paths.map((p) => snapshot.get(p)!.body.toString('base64')), before, 'after modification');
  rmSync(dist, { recursive: true, force: true });                   // removed entirely
  assert.deepEqual(paths.map((p) => snapshot.get(p)!.body.toString('base64')), before, 'after removal');
  assert.deepEqual([snapshot.files, snapshot.totalBytes, snapshot.get('assets/added-later.js')], [files, bytes, undefined]);
});

// ── Trusted startup loading: unsafe entries encountered during normal loading are rejected ──
// These tests do NOT establish race freedom or unconditional provenance of the startup
// snapshot; the build directory is trusted during startup (docs/engineering.md).

test('[R3] an allowed-looking asset symlink to a hidden or outside file, present during loading, is a startup error', (t) => {
  const cases: Array<[string, (f: ReturnType<typeof fixture>) => boolean]> = [
    ['→ hidden dotfile inside root', (f) => trySymlink(join(f.dist, '.env'), join(f.dist, 'assets', 'vendor.js'))],
    ['→ hidden directory inside root', (f) => trySymlink(join(f.dist, '.vite', 'manifest.json'), join(f.dist, 'assets', 'chunk.json'))],
    ['→ file outside root', (f) => trySymlink(join(f.root, 'secret.txt'), join(f.dist, 'assets', 'escape.js'))],
    ['relative → outside', (f) => trySymlink('../../secret.txt', join(f.dist, 'assets', 'relative.css'))],
    ['directory symlink inside root', (f) => trySymlink(join(f.dist, 'assets', 'fonts'), join(f.dist, 'assets', 'linked'), 'dir')],
    ['directory symlink outside root', (f) => trySymlink(f.outside, join(f.dist, 'vendor'), 'dir')],
  ];
  for (const [label, make] of cases) {
    const f = fixture();
    if (!make(f)) return t.skip('symlinks unavailable on this platform');
    assert.throws(() => bridgeFor(f.dist), (e: unknown) => e instanceof StaticUiError && /symbolic link/.test(e.message) && !e.message.includes(SECRET), label);
  }
});

test('[R3] best-effort hardening: these specific injected swaps between check and open are rejected (examples only, not a race-freedom guarantee)', (t) => {
  // Deterministic swaps via a test hook. A concurrent attacker with write access during startup
  // is OUTSIDE the security model and can still win other interleavings.
  {
    const f = fixture();
    let swapped = false;
    const opts = { beforeOpen: (rel: string) => {
      if (rel !== 'assets/index-Bq3x9.js' || swapped) return;
      swapped = true;
      renameSync(join(f.dist, 'assets'), join(f.dist, 'assets.orig'));
      if (!trySymlink(f.outside, join(f.dist, 'assets'), 'dir')) throw new Error('nosymlink');
    } };
    let result: unknown;
    try { result = loadStaticSnapshot(f.dist, opts); } catch (e) { result = e; }
    if (result instanceof Error && result.message === 'nosymlink') return t.skip('symlinks unavailable on this platform');
    assert.ok(swapped, 'race was injected');
    assert.ok(result instanceof StaticUiError && /changed while loading/.test(result.message), String(result));
  }
  // Parent replaced by a REAL directory (no symlink) with the same file name.
  {
    const f = fixture();
    let swapped = false;
    const opts = { beforeOpen: (rel: string) => {
      if (rel !== 'assets/index-Bq3x9.js' || swapped) return;
      swapped = true;
      renameSync(join(f.dist, 'assets'), join(f.dist, 'assets.orig'));
      mkdirSync(join(f.dist, 'assets'));
      writeFileSync(join(f.dist, 'assets', 'index-Bq3x9.js'), SECRET);
    } };
    assert.throws(() => loadStaticSnapshot(f.dist, opts), (e: unknown) => e instanceof StaticUiError && /changed while loading/.test(e.message));
  }
  // The file itself replaced by a symlink just before open (O_NOFOLLOW / identity check).
  {
    const f = fixture();
    const opts = { beforeOpen: (rel: string) => {
      if (rel !== 'manifest.json') return;
      rmSync(join(f.dist, 'manifest.json'));
      symlinkSync(join(f.root, 'secret.txt'), join(f.dist, 'manifest.json'));
    } };
    assert.throws(() => loadStaticSnapshot(f.dist, opts), StaticUiError);
  }
});

test('[R3] hard links and unsafe permissions present during loading are startup errors', { skip: !POSIX && 'POSIX permissions only' }, () => {
  const a = fixture();
  linkSync(join(a.root, 'secret.txt'), join(a.dist, 'assets', 'hard.js'));
  rejects(() => loadStaticSnapshot(a.dist), /hard-linked/);
  const b = fixture();
  chmodSync(join(b.dist, 'assets'), 0o777);
  rejects(() => loadStaticSnapshot(b.dist), /group- or world-writable: assets/);
  const c = fixture();
  chmodSync(join(c.dist, 'manifest.json'), 0o666);
  rejects(() => loadStaticSnapshot(c.dist), /writable: manifest\.json/);
});

// ── Limits ────────────────────────────────────────────────────────────────────

test('[R3] per-file, total-size, file-count and depth limits are enforced at startup', () => {
  const big = fixture();
  writeFileSync(join(big.dist, 'assets', 'huge.js'), Buffer.alloc(2048, 0x61));
  rejects(() => bridgeFor(big.dist, { uiLimits: { maxFileBytes: 1024 } }), /exceeds 1024 bytes: assets\/huge\.js/);
  assert.doesNotThrow(() => bridgeFor(big.dist, { uiLimits: { maxFileBytes: 4096 } }));
  const total = fixture();
  for (let i = 0; i < 4; i++) writeFileSync(join(total.dist, 'assets', `chunk-${i}.js`), Buffer.alloc(400, 0x61));
  rejects(() => bridgeFor(total.dist, { uiLimits: { maxTotalBytes: 1200 } }), /snapshot exceeds 1200 bytes/);
  rejects(() => bridgeFor(fixture().dist, { uiLimits: { maxFiles: 3 } }), /exceeds 3 files/);
  const deep = fixture();
  mkdirSync(join(deep.dist, 'a', 'b', 'c'), { recursive: true });
  writeFileSync(join(deep.dist, 'a', 'b', 'c', 'x.js'), '1');
  rejects(() => bridgeFor(deep.dist, { uiLimits: { maxDepth: 2 } }), /nesting exceeds 2/);
  assert.throws(() => bridgeFor(fixture().dist, { uiLimits: { maxFileBytes: 0 } }), RangeError);
});

// ── Missing and invalid directories ───────────────────────────────────────────

test('[R3] missing, non-directory and index-less UI directories are explicit startup errors', async () => {
  const f = fixture();
  rejects(() => bridgeFor(join(f.root, 'does-not-exist')), /not found/);
  rejects(() => bridgeFor(join(f.root, 'secret.txt')), /not a directory/);
  const empty = join(f.root, 'empty');
  mkdirSync(empty);
  rejects(() => bridgeFor(empty), /no index\.html/);
  // The runtime turns it into a RuntimeConfigError (main.ts prints it and exits 1).
  const env = { SIDEKICK_AGENT_TOKEN: AGENT, SIDEKICK_CONTROL_TOKEN: CONTROL };
  await assert.rejects(createBridgeRuntime(env, { uiDir: join(f.root, 'does-not-exist') }),
    (e: unknown) => e instanceof RuntimeConfigError && /UI directory rejected/.test(e.message));
  const ok = await createBridgeRuntime(env, { uiDir: f.dist });
  assert.match(ok.labels.ui, /in-memory snapshot \(8 files/);
  await ok.close();
});

test('[S] without a built UI, /ui/ answers 404 and the API is unaffected', async () => {
  const { bridge, url } = await start();
  try {
    assert.equal((await get(`${url}/ui/`)).status, 404);
    assert.equal((await get(`${url}/v1/health`)).status, 200);
  } finally { await bridge.close(); }
});
