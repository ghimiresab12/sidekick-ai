import type { OverlayState, SessionStatus } from '../contracts/shared';
import type { SessionCommand } from '../session/sessionMachine';
import type { PendingAction } from '../session/sessionReducer';
import { capitalize, SESSION_STATUS_LABEL } from '../ui/format';

interface Props {
  overlay: OverlayState;
  syntheticInput: boolean;
  pending: PendingAction | null;
  allowed: (cmd: SessionCommand) => boolean;
  onPause: () => void;
  onResume: () => void;
  onRequestEnd: () => void;
}

/** Glyph + text so state never relies on colour alone (design.md §9). */
const GLYPH: Record<SessionStatus, string> = { starting: '○', active: '●', paused: '❚❚', ended: '■' };

const CAPTURE_NOTE: Record<SessionStatus, string> = {
  starting: 'Nothing is being processed yet',
  active: 'Conversation audio and shared screen are being processed',
  paused: 'No new audio or screen processing',
  ended: 'Observation stopped',
};

const SYNTHETIC_NOTE: Record<SessionStatus, string> = {
  starting: 'Nothing is being processed yet',
  active: 'Synthetic demo inputs are being processed (no microphone or screen access)',
  paused: 'No new input processing',
  ended: 'Observation stopped',
};

export function StatusBar({ overlay, syntheticInput, pending, allowed, onPause, onResume, onRequestEnd }: Props) {
  const { status } = overlay;
  const busy = pending !== null;
  const activity = overlay.activityConfirmed
    ? `${capitalize(overlay.activity)} confirmed`
    : overlay.suggestedActivity
      ? `${capitalize(overlay.suggestedActivity)} suggested, not confirmed`
      : 'Activity not confirmed';

  return (
    <header className="statusbar">
      <div className="statusbar-main">
        <span className="brand">Sidekick</span>
        <span className={`status-chip status-${status}`} role="status" aria-live="polite">
          <span className="status-glyph" aria-hidden="true">{GLYPH[status]}</span>
          {SESSION_STATUS_LABEL[status]}
        </span>
        <span className="statusbar-meta">Quiet · {activity}</span>
      </div>
      <p className="capture-note">{(syntheticInput ? SYNTHETIC_NOTE : CAPTURE_NOTE)[status]}</p>
      <div className="statusbar-controls">
        {status === 'active' && (
          <button type="button" className="btn" onClick={onPause} disabled={busy || !allowed('pause')}>
            {pending === 'pause' ? 'Pausing…' : '❚❚ Pause'}
          </button>
        )}
        {status === 'paused' && (
          <button type="button" className="btn btn-primary" onClick={onResume} disabled={busy || !allowed('resume')}>
            {pending === 'resume' ? 'Resuming…' : '▶ Resume'}
          </button>
        )}
        <button type="button" className="btn btn-danger-outline" onClick={onRequestEnd} disabled={busy || !allowed('end')}>
          {pending === 'end' ? 'Ending…' : '■ End session'}
        </button>
      </div>
    </header>
  );
}
