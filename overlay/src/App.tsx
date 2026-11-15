/**
 * Composition root. The only place that wires the data source, session state
 * and voice together, and that enforces the cross-cutting rules:
 *   - speech stops on dismiss (that card), pause, end and discard;
 *   - End and Discard require confirmation;
 *   - screens follow the session lifecycle.
 *
 * To integrate with a real backend, swap `createMockDataSource` for a live
 * SidekickDataSource here; components do not change.
 */
import { useEffect, useState } from 'react';
import { ConfirmDialog } from './components/ConfirmDialog';
import { ConsentScreen } from './components/ConsentScreen';
import { EndSessionPanel } from './components/EndSessionPanel';
import { LiveScreen } from './components/LiveScreen';
import { MockBanner, MockControls } from './components/MockBanner';
import { SessionReview } from './components/SessionReview';
import { ActionErrorBanner, DiscardedScreen, LoadErrorScreen, LoadingScreen } from './components/StateScreens';
import type { MockDataSource } from './data/mockDataSource';
import { createEngineDataSource } from './data/engineDataSource';
import { useSidekickSession } from './session/useSidekickSession';
import { useVoiceExplanation } from './voice/useVoiceExplanation';

interface Instance {
  n: number;
  dataSource: MockDataSource;
}

const createInstance = (n: number): Instance => ({
  n,
  dataSource: createEngineDataSource(),
});

export function App() {
  const [instance, setInstance] = useState(() => createInstance(1));
  // `key` remounts everything for a new session, so no state leaks between sessions.
  return (
    <SidekickApp
      key={instance.n}
      dataSource={instance.dataSource}
      onRestart={() => setInstance((prev) => createInstance(prev.n + 1))}
    />
  );
}

function SidekickApp({ dataSource, onRestart }: { dataSource: MockDataSource; onRestart: () => void }) {
  const session = useSidekickSession(dataSource);
  const [simulateNoSpeech, setSimulateNoSpeech] = useState(false);
  const voice = useVoiceExplanation(dataSource, { simulateUnavailable: simulateNoSpeech });
  const [confirm, setConfirm] = useState<'end' | 'discard' | null>(null);

  const { state } = session;
  const snapshot = state.snapshot;
  const status = snapshot?.session.status;
  const { stop: stopVoice } = voice;

  // Safety net: speech never continues outside an active session, however the
  // status changed. (Handlers below also stop it explicitly, first.)
  useEffect(() => {
    if (status !== 'active') stopVoice();
  }, [status, stopVoice]);

  const handlePause = () => {
    voice.stop();
    void session.pause();
  };
  const handleDismiss = (id: string) => {
    voice.stopIfFor(id);
    void session.dismiss(id);
  };
  const handleConfirmEnd = () => {
    setConfirm(null);
    voice.stop();
    void session.end();
  };
  const handleConfirmDiscard = () => {
    setConfirm(null);
    voice.reset();
    void session.discard();
  };

  let screen: JSX.Element;
  let wide = false;
  if (state.discarded) {
    screen = <DiscardedScreen onRestart={onRestart} />;
  } else if (!snapshot && state.loadStatus === 'loading') {
    screen = <LoadingScreen />;
  } else if (!snapshot) {
    screen = <LoadErrorScreen message={state.loadError ?? 'Unknown error.'} onRetry={session.retryLoad} />;
  } else if (snapshot.session.status === 'starting') {
    screen = <ConsentScreen session={snapshot.session} starting={state.pending === 'start'} onStart={() => void session.start()} simulation={dataSource.mode === 'mock'} />;
  } else if (snapshot.session.status === 'ended') {
    if (state.review.status === 'ready') {
      wide = true;
      screen = (
        <SessionReview
          snapshot={snapshot}
          review={state.review.data}
          discarding={state.pending === 'discard'}
          onRequestDiscard={() => setConfirm('discard')}
        />
      );
    } else {
      screen = (
        <EndSessionPanel
          snapshot={snapshot}
          review={state.review}
          discarding={state.pending === 'discard'}
          onGenerateReview={() => void session.generateReview()}
          onRequestDiscard={() => setConfirm('discard')}
        />
      );
    }
  } else {
    screen = (
      <LiveScreen
        snapshot={snapshot}
        selectedId={state.selectedRecommendationId}
        pending={state.pending}
        allowed={session.allowed}
        voice={voice}
        onPause={handlePause}
        onResume={() => void session.resume()}
        onRequestEnd={() => setConfirm('end')}
        onDismiss={handleDismiss}
        onSelect={session.select}
      />
    );
  }

  return (
    <div className="app">
      {dataSource.mode === 'mock' && <MockBanner reasoningMode={snapshot?.reasoningMode} />}
      <main className={wide ? 'main main-wide' : 'main'}>
        {state.actionError && !state.discarded && (
          <ActionErrorBanner message={state.actionError} onClose={session.clearError} />
        )}
        {screen}
      </main>
      {dataSource.mode === 'mock' && !state.discarded && (
        <footer className="footer">
          <MockControls
            controls={dataSource.mock}
            status={status}
            simulateNoSpeech={simulateNoSpeech}
            onSimulateNoSpeechChange={setSimulateNoSpeech}
          />
        </footer>
      )}

      <ConfirmDialog
        open={confirm === 'end'}
        title="End this session?"
        confirmLabel="End session"
        onConfirm={handleConfirmEnd}
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
