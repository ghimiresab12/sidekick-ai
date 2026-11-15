/**
 * React hook: connects a SidekickBackend to the session reducer.
 *
 * - Connects once (and again on "Try again"), receiving versioned OverlayState.
 * - Exposes commands (start/pause/resume/end/discard/dismiss/review).
 * - Guards: one command at a time (no double-submits), only commands the lifecycle
 *   table allows, and no commands while the connection is not live, so the user
 *   never acts on a state that may already be out of date.
 */
import { useEffect, useReducer, useRef, useState } from 'react';
import { errorMessage, type SidekickBackend } from '../backend/SidekickBackend';
import { buildReview } from '../review/buildReview';
import { canRun, type SessionCommand } from './sessionMachine';
import { initialSessionUiState, sessionReducer, type PendingAction } from './sessionReducer';

export function useSidekickSession(backend: SidekickBackend) {
  const [state, dispatch] = useReducer(sessionReducer, initialSessionUiState);
  const [attempt, setAttempt] = useState(0);
  // A ref (not state) so two clicks in the same frame still see the lock.
  const pendingRef = useRef<PendingAction | null>(null);
  const overlayRef = useRef(state.overlay);
  overlayRef.current = state.overlay;

  useEffect(() => {
    let mounted = true;
    dispatch({ type: 'connection_changed', status: 'connecting' });
    let disconnect: () => void = () => {};
    try {
      disconnect = backend.connect({
        onState: (overlay) => mounted && dispatch({ type: 'state_received', state: overlay }),
        onConnection: (status, detail) => mounted && dispatch({ type: 'connection_changed', status, detail }),
      });
    } catch (e) {
      dispatch({ type: 'connection_changed', status: 'unavailable', detail: errorMessage(e) });
    }
    return () => {
      mounted = false;
      disconnect();
    };
  }, [backend, attempt]);

  async function run(action: PendingAction, work: () => Promise<void>): Promise<boolean> {
    if (pendingRef.current) return false;
    pendingRef.current = action;
    dispatch({ type: 'action_started', action });
    try {
      await work();
      dispatch({ type: 'action_succeeded' });
      return true;
    } catch (e) {
      dispatch({ type: 'action_failed', message: errorMessage(e) });
      return false;
    } finally {
      pendingRef.current = null;
    }
  }

  const status = state.overlay?.status;
  const live = state.connection === 'connected';
  const allowed = (command: SessionCommand) => live && !!status && !state.discarded && canRun(status, command);

  function command(cmd: SessionCommand, work: () => Promise<void>) {
    return allowed(cmd) ? run(cmd, work) : Promise.resolve(false);
  }

  return {
    state,
    live,
    allowed,
    isBusy: state.pending !== null,
    start: () => command('start', () => backend.startSession()),
    pause: () => command('pause', () => backend.pauseSession()),
    resume: () => command('resume', () => backend.resumeSession()),
    end: () => command('end', () => backend.endSession()),
    discard: async () => {
      const ok = await command('discard', () => backend.discardSession());
      if (ok) dispatch({ type: 'session_discarded' });
      return ok;
    },
    dismiss: (id: string) => (live ? run(`dismiss:${id}`, () => backend.dismiss(id)) : Promise.resolve(false)),
    select: (id: string | null) => dispatch({ type: 'recommendation_selected', id }),
    clearError: () => dispatch({ type: 'error_cleared' }),
    /** Surface an error from work outside the command lock (e.g. the synthetic feed). */
    showError: (message: string) => dispatch({ type: 'error_shown', message }),
    reconnect: () => setAttempt((n) => n + 1),
    generateReview: async () => {
      if (status !== 'ended' || state.review.status === 'loading') return;
      dispatch({ type: 'review_started' });
      try {
        const timeline = await backend.getTimeline();
        const inputNote = backend.label.syntheticInput
          ? 'Synthetic inputs: no live Chert screen share or transcripts were processed.'
          : undefined;
        const review = buildReview(timeline, overlayRef.current, { inputNote });
        dispatch({ type: 'review_succeeded', review, timeline });
      } catch (e) {
        dispatch({ type: 'review_failed', message: errorMessage(e) });
      }
    },
  };
}

export type SidekickSession = ReturnType<typeof useSidekickSession>;
