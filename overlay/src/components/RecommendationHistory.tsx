import type { RecommendationView } from '../contracts/shared';
import { isOpen } from '../session/selectors';
import { formatClock, REC_STATUS_LABEL, VOICE_REQUEST_LABEL } from '../ui/format';

interface Props {
  items: RecommendationView[];
  onShow: (id: string) => void;
}

/** Collapsed history (design.md §3). Open cards can be brought to the front. */
export function RecommendationHistory({ items, onShow }: Props) {
  return (
    <details className="history">
      <summary>
        History <span className="count">{items.length}</span>
      </summary>
      {items.length === 0 ? (
        <p className="muted">No other recommendations yet.</p>
      ) : (
        <ul>
          {items.map((r) => (
            <li key={r.id} className={`history-item history-${r.status}`}>
              <div className="history-text">
                <strong>{r.title}</strong>
                <span className="history-meta">
                  {REC_STATUS_LABEL[r.status]} · shown {formatClock(r.createdAt)}
                  {r.urgency === 'important' ? ' · Important' : ''}
                  {r.voice ? ` · ${VOICE_REQUEST_LABEL[r.voice.status]}` : ''}
                </span>
              </div>
              {isOpen(r) && (
                <button type="button" className="btn btn-small" onClick={() => onShow(r.id)}>
                  Show
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}
