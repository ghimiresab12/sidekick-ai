/** Small states: connecting, unavailable, connection banner, action error, discarded. */
import type { ConnectionStatus } from '../backend/SidekickBackend';

export function LoadingScreen() {
  return (
    <section className="panel center" role="status" aria-live="polite">
      <div className="spinner" aria-hidden="true" />
      <p>Connecting to Sidekick…</p>
    </section>
  );
}

/** No state was ever received, or the backend gave up. */
export function UnavailableScreen({ detail, onRetry }: { detail: string | null; onRetry: () => void }) {
  return (
    <section className="panel center" role="alert">
      <h1>Sidekick service unavailable</h1>
      <p className="error-text">{detail ?? 'Could not reach the Sidekick service.'}</p>
      <button type="button" className="btn btn-primary" onClick={onRetry}>
        Try again
      </button>
    </section>
  );
}

/**
 * Shown over a session whose last state is still on screen but no longer live.
 * Actions and voice are disabled meanwhile, so nothing acts on out-of-date state.
 */
export function ConnectionBanner({
  status,
  detail,
  onRetry,
}: {
  status: ConnectionStatus;
  detail: string | null;
  onRetry: () => void;
}) {
  // Rendered only once a state exists, so `connecting` here is a manual reconnect: say so.
  if (status === 'connected') return null;
  return (
    <div className="banner-error" role="alert">
      <span>
        {status === 'reconnecting' || status === 'connecting'
          ? 'Connection to Sidekick lost. Reconnecting… Showing the last known state; actions are paused.'
          : `Sidekick service unavailable. ${detail ?? ''} Showing the last known state; actions are disabled.`}
      </span>
      {status === 'unavailable' && (
        <button type="button" className="btn btn-small" onClick={onRetry}>
          Reconnect
        </button>
      )}
    </div>
  );
}

export function ActionErrorBanner({ message, onClose }: { message: string; onClose: () => void }) {
  return (
    <div className="banner-error" role="alert">
      <span>{message}</span>
      <button type="button" className="btn btn-small" onClick={onClose} aria-label="Dismiss error">
        Close
      </button>
    </div>
  );
}

export function DiscardedScreen({ onRestart, needsNewPairing }: { onRestart: () => void; needsNewPairing: boolean }) {
  return (
    <section className="panel center" aria-labelledby="discarded-title">
      <h1 id="discarded-title">Session discarded</h1>
      <p>
        This session’s recommendations and event history were cleared from memory. Its review is no longer available,
        and it cannot be resumed.
      </p>
      {needsNewPairing ? (
        <p className="muted">For a new session, ask the operator for a new pairing link.</p>
      ) : (
        <button type="button" className="btn btn-primary" onClick={onRestart}>
          Set up a new session
        </button>
      )}
    </section>
  );
}
