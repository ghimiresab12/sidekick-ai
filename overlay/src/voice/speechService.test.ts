import { describe, expect, it, vi } from 'vitest';
import {
  createSpeechPlayer,
  loadVoices,
  pickLocalVoice,
  splitIntoChunks,
  type SpeakHandlers,
  type SynthLike,
  type UtteranceLike,
  type VoiceLike,
} from './speechService';

const voice = (name: string, lang: string, localService: boolean, isDefault = false): VoiceLike => ({
  name, lang, localService, default: isDefault,
});

/** A fake synth that records calls; tests fire utterance callbacks by hand. */
function fakeSynth(voices: VoiceLike[] = []) {
  const spoken: UtteranceLike[] = [];
  const synth: SynthLike & { cancelCount: number } = {
    cancelCount: 0,
    speak: (u) => spoken.push(u),
    cancel() {
      this.cancelCount += 1;
    },
    getVoices: () => voices,
  };
  const make = (text: string): UtteranceLike => ({ text, lang: '', voice: null, onstart: null, onend: null, onerror: null });
  return { synth, spoken, make };
}

const handlers = () => ({
  onStart: vi.fn<SpeakHandlers['onStart']>(),
  onEnd: vi.fn<SpeakHandlers['onEnd']>(),
  onInterrupted: vi.fn<SpeakHandlers['onInterrupted']>(),
  onError: vi.fn<SpeakHandlers['onError']>(),
});

describe('pickLocalVoice — on-device voices only', () => {
  it('never returns a network voice', () => {
    expect(pickLocalVoice([voice('Google US English', 'en-US', false)], 'en-US')).toBeNull();
  });
  it('prefers matching language, then default', () => {
    const v = [voice('Thomas', 'fr-FR', true, true), voice('Samantha', 'en-US', true), voice('Daniel', 'en-GB', true, true)];
    expect(pickLocalVoice(v, 'en-US')?.name).toBe('Daniel');
    expect(pickLocalVoice(v.slice(0, 2), 'en-US')?.name).toBe('Samantha');
    expect(pickLocalVoice([voice('Thomas', 'fr-FR', true)], 'en-US')?.name).toBe('Thomas');
  });
});

describe('loadVoices', () => {
  it('waits for voiceschanged when the list starts empty', async () => {
    let list: VoiceLike[] = [];
    let fire: () => void = () => {};
    const synth: SynthLike = {
      speak() {}, cancel() {}, getVoices: () => list,
      addEventListener: (_t, fn) => { fire = fn; },
      removeEventListener() {},
    };
    const p = loadVoices(synth, 5000);
    list = [voice('Samantha', 'en-US', true)];
    fire();
    expect((await p).map((v) => v.name)).toEqual(['Samantha']);
  });
});

describe('splitIntoChunks', () => {
  it('splits into sentences and keeps all text', () => {
    const text = 'First thing. Second "quoted" thing! Third?  Trailing words';
    const chunks = splitIntoChunks(text);
    expect(chunks).toEqual(['First thing.', 'Second "quoted" thing!', 'Third?', 'Trailing words']);
  });
  it('breaks very long sentences under the max length', () => {
    const long = Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ') + '.';
    const chunks = splitIntoChunks(long, 100);
    expect(chunks.every((c) => c.length <= 100)).toBe(true);
    expect(chunks.join(' ')).toBe(long);
  });
});

describe('createSpeechPlayer', () => {
  const v = voice('Samantha', 'en-US', true);

  it('cancels anything playing before speaking (no overlap) and queues all chunks', () => {
    const { synth, spoken, make } = fakeSynth();
    createSpeechPlayer(synth, make).speak(['a.', 'b.'], v, handlers());
    expect(synth.cancelCount).toBe(1);
    expect(spoken.map((u) => u.text)).toEqual(['a.', 'b.']);
    expect(spoken[0].voice).toBe(v);
    expect(spoken[0].lang).toBe('en-US');
  });

  it('fires onStart on the first chunk and onEnd only after the last', () => {
    const { synth, spoken, make } = fakeSynth();
    const h = handlers();
    createSpeechPlayer(synth, make).speak(['a.', 'b.'], v, h);
    spoken[0].onstart?.({});
    expect(h.onStart).toHaveBeenCalledOnce();
    expect(spoken[0].onend).toBeNull();
    spoken[1].onend?.({});
    expect(h.onEnd).toHaveBeenCalledOnce();
  });

  it('ignores the "interrupted" error caused by our own cancel()', () => {
    const { synth, spoken, make } = fakeSynth();
    const h = handlers();
    const player = createSpeechPlayer(synth, make);
    player.speak(['a.'], v, h);
    player.cancel();
    spoken[0].onerror?.({ error: 'interrupted' }); // Chrome does this after cancel()
    spoken[0].onend?.({}); // Safari does this after cancel()
    expect(h.onError).not.toHaveBeenCalled();
    expect(h.onInterrupted).not.toHaveBeenCalled();
    expect(h.onEnd).not.toHaveBeenCalled();
  });

  it('a second speak() silences callbacks of the first', () => {
    const { synth, spoken, make } = fakeSynth();
    const first = handlers();
    const player = createSpeechPlayer(synth, make);
    player.speak(['a.'], v, first);
    player.speak(['b.'], v, handlers());
    spoken[0].onend?.({});
    expect(first.onEnd).not.toHaveBeenCalled();
  });

  it('reports real errors and external interruptions distinctly', () => {
    const { synth, spoken, make } = fakeSynth();
    const h = handlers();
    const player = createSpeechPlayer(synth, make);
    player.speak(['a.', 'b.'], v, h);
    spoken[0].onerror?.({ error: 'synthesis-failed' });
    expect(h.onError).toHaveBeenCalledWith('synthesis-failed');
    spoken[1].onerror?.({ error: 'synthesis-failed' }); // later chunks ignored
    expect(h.onError).toHaveBeenCalledOnce();

    const h2 = handlers();
    player.speak(['c.'], v, h2);
    spoken[2].onerror?.({ error: 'interrupted' }); // not caused by us
    expect(h2.onInterrupted).toHaveBeenCalledOnce();
  });
});
