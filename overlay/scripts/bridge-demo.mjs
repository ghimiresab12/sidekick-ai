#!/usr/bin/env node
/**
 * Local demo/E2E harness: runs the REAL Node bridge (root `dist/`, production runtime)
 * serving the built overlay at /ui/, and plays the two roles the overlay does not:
 * the OPERATOR (control token: session, consent, resume, pairing) and the AGENT
 * (agent token: synthetic transcript and frames). Nothing here changes the bridge.
 *
 * Inputs are SYNTHETIC: one scripted transcript line and generated controlled-scene
 * PNGs. Reasoning is the deterministic mock provider. Gemini vision runs with its HTTP
 * MOCKED (Prabin's `mockVisionFetch`), so no network request leaves the machine and no
 * API key is needed. Tokens are random per run and never printed. Localhost only.
 *
 * Prerequisites (from the repository root):
 *   npm ci && npm run build            # root dist/ (bridge runtime)
 *   npm ci --prefix overlay && npm --prefix overlay run build
 * Run:
 *   node overlay/scripts/bridge-demo.mjs [--port 8787]
 * Then type commands: pair [name] · gaming · consent · role · frame [uncovered|covered|obscured|unrelated] · resume · drop · quit
 *
 * Usual order: open the pairing URL, use the overlay's "Confirm gaming" (or type `gaming`),
 * `consent`, `role`, `frame`. Cards appear only after the activity is confirmed.
 */
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = (p) => pathToFileURL(fileURLToPath(new URL(`../../${p}`, import.meta.url))).href;

export const ROLE_LINE = 'Alex is responsible for left defense.';

/**
 * Starts the bridge on 127.0.0.1 and returns operator/agent helpers.
 * @param {{ port?: number, participants?: string[], ui?: Record<string, number> }} [options]
 */
export async function startDemoBridge(options = {}) {
  const { createBridgeRuntime } = await import(repo('dist/src/bridge/runtime.js'));
  const { mockVisionFetch } = await import(repo('examples/vision-demo.mjs'));
  const { scenePng } = await import(repo('examples/vision-fixtures.mjs'));

  const agentToken = randomBytes(24).toString('hex');
  const controlToken = randomBytes(24).toString('hex');
  let scene = 'uncovered';
  const runtime = await createBridgeRuntime(
    {
      SIDEKICK_AGENT_TOKEN: agentToken,
      SIDEKICK_CONTROL_TOKEN: controlToken,
      SIDEKICK_REASONING: 'mock',
      SIDEKICK_VISION: 'gemini',
      GEMINI_API_KEY: 'offline-demo-not-a-real-key',
      GEMINI_MODEL: 'gemini-offline-demo',
    },
    {
      fetchImpl: () => mockVisionFetch(scene)(),
      uiDir: fileURLToPath(new URL('../dist', import.meta.url)),
      ...(options.ui ? { ui: options.ui } : {}),
    },
  );
  const { url } = await runtime.listen(options.port ?? 8787);

  async function call(token, method, path, { json, body, headers = {} } = {}) {
    const h = { authorization: `Bearer ${token}`, ...headers };
    if (json !== undefined) h['content-type'] = 'application/json';
    const res = await fetch(url + path, { method, headers: h, ...(json !== undefined ? { body: JSON.stringify(json) } : body ? { body } : {}) });
    const text = await res.text();
    const parsed = text ? JSON.parse(text) : {};
    if (!res.ok) throw new Error(`${method} ${path.replace(/sessions\/[^/]+/, 'sessions/:id')} → ${res.status} ${parsed.error ?? ''}`);
    return parsed;
  }
  const control = (m, p, o) => call(controlToken, m, p, o);
  const agent = (m, p, o) => call(agentToken, m, p, o);

  const { sessionId } = await control('POST', '/v1/sessions', { json: { externalRef: `demo-${Date.now()}` } });
  const participants = {};
  for (const displayName of options.participants ?? ['Alex', 'Jordan', 'Sam']) {
    participants[displayName] = (await control('POST', `/v1/sessions/${sessionId}/participants`, { json: { displayName } })).id;
  }
  const generation = async () => (await agent('GET', `/v1/sessions/${sessionId}/capture`)).captureGeneration;

  return {
    url,
    sessionId,
    participants,
    coordinator: runtime.coordinator,
    /** One-time pairing URL for one browser (optionally bound to a participant). */
    async pair(participantName) {
      const pid = participantName ? participants[participantName] : undefined;
      return (await control('POST', `/v1/sessions/${sessionId}/pairings`, { json: pid ? { participantId: pid } : {} })).url;
    },
    /** Normally done from the overlay ("Confirm gaming"); reasoning needs a confirmed activity. */
    confirmGaming: () => control('POST', `/v1/sessions/${sessionId}/activity`, { json: { activity: 'gaming' } }),
    consent: () => control('POST', `/v1/sessions/${sessionId}/consent`, { json: { consent: true, allParticipantsAgreed: true } }),
    resume: () => control('POST', `/v1/sessions/${sessionId}/resume`),
    async role(text = ROLE_LINE) {
      const r = await agent('POST', `/v1/sessions/${sessionId}/transcripts`, {
        json: { captureGeneration: await generation(), observedAt: new Date().toISOString(), text },
      });
      await runtime.coordinator.whenIdle(sessionId);
      return r;
    },
    async frame(nextScene = 'uncovered') {
      scene = nextScene;
      const r = await agent('POST', `/v1/sessions/${sessionId}/frames`, {
        body: scenePng(nextScene),
        headers: { 'content-type': 'image/png', 'x-media-source': 'screen_share', 'x-capture-generation': String(await generation()), 'x-observed-at': new Date().toISOString() },
      });
      await runtime.coordinator.whenIdle(sessionId);
      return r;
    },
    /** Simulates a network drop: closes every open connection (streams reconnect by themselves). */
    dropConnections: () => runtime.bridge.server.closeAllConnections(),
    close: () => runtime.close(),
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const i = process.argv.indexOf('--port');
  const port = i >= 0 ? Number(process.argv[i + 1]) : 8787;
  const demo = await startDemoBridge({ port });
  console.log(`bridge ${demo.url} (mock reasoning, mocked Gemini vision HTTP, synthetic inputs, localhost only)`);
  console.log(`session ${demo.sessionId}; participants ${Object.keys(demo.participants).join(', ')}`);
  console.log(`pair one browser (2 minutes, one use): ${await demo.pair()}`);
  console.log('commands: pair [name] · gaming · consent · role · frame [scene] · resume · drop · quit');
  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    const [cmd, arg] = line.trim().split(/\s+/);
    try {
      if (cmd === 'pair') console.log(await demo.pair(arg));
      else if (cmd === 'consent') console.log((await demo.consent()).status);
      else if (cmd === 'gaming') console.log((await demo.confirmGaming()).activityConfirmed ? 'gaming confirmed' : 'not confirmed');
      else if (cmd === 'role') await demo.role(), console.log('transcript sent');
      else if (cmd === 'frame') await demo.frame(arg), console.log(`frame sent (${arg ?? 'uncovered'})`);
      else if (cmd === 'resume') console.log((await demo.resume()).status);
      else if (cmd === 'drop') demo.dropConnections(), console.log('connections dropped');
      else if (cmd === 'quit') break;
      else if (cmd) console.log('unknown command');
    } catch (e) {
      console.log(`failed: ${e.message}`);
    }
  }
  await demo.close();
  process.exit(0);
}
