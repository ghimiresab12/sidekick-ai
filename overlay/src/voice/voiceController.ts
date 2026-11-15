/**
 * Voice explanation state machine (design.md §5), framework-free.
 *
 *   idle ─explain─▶ preparing ─▶ speaking ─▶ finished      (back to quiet)
 *                      │            ├─stop─▶ cancelled
 *                      │            └─error▶ failed + text fallback
 *                      ├─stop─▶ cancelled (late backend reply is cancelled too)
 *                      └─no speech / no local voice / request error ▶ failed (+ text if any)
 *
 * Contract (engineering.md §3.1–3.2): every explanation is an engine VOICE REQUEST.
 * Outcomes are reported by request id: `playing_locally` / `finished` / `failed`
 * through `reportVoiceStatus`, a user Stop through `cancelExplanation`. When the
 * engine itself ends the request (pause, end, timeout), `activeVoiceRequest`
 * disappears from OverlayState and `syncActiveRequest` silences local playback
 * without reporting anything back.
 *
 * Rules: one explanation at a time across ALL cards; explain() is ignored while
 * busy; a token invalidates late async results after stop/reset.
 */
import type { ExplanationScript } from '../contracts/pending';
import type { VoiceRequestStatus } from '../contracts/shared';
import type { LocalVoiceStatus } from '../backend/SidekickBackend';
import { splitIntoChunks, type SpeechPlayer, type VoiceLike } from './speechService';

export type VoiceStatus = 'idle' | 'preparing' | 'speaking' | 'finished' | 'cancelled' | 'failed';

export interface VoiceState {
  status: VoiceStatus;
  recommendationId: string | null;
  /** Engine voice request id, once the backend has created it. */
  requestId: string | null;
  script: ExplanationScript | null;
  /** Shown when voice could not play. `text` is null if no explanation was received. */
  fallback: { reason: string; text: string | null } | null;
}

export interface VoiceControllerDeps {
  requestExplanation(recommendationId: string): Promise<ExplanationScript>;
  reportStatus(requestId: string, status: LocalVoiceStatus): Promise<void>;
  cancel(requestId: string): Promise<void>;
  /** False when the browser lacks speech synthesis (or the demo toggle forces it). */
  isSpeechAvailable(): boolean;
  /** Resolves to an on-device voice, or null if only network voices exist. */
  findLocalVoice(): Promise<VoiceLike | null>;
  /** Lazily created so unsupported browsers never touch the API. */
  getPlayer(): SpeechPlayer | null;
}

export const IDLE_VOICE_STATE: VoiceState = {
  status: 'idle',
  recommendationId: null,
  requestId: null,
  script: null,
  fallback: null,
};

export const isVoiceBusy = (s: VoiceState) => s.status === 'preparing' || s.status === 'speaking';

/** Fire-and-forget backend report: a failed report must never break local playback. */
const quietly = (p: Promise<void>) => void p.catch(() => {});

export function createVoiceController(deps: VoiceControllerDeps) {
  let state: VoiceState = IDLE_VOICE_STATE;
  let token = 0;
  /** True once OverlayState has shown our request as active (see syncActiveRequest). */
  let seenActive = false;
  const listeners = new Set<() => void>();

  const set = (next: VoiceState) => {
    state = next;
    listeners.forEach((l) => l());
  };

  const fail = (id: string, reason: string, script: ExplanationScript | null) =>
    set({
      status: 'failed',
      recommendationId: id,
      requestId: script?.request.id ?? null,
      script,
      fallback: { reason, text: script?.text ?? null },
    });

  async function explain(recommendationId: string): Promise<void> {
    if (isVoiceBusy(state)) return; // no overlapping explanations
    const mine = ++token;
    seenActive = false;
    set({ ...IDLE_VOICE_STATE, status: 'preparing', recommendationId });

    let script: ExplanationScript;
    try {
      script = await deps.requestExplanation(recommendationId);
    } catch (e) {
      if (mine !== token) return;
      fail(recommendationId, e instanceof Error ? e.message : 'Could not prepare the explanation.', null);
      return;
    }
    const requestId = script.request.id;
    if (mine !== token) {
      // Stopped while preparing: the engine created a request we will never play.
      quietly(deps.cancel(requestId));
      return;
    }
    if (script.request.recommendationId !== recommendationId) {
      quietly(deps.reportStatus(requestId, 'failed'));
      fail(recommendationId, 'Received an explanation for a different recommendation; not playing it.', null);
      return;
    }

    const player = deps.isSpeechAvailable() ? deps.getPlayer() : null;
    if (!player) {
      fail(recommendationId, 'Speech synthesis is not available in this browser. Showing the explanation as text.', script);
      quietly(deps.reportStatus(requestId, 'failed'));
      return;
    }

    set({ status: 'preparing', recommendationId, requestId, script, fallback: null });
    const voice = await deps.findLocalVoice();
    if (mine !== token) return; // stop() already cancelled the request
    if (!voice) {
      fail(
        recommendationId,
        'No on-device voice was found. Sidekick does not use network voices, so the explanation is shown as text.',
        script,
      );
      quietly(deps.reportStatus(requestId, 'failed'));
      return;
    }

    player.speak(splitIntoChunks(script.text), voice, {
      onStart: () => {
        if (mine !== token) return;
        set({ status: 'speaking', recommendationId, requestId, script, fallback: null });
        quietly(deps.reportStatus(requestId, 'playing_locally'));
      },
      onEnd: () => {
        if (mine !== token) return;
        token += 1;
        set({ status: 'finished', recommendationId, requestId, script, fallback: null });
        quietly(deps.reportStatus(requestId, 'finished'));
      },
      // Interrupted by something other than our own Stop: playback did not complete.
      onInterrupted: () => {
        if (mine !== token) return;
        token += 1;
        fail(recommendationId, 'Voice playback was interrupted. Showing the explanation as text.', script);
        quietly(deps.reportStatus(requestId, 'failed'));
      },
      onError: (detail) => {
        if (mine !== token) return;
        token += 1;
        fail(recommendationId, `Voice playback failed (${detail}). Showing the explanation as text.`, script);
        quietly(deps.reportStatus(requestId, 'failed'));
      },
    });
  }

  /** Silences local playback and moves to `cancelled`. Returns the request id, if any. */
  function silenceLocally(): string | null {
    if (!isVoiceBusy(state)) return null;
    token += 1;
    deps.getPlayer()?.cancel();
    const requestId = state.requestId;
    set({ ...state, status: 'cancelled', fallback: null });
    return requestId;
  }

  /** Stop Voice (user): silence now and tell the engine (`cancelExplanation`, reason user). */
  function stop(): void {
    const requestId = silenceLocally();
    if (requestId) quietly(deps.cancel(requestId));
  }

  /** Stop only if the given card is the one being explained (used on dismiss). */
  function stopIfFor(recommendationId: string): void {
    if (state.recommendationId === recommendationId) stop();
  }

  /**
   * Pause/End: silence locally WITHOUT reporting, because the engine cancels the
   * request itself and records the real reason (`session_paused` / `session_ended`).
   * Returns the request id so the caller can cancel it if the lifecycle call fails.
   */
  function silenceForLifecycle(): string | null {
    return silenceLocally();
  }

  /**
   * Called with every OverlayState. The engine is the authority on whether our
   * request is still live: once it has shown our request active, its disappearance
   * or replacement (timeout, pause, end) silences local playback.
   */
  function syncActiveRequest(active: { requestId: string; status: VoiceRequestStatus } | undefined): void {
    if (!isVoiceBusy(state) || !state.requestId) return;
    if (active?.requestId === state.requestId) {
      seenActive = true;
      return;
    }
    if (seenActive) silenceLocally();
  }

  /** Silence and forget everything without reporting (session discarded / unmount). */
  function reset(): void {
    token += 1;
    if (isVoiceBusy(state)) deps.getPlayer()?.cancel();
    seenActive = false;
    set(IDLE_VOICE_STATE);
  }

  return {
    explain,
    stop,
    stopIfFor,
    silenceForLifecycle,
    syncActiveRequest,
    cancelOnBackend: (requestId: string) => quietly(deps.cancel(requestId)),
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
