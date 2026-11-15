import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PAIRING_CODE_RE, readCookie, uiCookie, UiAuth } from '../../src/bridge/ui-auth.js';

function clocked(options = {}) {
  let now = 1_000_000;
  const auth = new UiAuth({ now: () => now, pairingTtlMs: 1000, idleTtlMs: 5000, maxFailures: 3, failureWindowMs: 10_000, ...options });
  return { auth, advance: (ms: number) => { now += ms; } };
}

test('pairing codes are 12 chars from the unambiguous alphabet and unique', () => {
  const { auth } = clocked();
  const codes = new Set(Array.from({ length: 500 }, () => auth.createPairing('s1').code));
  assert.equal(codes.size, 500);
  for (const c of codes) assert.match(c, PAIRING_CODE_RE);
  assert.ok([...codes].every((c) => !/[01OILU]/.test(c)));
});

test('a code redeems exactly once into a session-scoped credential', () => {
  const { auth } = clocked();
  const { code } = auth.createPairing('s1', 'p1');
  const r = auth.redeem(code);
  assert.ok(r.ok);
  assert.equal(r.client.sessionId, 's1');
  assert.equal(r.client.participantId, 'p1');
  assert.ok(r.credential.length >= 43, '256-bit credential');
  assert.equal(auth.authenticate(r.credential), r.client);
  assert.deepEqual(auth.redeem(code), { ok: false, error: 'invalid_pairing' }, 'reuse fails');
});

test('expired, unknown and malformed codes fail identically', () => {
  const { auth, advance } = clocked({ maxFailures: 10 });
  const { code } = auth.createPairing('s1');
  advance(1001);
  for (const bad of [code, 'AAAAAAAAAAAA', 'short', 42, null, undefined, '<script>']) {
    assert.deepEqual(auth.redeem(bad), { ok: false, error: 'invalid_pairing' }, String(bad));
  }
});

test('failed redemptions are rate-limited, then recover after the window', () => {
  const { auth, advance } = clocked();
  for (let i = 0; i < 3; i++) auth.redeem('AAAAAAAAAAAA');
  const { code } = auth.createPairing('s1');
  assert.deepEqual(auth.redeem(code), { ok: false, error: 'pairing_rate_limited' }, 'even a valid code is refused while limited');
  advance(10_001);
  const fresh = auth.createPairing('s1');
  assert.equal(auth.redeem(fresh.code).ok, true);
});

test('credentials idle-expire unless a stream is open; revocation is per session', () => {
  const { auth, advance } = clocked();
  const a = auth.redeem(auth.createPairing('s1').code);
  const b = auth.redeem(auth.createPairing('s2').code);
  assert.ok(a.ok && b.ok);
  a.client.openStreams = 1;
  advance(6000);
  assert.ok(auth.authenticate(a.credential), 'open stream keeps it alive');
  assert.equal(auth.authenticate(b.credential), undefined, 'idle expired');
  const c = auth.redeem(auth.createPairing('s1').code);
  assert.ok(c.ok);
  const pending = auth.createPairing('s1').code;
  assert.equal(auth.revokeSession('s1').length, 2);
  assert.equal(auth.authenticate(a.credential), undefined);
  assert.equal(auth.authenticate(c.credential), undefined);
  assert.equal(auth.redeem(pending).ok, false, 'pending pairings revoked too');
});

test('cookie helpers', () => {
  assert.equal(readCookie('a=1; sidekick_ui=XYZ; b=2', 'sidekick_ui'), 'XYZ');
  assert.equal(readCookie(undefined, 'sidekick_ui'), undefined);
  assert.match(uiCookie('v'), /HttpOnly/);
  assert.match(uiCookie('v'), /SameSite=Strict/);
  assert.match(uiCookie('v'), /Path=\/v1/);
  assert.ok(!/Max-Age/.test(uiCookie('v')), 'browser-session cookie');
});
