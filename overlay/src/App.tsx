/**
 * Composition root. The only place that wires the backend, session state and voice
 * together, and that enforces the cross-cutting rules:
 *   - speech stops on dismiss (that card), pause, end, discard, connection loss,
 *     and whenever the engine's `activeVoiceRequest` ends our request;
 *   - End and Discard require confirmation;
 *   - screens follow the session lifecycle and connection health.
 *
 * The backend is chosen in `loadBackendFactory()`. Components never import one.
 */
import { useEffect, useState } from 'react';
import { createHttpBackend } from './backend/httpBackend';
import { errorMessage, type SidekickBackend } from './backend/SidekickBackend';
import { BackendBanner, DemoControls } from './components/BackendBanner';
import { ConfirmDialog } from './components/ConfirmDialog';
import { ConsentScreen } from './components/ConsentScreen';
import { EndSessionPanel } from './components/EndSessionPanel';
import { LiveScreen } from './components/LiveScreen';
import { SessionReview } from './components/SessionReview';
import {
  ActionErrorBanner,
  ConnectionBanner,
  DiscardedScreen,
  LoadingScreen,
  UnavailableScreen,
} from './components/StateScreens';
import { useSidekickSession } from './session/useSidekickSession';
import { useVoiceExplanation } from './voice/useVoiceExplanation';

type BackendFactory = () => SidekickBackend;

/**
 * Default: the Node bridge's browser API (the bridge owns all session state).
 * `vite --mode simulation` selects the in-process simulation instead. The flag is a
 * build-time constant, so in the default build this branch and its lazy import are
 * removed and the live bundle contains no engine, coordinator or reasoning code.
 */
async function loadBackendFactory(): Promise<BackendFactory> {
  if (__SIDEKICK_SIMULATION__) {
    const { createInProcessBackend } = await import('./backend/inProcessBackend');
    return () => createInProcessBackend();
  }
  return () => createHttpBackend();
}

interface Instance {
  n: number;
  backend: SidekickBackend;
}

export function App() {
  const [factory, setFactory] = useState<BackendFactory | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    loadBackendFactory().then(
      (f) => setFactory(() => f),
      (e: unknown) => setLoadError(errorMessage(e)),
    );
  }, []);
  if (!factory) {
    return (
      <div className="app">
        <main className="main">
          {loadError ? <UnavailableScreen detail={loadError} onRetry={() => window.location.reload()} /> : <LoadingScreen />}
        </main>
      </div>
    );
  }
  return <Sessions createBackend={factory} />;
}

function Sessions({ createBackend }: { createBackend: BackendFactory }) {
  const [instance, setInstance] = useState<Instance>(() => ({ n: 1, backend: createBackend() }));
  // `key` remounts everything for a new session, so no state leaks between sessions.
  return (
    <SidekickApp
      key={instance.n}
      backend={instance.backend}
      onRestart={() => setInstance((prev) => ({ n: prev.n + 1, backend: createBackend() }))}
    />
  );
}

function SidekickApp({ backend, onRestart }: { backend: SidekickBackend; onRestart: () => void }) {
  const session = useSidekickSession(backend);
  const [simulateNoSpeech, setSimulateNoSpeech] = useState(false);
  const voice = useVoiceExplanation(backend, { simulateUnavailable: simulateNoSpeech });
  const [confirm, setConfirm] = useState<'end' | 'discard' | null>(null);
  const [advancing, setAdvancing] = useState(false);

  const { state, live } = session;
  const overlay = state.overlay;
  const status = overlay?.status;
  const activeVoiceRequest = overlay?.activeVoiceRequest;
  const { syncActiveRequest, silenceForLifecycle } = voice;

  // The engine is the authority on whether our voice request is still live.
  useEffect(() => {
    syncActiveRequest(activeVoiceRequest);
  }, [activeVoiceRequest, syncActiveRequest]);

  // Safety net: speech never continues outside an active, connected session. The
  // engine records its own cancel reason (pause/end), so nothing is reported here.
  useEffect(() => {
    if (status !== 'active' || !live) silenceForLifecycle();
  }, [status, live, silenceForLifecycle]);

  const leaveActive = async (op: () => Promise<boolean>) => {
    const requestId = voice.silenceForLifecycle();
    const ok = await op();
    // If the lifecycle call failed, the engine still holds our request: cancel it.
    if (!ok && requestId) voice.cancelOnBackend(requestId);
  };
  const handleDismiss = (id: string) => {
    voice.stopIfFor(id); // user action → cancelExplanation(reason user)
    void session.dismiss(id);
  };
  const handleConfirmDiscard = () => {
    setConfirm(null);
    voice.reset();
    void session.discard();
  };
  const handleAdvance = async () => {
    if (!backend.simulation) return;
    setAdvancing(true);
    try {
      await backend.simulation.advance();
    } catch (e) {
      session.showError(errorMessage(e));
    } finally {
      setAdvancing(false);
    }
  };

  let screen: JSX.Element;
  let wide = false;
  if (state.discarded) {
    screen = <DiscardedScreen onRestart={onRestart} needsNewPairing={backend.capabilities.consent === 'operator'} />;
  } else if (!overlay && state.connection === 'unavailable') {
    screen = <UnavailableScreen detail={state.connectionDetail} onRetry={session.reconnect} />;
  } else if (!overlay) {
    screen = <LoadingScreen />;
  } else if (overlay.status === 'starting') {
    screen = (
      <ConsentScreen
        overlay={overlay}
        syntheticInput={backend.label.syntheticInput}
        consent={backend.capabilities.consent}
        setup={backend.setup}
        starting={state.pending === 'start'}
        disabled={!live}
        onStart={() => void session.start()}
      />
    );
  } else if (overlay.status === 'ended') {
    if (state.review.status === 'ready') {
      wide = true;
      screen = (
        <SessionReview
          overlay={overlay}
          timeline={state.review.timeline}
          review={state.review.data}
          discarding={state.pending === 'discard'}
          disabled={!live}
          onRequestDiscard={() => setConfirm('discard')}
        />
      );
    } else {
      screen = (
        <EndSessionPanel
          overlay={overlay}
          review={state.review}
          discarding={state.pending === 'discard'}
          disabled={!live}
          onGenerateReview={() => void session.generateReview()}
          onRequestDiscard={() => setConfirm('discard')}
        />
      );
    }
  } else {
    screen = (
      <LiveScreen
        overlay={overlay}
        live={live}
        syntheticInput={backend.label.syntheticInput}
        selectedId={state.selectedRecommendationId}
        pending={state.pending}
        allowed={session.allowed}
        operatorResumes={!backend.capabilities.resume}
        voice={voice}
        onPause={() => void leaveActive(session.pause)}
        onResume={() => void session.resume()}
        onRequestEnd={() => setConfirm('end')}
        onDismiss={handleDismiss}
        onSelect={session.select}
      />
    );
  }

  return (
    <div className="app">
      <BackendBanner label={backend.label} />
      <main className={wide ? 'main main-wide' : 'main'}>
        {!state.discarded && overlay && (
          <ConnectionBanner status={state.connection} detail={state.connectionDetail} onRetry={session.reconnect} />
        )}
        {state.actionError && !state.discarded && (
          <ActionErrorBanner message={state.actionError} onClose={session.clearError} />
        )}
        {screen}
      </main>
      {!state.discarded && (
        <footer className="footer">
          <DemoControls
            simulation={backend.simulation}
            status={status}
            live={live}
            advancing={advancing}
            onAdvance={() => void handleAdvance()}
            simulateNoSpeech={simulateNoSpeech}
            onSimulateNoSpeechChange={setSimulateNoSpeech}
          />
        </footer>
      )}

      <ConfirmDialog
        open={confirm === 'end'}
        title="End this session?"
        confirmLabel="End session"
        onConfirm={() => {
          setConfirm(null);
          void leaveActive(session.end);
        }}
        onCancel={() => setConfirm(null)}
      >
        <p>
          Sidekick stops observing immediately and any voice explanation stops. You can then generate a review or
          discard the session. An ended session cannot be resumed.
        </p>
      </ConfirmDialog>
      <ConfirmDialog
        open={confirm === 'discard'}
        title="Discard this session?"
        confirmLabel="Discard permanently"
        tone="danger"
        onConfirm={handleConfirmDiscard}
        onCancel={() => setConfirm(null)}
      >
        <p>
          This deletes the session’s recommendations, evidence and event history from memory. The review will be
          unavailable afterwards. This cannot be undone.
        </p>
      </ConfirmDialog>
    </div>
  );
}
