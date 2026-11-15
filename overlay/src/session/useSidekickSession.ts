/**
 * React hook: connects a SidekickDataSource to the session reducer.
 *
 * - Loads the first snapshot and subscribes to pushed updates.
 * - Exposes commands (start/pause/resume/end/discard/dismiss/review).
 * - Guards: one command at a time (no double-submits) and only commands the
 *   lifecycle table allows from the current status.
 */
import { useEffect, useReducer, useRef, useState } from 'react';
import { errorMessage, type SidekickDataSource } from '../data/SidekickDataSource';
import { canRun, type SessionCommand } from './sessionMachine';
import { initialSessionUiState, sessionReducer, type PendingAction } from './sessionReducer';

export function useSidekickSession(dataSource: SidekickDataSource) {
  const [state, dispatch] = useReducer(sessionReducer, initialSessionUiState);
  const [loadAttempt, setLoadAttempt] = useState(0);
  // A ref (not state) so two clicks in the same frame still see the lock.
  const pendingRef = useRef<PendingAction | null>(null);

  useEffect(() => {
    let mounted = true;
    dispatch({ type: 'load_started' });
    const unsubscribe = dataSource.subscribe((snapshot) => {
      if (mounted) dispatch({ type: 'snapshot_received', snapshot });
    });
    dataSource
      .getSnapshot()
      .then((snapshot) => mounted && dispatch({ type: 'snapshot_received', snapshot }))
      .catch((e) => mounted && dispatch({ type: 'load_failed', message: errorMessage(e) }));
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [dataSource, loadAttempt]);

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

  const status = state.snapshot?.session.status;
  const allowed = (command: SessionCommand) => !!status && !state.discarded && canRun(status, command);

  function command(cmd: SessionCommand, work: () => Promise<void>) {
    return allowed(cmd) ? run(cmd, work) : Promise.resolve(false);
  }

  return {
    state,
    allowed,
    isBusy: state.pending !== null,
    start: () => command('start', () => dataSource.startSession()),
    pause: () => command('pause', () => dataSource.pauseSession()),
    resume: () => command('resume', () => dataSource.resumeSession()),
    end: () => command('end', () => dataSource.endSession()),
    discard: async () => {
      const ok = await command('discard', () => dataSource.discardSession());
      if (ok) dispatch({ type: 'session_discarded' });
      return ok;
    },
    dismiss: (id: string) => run(`dismiss:${id}`, () => dataSource.dismissRecommendation(id)),
    select: (id: string | null) => dispatch({ type: 'recommendation_selected', id }),
    clearError: () => dispatch({ type: 'error_cleared' }),
    retryLoad: () => setLoadAttempt((n) => n + 1),
    generateReview: async () => {
      if (status !== 'ended' || state.review.status === 'loading') return;
      dispatch({ type: 'review_started' });
      try {
        dispatch({ type: 'review_succeeded', review: await dataSource.generateReview() });
      } catch (e) {
        dispatch({ type: 'review_failed', message: errorMessage(e) });
      }
    },
  };
}

export type SidekickSession = ReturnType<typeof useSidekickSession>;
