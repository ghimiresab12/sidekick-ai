/**
 * Session lifecycle rules (docs/engineering.md §4, docs/design.md §7) as a
 * transition table, used by the UI to disable buttons. It mirrors the engine,
 * which remains the authority and rejects anything illegal itself. The UI is
 * stricter in one place: discard is offered only after End (design.md §7).
 *
 *   starting --start--> active <--pause/resume--> paused
 *   active | paused --end--> ended --discard--> discarded
 *
 * 'discarded' is a UI/lifecycle terminal state, not a SessionStatus: once
 * discarded, the session's data no longer exists. Nothing leaves 'ended'
 * except discard, so an ended session can never silently resume.
 */
import type { SessionStatus } from '../contracts/shared';

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
