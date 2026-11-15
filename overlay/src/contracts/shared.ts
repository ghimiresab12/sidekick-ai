/**
 * The overlay's single entry point to the SHARED application contracts.
 *
 * Every type here is re-exported, type-only, from `src/contracts/types.ts` (owned by
 * the session/contracts workstream). The overlay defines no duplicate of any of them:
 * if the engine's contract changes, `npm run typecheck` in overlay/ fails instead of
 * drifting silently. Type-only imports are erased at build time, so no engine code is
 * bundled through this file.
 */
export type {
  Activity,
  EngineError,
  ExplanationContext,
  ExplanationRequest,
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
