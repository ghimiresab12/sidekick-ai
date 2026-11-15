/**
 * Overlay-side types that have NO equivalent in `src/contracts/types.ts` yet.
 *
 * Only the session review remains here. `ExplanationScript` and the browser timeline
 * now come from the shared contracts (`./shared`).
 */

/**
 * Review result. Defined only as a *proposed* contract in docs/engineering.md §8 (not
 * in `src/contracts/types.ts`), and the bridge has no review service. The overlay
 * builds it from the browser timeline (`review/buildReview.ts`) in both backends.
 * Field names follow §8 exactly.
 */
export interface SessionReview {
  sessionId: string;
  generatedAt: string;
  activity: string;
  overview: string;
  keyMoments: Array<{ eventIds: string[]; time?: string; whatHappened: string }>;
  strengths: string[];
  improvementAreas: string[];
  nextActions: string[];
  limitations: string[];
}
