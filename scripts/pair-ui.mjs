#!/usr/bin/env node
/**
 * Operator helper: create (or reuse) the session for a room and print a one-time pairing URL
 * for ONE browser. Uses SIDEKICK_CONTROL_TOKEN from the server environment; the token is
 * never printed. The URL contains a short-lived secret code: give it only to the intended
 * participant's device, then it is consumed on first use.
 *
 *   npm run pair -- --room <room-name> [--participant <displayName>]
 */
const args = process.argv.slice(2);
const arg = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const room = arg('room');
const participantName = arg('participant');
const token = process.env.SIDEKICK_CONTROL_TOKEN ?? '';
const port = (process.env.SIDEKICK_BRIDGE_PORT ?? '').trim() || '8787';
if (!room || !token) {
  console.error('usage: SIDEKICK_CONTROL_TOKEN=… npm run pair -- --room <room-name> [--participant <displayName>]');
  process.exit(1);
}
const base = `http://127.0.0.1:${port}`;
const call = async (method, path, body) => {
  const res = await fetch(base + path, {
    method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path.replace(/sessions\/[^/]+/, 'sessions/:id')} → ${res.status} ${json.error ?? ''}`);
  return json;
};
try {
  const session = await call('POST', '/v1/sessions', { externalRef: room });
  let participantId;
  if (participantName) {
    const list = await call('GET', `/v1/sessions/${session.sessionId}/participants`);
    participantId = list.participants.find((p) => p.displayName === participantName)?.id
      ?? (await call('POST', `/v1/sessions/${session.sessionId}/participants`, { displayName: participantName })).id;
  }
  const pairing = await call('POST', `/v1/sessions/${session.sessionId}/pairings`, participantId ? { participantId } : {});
  console.log(`session ${session.sessionId} (${session.status})`);
  console.log(`open within 2 minutes, on ONE device: ${pairing.url}`);
} catch (e) {
  console.error(`pairing failed: ${e.message}`);
  process.exit(1);
}
