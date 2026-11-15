/**
 * UI state for one session, updated only through this pure reducer.
 *
 * The data source owns the *truth* (session status, cards, events) and pushes
 * snapshots; this reducer adds UI concerns on top: loading/errors, which
 * command is in flight, the review request, and which card the user selected.
 */
import type { SessionReview } from '../contracts/sidekick';
import type { SessionSnapshot } from '../data/SidekickDataSource';
import type { SessionCommand } from './sessionMachine';

export type PendingAction = SessionCommand | `dismiss:${string}`;

export type ReviewState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; data: SessionReview }
  | { status: 'error'; message: string };

export interface SessionUiState {
  loadStatus: 'loading' | 'ready' | 'error';
  loadError: string | null;
  snapshot: SessionSnapshot | null;
  /** Terminal: data was deleted. Only an explicit "start new session" leaves it. */
  discarded: boolean;
  pending: PendingAction | null;
  actionError: string | null;
  review: ReviewState;
  selectedRecommendationId: string | null;
}

export type SessionUiAction =
  | { type: 'load_started' }
  | { type: 'load_failed'; message: string }
  | { type: 'snapshot_received'; snapshot: SessionSnapshot }
  | { type: 'action_started'; action: PendingAction }
  | { type: 'action_succeeded' }
  | { type: 'action_failed'; message: string }
  | { type: 'error_cleared' }
  | { type: 'review_started' }
  | { type: 'review_succeeded'; review: SessionReview }
  | { type: 'review_failed'; message: string }
  | { type: 'recommendation_selected'; id: string | null }
  | { type: 'session_discarded' };

export const initialSessionUiState: SessionUiState = {
  loadStatus: 'loading',
  loadError: null,
  snapshot: null,
  discarded: false,
  pending: null,
  actionError: null,
  review: { status: 'idle' },
  selectedRecommendationId: null,
};

export function sessionReducer(state: SessionUiState, action: SessionUiAction): SessionUiState {
  // Once discarded, ignore anything late-arriving (e.g. an in-flight snapshot).
  if (state.discarded && action.type !== 'session_discarded') return state;

  switch (action.type) {
    case 'load_started':
      return { ...state, loadStatus: 'loading', loadError: null };
    case 'load_failed':
      return { ...state, loadStatus: 'error', loadError: action.message };
    case 'snapshot_received': {
      // Drop a selection that no longer points at an open card.
      const sel = state.selectedRecommendationId;
      const stillOpen = sel
        ? action.snapshot.recommendations.some((r) => r.id === sel && (r.status === 'active' || r.status === 'stale'))
        : false;
      return {
        ...state,
        loadStatus: 'ready',
        loadError: null,
        snapshot: action.snapshot,
        selectedRecommendationId: stillOpen ? sel : null,
      };
    }
    case 'action_started':
      return { ...state, pending: action.action, actionError: null };
    case 'action_succeeded':
      return { ...state, pending: null };
    case 'action_failed':
      return { ...state, pending: null, actionError: action.message };
    case 'error_cleared':
      return { ...state, actionError: null };
    case 'review_started':
      return { ...state, review: { status: 'loading' } };
    case 'review_succeeded':
      return { ...state, review: { status: 'ready', data: action.review } };
    case 'review_failed':
      return { ...state, review: { status: 'error', message: action.message } };
    case 'recommendation_selected':
      return { ...state, selectedRecommendationId: action.id };
    case 'session_discarded':
      return { ...initialSessionUiState, loadStatus: 'ready', discarded: true };
  }
}
