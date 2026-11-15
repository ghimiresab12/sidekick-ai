import { describe, expect, it } from 'vitest';
import type { SessionSnapshot } from '../data/SidekickDataSource';
import { initialSessionUiState, sessionReducer, type SessionUiState } from './sessionReducer';

function snap(recStatus: 'active' | 'stale' | 'dismissed' = 'active'): SessionSnapshot {
  return {
    session: {
      id: 's1', status: 'active', consentActive: true, activity: 'gaming', activityConfirmed: true,
      startedAt: '2026-01-01T00:00:00.000Z', participants: {}, goals: [], latestObservationIds: [], recommendationIds: ['r1'],
    },
    recommendations: [{
      id: 'r1', sessionId: 's1', createdAt: '2026-01-01T00:00:01.000Z', status: recStatus, title: 't',
      shortAdvice: 'a', evidenceObservationIds: ['o1'], urgency: 'normal',
    }],
    observations: [],
    events: [],
  };
}

describe('sessionReducer', () => {
  it('stores snapshots and marks loading ready', () => {
    const s = sessionReducer(initialSessionUiState, { type: 'snapshot_received', snapshot: snap() });
    expect(s.loadStatus).toBe('ready');
    expect(s.snapshot?.session.id).toBe('s1');
  });

  it('tracks a pending command and its failure message', () => {
    let s = sessionReducer(initialSessionUiState, { type: 'action_started', action: 'pause' });
    expect(s.pending).toBe('pause');
    s = sessionReducer(s, { type: 'action_failed', message: 'nope' });
    expect(s.pending).toBeNull();
    expect(s.actionError).toBe('nope');
    expect(sessionReducer(s, { type: 'error_cleared' }).actionError).toBeNull();
  });

  it('drops a selection once the selected card is no longer open', () => {
    let s: SessionUiState = sessionReducer(initialSessionUiState, { type: 'snapshot_received', snapshot: snap() });
    s = sessionReducer(s, { type: 'recommendation_selected', id: 'r1' });
    expect(s.selectedRecommendationId).toBe('r1');
    s = sessionReducer(s, { type: 'snapshot_received', snapshot: snap('stale') });
    expect(s.selectedRecommendationId).toBe('r1'); // stale is still open
    s = sessionReducer(s, { type: 'snapshot_received', snapshot: snap('dismissed') });
    expect(s.selectedRecommendationId).toBeNull();
  });

  it('discard clears all session data and ignores late snapshots', () => {
    let s = sessionReducer(initialSessionUiState, { type: 'snapshot_received', snapshot: snap() });
    s = sessionReducer(s, { type: 'review_succeeded', review: {
      sessionId: 's1', generatedAt: '', activity: 'gaming', overview: '', keyMoments: [], strengths: [],
      improvementAreas: [], nextActions: [], limitations: [],
    } });
    s = sessionReducer(s, { type: 'session_discarded' });
    expect(s.discarded).toBe(true);
    expect(s.snapshot).toBeNull();
    expect(s.review.status).toBe('idle');
    const after = sessionReducer(s, { type: 'snapshot_received', snapshot: snap() });
    expect(after).toBe(s);
  });
});
