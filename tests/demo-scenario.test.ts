import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDemoScenario } from '../src/mock/demo-scenario.js';
import { value } from './helpers.js';

test('smoke: mock demo path yields exactly one card, one explanation and a reviewable timeline', () => {
  const { engine, sessionId, recommendationId, timeline, overlayUpdates } = runDemoScenario();
  const types = timeline.map((e) => e.type);
  assert.equal(types.filter((t) => t === 'recommendation_created').length, 1);
  assert.equal(types.filter((t) => t === 'voice_requested').length, 1);
  assert.equal(types.filter((t) => t === 'voice_finished').length, 1);
  assert.ok(types.includes('role_updated'));
  assert.ok(types.includes('recommendation_resolved'));
  assert.equal(types.at(-1), 'session_ended');

  const rec = value(engine.getSession(sessionId)).recommendations.find((r) => r.id === recommendationId)!;
  assert.equal(rec.status, 'resolved');
  assert.equal(rec.conditionObservationIds.length, 2, 'two gap frames merged into one card');
  assert.equal(rec.contextObservationIds.length, 1, 'role utterance kept as context only');
  assert.equal(value(engine.getSession(sessionId)).voiceRequests[0]?.status, 'finished');
  assert.ok(types.includes('decision_recorded'));
  assert.ok(overlayUpdates.some((s) => s.prominent?.id === recommendationId));
  assert.equal(overlayUpdates.at(-1)?.status, 'ended');
});
