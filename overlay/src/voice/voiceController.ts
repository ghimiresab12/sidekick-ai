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
 * busy; a token invalidates late async results after stop/reset; if the backend refuses
 * the `playing_locally` report (request already over, or a 409), playback stops.
 *
 * Terminal reports are ACKNOWLEDGED, not fire-and-forget. A request stays live on the
 * backend until it hears `finished`/`failed`/cancel (or its 60 s timeout), and a live
 * request blocks every other explanation in the session (`voice_busy`). So every terminal
 * report (finish, failure, Stop, a late request after Stop, connection loss) goes through
 * `settle()`: if the backend cannot be reached it is re-sent with a short bounded backoff,
 * and again after a reconnect while the backend still shows that request as active; it is
 * dropped once the backend accepts it or refuses it (404/409: already over).
 *
 * Connection loss (`interruptForConnectionLoss`): speech stops immediately and the request
 * is reported `failed` (playback did not complete). If that report cannot get through, it
 * is re-sent from `connectionRestored()` with the reconnect snapshot.
 */
import type { ExplanationScript } from '../contracts/shared';
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
  /**
   * Delays before re-sending an unacknowledged terminal report the backend could not be
   * reached for, while the live stream stays up (an HTTP-only blip). After the last one, only
   * `connectionRestored()` re-sends it. Default 0.5 s, 1 s, 2 s, 4 s.
   */
  reportRetryDelaysMs?: readonly number[];
}

export const IDLE_VOICE_STATE: VoiceState = {
  status: 'idle',
  recommendationId: null,
  requestId: null,
  script: null,
  fallback: null,
};

export const isVoiceBusy = (s: VoiceState) => s.status === 'preparing' || s.status === 'speaking';

/**
 * True when the backend REFUSED a report (as opposed to being unreachable): e.g.
 * `voice_request_not_found` (the explanation is already over) or a 409. The explanation
 * must then stop locally and is never retried (engineering.md milestone 4, "Voice").
 */
const isRefusal = (e: unknown) =>
  typeof e === 'object' && e !== null && 'code' in e && (e as { code: unknown }).code !== 'unavailable';

export const CONNECTION_LOST_REASON =
  'The connection to Sidekick was lost, so the explanation stopped. You can request it again once reconnected.';

export function createVoiceController(deps: VoiceControllerDeps) {
  let state: VoiceState = IDLE_VOICE_STATE;
  let token = 0;
  /** Terminal reports the backend has not yet acknowledged, by request id. */
  const unacked = new Map<string, () => Promise<void>>();
  const inFlight = new Set<string>();
  const retryDelays = deps.reportRetryDelaysMs ?? [500, 1_000, 2_000, 4_000];
  /** Pending automatic re-send per request id, and how many have been made. */
  const retries = new Map<string, { timer: ReturnType<typeof setTimeout> | undefined; attempts: number }>();
  const forget = (requestId: string) => {
    unacked.delete(requestId);
    const r = retries.get(requestId);
    if (r?.timer !== undefined) clearTimeout(r.timer);
    retries.delete(requestId);
  };
  /** True once OverlayState has shown our request as active (see syncActiveRequest). */
  let seenActive = false;
  const listeners = new Set<() => void>();

  const set = (next: VoiceState) => {
    state = next;
    listeners.forEach((l) => l());
  };

  /** Sends one terminal report and keeps it until the backend accepts or refuses it. */
  async function flush(requestId: string): Promise<void> {
    const send = unacked.get(requestId);
    if (!send || inFlight.has(requestId)) return;
    inFlight.add(requestId);
    let retry = false;
    try {
      await send();
      forget(requestId);
    } catch (e) {
      if (isRefusal(e)) forget(requestId); // the backend no longer holds it live
      else retry = unacked.has(requestId); // unreachable: keep it and try again
    } finally {
      inFlight.delete(requestId);
    }
    if (retry) scheduleRetry(requestId);
  }
  /** Bounded automatic re-send; connectionRestored() still re-sends after the last attempt. */
  function scheduleRetry(requestId: string): void {
    const r = retries.get(requestId) ?? { timer: undefined, attempts: 0 };
    const delay = retryDelays[r.attempts];
    if (r.timer !== undefined || delay === undefined) return;
    r.attempts += 1;
    r.timer = setTimeout(() => {
      r.timer = undefined;
      void flush(requestId);
    }, delay);
    retries.set(requestId, r);
  }
  const settle = (requestId: string, send: () => Promise<void>) => {
    unacked.set(requestId, send);
    void flush(requestId);
  };
  const settleStatus = (requestId: string, status: 'finished' | 'failed') =>
    settle(requestId, () => deps.reportStatus(requestId, status));
  const settleCancel = (requestId: string) => settle(requestId, () => deps.cancel(requestId));

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
      // Stopped (or disconnected) while preparing: the engine created a request we will never play.
      settleCancel(requestId);
      return;
    }
    if (script.request.recommendationId !== recommendationId) {
      settleStatus(requestId, 'failed');
      fail(recommendationId, 'Received an explanation for a different recommendation; not playing it.', null);
      return;
    }

    const player = deps.isSpeechAvailable() ? deps.getPlayer() : null;
    if (!player) {
      fail(recommendationId, 'Speech synthesis is not available in this browser. Showing the explanation as text.', script);
      settleStatus(requestId, 'failed');
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
      settleStatus(requestId, 'failed');
      return;
    }

    player.speak(splitIntoChunks(script.text), voice, {
      onStart: () => {
        if (mine !== token) return;
        set({ status: 'speaking', recommendationId, requestId, script, fallback: null });
        void deps.reportStatus(requestId, 'playing_locally').catch((e: unknown) => {
          if (mine === token && isRefusal(e)) silenceLocally(); // the backend already ended it
        });
      },
      onEnd: () => {
        if (mine !== token) return;
        token += 1;
        set({ status: 'finished', recommendationId, requestId, script, fallback: null });
        settleStatus(requestId, 'finished');
      },
      // Interrupted by something other than our own Stop: playback did not complete.
      onInterrupted: () => {
        if (mine !== token) return;
        token += 1;
        fail(recommendationId, 'Voice playback was interrupted. Showing the explanation as text.', script);
        settleStatus(requestId, 'failed');
      },
      onError: (detail) => {
        if (mine !== token) return;
        token += 1;
        fail(recommendationId, `Voice playback failed (${detail}). Showing the explanation as text.`, script);
        settleStatus(requestId, 'failed');
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
    if (requestId) settleCancel(requestId);
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

  /**
   * The live connection to the backend was lost. Speech must not continue on a state that
   * may be out of date, and the backend must not keep the request live (it would block
   * every explanation in the session). Stops speech now, shows the text, and reports the
   * playback as `failed` (it did not complete). If the report cannot get through, it is
   * re-sent from `connectionRestored()`. A request still being prepared is invalidated:
   * when its late reply arrives, it is cancelled (see explain()).
   */
  function interruptForConnectionLoss(): void {
    if (!isVoiceBusy(state)) return;
    const { recommendationId, script } = state;
    const requestId = silenceLocally();
    if (!requestId || !recommendationId) return;
    set({
      status: 'failed',
      recommendationId,
      requestId,
      script,
      fallback: { reason: CONNECTION_LOST_REASON, text: script?.text ?? null },
    });
    settleStatus(requestId, 'failed');
  }

  /**
   * The live connection is back; `active` is the backend's current `activeVoiceRequest`.
   * Re-sends any unacknowledged terminal report for a request the backend still holds live,
   * and forgets the ones it has already ended. Never restarts speech.
   */
  function connectionRestored(active: { requestId: string } | undefined): void {
    for (const requestId of [...unacked.keys()]) {
      if (active?.requestId === requestId) void flush(requestId);
      else forget(requestId);
    }
  }

  /** Silence and forget everything without reporting (session discarded / unmount). */
  function reset(): void {
    token += 1;
    if (isVoiceBusy(state)) deps.getPlayer()?.cancel();
    seenActive = false;
    for (const requestId of [...unacked.keys()]) forget(requestId);
    set(IDLE_VOICE_STATE);
  }

  return {
    explain,
    stop,
    stopIfFor,
    silenceForLifecycle,
    syncActiveRequest,
    interruptForConnectionLoss,
    connectionRestored,
    cancelOnBackend: (requestId: string) => settleCancel(requestId),
    /** Request ids whose terminal report the backend has not acknowledged yet (tests, diagnostics). */
    pendingReports: () => [...unacked.keys()],
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

/**
 * The connection → voice rule App.tsx applies on every change of connection health or of the
 * backend's `activeVoiceRequest`: connection lost → stop speech and report the interruption;
 * connection back → re-send any unacknowledged report for a request the backend still holds.
 */
export function syncVoiceWithConnection(
  controller: Pick<VoiceController, 'interruptForConnectionLoss' | 'connectionRestored'>,
  live: boolean,
  active: { requestId: string } | undefined,
): void {
  if (!live) controller.interruptForConnectionLoss();
  else controller.connectionRestored(active);
}
