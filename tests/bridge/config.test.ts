import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_BRIDGE_PORT, loadBridgeConfig } from '../../src/bridge/config.js';

test('[B2-2] unset, empty and whitespace optional variables use the documented defaults', () => {
  for (const blank of [undefined, '', '   ']) {
    const r = loadBridgeConfig({ SIDEKICK_BRIDGE_PORT: blank, SIDEKICK_REASONING: blank, SIDEKICK_AGENT_TOKEN: 'a', SIDEKICK_CONTROL_TOKEN: 'c' });
    assert.ok(r.ok, `blank=${JSON.stringify(blank)}`);
    assert.equal(r.value.port, DEFAULT_BRIDGE_PORT);
    assert.equal(r.value.reasoning, 'mock');
  }
});

test('[B2-2] the shipped .env.example, copied as-is, parses without errors', () => {
  const env: Record<string, string> = {};
  for (const line of readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) env[m[1]!] = m[2]!;
  }
  assert.ok('SIDEKICK_BRIDGE_PORT' in env && 'SIDEKICK_REASONING' in env, 'template lists the optional variables');
  const r = loadBridgeConfig(env);
  assert.ok(r.ok);
  assert.deepEqual([r.value.port, r.value.reasoning], [DEFAULT_BRIDGE_PORT, 'mock']);
  assert.equal(r.value.agentToken, '', 'tokens stay empty → createBridge rejects them (still mandatory)');
});

test('[B2-2] explicit values are honoured and invalid ones rejected', () => {
  const ok = loadBridgeConfig({ SIDEKICK_BRIDGE_PORT: ' 9001 ', SIDEKICK_REASONING: 'gemini' });
  assert.ok(ok.ok);
  assert.deepEqual([ok.value.port, ok.value.reasoning], [9001, 'gemini']);
  for (const port of ['0', '65536', 'abc', '80.5']) assert.equal(loadBridgeConfig({ SIDEKICK_BRIDGE_PORT: port }).ok, false, port);
  assert.equal(loadBridgeConfig({ SIDEKICK_REASONING: 'openai' }).ok, false);
});
