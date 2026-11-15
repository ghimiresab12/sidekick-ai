import type { SessionStatus } from '../contracts/sidekick';
import type { MockControls as MockControlsApi } from '../data/mockDataSource';

/** Always-visible honesty label (CLAUDE.md rule 10, design.md §3). */
export function MockBanner() {
  return (
    <div className="mock-banner" role="note">
      <strong>Mock data</strong>
      <span>Fictional scripted session · Companion panel fallback, not a native FaceTime overlay · Not connected to Chert</span>
    </div>
  );
}

interface ControlsProps {
  controls: MockControlsApi;
  status: SessionStatus | undefined;
  simulateNoSpeech: boolean;
  onSimulateNoSpeechChange: (value: boolean) => void;
}

/** Demo-only controls so a presenter can control timing and show the fallback path. */
export function MockControls({ controls, status, simulateNoSpeech, onSimulateNoSpeechChange }: ControlsProps) {
  const remaining = controls.remainingFeedSteps();
  const canAdvance = status === 'active' && remaining > 0;
  return (
    <details className="mock-controls">
      <summary>Demo controls (mock only)</summary>
      <div className="mock-controls-body">
        <div>
          <button type="button" className="btn btn-small" onClick={() => void controls.advanceFeed()} disabled={!canAdvance}>
            Play next scripted observation now
          </button>
          <span className="muted small">
            {' '}
            {remaining} scripted step{remaining === 1 ? '' : 's'} left
            {status !== 'active' && remaining > 0 ? ' (plays only while observing)' : ''}
          </span>
        </div>
        <label className="checkbox small">
          <input type="checkbox" checked={simulateNoSpeech} onChange={(e) => onSimulateNoSpeechChange(e.target.checked)} />
          <span>Simulate speech synthesis unavailable (shows the text fallback)</span>
        </label>
      </div>
    </details>
  );
}
