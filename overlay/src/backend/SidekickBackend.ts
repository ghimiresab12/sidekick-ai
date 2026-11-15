/**
 * The ONLY boundary between the overlay UI and the Sidekick backend.
 *
 * Every operation maps 1:1 to the engine/coordinator API in docs/engineering.md §3.1
 * and §3.2, expressed in shared contract types:
 *
 *   connect → subscribe(sessionId) : OverlayState (versioned)
 *   startSession / pause / resume / end / discard → coordinator lifecycle
 *   dismiss → engine.dismiss
 *   requestExplanation → engine.requestExplanation + backend text generation (GAP 1)
 *   reportVoiceStatus / cancelExplanation → engine voice callbacks (by request id)
 *   getTimeline → engine.getTimeline (+ timelineTruncated)
 *
 * Implementations: `inProcessBackend` (real coordinator in the page, synthetic input)
 * and, once the local bridge lands on main, an HTTP/SSE adapter. Components never
 * import an implementation; App.tsx chooses one.
 */
import type { EngineError, OverlayState } from '../contracts/shared';
import type { ExplanationScript, SessionTimeline } from '../contracts/pending';

/**
 * Transport health, separate from session status.
 * - connecting: no state received yet.
 * - connected: live updates flowing.
 * - reconnecting: updates interrupted; the last state shown may be out of date.
 * - unavailable: gave up (or the backend reported it cannot serve).
 */
export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'unavailable';

export interface BackendListener {
  onState(state: OverlayState): void;
  onConnection(status: ConnectionStatus, detail?: string): void;
}

/** Local playback outcomes the browser reports. `cancelled` goes through `cancelExplanation`. */
export type LocalVoiceStatus = 'playing_locally' | 'finished' | 'failed';

/** Present only on simulation backends: drives the synthetic input feed. */
export interface SimulationControls {
  advance(): Promise<void>;
  remaining(): number;
}

export interface BackendLabel {
  /** Short, always-visible honesty label (CLAUDE.md rule 10). */
  title: string;
  detail: string;
  /** True when inputs are synthetic: the consent screen must not claim live capture. */
  syntheticInput: boolean;
}

export interface SidekickBackend {
  readonly label: BackendLabel;
  /** Starts delivering state. Returns a disconnect function. Safe to call again after disconnect. */
  connect(listener: BackendListener): () => void;

  startSession(): Promise<void>;
  pauseSession(): Promise<void>;
  resumeSession(): Promise<void>;
  endSession(): Promise<void>;
  discardSession(): Promise<void>;

  dismiss(recommendationId: string): Promise<void>;

  requestExplanation(recommendationId: string): Promise<ExplanationScript>;
  reportVoiceStatus(requestId: string, status: LocalVoiceStatus): Promise<void>;
  cancelExplanation(requestId: string): Promise<void>;

  getTimeline(): Promise<SessionTimeline>;

  readonly simulation?: SimulationControls;
}

export type BackendErrorCode = EngineError | 'unavailable' | 'invalid_response' | 'reasoning_failed';

export class BackendError extends Error {
  readonly code: BackendErrorCode;
  constructor(code: BackendErrorCode, message?: string) {
    super(message ?? MESSAGES[code] ?? code);
    this.name = 'BackendError';
    this.code = code;
  }
}

/** User-facing wording for engine error codes. Unknown codes fall back to the code. */
const MESSAGES: Partial<Record<BackendErrorCode, string>> = {
  session_not_found: 'This session no longer exists.',
  consent_required: 'Start the session with consent first.',
  session_not_active: 'Sidekick is not observing right now.',
  invalid_transition: 'That action is not allowed in the current state.',
  recommendation_not_found: 'That recommendation no longer exists.',
  voice_busy: 'Another explanation is already playing.',
  voice_request_not_found: 'That explanation request has already ended.',
  unavailable: 'The Sidekick service is unavailable.',
  invalid_response: 'The Sidekick service sent an unexpected response.',
  reasoning_failed: 'Reasoning failed for this observation; no advice was created.',
};

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return 'Something went wrong. Please try again.';
}
