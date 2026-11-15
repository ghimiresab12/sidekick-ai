import type { BackendLabel, SimulationControls as SimulationApi } from '../backend/SidekickBackend';
import type { SessionStatus } from '../contracts/shared';

/** Always-visible honesty label (CLAUDE.md rule 10, design.md §3): says exactly what is real. */
export function BackendBanner({ label }: { label: BackendLabel }) {
  return (
    <div className="mock-banner" role="note">
      <strong>{label.title}</strong>
      <span>{label.detail}</span>
    </div>
  );
}

interface ControlsProps {
  simulation: SimulationApi | undefined;
  status: SessionStatus | undefined;
  live: boolean;
  advancing: boolean;
  onAdvance: () => void;
  simulateNoSpeech: boolean;
  onSimulateNoSpeechChange: (value: boolean) => void;
}

/** Presenter controls: drive the synthetic feed (simulation backends only) and force the text fallback. */
export function DemoControls({
  simulation,
  status,
  live,
  advancing,
  onAdvance,
  simulateNoSpeech,
  onSimulateNoSpeechChange,
}: ControlsProps) {
  const remaining = simulation?.remaining() ?? 0;
  const canAdvance = !!simulation && live && status === 'active' && remaining > 0 && !advancing;
  return (
    <details className="mock-controls">
      <summary>Demo controls</summary>
      <div className="mock-controls-body">
        {simulation && (
          <div>
            <button type="button" className="btn btn-small" onClick={onAdvance} disabled={!canAdvance}>
              {advancing ? 'Reasoning…' : 'Send next synthetic observation'}
            </button>
            <span className="muted small">
              {' '}
              {remaining} synthetic step{remaining === 1 ? '' : 's'} left
              {status !== 'active' && remaining > 0 ? ' (sent only while observing)' : ''}
            </span>
          </div>
        )}
        <label className="checkbox small">
          <input type="checkbox" checked={simulateNoSpeech} onChange={(e) => onSimulateNoSpeechChange(e.target.checked)} />
          <span>Simulate speech synthesis unavailable (shows the text fallback)</span>
        </label>
      </div>
    </details>
  );
}
