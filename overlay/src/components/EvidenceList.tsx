import type { EvidenceItem } from '../session/selectors';
import { formatClock, QUALITY_LABEL, SOURCE_LABEL } from '../ui/format';

/** Source + observation time + quality in words. No confidence numbers. */
export function EvidenceList({ items, compact = false }: { items: EvidenceItem[]; compact?: boolean }) {
  return (
    <section className={compact ? 'evidence evidence-compact' : 'evidence'} aria-label="Supporting evidence">
      <h3 className="section-label">Evidence</h3>
      {items.length === 0 ? (
        <p className="muted">No supporting observations were attached.</p>
      ) : (
        <ul>
          {items.map(({ id, observation: o }) =>
            o ? (
              <li key={id}>
                <span className={`tag tag-${o.source}`}>{SOURCE_LABEL[o.source]}</span>
                <span className="evidence-summary">{o.summary}</span>
                <span className="evidence-meta">
                  observed {formatClock(o.observedAt)} · {QUALITY_LABEL[o.evidenceQuality]}
                  {o.source === 'transcript' && !o.speakerId ? ' · speaker not verified' : ''}
                </span>
              </li>
            ) : (
              <li key={id} className="evidence-missing">
                Evidence reference <code>{id}</code> is unavailable.
              </li>
            ),
          )}
        </ul>
      )}
    </section>
  );
}
