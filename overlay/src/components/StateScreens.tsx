/** Small full-screen states: loading, load error, action error, discarded. */

export function LoadingScreen() {
  return (
    <section className="panel center" role="status" aria-live="polite">
      <div className="spinner" aria-hidden="true" />
      <p>Loading session…</p>
    </section>
  );
}

export function LoadErrorScreen({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <section className="panel center" role="alert">
      <h1>Couldn’t load the session</h1>
      <p className="error-text">{message}</p>
      <button type="button" className="btn btn-primary" onClick={onRetry}>
        Try again
      </button>
    </section>
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

export function DiscardedScreen({ onRestart }: { onRestart: () => void }) {
  return (
    <section className="panel center" aria-labelledby="discarded-title">
      <h1 id="discarded-title">Session discarded</h1>
      <p>
        This session’s recommendations and event history were cleared from memory. Its review is no longer available,
        and it cannot be resumed.
      </p>
      <button type="button" className="btn btn-primary" onClick={onRestart}>
        Set up a new mock session
      </button>
    </section>
  );
}
