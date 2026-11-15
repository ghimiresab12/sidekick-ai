import { pathToFileURL } from 'node:url';
import { createGeminiVision, VISION_PROFILE, VISION_FACT_KEYS } from '../src/adapters/model/gemini-vision.mts';
import { createGeminiProvider } from '../src/adapters/model/gemini.mts';
import { createMockProvider } from '../src/adapters/model/mock.mts';
import { reason } from '../src/reasoning/reason.mts';
import { scenePng, SCENES } from './vision-fixtures.mjs';

export function mockVisionFetch(scene) {
  // Fixture answers are intentionally supplied, not derived by a pretend vision algorithm.
  const data = scene === 'unrelated'
    ? { scene: 'unrelated_or_uncertain', zoneVisibility: 'not_visible', coverage: 'unknown' }
    : { scene: 'controlled_soccer', zoneVisibility: scene === 'obscured' ? 'partial' : 'full',
      coverage: scene === 'obscured' ? 'unknown' : scene };
  return async () => Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(data) }] } }] });
}

export async function runVisionScenario(scene, { live = false, visionOnly = false } = {}) {
  if (!SCENES.includes(scene)) throw Error('invalid_scene');
  const credentials = live ? { apiKey: process.env.GEMINI_API_KEY, model: process.env.GEMINI_MODEL }
    : { apiKey: 'offline-test-only', model: 'gemini-offline-test' };
  const liveFetch = async (...args) => {
    const response = await fetch(...args);
    if (!response.ok) console.error(JSON.stringify({ provider: 'Gemini', httpStatus: response.status }));
    return response;
  };
  const vision = createGeminiVision({ ...credentials, profile: VISION_PROFILE,
    fetchImpl: live ? liveFetch : mockVisionFetch(scene) });
  // No files are written. Only generated synthetic pixels are sent in live mode.
  const image = scenePng(scene);
  if (visionOnly) {
    const start = performance.now();
    const description = await vision.describe({ image, mimeType: 'image/png', captureGeneration: 1, observedAt: new Date().toISOString() }, new AbortController().signal);
    return { scene, elapsedMs: Math.round(performance.now() - start), description };
  }
  // Build with tsc first. Keeping this import dynamic lets vision-only run independently.
  const { SidekickCoordinator } = await import('../dist/src/coordinator/coordinator.js');
  const diagnostics = [];
  const provider = live ? createGeminiProvider({ ...credentials, fetchImpl: liveFetch,
    onDiagnostic: d => diagnostics.push({ type: 'provider_diagnostic', ...d }) }) : createMockProvider();
  const c = new SidekickCoordinator({ vision, reasoning: (input, signal) => reason(input, provider, { signal }),
    conditionFactKeys: [...VISION_FACT_KEYS], onDiagnostic: d => diagnostics.push(d) });
  const unwrap = r => { if (!r.ok) throw Error(r.error); return r.value; };
  const sid = unwrap(c.createSession()).id;
  const start = performance.now();
  try {
    const active = unwrap(c.startWithConsent(sid));
    unwrap(c.engine.addParticipant(sid, { displayName: 'Alex' }));
    unwrap(c.engine.confirmActivity(sid, 'gaming'));
    unwrap(c.ingestConversation(sid, { captureGeneration: active.captureGeneration,
      observedAt: new Date().toISOString(), text: 'Alex is responsible for left defense.' }));
    await c.whenIdle(sid);
    const capturedAt = new Date().toISOString();
    const observation = unwrap(await c.ingestFrame(sid, { captureGeneration: active.captureGeneration,
      observedAt: capturedAt, image, mimeType: 'image/png' }));
    await c.whenIdle(sid);
    const session = unwrap(c.engine.getSession(sid));
    const overlay = unwrap(c.engine.getOverlayState(sid));
    const observations = unwrap(c.engine.listObservations(sid));
    const timeline = unwrap(c.engine.getTimeline(sid));
    return { scene, elapsedMs: Math.round(performance.now() - start), observation,
      participants: session.participants, recommendations: session.recommendations, overlay,
      observations, timeline, diagnostics };
  } finally { c.end(sid); await c.whenIdle(sid); c.discard(sid); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const allowed = new Set(['--live', '--vision-only', '--scene', ...SCENES]);
  if (args.some(x => !allowed.has(x))) { console.error('Usage: node examples/vision-demo.mjs [--live] [--vision-only] [--scene uncovered|covered|obscured|unrelated]'); process.exitCode = 1; }
  else {
    const live = args.includes('--live'); const visionOnly = args.includes('--vision-only');
    const index = args.indexOf('--scene'); const scenes = index < 0 ? SCENES : [args[index + 1]];
    console.log(live ? 'REAL GEMINI / SYNTHETIC IMAGES AND TRANSCRIPT / NO CHERT' : 'OFFLINE MOCK RESPONSES / SYNTHETIC IMAGES / NO GEMINI / NO CHERT');
    for (const scene of scenes) {
      try {
        const result = await runVisionScenario(scene, { live, visionOnly });
        if (visionOnly) console.log(JSON.stringify(result, null, 2));
        else console.log(JSON.stringify({ scene, elapsedMs: result.elapsedMs,
          observation: result.observation, participants: result.participants,
          recommendations: result.recommendations, diagnostics: result.diagnostics }, null, 2));
        if (result.diagnostics?.some(d => d.type === 'reasoning_failed')) process.exitCode = 1;
      } catch (e) {
        // Do not print unknown exception messages, stacks, credentials or provider bodies.
        const known = ['invalid_scene', 'invalid_frame', 'timeout', 'aborted', 'provider_error', 'invalid_output', 'busy', 'vision_failed'];
        console.error(JSON.stringify({ scene, ok: false, error: known.includes(e?.message) ? e.message : 'demo_failed_check_configuration_and_build' }));
        process.exitCode = 1;
      }
    }
  }
}
