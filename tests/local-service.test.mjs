import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let child;
let baseUrl;

async function freePort() {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  await new Promise((resolveClose, reject) => probe.close((error) => error ? reject(error) : resolveClose()));
  return port;
}

async function json(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  const body = await response.json();
  assert.equal(response.ok, true, JSON.stringify(body));
  return body;
}

before(async () => {
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['scripts/sidekick-local-server.mjs'], {
    cwd: root,
    stdio: 'ignore',
    env: { ...process.env, SIDEKICK_PORT: String(port), GEMINI_API_KEY: '', GEMINI_MODEL: '' },
  });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Local service exited early (${child.exitCode}).`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
  }
  throw new Error('Local service did not become ready.');
});

after(async () => {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await once(child, 'exit');
});

test('synthetic UI flow reaches the engine, reasoning provider, voice request and review', async () => {
  const health = await json('/api/health');
  assert.equal(health.reasoningMode, 'deterministic mock');

  const started = await json('/api/session/start', { method: 'POST', body: '{}' });
  assert.equal(started.session.status, 'active');

  await json('/api/session/demo/advance', { method: 'POST', body: '{}' });
  const roleState = await json('/api/session');
  assert.equal(Object.values(roleState.session.participants).find((p) => p.displayName === 'Alex')?.role, 'left defense');

  await json('/api/session/demo/advance', { method: 'POST', body: '{}' });
  const recommendationState = await json('/api/session');
  assert.equal(recommendationState.recommendations.length, 1);
  assert.equal(recommendationState.recommendations[0].title, 'Left defense appears exposed');
  assert.equal(recommendationState.recommendations[0].evidenceObservationIds.length, 2);

  const recommendationId = recommendationState.recommendations[0].id;
  const explanation = await json('/api/session/voice', {
    method: 'POST', body: JSON.stringify({ recommendationId }),
  });
  assert.match(explanation.text, /Alex/);
  assert.match(explanation.text, /left defensive zone appears uncovered/);

  await json('/api/session/voice-report', {
    method: 'POST', body: JSON.stringify({ recommendationId, report: 'playing' }),
  });
  await json('/api/session/voice-report', {
    method: 'POST', body: JSON.stringify({ recommendationId, report: 'finished' }),
  });
  await json('/api/session/end', { method: 'POST', body: '{}' });
  const review = await json('/api/session/review', { method: 'POST', body: '{}' });
  assert.match(review.overview, /simulated gaming session/);
  assert.ok(review.keyMoments.length > 0);
  assert.match(review.limitations[0], /no live Chert/);
});
