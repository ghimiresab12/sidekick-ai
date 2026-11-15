import { describe, expect, it } from 'vitest';
import type { OverlayState, RecommendationView } from '../contracts/shared';
import { initialSessionUiState, isNewer, sessionReducer, type SessionUiState } from './sessionReducer';

const card = (status: RecommendationView['status'] = 'active'): RecommendationView => ({
  id: 'r1',
  status,
  title: 'Left defense appears exposed',
  shortAdvice: 'Cover left.',
  urgency: 'normal',
  createdAt: '2026-11-14T18:00:01.000Z',
  lastConditionAt: '2026-11-14T18:00:01.000Z',
  evidence: [],
  relatedParticipants: [],
  contextChangedSinceCreation: false,
  canExplain: status === 'active',
});

function overlay(version: number, status: RecommendationView['status'] = 'active', sessionId = 's1'): OverlayState {
  const c = card(status);
  return {
    sessionId,
    version,
    status: 'active',
    activity: 'gaming',
    activityConfirmed: true,
    ...(status === 'active' ? { prominent: c } : {}),
    history: status === 'active' ? [] : [c],
    voiceBusy: false,
  };
}

describe('sessionReducer', () => {
  it('stores the first OverlayState', () => {
    const s = sessionReducer(initialSessionUiState, { type: 'state_received', state: overlay(1) });
    expect(s.overlay?.version).toBe(1);
  });

  it('drops duplicate and out-of-order snapshots (version must increase)', () => {
    let s = sessionReducer(initialSessionUiState, { type: 'state_received', state: overlay(5) });
    const same = sessionReducer(s, { type: 'state_received', state: overlay(5, 'stale') });
    expect(same).toBe(s);
    const older = sessionReducer(s, { type: 'state_received', state: overlay(3, 'stale') });
    expect(older).toBe(s);
    s = sessionReducer(s, { type: 'state_received', state: overlay(6, 'stale') });
    expect(s.overlay?.version).toBe(6);
  });

  it('accepts a lower version from a DIFFERENT session (new session after restart)', () => {
    expect(isNewer(overlay(9), overlay(1, 'active', 's2'))).toBe(true);
  });

  it('tracks connection health separately from session state', () => {
    let s = sessionReducer(initialSessionUiState, { type: 'state_received', state: overlay(1) });
    s = sessionReducer(s, { type: 'connection_changed', status: 'reconnecting' });
    expect(s.connection).toBe('reconnecting');
    expect(s.overlay?.version).toBe(1); // last known state kept, UI marks it not live
    s = sessionReducer(s, { type: 'connection_changed', status: 'unavailable', detail: 'down' });
    expect(s).toMatchObject({ connection: 'unavailable', connectionDetail: 'down' });
  });

  it('tracks a pending command and its failure message; error_shown keeps the command', () => {
    let s = sessionReducer(initialSessionUiState, { type: 'action_started', action: 'pause' });
    expect(s.pending).toBe('pause');
    const shown = sessionReducer(s, { type: 'error_shown', message: 'feed failed' });
    expect(shown).toMatchObject({ pending: 'pause', actionError: 'feed failed' });
    s = sessionReducer(s, { type: 'action_failed', message: 'nope' });
    expect(s.pending).toBeNull();
    expect(s.actionError).toBe('nope');
    expect(sessionReducer(s, { type: 'error_cleared' }).actionError).toBeNull();
  });

  it('drops a selection once the selected card is no longer open', () => {
    let s: SessionUiState = sessionReducer(initialSessionUiState, { type: 'state_received', state: overlay(1) });
    s = sessionReducer(s, { type: 'recommendation_selected', id: 'r1' });
    s = sessionReducer(s, { type: 'state_received', state: overlay(2, 'stale') });
    expect(s.selectedRecommendationId).toBe('r1'); // stale is still open
    s = sessionReducer(s, { type: 'state_received', state: overlay(3, 'dismissed') });
    expect(s.selectedRecommendationId).toBeNull();
  });

  it('discard clears all session data and ignores late snapshots', () => {
    let s = sessionReducer(initialSessionUiState, { type: 'state_received', state: overlay(1) });
    s = sessionReducer(s, {
      type: 'review_succeeded',
      timeline: { events: [], truncated: false },
      review: {
        sessionId: 's1', generatedAt: '', activity: 'gaming', overview: '', keyMoments: [], strengths: [],
        improvementAreas: [], nextActions: [], limitations: [],
      },
    });
    s = sessionReducer(s, { type: 'session_discarded' });
    expect(s.discarded).toBe(true);
    expect(s.overlay).toBeNull();
    expect(s.review.status).toBe('idle');
    expect(sessionReducer(s, { type: 'state_received', state: overlay(99) })).toBe(s);
  });
});
