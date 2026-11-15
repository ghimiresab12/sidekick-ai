import type { OverlayState } from '../contracts/shared';
import { allCards } from '../session/selectors';
import type { ReviewState } from '../session/sessionReducer';

interface Props {
  overlay: OverlayState;
  review: ReviewState;
  discarding: boolean;
  disabled: boolean;
  onGenerateReview: () => void;
  onRequestDiscard: () => void;
}

/** Shown right after End: observation has stopped; choose Review or Discard (design.md §7). */
export function EndSessionPanel({ overlay, review, discarding, disabled, onGenerateReview, onRequestDiscard }: Props) {
  const shown = allCards(overlay).length;
  const loading = review.status === 'loading';

  return (
    <section className="panel" aria-labelledby="ended-title">
      <span className="status-chip status-ended">
        <span className="status-glyph" aria-hidden="true">■</span>Ended
      </span>
      <h1 id="ended-title">Session ended</h1>
      <p className="lead">Observation has stopped. No new input is processed for this session.</p>

      <dl className="facts">
        <div>
          <dt>Recommendations shown</dt>
          <dd>{shown}</dd>
        </div>
      </dl>

      {shown === 0 && (
        <p className="notice">
          No recommendations were shown, so the review will say there is not enough evidence for an assessment.
        </p>
      )}
      {review.status === 'error' && (
        <p className="error-text" role="alert">
          Could not generate the review: {review.message}
        </p>
      )}

      <div className="actions">
        <button
          type="button"
          className="btn btn-primary btn-large"
          onClick={onGenerateReview}
          disabled={loading || discarding || disabled}
        >
          {loading ? 'Generating review…' : review.status === 'error' ? 'Try again' : 'Generate review'}
        </button>
        <button
          type="button"
          className="btn btn-danger-outline"
          onClick={onRequestDiscard}
          disabled={loading || discarding || disabled}
        >
          {discarding ? 'Discarding…' : 'Discard session'}
        </button>
      </div>
      <p className="muted small">
        Discarding deletes this session’s recommendations and event history from memory. The review will not be
        available afterwards.
      </p>
    </section>
  );
}
