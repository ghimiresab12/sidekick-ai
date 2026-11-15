import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import seedJson from './mock-session.json';
import { createMockDataSource, STALE_EXPLANATION_PREFIX } from './mockDataSource';
import { validateSeed } from './mockSeed';
import type { SessionSnapshot } from './SidekickDataSource';

const make = () => createMockDataSource(seedJson, { latencyMs: 0 });
const feedMs = (i: number) => (seedJson.feed[i] as { afterMs: number }).afterMs;

describe('mock seed', () => {
  it('the shipped mock-session.json is valid', () => {
    expect(() => validateSeed(seedJson)).not.toThrow();
  });

  it('rejects recommendations without evidence and resolutions without a new observation', () => {
    const bad = structuredClone(seedJson);
    bad.feed[1].recommendations![0].evidenceObservationIds = [];
    expect(() => validateSeed(bad)).toThrow(/must cite evidence/);
    const bad2 = structuredClone(seedJson);
    delete (bad2.feed[3] as { observations?: unknown }).observations;
    expect(() => validateSeed(bad2)).toThrow(/resolves without a new observation/);
  });

  it('an invalid seed surfaces as a load error, not a crash', async () => {
    const ds = createMockDataSource({ nope: true }, { latencyMs: 0 });
    await expect(ds.getSnapshot()).rejects.toThrow(/Mock data is invalid/);
  });
});

describe('mock data source', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('starts in "starting" with no cards and no events until consent', async () => {
    const s = await make().getSnapshot();
    expect(s.session.status).toBe('starting');
    expect(s.session.consentActive).toBe(false);
    expect(s.recommendations).toEqual([]);
    expect(s.events).toEqual([]);
  });

  it('plays the scripted feed only after start, stamping session id and times', async () => {
    const ds = make();
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await ds.getSnapshot()).observations).toHaveLength(0); // nothing before consent

    await ds.startSession();
    await vi.advanceTimersByTimeAsync(feedMs(0));
    let s = await ds.getSnapshot();
    expect(s.session.participants.p1.role).toBe('Left defense');
    expect(s.events.map((e) => e.type)).toContain('role_updated');

    await vi.advanceTimersByTimeAsync(feedMs(1));
    s = await ds.getSnapshot();
    expect(s.recommendations.map((r) => r.id)).toEqual(['r1']);
    expect(s.recommendations[0]).toMatchObject({ sessionId: 'mock-session-1', status: 'active' });
    expect(Date.parse(s.recommendations[0].createdAt)).not.toBeNaN();
  });

  it('pushes snapshots to subscribers', async () => {
    const ds = make();
    const seen: SessionSnapshot[] = [];
    ds.subscribe((s) => seen.push(s));
    await ds.startSession();
    expect(seen.at(-1)?.session.status).toBe('active');
  });

  it('rejects invalid transitions', async () => {
    const ds = make();
    await expect(ds.pauseSession()).rejects.toThrow(/Cannot pause/);
    await ds.startSession();
    await expect(ds.startSession()).rejects.toThrow(/Cannot start/);
    await expect(ds.resumeSession()).rejects.toThrow(/Cannot resume/);
    await expect(ds.discardSession()).rejects.toThrow(/Cannot discard/);
    await ds.endSession();
    await expect(ds.resumeSession()).rejects.toThrow(/Cannot resume a session that is ended/);
  });

  it('pause stops new advice and marks open cards stale; resume continues the feed', async () => {
    const ds = make();
    await ds.startSession();
    await ds.mock.advanceFeed();
    await ds.mock.advanceFeed(); // r1 shown
    await ds.pauseSession();
    let s = await ds.getSnapshot();
    expect(s.recommendations[0].status).toBe('stale');
    expect(s.events.map((e) => e.type)).toEqual(expect.arrayContaining(['recommendation_stale', 'session_paused']));

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect((await ds.getSnapshot()).recommendations).toHaveLength(1); // nothing new while paused
    expect(await ds.mock.advanceFeed()).toBe(false);

    await ds.resumeSession();
    await vi.advanceTimersByTimeAsync(feedMs(2));
    s = await ds.getSnapshot();
    expect(s.recommendations.map((r) => r.id)).toEqual(['r1', 'r2']);
  });

  it('end stops observation: no further feed steps play', async () => {
    const ds = make();
    await ds.startSession();
    await ds.endSession();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    const s = await ds.getSnapshot();
    expect(s.session.status).toBe('ended');
    expect(s.session.consentActive).toBe(false);
    expect(s.session.endedAt).toBeTruthy();
    expect(s.observations).toHaveLength(0);
  });

  it('dismiss keeps the card (status dismissed) and logs an event for review', async () => {
    const ds = make();
    await ds.startSession();
    await ds.mock.advanceFeed();
    await ds.mock.advanceFeed();
    await ds.dismissRecommendation('r1');
    const s = await ds.getSnapshot();
    expect(s.recommendations[0].status).toBe('dismissed');
    expect(s.events.at(-1)).toMatchObject({ type: 'recommendation_dismissed', recommendationId: 'r1' });
    await expect(ds.dismissRecommendation('r1')).rejects.toThrow(/Cannot dismiss a dismissed/);
    await expect(ds.dismissRecommendation('nope')).rejects.toThrow(/does not exist/);
  });

  it('later observation resolves a card, citing that observation', async () => {
    const ds = make();
    await ds.startSession();
    for (let i = 0; i < 4; i++) await ds.mock.advanceFeed();
    const s = await ds.getSnapshot();
    expect(s.recommendations.find((r) => r.id === 'r1')?.status).toBe('resolved');
    expect(s.events.find((e) => e.type === 'recommendation_resolved')?.observationIds).toEqual(['o5']);
    expect(ds.mock.remainingFeedSteps()).toBe(0);
  });

  describe('voice explanation requests', () => {
    it('returns grounded text scoped to the recommendation and logs voice_requested', async () => {
      const ds = make();
      await ds.startSession();
      await ds.mock.advanceFeed();
      await ds.mock.advanceFeed();
      const exp = await ds.requestVoiceExplanation('r1');
      expect(exp.recommendationId).toBe('r1');
      expect(exp.refersToEarlierObservation).toBe(false);
      expect(exp.evidenceObservationIds).toEqual(['o1', 'o3']);
      const s = await ds.getSnapshot();
      expect(s.events.at(-1)?.type).toBe('voice_requested');
      expect(s.recommendations[0].voiceDeliveryStatus).toBe('pending');
    });

    it('rejects unknown ids and requests outside an active session', async () => {
      const ds = make();
      await expect(ds.requestVoiceExplanation('r1')).rejects.toThrow(/active session/);
      await ds.startSession();
      await expect(ds.requestVoiceExplanation('ghost')).rejects.toThrow(/does not exist/);
      await ds.mock.advanceFeed();
      await ds.mock.advanceFeed();
      await ds.pauseSession();
      await expect(ds.requestVoiceExplanation('r1')).rejects.toThrow(/active session/);
    });

    it('prefixes stale cards so they are not read as a live alert', async () => {
      const ds = make();
      await ds.startSession();
      await ds.mock.advanceFeed();
      await ds.mock.advanceFeed();
      await ds.pauseSession();
      await ds.resumeSession(); // r1 stays stale after resume
      const exp = await ds.requestVoiceExplanation('r1');
      expect(exp.refersToEarlierObservation).toBe(true);
      expect(exp.text.startsWith(STALE_EXPLANATION_PREFIX)).toBe(true);
    });

    it('records playback reports as events', async () => {
      const ds = make();
      await ds.startSession();
      await ds.mock.advanceFeed();
      await ds.mock.advanceFeed();
      ds.reportVoicePlayback('r1', 'playing');
      ds.reportVoicePlayback('r1', 'cancelled');
      ds.reportVoicePlayback('r1', 'failed');
      ds.reportVoicePlayback('r1', 'finished');
      const types = (await ds.getSnapshot()).events.map((e) => e.type);
      expect(types.slice(-3)).toEqual(['voice_cancelled', 'voice_failed', 'voice_finished']);
    });
  });

  it('review only after end; discard deletes everything and blocks further calls', async () => {
    const ds = make();
    await ds.startSession();
    await expect(ds.generateReview()).rejects.toThrow(/End the session/);
    await ds.endSession();
    const review = await ds.generateReview();
    expect(review.sessionId).toBe('mock-session-1');
    await ds.discardSession();
    await expect(ds.getSnapshot()).rejects.toThrow(/discarded/);
    await expect(ds.generateReview()).rejects.toThrow(/discarded/);
    expect(() => ds.reportVoicePlayback('r1', 'finished')).not.toThrow();
  });
});
