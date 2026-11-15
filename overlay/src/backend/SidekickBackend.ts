/**
 * The ONLY boundary between the overlay UI and the Sidekick backend.
 *
 * Two implementations, chosen in App.tsx (components never import one):
 *
 * - `httpBackend` (default): the Node bridge's browser API (docs/engineering.md
 *   "Integration milestone 4"). The bridge process owns the engine, coordinator and
 *   session state; the page is only a client. Pairing by one-time code, an HttpOnly
 *   cookie, a same-origin SSE stream of `OverlayState`, and JSON routes.
 * - `inProcessBackend` (explicit development mode): the real engine + coordinator +
 *   mock reasoning in the page, fed by a synthetic feed. Used by tests and offline demos.
 *
 * Both return the same browser-safe shapes: projected `OverlayState`, `ExplanationScript`
 * and `BrowserSessionTimeline` (shared contracts).
 */
import type { BrowserSessionTimeline, EngineError, ExplanationScript, OverlayState } from '../contracts/shared';

/**
 * Transport health, separate from session status.
 * - connecting: no state received yet.
 * - connected: live updates flowing.
 * - reconnecting: updates interrupted; the last state shown may be out of date.
 * - unavailable: gave up (or the backend reported it cannot serve, e.g. pairing expired).
 */
export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'unavailable';

export interface BackendListener {
  onState(state: OverlayState): void;
  onConnection(status: ConnectionStatus, detail?: string): void;
  /** The backend says the session no longer exists (discarded, possibly by someone else). */
  onDiscarded?(): void;
}

/** Local playback outcomes the browser reports. `cancelled` goes through `cancelExplanation`. */
export type LocalVoiceStatus = 'playing_locally' | 'finished' | 'failed';

/** Present only on simulation backends: drives the synthetic input feed. */
export interface SimulationControls {
  advance(): Promise<void>;
  remaining(): number;
}

/** A participant as a browser may see it (safe role labels only). */
export interface BrowserParticipant {
  id: string;
  displayName: string;
  role?: string;
}

/** Session setup a paired browser may do (bridge only): register names, confirm the activity. */
export interface SetupControls {
  listParticipants(): Promise<BrowserParticipant[]>;
  /** Resolves to the participant with the bridge's NORMALIZED display name. */
  addParticipant(displayName: string): Promise<BrowserParticipant>;
  confirmGaming(): Promise<void>;
}

export interface BackendCapabilities {
  /**
   * `local`: this page starts the session after its own consent checkbox (simulation).
   * `operator`: consent is operator-only (the operator attests all participants agreed);
   * the page must show "waiting for the operator" and never offer a consent button.
   */
  consent: 'local' | 'operator';
  /** Resume is operator-only on the bridge (a group decision, like consent). */
  resume: boolean;
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
  readonly capabilities: BackendCapabilities;
  /** Starts delivering state. Returns a disconnect function. Safe to call again after disconnect. */
  connect(listener: BackendListener): () => void;

  /** Only when `capabilities.consent === 'local'`. */
  startSession(): Promise<void>;
  pauseSession(): Promise<void>;
  /** Only when `capabilities.resume`. */
  resumeSession(): Promise<void>;
  endSession(): Promise<void>;
  discardSession(): Promise<void>;

  dismiss(recommendationId: string): Promise<void>;

  requestExplanation(recommendationId: string): Promise<ExplanationScript>;
  reportVoiceStatus(requestId: string, status: LocalVoiceStatus): Promise<void>;
  cancelExplanation(requestId: string): Promise<void>;

  getTimeline(): Promise<BrowserSessionTimeline>;

  readonly setup?: SetupControls;
  readonly simulation?: SimulationControls;
}

/** Error codes the bridge's browser API can return (engineering.md milestone 2 and 4 tables). */
export type BridgeErrorCode =
  | 'unauthorized'
  | 'invalid_pairing'
  | 'pairing_rate_limited'
  | 'forbidden'
  | 'forbidden_origin'
  | 'forbidden_host'
  | 'csrf_rejected'
  | 'not_request_owner'
  | 'not_found'
  | 'method_not_allowed'
  | 'invalid_input'
  | 'invalid_json'
  | 'unexpected_body'
  | 'payload_too_large'
  | 'unsupported_media_type'
  | 'too_many_streams'
  | 'invalid_participant_name'
  | 'duplicate_participant'
  | 'participant_limit_reached'
  | 'aborted';

export type BackendErrorCode =
  | EngineError
  | BridgeErrorCode
  | 'unavailable'
  | 'invalid_response'
  | 'reasoning_failed'
  | 'operator_only'
  | 'unknown_error';

export class BackendError extends Error {
  readonly code: BackendErrorCode;
  /** HTTP status, when the error came from the bridge. */
  readonly httpStatus?: number;
  constructor(code: BackendErrorCode, message?: string, httpStatus?: number) {
    super(message ?? MESSAGES[code] ?? code);
    this.name = 'BackendError';
    this.code = code;
    if (httpStatus !== undefined) this.httpStatus = httpStatus;
  }
}

export const REPAIR_MESSAGE = 'This device is not paired, or its pairing expired. Ask the operator for a new pairing link.';

/** User-facing wording for error codes. Unknown codes fall back to the code. */
const MESSAGES: Partial<Record<BackendErrorCode, string>> = {
  session_not_found: 'This session no longer exists.',
  consent_required: 'The session has not been started with consent yet.',
  session_not_active: 'Sidekick is not observing right now.',
  invalid_transition: 'That action is not allowed in the current state.',
  recommendation_not_found: 'That recommendation no longer exists.',
  voice_busy: 'Another explanation is already playing.',
  voice_request_not_found: 'That explanation has already ended.',
  unavailable: 'The Sidekick service is unavailable.',
  invalid_response: 'The Sidekick service sent an unexpected response.',
  reasoning_failed: 'Reasoning failed for this observation; no advice was created.',
  operator_only: 'Only the operator can do that.',
  unauthorized: REPAIR_MESSAGE,
  invalid_pairing: 'This pairing link is invalid, expired or already used. Ask the operator for a new pairing link.',
  pairing_rate_limited: 'Too many pairing attempts. Wait a minute, then ask the operator for a new link.',
  forbidden: 'This device is not allowed to do that.',
  csrf_rejected: 'The request was rejected by the Sidekick service.',
  not_request_owner: 'That explanation belongs to another device.',
  too_many_streams: 'Too many Sidekick windows are open for this session. Close one and try again.',
  invalid_participant_name: 'Enter a name with at least one visible letter, digit or symbol.',
  duplicate_participant: 'Someone with that name is already in the session.',
  participant_limit_reached: 'This session already has the maximum number of participants.',
  unknown_error: 'Something went wrong. Please try again.',
};

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return 'Something went wrong. Please try again.';
}
