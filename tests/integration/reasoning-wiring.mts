/**
 * Wiring between the coordinator's ReasoningFn port and Prabin's real reasoning module.
 * Used at runtime by the integration tests (Node type-strips .mts) and type-checked by
 * `npm run typecheck` (tsconfig.reasoning-compat.json), so an incompatible change to
 * either side fails the type check. Only type imports from the coordinator are used.
 */
import { reason } from '../../src/reasoning/reason.mts';
import { createMockProvider } from '../../src/adapters/model/mock.mts';
import type { ReasoningProvider } from '../../src/reasoning/contracts.mts';
import type { ReasoningFn } from '../../src/coordinator/ports.ts';

export function createReasoningFn(provider: ReasoningProvider): ReasoningFn {
  return (request, signal) => reason(request, provider, { signal });
}

/** Offline deterministic simulator — NOT Gemini. */
export const mockReasoning: ReasoningFn = createReasoningFn(createMockProvider());
