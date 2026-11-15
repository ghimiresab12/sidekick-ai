import test from 'node:test';
import assert from 'node:assert/strict';
import type { Participant, Observation, ScreenObservation, Recommendation, OverlayState, SessionEvent } from '../../src/contracts/types.js';
import type { CoordinatorDiagnostic, FrameInput, VisionPort, ReasoningFn } from '../../src/coordinator/ports.js';
import { SidekickCoordinator } from '../../src/coordinator/coordinator.js';
const demoUrl = new URL('../../../examples/vision-demo.mjs', import.meta.url).href;
const { runVisionScenario } = await import(demoUrl) as {
  runVisionScenario(scene: string): Promise<{
    participants: Participant[]; observations: Observation[]; observation: ScreenObservation;
    recommendations: Recommendation[]; overlay: OverlayState; timeline: SessionEvent[];
    diagnostics: CoordinatorDiagnostic[];
  }>;
};

for (const scene of ['uncovered', 'covered', 'obscured', 'unrelated']) {
  test(`real coordinator with injected Gemini HTTP response: ${scene}`, async () => {
    const r = await runVisionScenario(scene);
    assert.equal(r.diagnostics.some(d => d.type === 'reasoning_failed'), false);
    assert.equal(r.participants[0]!.role, 'left defense');
    assert.equal(r.recommendations.length, scene === 'uncovered' ? 1 : 0);
    assert.equal(r.observation.source, 'screen');
    assert.equal('image' in r.observation, false);
    assert.equal(r.overlay.voiceBusy, false);
    if (scene === 'uncovered') {
      const card = r.recommendations[0]!;
      assert.deepEqual(card.conditionObservationIds, [r.observation.id]);
      const context = r.observations.find(o => o.id === card.contextObservationIds?.[0]);
      assert.ok(context?.source === 'transcript');
      assert.equal(context.text, 'Alex is responsible for left defense.');
      assert.match(card.shortAdvice, /Alex/);
      assert.equal(r.timeline.some(e => e.type === 'recommendation_created'), true);
      assert.equal(r.timeline.some(e => e.type === 'voice_requested'), false);
    }
  });
}

const adapterUrl = new URL('../../../src/adapters/model/gemini-vision.mts', import.meta.url).href;
const fixtureUrl = new URL('../../../examples/vision-fixtures.mjs', import.meta.url).href;
const wiringUrl = new URL('../../../tests/integration/reasoning-wiring.mts', import.meta.url).href;
const { createGeminiVision } = await import(adapterUrl) as {
  createGeminiVision(options: { apiKey: string; model: string; profile: 'controlled-soccer-v1'; fetchImpl: typeof fetch }): VisionPort;
};
const { scenePng } = await import(fixtureUrl) as { scenePng(scene: string): Uint8Array };
const { mockReasoning } = await import(wiringUrl) as { mockReasoning: ReasoningFn };
const answer = () => Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({
  scene: 'controlled_soccer', zoneVisibility: 'full', coverage: 'uncovered',
}) }] } }] });

function setup(fetchImpl: typeof fetch) {
  let now = Date.parse('2026-11-15T04:00:00Z');
  const c = new SidekickCoordinator({ now: () => new Date(now), reasoning: mockReasoning,
    vision: createGeminiVision({ apiKey: 'test-only', model: 'gemini-test', profile: 'controlled-soccer-v1', fetchImpl }),
    conditionFactKeys: ['leftZoneVisible', 'leftZoneUncovered'],
  });
  const session = c.createSession(); assert.ok(session.ok);
  const sid = session.value.id;
  const active = c.startWithConsent(sid); assert.ok(active.ok);
  assert.ok(c.engine.confirmActivity(sid, 'gaming').ok);
  const frame: FrameInput = { mediaSource: 'screen_share', image: scenePng('uncovered'), mimeType: 'image/png',
    observedAt: new Date(now).toISOString(), captureGeneration: active.value.captureGeneration };
  return { c, sid, frame, advance: (ms: number) => { now += ms; } };
}

for (const lifecycle of ['pause', 'end', 'discard'] as const) {
  test(`${lifecycle} cancels Gemini vision and prevents late frame ingestion`, async () => {
    let finish!: (r: Response) => void; let providerSignal: AbortSignal | null | undefined;
    const h = setup(async (_, init) => { providerSignal = init?.signal; return new Promise(resolve => { finish = resolve; }); });
    const pending = h.c.ingestFrame(h.sid, h.frame);
    assert.ok(h.c[lifecycle](h.sid).ok);
    finish(answer());
    const r = await pending;
    assert.equal(r.ok, false); assert.equal(providerSignal?.aborted, true);
    await h.c.whenIdle(h.sid);
    const observations = h.c.engine.listObservations(h.sid);
    if (lifecycle !== 'discard') { assert.ok(observations.ok); assert.equal(observations.value.length, 0); h.c.discard(h.sid); }
    else assert.equal(observations.ok, false);
  });
}

test('malformed vision output cannot enter engine memory', async () => {
  const h = setup(async () => Response.json({ candidates: [] }));
  const r = await h.c.ingestFrame(h.sid, h.frame);
  assert.equal(r.ok, false);
  const observations = h.c.engine.listObservations(h.sid); assert.ok(observations.ok);
  assert.equal(observations.value.length, 0); h.c.discard(h.sid);
});

test('repeated visual condition creates only one recommendation and never speaks', async () => {
  const h = setup(async () => answer());
  for (let i = 0; i < 3; i++) {
    h.advance(1); h.frame.observedAt = new Date(Date.parse(h.frame.observedAt) + 1).toISOString();
    assert.ok((await h.c.ingestFrame(h.sid, h.frame)).ok); await h.c.whenIdle(h.sid);
  }
  const state = h.c.engine.getSession(h.sid); assert.ok(state.ok);
  assert.equal(state.value.recommendations.length, 1);
  assert.equal(state.value.voiceRequests.length, 0);
  const timeline = h.c.engine.getTimeline(h.sid); assert.ok(timeline.ok);
  assert.equal(timeline.value.filter(e => e.type === 'recommendation_created').length, 1);
  h.c.discard(h.sid);
});

test('slow vision does not refresh capture time or revive stale evidence', async () => {
  let finish!: (r: Response) => void;
  const h = setup(async () => new Promise(resolve => { finish = resolve; }));
  const capturedAt = h.frame.observedAt;
  const pending = h.c.ingestFrame(h.sid, h.frame);
  h.advance(16_000); finish(answer());
  const r = await pending; assert.ok(r.ok);
  assert.equal(r.value.observedAt, capturedAt);
  await h.c.whenIdle(h.sid);
  const state = h.c.engine.getSession(h.sid); assert.ok(state.ok);
  assert.equal(state.value.recommendations.length, 0); h.c.discard(h.sid);
});
