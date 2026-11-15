import type { Session } from '../contracts/sidekick';
import type { SessionCommand } from '../session/sessionMachine';
import type { PendingAction } from '../session/sessionReducer';
import { capitalize, SESSION_STATUS_LABEL } from '../ui/format';

interface Props {
  session: Session;
  pending: PendingAction | null;
  allowed: (cmd: SessionCommand) => boolean;
  onPause: () => void;
  onResume: () => void;
  onRequestEnd: () => void;
}

/** Glyph + text so state never relies on colour alone (design.md §9). */
const GLYPH: Record<Session['status'], string> = { starting: '○', active: '●', paused: '❚❚', ended: '■' };

const CAPTURE_NOTE: Record<Session['status'], string> = {
  starting: 'Nothing is being processed yet',
  active: 'Conversation audio and shared screen are being processed',
  paused: 'No new audio or screen processing',
  ended: 'Observation stopped',
};

export function StatusBar({ session, pending, allowed, onPause, onResume, onRequestEnd }: Props) {
  const busy = pending !== null;
  const activity = session.activityConfirmed
    ? `${capitalize(session.activity)} confirmed`
    : 'Activity not confirmed';

  return (
    <header className="statusbar">
      <div className="statusbar-main">
        <span className="brand">Sidekick</span>
        <span className={`status-chip status-${session.status}`} role="status" aria-live="polite">
          <span className="status-glyph" aria-hidden="true">{GLYPH[session.status]}</span>
          {SESSION_STATUS_LABEL[session.status]}
        </span>
        <span className="statusbar-meta">Quiet · {activity}</span>
      </div>
      <p className="capture-note">{CAPTURE_NOTE[session.status]}</p>
      <div className="statusbar-controls">
        {session.status === 'active' && (
          <button type="button" className="btn" onClick={onPause} disabled={busy || !allowed('pause')}>
            {pending === 'pause' ? 'Pausing…' : '❚❚ Pause'}
          </button>
        )}
        {session.status === 'paused' && (
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
