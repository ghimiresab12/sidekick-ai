/**
 * UI state for one session, updated only through this pure reducer.
 *
 * The backend owns the truth and pushes `OverlayState` snapshots. This reducer adds
 * UI concerns on top: connection health, which command is in flight, errors, the
 * review request, and which card the user selected.
 *
 * Duplicate/out-of-order protection: `OverlayState.version` is monotonic per session
 * (engineering.md §3). A snapshot whose version is not greater than the one applied
 * is dropped, so a replayed or reordered message can never roll the UI back.
 */
import type { SessionReview } from '../contracts/pending';
import type { BrowserSessionTimeline as SessionTimeline } from '../contracts/shared';
import type { OverlayState } from '../contracts/shared';
import type { ConnectionStatus } from '../backend/SidekickBackend';
import { allCards } from './selectors';
import type { SessionCommand } from './sessionMachine';

export type PendingAction = SessionCommand | `dismiss:${string}`;

export type ReviewState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; data: SessionReview; timeline: SessionTimeline }
  | { status: 'error'; message: string };

export interface SessionUiState {
  connection: ConnectionStatus;
  connectionDetail: string | null;
  overlay: OverlayState | null;
  /** Terminal: data was deleted. Only an explicit "start new session" leaves it. */
  discarded: boolean;
  pending: PendingAction | null;
  actionError: string | null;
  review: ReviewState;
  selectedRecommendationId: string | null;
}

export type SessionUiAction =
  | { type: 'connection_changed'; status: ConnectionStatus; detail?: string }
  | { type: 'state_received'; state: OverlayState }
  | { type: 'action_started'; action: PendingAction }
  | { type: 'action_succeeded' }
  | { type: 'action_failed'; message: string }
  | { type: 'error_cleared' }
  | { type: 'error_shown'; message: string }
  | { type: 'review_started' }
  | { type: 'review_succeeded'; review: SessionReview; timeline: SessionTimeline }
  | { type: 'review_failed'; message: string }
  | { type: 'recommendation_selected'; id: string | null }
  | { type: 'session_discarded' };

export const initialSessionUiState: SessionUiState = {
  connection: 'connecting',
  connectionDetail: null,
  overlay: null,
  discarded: false,
  pending: null,
  actionError: null,
  review: { status: 'idle' },
  selectedRecommendationId: null,
};

/** True when the snapshot should replace the current one. */
export function isNewer(current: OverlayState | null, next: OverlayState): boolean {
  if (!current || current.sessionId !== next.sessionId) return true;
  return next.version > current.version;
}

export function sessionReducer(state: SessionUiState, action: SessionUiAction): SessionUiState {
  // Once discarded, ignore anything late-arriving (e.g. an in-flight snapshot).
  if (state.discarded && action.type !== 'session_discarded') return state;

  switch (action.type) {
    case 'connection_changed':
      return { ...state, connection: action.status, connectionDetail: action.detail ?? null };
    case 'state_received': {
      if (!isNewer(state.overlay, action.state)) return state;
      // Keep a selection only while it still points at an open card.
      const sel = state.selectedRecommendationId;
      const stillOpen = sel
        ? allCards(action.state).some((c) => c.id === sel && (c.status === 'active' || c.status === 'stale'))
        : false;
      return { ...state, overlay: action.state, selectedRecommendationId: stillOpen ? sel : null };
    }
    case 'action_started':
      return { ...state, pending: action.action, actionError: null };
    case 'action_succeeded':
      return { ...state, pending: null };
    case 'action_failed':
      return { ...state, pending: null, actionError: action.message };
    case 'error_cleared':
      return { ...state, actionError: null };
    case 'error_shown':
      return { ...state, actionError: action.message };
    case 'review_started':
      return { ...state, review: { status: 'loading' } };
    case 'review_succeeded':
      return { ...state, review: { status: 'ready', data: action.review, timeline: action.timeline } };
    case 'review_failed':
      return { ...state, review: { status: 'error', message: action.message } };
    case 'recommendation_selected':
      return { ...state, selectedRecommendationId: action.id };
    case 'session_discarded':
      return { ...initialSessionUiState, connection: 'unavailable', discarded: true };
  }
}
