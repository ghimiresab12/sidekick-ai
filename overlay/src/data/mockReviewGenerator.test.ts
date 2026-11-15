import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import seedJson from './mock-session.json';
import { createMockDataSource } from './mockDataSource';
import { NOT_ENOUGH_EVIDENCE } from './mockReviewGenerator';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

async function endedSession(steps: number, beforeEnd?: (ds: ReturnType<typeof createMockDataSource>) => Promise<void>) {
  const ds = createMockDataSource(seedJson, { latencyMs: 0 });
  await ds.startSession();
  for (let i = 0; i < steps; i++) await ds.mock.advanceFeed();
  await beforeEnd?.(ds);
  await ds.endSession();
  return { ds, snapshot: await ds.getSnapshot(), review: await ds.generateReview() };
}

describe('mock review generator — grounded in recorded events', () => {
  it('every key moment cites an event that exists in this session', async () => {
    const { snapshot, review } = await endedSession(4, async (ds) => {
      await ds.requestVoiceExplanation('r2');
    });
    const ids = new Set(snapshot.events.map((e) => e.id));
    expect(review.keyMoments.length).toBeGreaterThan(0);
    for (const m of review.keyMoments) for (const id of m.eventIds) expect(ids.has(id)).toBe(true);
    expect(review.keyMoments.some((m) => m.whatHappened.includes('Voice explanation requested'))).toBe(true);
  });

  it('with no recommendations it says there is not enough evidence and lists no strengths', async () => {
    const { review } = await endedSession(0);
    expect(review.overview).toContain(NOT_ENOUGH_EVIDENCE);
    expect(review.limitations[0]).toBe(NOT_ENOUGH_EVIDENCE);
    expect(review.strengths).toEqual([]);
    expect(review.improvementAreas).toEqual([]);
    expect(review.nextActions).toEqual([]);
  });

  it('lists a strength only when a later observation resolved an issue', async () => {
    const before = await endedSession(3);
    expect(before.review.strengths).toEqual([]);
    expect(before.review.improvementAreas.some((s) => s.includes('Left defense appears exposed'))).toBe(true);

    const after = await endedSession(4);
    expect(after.review.strengths).toHaveLength(1);
    expect(after.review.strengths[0]).toContain('back inside the left defensive zone');
    expect(after.review.improvementAreas.some((s) => s.includes('Left defense'))).toBe(false);
  });

  it('notes that dismissal is not resolution', async () => {
    const { review } = await endedSession(2, (ds) => ds.dismissRecommendation('r1'));
    expect(review.limitations.join(' ')).toMatch(/does not mean the issue was resolved/);
  });

  it('contains no invented percentages or scores', async () => {
    const { review } = await endedSession(4);
    const text = JSON.stringify(review);
    expect(text).not.toMatch(/\d+\s?%/);
    expect(text).not.toMatch(/\bscore[ds]?\b|\brating\b|\bconfidence\b/i);
  });
});
