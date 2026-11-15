import { describe, expect, it, vi } from 'vitest';
import type { ExplanationScript } from '../contracts/shared';
import type { SpeakHandlers, SpeechPlayer, VoiceLike } from './speechService';
import { createVoiceController, type VoiceControllerDeps } from './voiceController';

const VOICE: VoiceLike = { name: 'Samantha', lang: 'en-US', localService: true, default: true };
let nextRequest = 0;
const script = (recommendationId: string): ExplanationScript => ({
  request: {
    id: `req-${++nextRequest}`,
    sessionId: 's1',
    recommendationId,
    status: 'pending',
    requestedAt: '2026-11-14T18:00:00.000Z',
    updatedAt: '2026-11-14T18:00:00.000Z',
  },
  text: 'One. Two.',
  refersToEarlierObservation: false,
});

function setup(over: Partial<VoiceControllerDeps> = {}) {
  let last: SpeakHandlers | null = null;
  const player = {
    speak: vi.fn<SpeechPlayer['speak']>((_c, _v, h) => {
      last = h;
    }),
    cancel: vi.fn<SpeechPlayer['cancel']>(),
  };
  const reports: Array<[string, string]> = [];
  const deps: VoiceControllerDeps = {
    requestExplanation: vi.fn(async (id: string) => script(id)),
    reportStatus: async (requestId, status) => {
      reports.push([requestId, status]);
    },
    cancel: async (requestId) => {
      reports.push([requestId, 'cancel']);
    },
    isSpeechAvailable: () => true,
    findLocalVoice: async () => VOICE,
    getPlayer: () => player,
    ...over,
  };
  const c = createVoiceController(deps);
  return { c, player, reports, deps, handlers: () => last! };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('voice controller (engine voice requests)', () => {
  it('idle → preparing → speaking → finished, reported by request id', async () => {
    const { c, player, reports, handlers } = setup();
    const p = c.explain('r1');
    expect(c.getState()).toMatchObject({ status: 'preparing', recommendationId: 'r1' });
    await p;
    const requestId = c.getState().requestId!;
    expect(player.speak).toHaveBeenCalledWith(['One.', 'Two.'], VOICE, expect.any(Object));
    handlers().onStart();
    expect(c.getState().status).toBe('speaking');
    handlers().onEnd();
    expect(c.getState().status).toBe('finished');
    expect(reports).toEqual([
      [requestId, 'playing_locally'],
      [requestId, 'finished'],
    ]);
  });

  it('ignores explain() while busy (no overlapping explanations)', async () => {
    const { c, deps } = setup();
    await c.explain('r1');
    await c.explain('r2');
    expect(deps.requestExplanation).toHaveBeenCalledTimes(1);
    expect(c.getState().recommendationId).toBe('r1');
  });

  it('Stop cancels speech immediately and calls cancelExplanation (never reportStatus)', async () => {
    const { c, player, reports, handlers } = setup();
    await c.explain('r1');
    const requestId = c.getState().requestId!;
    handlers().onStart();
    c.stop();
    expect(player.cancel).toHaveBeenCalledOnce();
    expect(c.getState().status).toBe('cancelled');
    expect(reports.at(-1)).toEqual([requestId, 'cancel']);
    handlers().onEnd(); // late callback after cancel
    expect(c.getState().status).toBe('cancelled');
    expect(reports.filter(([, s]) => s === 'finished')).toEqual([]);
  });

  it('Stop while preparing cancels the late engine request so it cannot stay pending', async () => {
    let resolve!: (s: ExplanationScript) => void;
    const { c, player, reports } = setup({ requestExplanation: () => new Promise((r) => (resolve = r)) });
    const p = c.explain('r1');
    c.stop(); // no request id yet: nothing to cancel locally
    const late = script('r1');
    resolve(late);
    await p;
    await flush();
    expect(player.speak).not.toHaveBeenCalled();
    expect(c.getState().status).toBe('cancelled');
    expect(reports).toEqual([[late.request.id, 'cancel']]);
  });

  it('stopIfFor only stops the matching card (dismiss)', async () => {
    const { c } = setup();
    await c.explain('r1');
    c.stopIfFor('r2');
    expect(c.getState().status).toBe('preparing');
    c.stopIfFor('r1');
    expect(c.getState().status).toBe('cancelled');
  });

  it('silenceForLifecycle stops playback WITHOUT reporting (engine records pause/end itself)', async () => {
    const { c, player, reports, handlers } = setup();
    await c.explain('r1');
    handlers().onStart();
    const before = reports.length;
    const requestId = c.silenceForLifecycle();
    expect(requestId).toBe(c.getState().requestId);
    expect(player.cancel).toHaveBeenCalled();
    expect(c.getState().status).toBe('cancelled');
    expect(reports.length).toBe(before);
  });

  it('syncActiveRequest: silences once the engine drops a request it had shown as active', async () => {
    const { c, player, reports, handlers } = setup();
    await c.explain('r1');
    handlers().onStart();
    const requestId = c.getState().requestId!;
    const before = reports.length;
    c.syncActiveRequest(undefined); // not yet seen: an SSE snapshot may simply lag
    expect(c.getState().status).toBe('speaking');
    c.syncActiveRequest({ requestId, status: 'playing_locally' });
    c.syncActiveRequest(undefined); // engine ended it (timeout / pause / end)
    expect(player.cancel).toHaveBeenCalled();
    expect(c.getState().status).toBe('cancelled');
    expect(reports.length).toBe(before); // engine already terminal: nothing reported
  });

  it('falls back to text when speech synthesis is unavailable, reporting failed', async () => {
    const { c, player, reports } = setup({ isSpeechAvailable: () => false });
    await c.explain('r1');
    expect(player.speak).not.toHaveBeenCalled();
    expect(c.getState()).toMatchObject({ status: 'failed', fallback: { text: 'One. Two.' } });
    expect(c.getState().fallback?.reason).toMatch(/not available/);
    await flush();
    expect(reports).toEqual([[c.getState().requestId, 'failed']]);
  });

  it('refuses network-only voices and shows text instead', async () => {
    const { c, player } = setup({ findLocalVoice: async () => null });
    await c.explain('r1');
    expect(player.speak).not.toHaveBeenCalled();
    expect(c.getState().fallback?.reason).toMatch(/does not use network voices/);
  });

  it('playback errors and outside interruptions show the text fallback and report failed', async () => {
    const { c, handlers, reports } = setup();
    await c.explain('r1');
    handlers().onError('synthesis-failed');
    expect(c.getState()).toMatchObject({ status: 'failed', fallback: { text: 'One. Two.' } });
    expect(reports.at(-1)?.[1]).toBe('failed');

    await c.explain('r1');
    handlers().onInterrupted();
    expect(c.getState().status).toBe('failed');
    expect(reports.at(-1)?.[1]).toBe('failed');
  });

  it('request errors fail without text and without any report', async () => {
    const { c, reports } = setup({
      requestExplanation: async () => {
        throw new Error('Sidekick is not observing right now.');
      },
    });
    await c.explain('r1');
    expect(c.getState()).toMatchObject({ status: 'failed', fallback: { text: null } });
    expect(reports).toEqual([]);
  });

  it('refuses a script for a different recommendation', async () => {
    const { c, player, reports } = setup({ requestExplanation: async () => script('other') });
    await c.explain('r1');
    expect(player.speak).not.toHaveBeenCalled();
    expect(c.getState().status).toBe('failed');
    await flush();
    expect(reports.at(-1)?.[1]).toBe('failed');
  });

  it('a failing backend report never breaks local playback', async () => {
    const { c, handlers } = setup({ reportStatus: async () => Promise.reject(new Error('offline')) });
    await c.explain('r1');
    handlers().onStart();
    handlers().onEnd();
    await flush();
    expect(c.getState().status).toBe('finished');
  });

  it('reset() silences without reporting (discard / unmount)', async () => {
    const { c, player, reports } = setup();
    await c.explain('r1');
    c.reset();
    expect(player.cancel).toHaveBeenCalled();
    expect(c.getState().status).toBe('idle');
    expect(reports).toEqual([]);
  });

  it('a refused playing_locally report (explanation already over) stops speech and is not retried', async () => {
    const calls: string[] = [];
    const { c, player, handlers } = setup({
      reportStatus: async (_id, status) => {
        calls.push(status);
        throw Object.assign(new Error('That explanation has already ended.'), { code: 'voice_request_not_found' });
      },
    });
    await c.explain('r1');
    handlers().onStart();
    await flush();
    expect(player.cancel).toHaveBeenCalled();
    expect(c.getState().status).toBe('cancelled');
    expect(calls).toEqual(['playing_locally']);
  });

  it('an unreachable backend does not stop local playback (connection loss is handled by the app)', async () => {
    const { c, player, handlers } = setup({
      reportStatus: async () => {
        throw Object.assign(new Error('unavailable'), { code: 'unavailable' });
      },
    });
    await c.explain('r1');
    handlers().onStart();
    await flush();
    expect(player.cancel).not.toHaveBeenCalled();
    expect(c.getState().status).toBe('speaking');
  });

  it('a terminal report lost to an outage is re-sent after reconnect while the backend still holds the request', async () => {
    let offline = true;
    const sent: string[] = [];
    const { c, handlers } = setup({
      reportStatus: async (_id, status) => {
        if (offline) throw Object.assign(new Error('unavailable'), { code: 'unavailable' });
        sent.push(status);
      },
    });
    await c.explain('r1');
    const id = c.getState().requestId!;
    handlers().onStart();
    handlers().onEnd(); // finished while the network was down
    await flush();
    expect(c.pendingReports()).toEqual([id]);
    offline = false;
    c.connectionRestored({ requestId: id }); // reconnect snapshot: still live on the backend
    await flush();
    expect(sent).toContain('finished');
    expect(c.pendingReports()).toEqual([]);
  });

  it('an unacknowledged report is dropped when the reconnect snapshot shows the backend already ended it', async () => {
    const { c, handlers } = setup({
      reportStatus: async () => {
        throw Object.assign(new Error('unavailable'), { code: 'unavailable' });
      },
    });
    await c.explain('r1');
    handlers().onStart();
    c.interruptForConnectionLoss();
    await flush();
    expect(c.getState().status).toBe('failed');
    expect(c.pendingReports()).toHaveLength(1);
    c.connectionRestored(undefined); // nothing active any more (e.g. timeout or client_disconnected)
    expect(c.pendingReports()).toEqual([]);
  });

  it('connection loss while still preparing invalidates the late reply and cancels that request', async () => {
    let resolve!: (s: ExplanationScript) => void;
    const { c, player, reports } = setup({ requestExplanation: () => new Promise((r) => (resolve = r)) });
    const p = c.explain('r1');
    c.interruptForConnectionLoss();
    const late = script('r1');
    resolve(late);
    await p;
    await flush();
    expect(player.speak).not.toHaveBeenCalled();
    expect(reports).toEqual([[late.request.id, 'cancel']]);
  });

  it('an unreachable terminal report is retried automatically while the stream stays up (HTTP-only blip)', async () => {
    let failures = 2;
    const sent: string[] = [];
    const { c, handlers } = setup({
      reportRetryDelaysMs: [0, 0, 0],
      reportStatus: async (_id, status) => {
        if (status !== 'finished') return;
        if (failures-- > 0) throw Object.assign(new Error('unavailable'), { code: 'unavailable' });
        sent.push(status);
      },
    });
    await c.explain('r1');
    handlers().onStart();
    handlers().onEnd();
    for (let i = 0; i < 6; i++) await flush();
    expect(sent).toEqual(['finished']);
    expect(c.pendingReports()).toEqual([]);
  });

  it('automatic retries are bounded, and reset() cancels pending retries', async () => {
    let calls = 0;
    const { c, handlers } = setup({
      reportRetryDelaysMs: [0, 0],
      reportStatus: async (_id, status) => {
        if (status !== 'finished') return;
        calls += 1;
        throw Object.assign(new Error('unavailable'), { code: 'unavailable' });
      },
    });
    await c.explain('r1');
    handlers().onStart();
    handlers().onEnd();
    for (let i = 0; i < 8; i++) await flush();
    expect(calls).toBe(3); // first send + 2 retries
    expect(c.pendingReports()).toHaveLength(1); // still waiting for connectionRestored()
    c.reset();
    expect(c.pendingReports()).toEqual([]);
  });
});
