/**
 * Bridge environment parsing (pure; unit-tested). Optional variables that are unset,
 * empty or whitespace-only fall back to their documented defaults, so a copied
 * `.env.example` with blank optional lines starts normally. Tokens stay mandatory and
 * are validated by `createBridge` (≥32 chars, distinct).
 */
export const DEFAULT_BRIDGE_PORT = 8787;
export type ReasoningMode = 'mock' | 'gemini';

export interface BridgeConfig {
  port: number;
  reasoning: ReasoningMode;
  agentToken: string;
  controlToken: string;
}

export type ConfigResult = { ok: true; value: BridgeConfig } | { ok: false; error: string };

/** Unset, empty and whitespace-only all mean "not provided". */
const optional = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
};

export function loadBridgeConfig(env: Record<string, string | undefined>): ConfigResult {
  const portText = optional(env.SIDEKICK_BRIDGE_PORT);
  const port = portText === undefined ? DEFAULT_BRIDGE_PORT : Number(portText);
  if (portText !== undefined && (!/^\d{1,5}$/.test(portText) || port < 1 || port > 65_535)) {
    return { ok: false, error: 'SIDEKICK_BRIDGE_PORT must be 1–65535 (leave empty for the default 8787)' };
  }
  const mode = optional(env.SIDEKICK_REASONING) ?? 'mock';
  if (mode !== 'mock' && mode !== 'gemini') {
    return { ok: false, error: 'SIDEKICK_REASONING must be mock or gemini (leave empty for mock)' };
  }
  // Tokens are required: an empty value is passed through and rejected by createBridge.
  return { ok: true, value: { port, reasoning: mode, agentToken: env.SIDEKICK_AGENT_TOKEN ?? '', controlToken: env.SIDEKICK_CONTROL_TOKEN ?? '' } };
}
