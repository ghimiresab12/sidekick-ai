/**
 * Vision wiring for the bridge runtime. Uses Prabin's Gemini vision adapter and its
 * exported constants unchanged (no duplicated profile or fact keys). Loaded at runtime
 * by `src/bridge/runtime.ts` (Node type-strips .mts) and type-checked by `npm run typecheck`.
 *
 * - `none` (default): no adapter; frame uploads return 503 vision_unavailable.
 * - `gemini`: `createGeminiVision` with the explicit `controlled-soccer-v1` profile, using
 *   the shared GEMINI_API_KEY / GEMINI_MODEL. Missing or invalid credentials throw — there
 *   is NO fallback to "no vision" or to a mock.
 */
import { createGeminiVision, VISION_FACT_KEYS, VISION_PROFILE } from '../adapters/model/gemini-vision.mts';
import type { VisionPort } from '../coordinator/ports.ts';

export type VisionMode = 'none' | 'gemini';

export interface VisionWiring {
  mode: VisionMode;
  /** Credential-free label for startup output. */
  label: string;
  vision?: VisionPort;
  /** Prabin's VISION_FACT_KEYS — the coordinator's condition-fact keys. */
  conditionFactKeys: readonly string[];
}

export function createVision(
  mode: VisionMode,
  env: Record<string, string | undefined>,
  options: { timeoutMs: number; fetchImpl?: typeof fetch },
): VisionWiring {
  if (mode === 'none') {
    return { mode, label: 'not configured — frame uploads return 503 vision_unavailable', conditionFactKeys: VISION_FACT_KEYS };
  }
  if (mode !== 'gemini') throw new RangeError('SIDEKICK_VISION must be none or gemini');
  const vision = createGeminiVision({
    apiKey: env.GEMINI_API_KEY?.trim() ?? '',
    model: env.GEMINI_MODEL?.trim() ?? '',
    profile: VISION_PROFILE,
    // Never longer than the bridge's single frame deadline; the bridge deadline still governs.
    timeoutMs: options.timeoutMs,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  return { mode, label: `Gemini vision (${VISION_PROFILE} profile only)`, vision, conditionFactKeys: VISION_FACT_KEYS };
}
