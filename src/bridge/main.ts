/**
 * Runnable bridge entrypoint: `npm run bridge`.
 *
 * Environment (server-only; never put these in browser code):
 *   SIDEKICK_AGENT_TOKEN    required, ≥32 chars — Python agent: sessions, capture state, ingest
 *   SIDEKICK_CONTROL_TOKEN  required, ≥32 chars, different — operator/UI: consent and lifecycle
 *   SIDEKICK_BRIDGE_PORT    optional; unset/empty → 8787 (always bound to 127.0.0.1)
 *   SIDEKICK_REASONING      optional; unset/empty → mock | gemini (needs GEMINI_API_KEY, GEMINI_MODEL)
 *   SIDEKICK_VISION         optional; unset/empty → none | gemini (needs GEMINI_API_KEY, GEMINI_MODEL)
 */
import { createBridgeRuntime, RuntimeConfigError, type BridgeRuntime } from './runtime.js';

function fatal(message: string): never {
  console.error(`sidekick-bridge: ${message}`);
  process.exit(1);
}

let runtime: BridgeRuntime;
try {
  runtime = await createBridgeRuntime(process.env);
} catch (error) {
  fatal(error instanceof RuntimeConfigError ? error.message : 'invalid bridge configuration');
}

const { url } = await runtime.listen();
console.log(`sidekick-bridge listening on ${url} (loopback only)`);
console.log(`  reasoning: ${runtime.labels.reasoning}`);
console.log(`  vision: ${runtime.labels.vision}`);

const shutdown = () => {
  void runtime.close().then(() => process.exit(0));
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
