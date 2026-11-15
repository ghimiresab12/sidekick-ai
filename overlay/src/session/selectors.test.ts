import { describe, expect, it } from 'vitest';
import type { OverlayState, RecommendationView } from '../contracts/shared';
import { allCards, countEarlierAdvice, selectHistory, selectMainCard } from './selectors';

const view = (id: string, status: RecommendationView['status']): RecommendationView => ({
  id,
  status,
  title: id,
  shortAdvice: '',
  urgency: 'normal',
  createdAt: '2026-11-14T18:00:00.000Z',
  lastConditionAt: '2026-11-14T18:00:00.000Z',
  evidence: [],
  relatedParticipants: [],
  contextChangedSinceCreation: false,
  canExplain: false,
});

const state = (prominent: RecommendationView | undefined, history: RecommendationView[]): OverlayState => ({
  sessionId: 's1',
  version: 1,
  status: 'active',
  activity: 'gaming',
  activityConfirmed: true,
  ...(prominent ? { prominent } : {}),
  history,
  voiceBusy: false,
});

describe('selectors over OverlayState', () => {
  it('uses the engine prominent card by default and keeps history order', () => {
    const s = state(view('a', 'active'), [view('b', 'stale'), view('c', 'dismissed')]);
    expect(selectMainCard(s, null)?.id).toBe('a');
    expect(selectHistory(s, 'a').map((c) => c.id)).toEqual(['b', 'c']);
  });

  it('never promotes stale advice on its own: no prominent → empty main slot', () => {
    const s = state(undefined, [view('b', 'stale')]);
    expect(selectMainCard(s, null)).toBeNull();
    expect(countEarlierAdvice(s)).toBe(1);
  });

  it('lets the user bring an OPEN history card to the front, but not a closed one', () => {
    const s = state(view('a', 'active'), [view('b', 'stale'), view('c', 'dismissed')]);
    expect(selectMainCard(s, 'b')?.id).toBe('b');
    expect(selectHistory(s, 'b').map((c) => c.id)).toEqual(['a', 'c']);
    expect(selectMainCard(s, 'c')?.id).toBe('a');
  });

  it('allCards lists prominent first', () => {
    expect(allCards(state(view('a', 'active'), [view('b', 'stale')])).map((c) => c.id)).toEqual(['a', 'b']);
    expect(allCards(null)).toEqual([]);
  });
});
