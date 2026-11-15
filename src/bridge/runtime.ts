/**
 * Builds the complete bridge runtime from an environment: config → reasoning wiring →
 * vision wiring → coordinator → bridge. `main.ts` uses it for production; tests use it
 * to exercise the exact production wiring with mocked Gemini HTTP.
 *
 * `fetchImpl` can only be injected from code (tests), never from the environment, so
 * production traffic cannot be redirected by configuration.
 */
import { SidekickCoordinator } from '../coordinator/coordinator.js';
import type { ReasoningFn, VisionPort } from '../coordinator/ports.js';
import { loadBridgeConfig, type BridgeConfig } from './config.js';
import { createBridge, type Bridge, type BridgeLogEntry } from './http-bridge.js';

/** Configuration problem with a safe, credential-free message. */
export class RuntimeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeConfigError';
  }
}

export interface RuntimeOptions {
  /** Test-only HTTP transport for Gemini vision. */
  fetchImpl?: typeof fetch;
  /** Single frame deadline (upload + vision). Default 10 s. Also caps the vision adapter timeout. */
  frameTimeoutMs?: number;
  onRequestLog?: (entry: BridgeLogEntry) => void;
}

export interface BridgeRuntime {
  config: BridgeConfig;
  coordinator: SidekickCoordinator;
  bridge: Bridge;
  labels: { reasoning: string; vision: string };
  /** Starts listening on 127.0.0.1 and the periodic stale/voice sweep. */
  listen(port?: number): Promise<{ port: number; url: string }>;
  close(): Promise<void>;
}

interface ReasoningModule {
  createReasoning(mode: string, env: Record<string, string | undefined>): { label: string; reasoning: ReasoningFn };
}
interface VisionModule {
  createVision(
    mode: string,
    env: Record<string, string | undefined>,
    options: { timeoutMs: number; fetchImpl?: typeof fetch },
  ): { label: string; vision?: VisionPort; conditionFactKeys: readonly string[] };
}

const wiring = (name: string) => new URL(`../../../src/bridge/${name}`, import.meta.url).href;

export async function createBridgeRuntime(
  env: Record<string, string | undefined>,
  options: RuntimeOptions = {},
): Promise<BridgeRuntime> {
  const parsed = loadBridgeConfig(env);
  if (!parsed.ok) throw new RuntimeConfigError(parsed.error);
  const config = parsed.value;
  const frameTimeoutMs = options.frameTimeoutMs ?? 10_000;

  let reasoning: { label: string; reasoning: ReasoningFn };
  try {
    reasoning = ((await import(wiring('reasoning-wiring.mts'))) as ReasoningModule).createReasoning(config.reasoning, env);
  } catch {
    throw new RuntimeConfigError('reasoning configuration failed (check SIDEKICK_REASONING and, for gemini, GEMINI_API_KEY / GEMINI_MODEL)');
  }
  let vision: { label: string; vision?: VisionPort; conditionFactKeys: readonly string[] };
  try {
    vision = ((await import(wiring('vision-wiring.mts'))) as VisionModule).createVision(config.vision, env, {
      timeoutMs: frameTimeoutMs,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
  } catch {
    throw new RuntimeConfigError('vision configuration failed (check SIDEKICK_VISION and, for gemini, GEMINI_API_KEY / GEMINI_MODEL)');
  }

  const coordinator = new SidekickCoordinator({
    reasoning: reasoning.reasoning,
    ...(vision.vision ? { vision: vision.vision } : {}),
    conditionFactKeys: vision.conditionFactKeys,
  });
  let bridge: Bridge;
  try {
    bridge = createBridge({
      coordinator,
      agentToken: config.agentToken,
      controlToken: config.controlToken,
      frameTimeoutMs,
      ...(options.onRequestLog ? { onRequestLog: options.onRequestLog } : {}),
    });
  } catch (error) {
    throw new RuntimeConfigError(error instanceof RangeError ? error.message : 'invalid bridge configuration');
  }

  let sweep: ReturnType<typeof setInterval> | undefined;
  return {
    config,
    coordinator,
    bridge,
    labels: { reasoning: reasoning.label, vision: vision.label },
    async listen(port = config.port) {
      const address = await bridge.listen(port);
      // Stale-card and abandoned-voice sweeps (docs/engineering.md §3.1).
      sweep = setInterval(() => coordinator.engine.sweepAll(), 2_000);
      sweep.unref?.();
      return address;
    },
    async close() {
      if (sweep) clearInterval(sweep);
      await bridge.close();
    },
  };
}
