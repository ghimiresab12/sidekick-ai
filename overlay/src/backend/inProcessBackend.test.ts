/**
 * END-TO-END through the REAL session engine, SidekickCoordinator and reasoning
 * module (mock provider), via the overlay's SidekickBackend port. Nothing here is
 * a hand-written fake of backend behaviour.
 */
import { describe, expect, it } from 'vitest';
import type { ReasoningFn } from '../../../src/coordinator/ports';
import { reason } from '../../../src/reasoning/reason.mts';
import { createMockProvider } from '../../../src/adapters/model/mock.mts';
import type { OverlayState } from '../contracts/shared';
import { buildReview, NOT_ENOUGH_EVIDENCE } from '../review/buildReview';
import { createInProcessBackend, type InProcessOptions } from './inProcessBackend';
import { BackendError, type ConnectionStatus } from './SidekickBackend';

function connect(options: InProcessOptions = {}) {
  const backend = createInProcessBackend(options);
  const states: OverlayState[] = [];
  const connection: ConnectionStatus[] = [];
  const disconnect = backend.connect({
    onState: (s) => states.push(s),
    onConnection: (c) => connection.push(c),
  });
  return { backend, states, connection, disconnect, last: () => states.at(-1)! };
}

/** Real reasoning, held at a gate so a lifecycle change can happen mid-call. */
function gatedReasoning() {
  const provider = createMockProvider();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const reasoning: ReasoningFn = async (request, signal) => {
    // Let transcript-only runs (role, and the coordinator's rerun) through; hold the screen frame.
    if (request.observations.some((o) => o.source === 'screen')) await gate;
    return reason(request, provider, { signal });
  };
  return { reasoning, release: () => release() };
}

async function startWithCard(options: InProcessOptions = {}) {
  const ctx = connect(options);
  await ctx.backend.startSession();
  await ctx.backend.simulation!.advance(); // transcript: Alex → left defense
  await ctx.backend.simulation!.advance(); // screen: left zone uncovered
  return ctx;
}

describe('in-process backend (real engine + coordinator + reasoning)', () => {
  it('connects and delivers the initial OverlayState (starting, gaming confirmed)', () => {
    const { connection, last } = connect();
    expect(connection).toEqual(['connected']);
    expect(last()).toMatchObject({ status: 'starting', activity: 'gaming', activityConfirmed: true, history: [] });
  });

  it('versions strictly increase across updates', async () => {
    const { states } = await startWithCard();
    const versions = states.map((s) => s.version);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
    expect(new Set(versions).size).toBe(versions.length);
  });

  it('start → synthetic feed → a real recommendation with evidence and player context', async () => {
    const { last } = await startWithCard();
    const card = last().prominent!;
    expect(card).toMatchObject({ title: 'Left defense appears exposed', status: 'active', canExplain: true });
    expect(card.relatedParticipants).toEqual([expect.objectContaining({ displayName: 'Alex', role: 'left defense' })]);
    expect(card.evidence.map((e) => [e.kind, e.source])).toEqual([
      ['condition', 'screen'],
      ['context', 'transcript'],
    ]);
    // OverlayState carries provenance only, never observation text.
    expect(JSON.stringify(last())).not.toContain('uncovered.');
    expect(JSON.stringify(last())).not.toContain('responsible for');
  });

  it('refuses the feed and voice before Start (engine lifecycle rules apply)', async () => {
    const { backend } = connect();
    await expect(backend.simulation!.advance()).rejects.toMatchObject({ code: 'session_not_active' });
    await expect(backend.requestExplanation('nope')).rejects.toBeInstanceOf(BackendError);
  });

  it('dismiss moves the card to history as dismissed', async () => {
    const { backend, last } = await startWithCard();
    const id = last().prominent!.id;
    await backend.dismiss(id);
    expect(last().prominent).toBeUndefined();
    expect(last().history[0]).toMatchObject({ id, status: 'dismissed', canExplain: false });
  });

  it('pause makes the card stale (history, not prominent); resume keeps it stale until new evidence', async () => {
    const { backend, last } = await startWithCard();
    await backend.pauseSession();
    expect(last().status).toBe('paused');
    expect(last().prominent).toBeUndefined();
    expect(last().history[0]).toMatchObject({ status: 'stale', staleReason: 'session_paused', canExplain: false });
    await backend.resumeSession();
    expect(last().status).toBe('active');
    expect(last().history[0].status).toBe('stale');
  });

  it('explain → grounded script → playing_locally → finished, reflected in OverlayState', async () => {
    const { backend, last } = await startWithCard();
    const id = last().prominent!.id;
    const script = await backend.requestExplanation(id);
    expect(script.request).toMatchObject({ recommendationId: id, status: 'pending' });
    expect(script.text).toContain('assigned Alex to left defense');
    expect(script.text).toContain('left defensive zone appears uncovered');
    expect(script.text).toContain('Ask Alex to cover left defense');
    expect(script.text).not.toContain('responsible for'); // transcript never quoted
    expect(last().activeVoiceRequest).toMatchObject({ requestId: script.request.id, status: 'pending' });

    await backend.reportVoiceStatus(script.request.id, 'playing_locally');
    expect(last().activeVoiceRequest?.status).toBe('playing_locally');
    await backend.reportVoiceStatus(script.request.id, 'finished');
    expect(last().activeVoiceRequest).toBeUndefined();
    expect(last().prominent!.voice).toMatchObject({ status: 'finished' });
  });

  it('user Stop is recorded as cancelled (reason user), not failed', async () => {
    const { backend, last } = await startWithCard();
    const id = last().prominent!.id;
    const script = await backend.requestExplanation(id);
    await backend.reportVoiceStatus(script.request.id, 'playing_locally');
    await backend.cancelExplanation(script.request.id);
    expect(last().prominent!.voice).toMatchObject({ status: 'cancelled' });
    const { events } = await backend.getTimeline();
    expect(events.at(-1)).toMatchObject({ type: 'voice_finished', outcome: 'cancelled', cancelReason: 'user' });
  });

  it('pause during playback: the ENGINE cancels with session_paused and drops activeVoiceRequest', async () => {
    const { backend, last } = await startWithCard();
    const script = await backend.requestExplanation(last().prominent!.id);
    await backend.reportVoiceStatus(script.request.id, 'playing_locally');
    await backend.pauseSession();
    expect(last().activeVoiceRequest).toBeUndefined();
    const { events } = await backend.getTimeline();
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'voice_finished', outcome: 'cancelled', cancelReason: 'session_paused' }),
    );
    await expect(backend.reportVoiceStatus(script.request.id, 'finished')).rejects.toBeInstanceOf(BackendError);
  });

  it('LATE reasoning after PAUSE is discarded: no card appears', async () => {
    const gated = gatedReasoning();
    const { backend, last } = connect({ reasoning: gated.reasoning });
    await backend.startSession();
    await backend.simulation!.advance(); // role applied
    const pending = backend.simulation!.advance(); // screen: reasoning held at the gate
    await new Promise((r) => setTimeout(r, 0));
    await backend.pauseSession(); // coordinator aborts the in-flight run
    gated.release();
    await pending.catch(() => {});
    expect(last().status).toBe('paused');
    expect(last().prominent).toBeUndefined();
    expect(last().history).toEqual([]);
  });

  it('LATE reasoning after END is discarded: no card appears and the review says not enough evidence', async () => {
    const gated = gatedReasoning();
    const { backend, last } = connect({ reasoning: gated.reasoning });
    await backend.startSession();
    await backend.simulation!.advance();
    const pending = backend.simulation!.advance();
    await new Promise((r) => setTimeout(r, 0));
    await backend.endSession();
    gated.release();
    await pending.catch(() => {});
    expect(last().status).toBe('ended');
    expect(last().history).toEqual([]);
    const review = buildReview(await backend.getTimeline(), last());
    expect(review.overview).toContain(NOT_ENOUGH_EVIDENCE);
  });

  it('a reasoning failure surfaces as reasoning_failed and creates nothing', async () => {
    const failing: ReasoningFn = async () => ({ ok: false, error: 'provider_error' });
    const { backend, last } = connect({ reasoning: failing });
    await backend.startSession();
    await expect(backend.simulation!.advance()).rejects.toMatchObject({ code: 'reasoning_failed' });
    expect(last().history).toEqual([]);
  });

  it('end → engine timeline → review grounded in recorded events only', async () => {
    const { backend, last } = await startWithCard();
    const id = last().prominent!.id;
    const script = await backend.requestExplanation(id);
    await backend.cancelExplanation(script.request.id);
    await backend.endSession();
    const timeline = await backend.getTimeline();
    expect(timeline.truncated).toBe(false);
    const review = buildReview(timeline, last(), { inputNote: 'Synthetic inputs.' });
    const eventIds = new Set(timeline.events.map((e) => e.id));
    expect(review.keyMoments.length).toBeGreaterThan(0);
    for (const m of review.keyMoments) for (const e of m.eventIds) expect(eventIds.has(e)).toBe(true);
    expect(review.overview).toContain('Left defense appears exposed');
    expect(review.strengths).toEqual([]); // nothing was resolved by a later observation
    expect(review.improvementAreas[0]).toContain('no later observation confirmed');
    expect(review.limitations).toContain('Synthetic inputs.');
    expect(review.limitations.join(' ')).toMatch(/not that it was followed/);
    const generated = [review.overview, ...review.strengths, ...review.improvementAreas, ...review.nextActions].join(' ');
    expect(generated).not.toMatch(/\d+\s*%|\bscore\b|\brating\b|\bwon\b|\blost\b/i);
  });

  it('an ended session cannot be resumed (engine rule)', async () => {
    const { backend } = await startWithCard();
    await backend.endSession();
    await expect(backend.resumeSession()).rejects.toMatchObject({ code: 'invalid_transition' });
  });

  it('discard deletes the session; every later call fails and reconnect reports unavailable', async () => {
    const { backend } = await startWithCard();
    await backend.endSession();
    await backend.discardSession();
    await expect(backend.getTimeline()).rejects.toMatchObject({ code: 'session_not_found' });
    expect(backend.simulation!.remaining()).toBe(0);
    const connection: ConnectionStatus[] = [];
    backend.connect({ onState: () => {}, onConnection: (c) => connection.push(c) });
    expect(connection).toEqual(['unavailable']);
  });

  it('disconnect stops delivery', async () => {
    const { backend, states, disconnect } = connect();
    disconnect();
    const before = states.length;
    await backend.startSession();
    expect(states.length).toBe(before);
  });

  describe('resolution matches the bridge runtime (controlledSoccerResolution)', () => {
    /** A fixed clock the test moves forward between steps, so each observation is strictly newer. */
    async function cardWithCoveredStepNext() {
      const clock = { t: Date.parse('2026-11-15T12:00:00.000Z') };
      const feed = [
        { source: 'transcript' as const, text: 'Alex is responsible for left defense.' },
        { source: 'screen' as const, summary: 'Left zone uncovered.', facts: { leftZoneVisible: true, leftZoneUncovered: true } },
        { source: 'screen' as const, summary: 'Left zone covered.', facts: { leftZoneVisible: true, leftZoneUncovered: false } },
      ];
      const ctx = connect({ now: () => new Date(clock.t), feed });
      await ctx.backend.startSession();
      const step = async () => {
        clock.t += 2_000;
        await ctx.backend.simulation!.advance();
      };
      await step(); // transcript
      await step(); // uncovered → card
      expect(ctx.last().prominent).toMatchObject({ status: 'active' });
      return { ...ctx, step };
    }

    it('newer clear screen evidence that the zone is covered resolves the card', async () => {
      const { backend, last, step } = await cardWithCoveredStepNext();
      const id = last().prominent!.id;
      await step(); // covered
      expect(last().prominent).toBeUndefined();
      expect(last().history[0]).toMatchObject({ id, status: 'resolved', canExplain: false });
      const { events } = await backend.getTimeline();
      expect(events.some((e) => e.type === 'recommendation_resolved')).toBe(true);
    });

    it('resolving the card being explained ends its voice request (recommendation_resolved)', async () => {
      const { backend, last, step } = await cardWithCoveredStepNext();
      const script = await backend.requestExplanation(last().prominent!.id);
      await backend.reportVoiceStatus(script.request.id, 'playing_locally');
      expect(last().activeVoiceRequest?.requestId).toBe(script.request.id);
      await step(); // covered → resolved
      expect(last().activeVoiceRequest).toBeUndefined(); // the overlay stops speech when it disappears
      const { events } = await backend.getTimeline();
      expect(events).toContainEqual(
        expect.objectContaining({ type: 'voice_finished', outcome: 'cancelled', cancelReason: 'recommendation_resolved' }),
      );
    });
  });
});
