/**
 * Ports the coordinator depends on. These are structural interfaces only — the
 * coordinator never imports Prabin's reasoning/vision modules directly. The real
 * wiring (`tests/integration/reasoning-wiring.mts`, later the server entrypoint)
 * adapts them, and `npm run typecheck` verifies the real `reason()` is assignable.
 */
import type {
  CaptureGeneration,
  EngineError,
  EvidenceQuality,
  IsoTime,
  Observation,
  RecommendationCandidate,
  ScreenFacts,
  SessionSnapshot,
} from '../contracts/types.js';

// ── Reasoning (owned by Prabin: src/reasoning) ──────────────────────────────

/** What the coordinator hands to reasoning. Matches `ReasoningInput` in src/reasoning/contracts.mts. */
export interface ReasoningRequest {
  /** Engine snapshot (goals trimmed to active ones). */
  session: SessionSnapshot;
  /** Engine-ingested observations selected by `selectObservations`, oldest first. */
  observations: Observation[];
  /** Engine clock — the same clock the engine uses. Never a model-generated time. */
  now: IsoTime;
  staleAfterMs: number;
}

/** Context proposals the coordinator knows how to apply through engine APIs. */
export type ReasoningContextProposal = { sourceObservationIds: string[] } & (
  | { type: 'role_assignment'; participantId: string; role: string }
  | { type: 'group_goal'; text: string }
  | { type: 'activity_identification'; activity: 'gaming' }
  | { type: 'participant_decision'; text: string; participantIds: string[] }
);

export interface ReasoningOutput {
  sessionId: string;
  /** Revision of the snapshot the result was computed against. */
  basedOnContextRevision: number;
  captureGeneration: CaptureGeneration;
  contextUpdates: ReasoningContextProposal[];
  recommendationCandidates: RecommendationCandidate[];
  uncertainties: string[];
  withheld: Array<{ category: string; index: number; reason: string }>;
}

export type ReasoningResult = { ok: true; value: ReasoningOutput } | { ok: false; error: string };

/** One reasoning call. Must honour `signal` (abort on pause/end/discard). */
export type ReasoningFn = (request: ReasoningRequest, signal: AbortSignal) => Promise<ReasoningResult>;

// ── Vision (owned by Prabin; interface PROPOSED, not yet implemented) ───────

/** A sampled frame handed over by the capture adapter. Held in memory only, never stored. */
export interface FrameInput {
  /** Generation read when the frame was CAPTURED. Preserved through vision into the engine. */
  captureGeneration: CaptureGeneration;
  /** Source time of the frame. */
  observedAt: IsoTime;
  image: Uint8Array;
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
}

/** Structured description of one frame — becomes `ScreenInput` (minus generation/time). */
export interface ScreenDescription {
  summary: string;
  evidenceQuality: EvidenceQuality;
  facts?: ScreenFacts;
}

/**
 * Vision adapter. Errors MAY carry a string `code` property; the coordinator maps:
 *   `invalid_frame` → `invalid_input` (the image itself was rejected),
 *   `busy`          → `vision_busy`   (adapter-local concurrency limit, not provider rate limiting),
 *   `timeout`       → `vision_timeout` (the adapter's own deadline),
 *   anything else   → `vision_failed` (e.g. provider HTTP errors, including provider 429, or invalid output).
 * Cancellation always wins: if the caller/lifecycle signal aborted, the result is `aborted`
 * regardless of what the adapter threw.
 */
export interface VisionPort {
  describe(frame: FrameInput, signal: AbortSignal): Promise<ScreenDescription>;
}

// ── Coordinator results and diagnostics ─────────────────────────────────────

export type CoordinatorError =
  | EngineError
  | 'vision_unavailable'
  | 'vision_failed'
  | 'vision_busy'
  | 'vision_timeout'
  | 'aborted';

export type CoordinatorResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: CoordinatorError; detail?: string };

/**
 * Structured, content-free diagnostics (no transcript text, summaries or frames) for
 * logging and tests. `reason` / `outcome` values are codes, never model prose.
 */
export type CoordinatorDiagnostic =
  | { type: 'reasoning_skipped'; sessionId: string; reason: 'inactive' | 'no_observations' | 'selection_failed' }
  /** Future-stamped evidence excluded; a run is scheduled when the earliest becomes eligible. */
  | { type: 'reasoning_deferred'; sessionId: string; delayMs: number }
  | { type: 'reasoning_failed'; sessionId: string; error: string }
  | {
      type: 'reasoning_discarded';
      sessionId: string;
      reason:
        | 'aborted'
        | 'session_gone'
        | 'lifecycle_changed'
        | 'result_mismatch'
        | 'context_changed'
        | 'evidence_superseded';
    }
  | { type: 'context_applied'; sessionId: string; proposal: string; outcome: string }
  | { type: 'candidate_result'; sessionId: string; outcome: string; recommendationId?: string }
  | { type: 'candidates_withheld'; sessionId: string; reasons: string[] }
  | { type: 'rerun_budget_exhausted'; sessionId: string }
  /** `code` is the adapter's error code when it is one of the known values, else `unknown`. */
  | { type: 'vision_failed'; sessionId: string; aborted: boolean; code: 'invalid_frame' | 'busy' | 'timeout' | 'unknown' };
