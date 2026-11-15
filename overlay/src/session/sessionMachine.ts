/**
 * Session lifecycle rules (docs/engineering.md §4, docs/design.md §7) as a
 * transition table. Shared by the mock backend (rejects illegal commands) and
 * the UI (disables buttons), so both always agree.
 *
 *   starting --start--> active <--pause/resume--> paused
 *   active | paused --end--> ended --discard--> discarded
 *
 * 'discarded' is a UI/lifecycle terminal state, not a SessionStatus: once
 * discarded, the session's data no longer exists. Nothing leaves 'ended'
 * except discard, so an ended session can never silently resume.
 */
import type { SessionStatus } from '../contracts/sidekick';

export type SessionCommand = 'start' | 'pause' | 'resume' | 'end' | 'discard';
export type LifecycleState = SessionStatus | 'discarded';

const TRANSITIONS: Record<LifecycleState, Partial<Record<SessionCommand, LifecycleState>>> = {
  starting: { start: 'active' },
  active: { pause: 'paused', end: 'ended' },
  paused: { resume: 'active', end: 'ended' },
  ended: { discard: 'discarded' },
  discarded: {},
};

export function canRun(state: LifecycleState, command: SessionCommand): boolean {
  return TRANSITIONS[state][command] !== undefined;
}

/** Returns the next state, or null if the command is not allowed. */
export function nextState(state: LifecycleState, command: SessionCommand): LifecycleState | null {
  return TRANSITIONS[state][command] ?? null;
}
