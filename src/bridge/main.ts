/**
 * Runnable bridge entrypoint: `npm run bridge`.
 *
 * Environment (server-only; never put these in browser code):
 *   SIDEKICK_AGENT_TOKEN    ≥32 chars — Python agent: sessions, capture state, ingest
 *   SIDEKICK_CONTROL_TOKEN  ≥32 chars, different — operator/UI: consent and lifecycle
 *   SIDEKICK_BRIDGE_PORT    optional; unset/empty → 8787 (always bound to 127.0.0.1)
 *   SIDEKICK_REASONING      optional; unset/empty → mock | gemini (needs GEMINI_API_KEY, GEMINI_MODEL)
 *
 * No vision adapter is configured yet, so frame uploads return 503 vision_unavailable
 * until Prabin's VisionPort implementation is wired in.
 */
import { SidekickCoordinator } from '../coordinator/coordinator.js';
import type { ReasoningFn } from '../coordinator/ports.js';
import { loadBridgeConfig } from './config.js';
import { createBridge } from './http-bridge.js';

interface WiringModule {
  createReasoning(mode: string, env: Record<string, string | undefined>): { label: string; reasoning: ReasoningFn };
}

function fatal(message: string): never {
  console.error(`sidekick-bridge: ${message}`);
  process.exit(1);
}

const env = process.env;
const parsed = loadBridgeConfig(env);
if (!parsed.ok) fatal(parsed.error);
const config = parsed.value;

let wiring: { label: string; reasoning: ReasoningFn };
try {
  const url = new URL('../../../src/bridge/reasoning-wiring.mts', import.meta.url);
  const module = (await import(url.href)) as WiringModule;
  wiring = module.createReasoning(config.reasoning, env);
} catch {
  fatal('reasoning configuration failed (check SIDEKICK_REASONING and, for gemini, GEMINI_API_KEY / GEMINI_MODEL)');
}

const coordinator = new SidekickCoordinator({
  reasoning: wiring.reasoning,
  // MVP rule facts the (future) vision adapter must provide on every frame.
  conditionFactKeys: ['leftZoneVisible', 'leftZoneUncovered'],
});

let bridge;
try {
  bridge = createBridge({
    coordinator,
    agentToken: config.agentToken,
    controlToken: config.controlToken,
  });
} catch (error) {
  fatal(error instanceof Error ? error.message : 'invalid bridge configuration');
}

// Stale-card and abandoned-voice sweeps (docs/engineering.md §3.1).
const sweep = setInterval(() => coordinator.engine.sweepAll(), 2_000);
const { url } = await bridge.listen(config.port);
console.log(`sidekick-bridge listening on ${url} (loopback only)`);
console.log(`  reasoning: ${wiring.label}`);
console.log('  vision: not configured — frame uploads return 503 vision_unavailable');

const shutdown = () => {
  clearInterval(sweep);
  void bridge.close().then(() => process.exit(0));
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
