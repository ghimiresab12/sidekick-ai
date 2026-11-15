import { describe, expect, it, vi } from 'vitest';
import type { VoiceExplanation } from '../contracts/proposed';
import type { SpeakHandlers, SpeechPlayer, VoiceLike } from './speechService';
import { createVoiceController, type VoiceControllerDeps } from './voiceController';

const VOICE: VoiceLike = { name: 'Samantha', lang: 'en-US', localService: true, default: true };
const exp = (id: string): VoiceExplanation => ({
  recommendationId: id, text: 'One. Two.', refersToEarlierObservation: false, evidenceObservationIds: ['o1'], generatedAt: '',
});

function setup(over: Partial<VoiceControllerDeps> = {}) {
  let last: SpeakHandlers | null = null;
  const player = {
    speak: vi.fn<SpeechPlayer['speak']>((_c, _v, h) => { last = h; }),
    cancel: vi.fn<SpeechPlayer['cancel']>(),
  };
  const reports: Array<[string, string]> = [];
  const deps: VoiceControllerDeps = {
    requestExplanation: vi.fn(async (id: string) => exp(id)),
    reportPlayback: (id, r) => reports.push([id, r]),
    isSpeechAvailable: () => true,
    findLocalVoice: async () => VOICE,
    getPlayer: () => player,
    ...over,
  };
  const c = createVoiceController(deps);
  return { c, player, reports, deps, handlers: () => last! };
}

describe('voice controller', () => {
  it('idle → preparing → speaking → finished, scoped to one recommendation', async () => {
    const { c, player, reports, handlers } = setup();
    const p = c.explain('r1');
    expect(c.getState()).toMatchObject({ status: 'preparing', recommendationId: 'r1' });
    await p;
    expect(player.speak).toHaveBeenCalledWith(['One.', 'Two.'], VOICE, expect.any(Object));
    handlers().onStart();
    expect(c.getState().status).toBe('speaking');
    handlers().onEnd();
    expect(c.getState().status).toBe('finished');
    expect(reports).toEqual([['r1', 'playing'], ['r1', 'finished']]);
  });

  it('ignores explain() while busy — no overlapping explanations', async () => {
    const { c, deps } = setup();
    await c.explain('r1');
    await c.explain('r2');
    expect(deps.requestExplanation).toHaveBeenCalledTimes(1);
    expect(c.getState().recommendationId).toBe('r1');
  });

  it('stop() cancels speech immediately and records cancelled', async () => {
    const { c, player, reports, handlers } = setup();
    await c.explain('r1');
    handlers().onStart();
    c.stop();
    expect(player.cancel).toHaveBeenCalledOnce();
    expect(c.getState().status).toBe('cancelled');
    expect(reports.at(-1)).toEqual(['r1', 'cancelled']);
    handlers().onEnd(); // late callback after cancel
    expect(c.getState().status).toBe('cancelled');
  });

  it('stop() while preparing discards the late server reply (nothing is spoken)', async () => {
    let resolve!: (e: VoiceExplanation) => void;
    const { c, player } = setup({ requestExplanation: () => new Promise((r) => { resolve = r; }) });
    const p = c.explain('r1');
    c.stop();
    resolve(exp('r1'));
    await p;
    expect(player.speak).not.toHaveBeenCalled();
    expect(c.getState().status).toBe('cancelled');
  });

  it('stopIfFor only stops the matching card', async () => {
    const { c } = setup();
    await c.explain('r1');
    c.stopIfFor('r2');
    expect(c.getState().status).toBe('preparing');
    c.stopIfFor('r1');
    expect(c.getState().status).toBe('cancelled');
  });

  it('falls back to text when speech synthesis is unavailable', async () => {
    const { c, player, reports } = setup({ isSpeechAvailable: () => false });
    await c.explain('r1');
    expect(player.speak).not.toHaveBeenCalled();
    expect(c.getState()).toMatchObject({ status: 'failed', fallback: { text: 'One. Two.' } });
    expect(c.getState().fallback?.reason).toMatch(/not available/);
    expect(reports).toEqual([['r1', 'failed']]);
  });

  it('refuses network-only voices and shows text instead', async () => {
    const { c, player } = setup({ findLocalVoice: async () => null });
    await c.explain('r1');
    expect(player.speak).not.toHaveBeenCalled();
    expect(c.getState().fallback?.reason).toMatch(/does not use network voices/);
  });

  it('playback errors show the text fallback', async () => {
    const { c, handlers, reports } = setup();
    await c.explain('r1');
    handlers().onError('synthesis-failed');
    expect(c.getState()).toMatchObject({ status: 'failed', fallback: { text: 'One. Two.' } });
    expect(reports.at(-1)).toEqual(['r1', 'failed']);
  });

  it('request errors fail without text and without a playback report', async () => {
    const { c, reports } = setup({ requestExplanation: async () => { throw new Error('Session not active'); } });
    await c.explain('r1');
    expect(c.getState()).toMatchObject({ status: 'failed', fallback: { reason: 'Session not active', text: null } });
    expect(reports).toEqual([]);
  });

  it('reset() silences without reporting (used on discard)', async () => {
    const { c, player, reports } = setup();
    await c.explain('r1');
    c.reset();
    expect(player.cancel).toHaveBeenCalled();
    expect(c.getState().status).toBe('idle');
    expect(reports).toEqual([]);
  });

  it('can explain again after finishing (returns to quiet in between)', async () => {
    const { c, handlers, deps } = setup();
    await c.explain('r1');
    handlers().onEnd();
    await c.explain('r1');
    expect(deps.requestExplanation).toHaveBeenCalledTimes(2);
  });
});
