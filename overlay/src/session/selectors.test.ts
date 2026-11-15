import { describe, expect, it } from 'vitest';
import type { Session } from '../contracts/sidekick';
import type { RecommendationWithContext } from '../contracts/proposed';
import { selectEvidence, selectHistory, selectProminent, selectRelatedPlayers } from './selectors';

const rec = (id: string, over: Partial<RecommendationWithContext> = {}): RecommendationWithContext => ({
  id, sessionId: 's', createdAt: '2026-01-01T00:00:00.000Z', status: 'active', title: id, shortAdvice: '',
  evidenceObservationIds: ['o1'], urgency: 'normal', ...over,
});

describe('selectProminent — one prominent card', () => {
  it('prefers active over stale, important over normal, then newest', () => {
    const recs = [
      rec('oldNormal', { createdAt: '2026-01-01T00:00:01Z' }),
      rec('newNormal', { createdAt: '2026-01-01T00:00:05Z' }),
      rec('oldImportant', { createdAt: '2026-01-01T00:00:00Z', urgency: 'important' }),
      rec('staleImportant', { createdAt: '2026-01-01T00:00:09Z', urgency: 'important', status: 'stale' }),
    ];
    expect(selectProminent(recs, null)?.id).toBe('oldImportant');
    expect(selectProminent(recs.slice(0, 2), null)?.id).toBe('newNormal');
  });

  it('keeps stale cards visible when nothing is active (e.g. paused)', () => {
    expect(selectProminent([rec('a', { status: 'stale' })], null)?.id).toBe('a');
  });

  it('never shows dismissed or resolved cards prominently', () => {
    expect(selectProminent([rec('a', { status: 'dismissed' }), rec('b', { status: 'resolved' })], null)).toBeNull();
  });

  it('honours an open user selection, ignores a closed one', () => {
    const recs = [rec('a', { urgency: 'important' }), rec('b'), rec('c', { status: 'dismissed' })];
    expect(selectProminent(recs, 'b')?.id).toBe('b');
    expect(selectProminent(recs, 'c')?.id).toBe('a');
  });

  it('history excludes the prominent card', () => {
    expect(selectHistory([rec('a'), rec('b')], 'a').map((r) => r.id)).toEqual(['b']);
  });
});

describe('evidence and player context', () => {
  it('reports missing evidence instead of hiding it', () => {
    const items = selectEvidence(rec('a', { evidenceObservationIds: ['o1', 'gone'] }), [
      { id: 'o1', sessionId: 's', observedAt: '', source: 'screen', summary: 'x', evidenceQuality: 'clear' },
    ]);
    expect(items[0].observation?.summary).toBe('x');
    expect(items[1]).toEqual({ id: 'gone', observation: undefined });
  });

  it('resolves related players through session participants', () => {
    const session = { participants: { p1: { displayName: 'Alex', role: 'Left defense' } } } as unknown as Session;
    expect(selectRelatedPlayers(rec('a', { relatedParticipantIds: ['p1'] }), session)).toEqual([
      { id: 'p1', displayName: 'Alex', role: 'Left defense' },
    ]);
    expect(selectRelatedPlayers(rec('b'), session)).toEqual([]);
  });
});
