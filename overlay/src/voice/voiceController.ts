/**
 * Voice explanation state machine (design.md §5), framework-free.
 *
 *   idle ─explain─▶ preparing ─▶ speaking ─▶ finished      (back to quiet)
 *                      │            ├─stop─▶ cancelled
 *                      │            └─error▶ failed + text fallback
 *                      ├─stop─▶ cancelled (late server reply ignored)
 *                      └─no speech / no local voice / request error ▶ failed (+ text if any)
 *
 * Rules: one explanation at a time across ALL cards; explain() is ignored while
 * busy; every explain is scoped to one recommendationId; stop() cancels speech
 * immediately. A token invalidates late async results after stop/reset.
 */
import type { VoiceExplanation, VoicePlaybackReport } from '../contracts/proposed';
import { splitIntoChunks, type SpeechPlayer, type VoiceLike } from './speechService';

export type VoiceStatus = 'idle' | 'preparing' | 'speaking' | 'finished' | 'cancelled' | 'failed';

export interface VoiceState {
  status: VoiceStatus;
  recommendationId: string | null;
  explanation: VoiceExplanation | null;
  /** Shown when voice could not play. `text` is null if no explanation was received. */
  fallback: { reason: string; text: string | null } | null;
}

export interface VoiceControllerDeps {
  requestExplanation(recommendationId: string): Promise<VoiceExplanation>;
  reportPlayback(recommendationId: string, report: VoicePlaybackReport): void;
  /** False when the browser lacks speech synthesis (or the mock toggle forces it). */
  isSpeechAvailable(): boolean;
  /** Resolves to an on-device voice, or null if only network voices exist. */
  findLocalVoice(): Promise<VoiceLike | null>;
  /** Lazily created so unsupported browsers never touch the API. */
  getPlayer(): SpeechPlayer | null;
}

export const IDLE_VOICE_STATE: VoiceState = { status: 'idle', recommendationId: null, explanation: null, fallback: null };

export const isVoiceBusy = (s: VoiceState) => s.status === 'preparing' || s.status === 'speaking';

export function createVoiceController(deps: VoiceControllerDeps) {
  let state: VoiceState = IDLE_VOICE_STATE;
  let token = 0;
  const listeners = new Set<() => void>();

  const set = (next: VoiceState) => {
    state = next;
    listeners.forEach((l) => l());
  };

  const fail = (id: string, reason: string, explanation: VoiceExplanation | null) =>
    set({ status: 'failed', recommendationId: id, explanation, fallback: { reason, text: explanation?.text ?? null } });

  async function explain(recommendationId: string): Promise<void> {
    if (isVoiceBusy(state)) return; // no overlapping explanations
    const mine = ++token;
    set({ status: 'preparing', recommendationId, explanation: null, fallback: null });

    let explanation: VoiceExplanation;
    try {
      explanation = await deps.requestExplanation(recommendationId);
    } catch (e) {
      if (mine !== token) return;
      fail(recommendationId, e instanceof Error ? e.message : 'Could not prepare the explanation.', null);
      return;
    }
    if (mine !== token) return; // stopped while preparing
    if (explanation.recommendationId !== recommendationId) {
      fail(recommendationId, 'Received an explanation for a different recommendation; not playing it.', null);
      return;
    }

    const player = deps.isSpeechAvailable() ? deps.getPlayer() : null;
    if (!player) {
      fail(recommendationId, 'Speech synthesis is not available in this browser. Showing the explanation as text.', explanation);
      deps.reportPlayback(recommendationId, 'failed');
      return;
    }

    const voice = await deps.findLocalVoice();
    if (mine !== token) return;
    if (!voice) {
      fail(
        recommendationId,
        'No on-device voice was found. Sidekick does not use network voices, so the explanation is shown as text.',
        explanation,
      );
      deps.reportPlayback(recommendationId, 'failed');
      return;
    }

    set({ status: 'preparing', recommendationId, explanation, fallback: null });
    player.speak(splitIntoChunks(explanation.text), voice, {
      onStart: () => {
        if (mine !== token) return;
        set({ status: 'speaking', recommendationId, explanation, fallback: null });
        deps.reportPlayback(recommendationId, 'playing');
      },
      onEnd: () => {
        if (mine !== token) return;
        set({ status: 'finished', recommendationId, explanation, fallback: null });
        deps.reportPlayback(recommendationId, 'finished');
      },
      onInterrupted: () => {
        if (mine !== token) return;
        set({ status: 'cancelled', recommendationId, explanation, fallback: null });
        deps.reportPlayback(recommendationId, 'cancelled');
      },
      onError: (detail) => {
        if (mine !== token) return;
        fail(recommendationId, `Voice playback failed (${detail}). Showing the explanation as text.`, explanation);
        deps.reportPlayback(recommendationId, 'failed');
      },
    });
  }

  /** Stop Voice: cancel immediately and record it. No-op unless busy. */
  function stop(): void {
    if (!isVoiceBusy(state)) return;
    token += 1;
    deps.getPlayer()?.cancel();
    const id = state.recommendationId!;
    set({ ...state, status: 'cancelled', fallback: null });
    deps.reportPlayback(id, 'cancelled');
  }

  /** Stop only if the given card is the one being explained (used on dismiss). */
  function stopIfFor(recommendationId: string): void {
    if (state.recommendationId === recommendationId) stop();
  }

  /** Silence and forget everything without reporting (session discarded / unmount). */
  function reset(): void {
    token += 1;
    if (isVoiceBusy(state)) deps.getPlayer()?.cancel();
    set(IDLE_VOICE_STATE);
  }

  return {
    explain,
    stop,
    stopIfFor,
    reset,
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export type VoiceController = ReturnType<typeof createVoiceController>;
