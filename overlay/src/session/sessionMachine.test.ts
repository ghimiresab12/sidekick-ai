import { describe, expect, it } from 'vitest';
import { canRun, nextState, type LifecycleState, type SessionCommand } from './sessionMachine';

const ALL: SessionCommand[] = ['start', 'pause', 'resume', 'end', 'discard'];

describe('session lifecycle transitions', () => {
  it.each<[LifecycleState, SessionCommand, LifecycleState]>([
    ['starting', 'start', 'active'],
    ['active', 'pause', 'paused'],
    ['paused', 'resume', 'active'],
    ['active', 'end', 'ended'],
    ['paused', 'end', 'ended'],
    ['ended', 'discard', 'discarded'],
  ])('%s --%s--> %s', (from, cmd, to) => {
    expect(canRun(from, cmd)).toBe(true);
    expect(nextState(from, cmd)).toBe(to);
  });

  it('ended sessions can never resume, pause or restart (no silent reactivation)', () => {
    for (const cmd of ['start', 'pause', 'resume', 'end'] as const) expect(canRun('ended', cmd)).toBe(false);
  });

  it('discarded is terminal', () => {
    for (const cmd of ALL) expect(canRun('discarded', cmd)).toBe(false);
  });

  it('cannot discard a live session without ending it first', () => {
    expect(canRun('active', 'discard')).toBe(false);
    expect(canRun('paused', 'discard')).toBe(false);
  });

  it('cannot resume an active session or pause a paused one', () => {
    expect(nextState('active', 'resume')).toBeNull();
    expect(nextState('paused', 'pause')).toBeNull();
  });
});
