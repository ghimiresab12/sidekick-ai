/**
 * The overlay's single entry point to the SHARED application contracts.
 *
 * Every type here is re-exported, type-only, from `src/contracts/types.ts` (owned by
 * the session/contracts workstream). The overlay defines no duplicate of any of them:
 * if the engine's contract changes, `npm run typecheck` in overlay/ fails instead of
 * drifting silently. Type-only imports are erased at build time, so no engine code is
 * bundled through this file.
 *
 * The overlay consumes only BROWSER-SAFE shapes: `ExplanationScript` (never
 * `ExplanationContext`, which carries transcript text) and `BrowserSessionTimeline`
 * (no goal or decision wording), exactly as the bridge sends them (engineering.md
 * "Integration milestone 4").
 */
export type {
  Activity,
  BrowserSessionEvent,
  BrowserSessionTimeline,
  EngineError,
  ExplanationScript,
  ObservationSource,
  OverlayState,
  RecommendationStatus,
  RecommendationView,
  SessionEvent,
  SessionEventType,
  SessionStatus,
  StaleReason,
  Urgency,
  VoiceCancelReason,
  VoiceRequest,
  VoiceRequestStatus,
} from '../../../src/contracts/types';
