/**
 * Production reasoning wiring for the bridge entrypoint. Imports Prabin's reasoning
 * module and adapters without modifying them. Loaded at runtime by `src/bridge/main.ts`
 * (Node type-strips .mts) and type-checked by `npm run typecheck`.
 *
 * - `mock` (default): deterministic offline simulator. NOT Gemini; labelled as such.
 * - `gemini`: Prabin's Gemini text-reasoning adapter. Requires GEMINI_API_KEY and
 *   GEMINI_MODEL in the server environment. There is NO silent fallback to mock.
 */
import { reason } from '../reasoning/reason.mts';
import { createMockProvider } from '../adapters/model/mock.mts';
import { createGeminiProvider } from '../adapters/model/gemini.mts';
import type { ReasoningProvider } from '../reasoning/contracts.mts';
import type { ReasoningFn } from '../coordinator/ports.ts';

export type ReasoningMode = 'mock' | 'gemini';

export interface ReasoningWiring {
  mode: ReasoningMode;
  /** Human-readable, credential-free label for startup output. */
  label: string;
  reasoning: ReasoningFn;
}

export function createReasoning(mode: ReasoningMode, env: Record<string, string | undefined>): ReasoningWiring {
  let provider: ReasoningProvider;
  let label: string;
  if (mode === 'gemini') {
    // Throws (no fallback) if the key or model is missing or malformed.
    provider = createGeminiProvider({ apiKey: env.GEMINI_API_KEY ?? '', model: env.GEMINI_MODEL ?? '' });
    label = `Gemini text reasoning (${env.GEMINI_MODEL})`;
  } else if (mode === 'mock') {
    provider = createMockProvider();
    label = 'MOCK reasoning (offline simulator, not Gemini)';
  } else {
    throw new RangeError('SIDEKICK_REASONING must be mock or gemini');
  }
  return { mode, label, reasoning: (request, signal) => reason(request, provider, { signal }) };
}
