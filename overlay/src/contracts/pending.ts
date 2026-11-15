/**
 * Overlay-side types that have NO equivalent in `src/contracts/types.ts` yet.
 *
 * Each one is a real gap in the shared contracts, not a duplicate. They are kept
 * here, clearly marked, until the contracts owner (Sabik) decides whether to add
 * them to the shared file. Everything they contain is composed of shared types.
 * See overlay/README.md "Contract gaps" for the proposed additions.
 */
import type { SessionEvent, VoiceRequest } from './shared';

/**
 * GAP 1 — explanation text (formerly proposal P3).
 * engineering.md §3.2: `requestExplanation` returns `{ request, context }`, then "the
 * backend generates text from `context`". The shared file has no type for that text.
 * The overlay must not receive `ExplanationContext` itself, because it carries raw
 * transcript text, which `OverlayState` deliberately keeps out of the UI.
 */
export interface ExplanationScript {
  /** The engine's voice request, unchanged. Every playback report quotes `request.id`. */
  request: VoiceRequest;
  /** Grounded text for LOCAL speech synthesis. Never audio. */
  text: string;
  /** True when the card was stale or its evidence old: must not be read as a live alert. */
  refersToEarlierObservation: boolean;
}

/** `getTimeline()` plus the snapshot flag the review needs to state a gap honestly. */
export interface SessionTimeline {
  events: SessionEvent[];
  /** `SessionSnapshot.timelineTruncated`. */
  truncated: boolean;
}

/**
 * GAP 2 — review result. Defined only as a *proposed* contract in
 * docs/engineering.md §8 (not in `src/contracts/types.ts`), and no backend review
 * service exists yet. Field names follow §8 exactly.
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
