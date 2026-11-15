/**
 * React wrapper around the voice controller.
 *
 * `useSyncExternalStore` lets React read state that lives outside React (the
 * controller) and re-render whenever it changes — no duplicated useState.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { SidekickBackend } from '../backend/SidekickBackend';
import { createSpeechPlayer, getBrowserSpeech, loadVoices, pickLocalVoice, type SpeechPlayer } from './speechService';
import { createVoiceController, isVoiceBusy, syncVoiceWithConnection } from './voiceController';

export interface VoiceOptions {
  /** Mock/demo toggle to exercise the text fallback path. */
  simulateUnavailable?: boolean;
}

export function useVoiceExplanation(backend: SidekickBackend, options: VoiceOptions = {}) {
  const simulateRef = useRef(!!options.simulateUnavailable);
  simulateRef.current = !!options.simulateUnavailable;

  const [controller] = useState(() => {
    let player: SpeechPlayer | null = null;
    return createVoiceController({
      requestExplanation: (id) => backend.requestExplanation(id),
      reportStatus: (requestId, status) => backend.reportVoiceStatus(requestId, status),
      cancel: (requestId) => backend.cancelExplanation(requestId),
      isSpeechAvailable: () => !simulateRef.current && getBrowserSpeech() !== null,
      findLocalVoice: async () => {
        const speech = getBrowserSpeech();
        if (!speech) return null;
        const lang = typeof navigator !== 'undefined' ? navigator.language : 'en';
        return pickLocalVoice(await loadVoices(speech.synth), lang);
      },
      getPlayer: () => {
        if (player) return player;
        const speech = getBrowserSpeech();
        if (!speech) return null;
        player = createSpeechPlayer(speech.synth, speech.makeUtterance);
        return player;
      },
    });
  });

  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  const syncConnection = useCallback(
    (live: boolean, active: { requestId: string } | undefined) => syncVoiceWithConnection(controller, live, active),
    [controller],
  );

  // Never leave speech playing when the UI goes away (unmount, tab close).
  useEffect(() => {
    const onPageHide = () => controller.reset();
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      controller.reset();
    };
  }, [controller]);

  return {
    state,
    busy: isVoiceBusy(state),
    explain: controller.explain,
    stop: controller.stop,
    stopIfFor: controller.stopIfFor,
    silenceForLifecycle: controller.silenceForLifecycle,
    syncActiveRequest: controller.syncActiveRequest,
    interruptForConnectionLoss: controller.interruptForConnectionLoss,
    connectionRestored: controller.connectionRestored,
    /** See `syncVoiceWithConnection`. */
    syncConnection,
    cancelOnBackend: controller.cancelOnBackend,
    reset: controller.reset,
  };
}

export type VoiceApi = ReturnType<typeof useVoiceExplanation>;
