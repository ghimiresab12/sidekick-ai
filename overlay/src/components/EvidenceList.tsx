import type { RecommendationView } from '../contracts/shared';
import { EVIDENCE_KIND_LABEL, formatClock, SOURCE_LABEL } from '../ui/format';

type Evidence = RecommendationView['evidence'];

/**
 * Source + observation time + what the observation shows (design.md §4).
 * The shared OverlayState deliberately carries no observation text or transcript,
 * so the overlay shows provenance, never content, and no confidence numbers.
 */
export function EvidenceList({ items, compact = false }: { items: Evidence; compact?: boolean }) {
  return (
    <section className={compact ? 'evidence evidence-compact' : 'evidence'} aria-label="Supporting evidence">
      <h3 className="section-label">Evidence</h3>
      {items.length === 0 ? (
        <p className="muted">No supporting observations were attached.</p>
      ) : (
        <ul>
          {items.map((e) => (
            <li key={`${e.kind}-${e.observationId}`}>
              <span className={`tag tag-${e.source}`}>{SOURCE_LABEL[e.source]}</span>
              <span className="evidence-summary">{EVIDENCE_KIND_LABEL[e.kind]}</span>
              <span className="evidence-meta">observed {formatClock(e.observedAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
