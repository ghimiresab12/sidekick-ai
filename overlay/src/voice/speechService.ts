/**
 * Local, private speech playback using the browser's Web Speech API.
 *
 * PRIVACY BOUNDARY — this is the only module that produces sound.
 * - `speechSynthesis` plays through the OS's default audio output. It produces
 *   no media stream object our code could attach to a call, and this app never
 *   imports WebRTC, capture, LiveKit or Chert code (enforced by a test).
 * - Only ON-DEVICE voices (`localService === true`) are used. Some browsers
 *   offer network voices that send the text to a remote server; we refuse
 *   those and fall back to on-screen text instead.
 * - Acoustic pickup (speakers → microphone) and OS-level screen-share audio
 *   capture are outside what code can prevent: see overlay/README.md (CH-4).
 */

/** Minimal shapes we use — lets tests pass fakes without a browser. */
export interface VoiceLike {
  name: string;
  lang: string;
  localService: boolean;
  default: boolean;
}

export interface UtteranceLike {
  text: string;
  lang: string;
  voice: unknown;
  onstart: ((ev: unknown) => void) | null;
  onend: ((ev: unknown) => void) | null;
  onerror: ((ev: { error?: string }) => void) | null;
}

export interface SynthLike {
  speak(u: UtteranceLike): void;
  cancel(): void;
  getVoices(): VoiceLike[];
  addEventListener?(type: 'voiceschanged', fn: () => void): void;
  removeEventListener?(type: 'voiceschanged', fn: () => void): void;
}

export type UtteranceFactory = (text: string) => UtteranceLike;

export interface SpeakHandlers {
  onStart(): void;
  onEnd(): void;
  /** Interrupted by something other than our own cancel() (e.g. the OS). */
  onInterrupted(): void;
  onError(detail: string): void;
}

export interface SpeechPlayer {
  speak(chunks: string[], voice: VoiceLike, handlers: SpeakHandlers): void;
  cancel(): void;
}

/** Feature detection. Returns null when the browser has no speech synthesis. */
export function getBrowserSpeech(): { synth: SynthLike; makeUtterance: UtteranceFactory } | null {
  if (typeof window === 'undefined') return null;
  if (!('speechSynthesis' in window) || typeof window.SpeechSynthesisUtterance !== 'function') return null;
  return {
    synth: window.speechSynthesis as unknown as SynthLike,
    makeUtterance: (text) => new window.SpeechSynthesisUtterance(text) as unknown as UtteranceLike,
  };
}

/**
 * Pick an on-device voice, preferring the user's language and the default
 * voice. Returns null if every available voice is a network voice.
 */
export function pickLocalVoice(voices: VoiceLike[], preferredLang = 'en'): VoiceLike | null {
  const local = voices.filter((v) => v.localService);
  if (local.length === 0) return null;
  const base = preferredLang.toLowerCase().split('-')[0];
  const sameLang = local.filter((v) => v.lang.toLowerCase().startsWith(base));
  return sameLang.find((v) => v.default) ?? sameLang[0] ?? local.find((v) => v.default) ?? local[0];
}

/** Voices load asynchronously in some browsers (Chrome); wait briefly for them. */
export function loadVoices(synth: SynthLike, timeoutMs = 1500): Promise<VoiceLike[]> {
  const initial = synth.getVoices();
  if (initial.length > 0 || !synth.addEventListener) return Promise.resolve(initial);
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      synth.removeEventListener?.('voiceschanged', done);
      resolve(synth.getVoices());
    };
    const timer = setTimeout(done, timeoutMs);
    synth.addEventListener!('voiceschanged', done);
  });
}

/**
 * Split text into sentence-sized chunks. Long single utterances are known to
 * stop early in some Chrome builds; short queued utterances avoid that.
 */
export function splitIntoChunks(text: string, maxLen = 220): string[] {
  const sentences = text.replace(/\s+/g, ' ').trim().match(/[^.!?]+[.!?]+["”’)]*|[^.!?]+$/g) ?? [];
  const chunks: string[] = [];
  for (const raw of sentences) {
    const s = raw.trim();
    if (!s) continue;
    if (s.length <= maxLen) {
      chunks.push(s);
      continue;
    }
    // Very long sentence: break on commas/spaces near maxLen.
    let rest = s;
    while (rest.length > maxLen) {
      const cut = Math.max(rest.lastIndexOf(', ', maxLen), rest.lastIndexOf(' ', maxLen));
      const at = cut > 0 ? cut + 1 : maxLen;
      chunks.push(rest.slice(0, at).trim());
      rest = rest.slice(at).trim();
    }
    if (rest) chunks.push(rest);
  }
  return chunks;
}

/**
 * Wraps a synth so that:
 * - a new speak() always cancels anything playing (no overlap);
 * - callbacks from speech we cancelled ourselves are ignored (a token check),
 *   so Chrome's 'interrupted' error after cancel() is not shown as a failure.
 */
export function createSpeechPlayer(synth: SynthLike, makeUtterance: UtteranceFactory): SpeechPlayer {
  let token = 0;
  // Keep references: some browsers garbage-collect queued utterances and never fire onend.
  let queued: UtteranceLike[] = [];

  return {
    speak(chunks, voice, handlers) {
      token += 1;
      const mine = token;
      synth.cancel();
      queued = [];
      if (chunks.length === 0) {
        handlers.onEnd();
        return;
      }
      chunks.forEach((text, i) => {
        const u = makeUtterance(text);
        u.voice = voice;
        u.lang = voice.lang;
        if (i === 0) {
          u.onstart = () => {
            if (mine === token) handlers.onStart();
          };
        }
        if (i === chunks.length - 1) {
          u.onend = () => {
            if (mine !== token) return;
            token += 1;
            queued = [];
            handlers.onEnd();
          };
        }
        u.onerror = (ev) => {
          if (mine !== token) return; // our own cancel(): ignore
          token += 1;
          queued = [];
          synth.cancel(); // drop remaining chunks
          if (ev.error === 'interrupted' || ev.error === 'canceled') handlers.onInterrupted();
          else handlers.onError(ev.error ?? 'unknown');
        };
        queued.push(u);
        synth.speak(u);
      });
    },
    cancel() {
      token += 1;
      queued = [];
      synth.cancel();
    },
  };
}
