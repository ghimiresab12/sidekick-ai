import type { SessionReview as Review } from '../contracts/sidekick';
import type { SessionSnapshot } from '../data/SidekickDataSource';
import { selectEvidence, selectRelatedPlayers } from '../session/selectors';
import { capitalize, EVENT_LABEL, formatClock, REC_STATUS_LABEL } from '../ui/format';
import { EvidenceList } from './EvidenceList';
import { PlayerContext } from './PlayerContext';

interface Props {
  snapshot: SessionSnapshot;
  review: Review;
  discarding: boolean;
  onRequestDiscard: () => void;
}

function ListOrEmpty({ items, empty }: { items: string[]; empty: string }) {
  return items.length === 0 ? (
    <p className="muted">{empty}</p>
  ) : (
    <ul className="bullets">
      {items.map((t, i) => (
        <li key={i}>{t}</li>
      ))}
    </ul>
  );
}

/**
 * End-of-session review (design.md §8). Two clearly separated kinds of content:
 *  - GENERATED summary (here: mock rule-based generator) — interpretation.
 *  - RECORDED events — what was actually logged, with ids and times.
 * Every key moment links to the recorded event it is based on.
 */
export function SessionReview({ snapshot, review, discarding, onRequestDiscard }: Props) {
  const { session, events, recommendations, observations } = snapshot;
  const eventIds = new Set(events.map((e) => e.id));

  return (
    <div className="review">
      <header className="review-header">
        <div>
          <p className="eyebrow">Session review</p>
          <h1>
            {capitalize(review.activity)} session · Ended
          </h1>
          <p className="muted">
            {formatClock(session.startedAt)}–{formatClock(session.endedAt)} · {events.length} recorded events
          </p>
        </div>
        <button type="button" className="btn btn-danger-outline" onClick={onRequestDiscard} disabled={discarding}>
          {discarding ? 'Discarding…' : 'Discard session'}
        </button>
      </header>

      <div className="legend" aria-label="Legend">
        <span className="kind kind-generated">Generated summary</span>
        <span>Interpretation produced from the recorded events.</span>
        <span className="kind kind-recorded">Recorded event</span>
        <span>Logged as it happened, with time and event id.</span>
      </div>

      <div className="review-grid">
        <section className="panel review-summary" aria-labelledby="summary-title">
          <div className="section-head">
            <h2 id="summary-title">Summary</h2>
            <span className="kind kind-generated">Generated</span>
          </div>
          <p className="provenance">
            Produced by the mock rule-based review generator at {formatClock(review.generatedAt)}. Not AI and not live
            data.
          </p>
          <p className="overview">{review.overview}</p>

          <h3>Key moments</h3>
          {review.keyMoments.length === 0 ? (
            <p className="muted">No key moments were recorded.</p>
          ) : (
            <ol className="moments">
              {review.keyMoments.map((m, i) => (
                <li key={i}>
                  <span className="moment-time">{formatClock(m.time)}</span>
                  <span className="moment-text">{m.whatHappened}</span>
                  <span className="moment-refs">
                    {m.eventIds.map((id) =>
                      eventIds.has(id) ? (
                        <a key={id} href={`#event-${id}`} className="ref">
                          event {id.split('-').pop()}
                        </a>
                      ) : (
                        <span key={id} className="ref ref-missing">
                          unknown event
                        </span>
                      ),
                    )}
                  </span>
                </li>
              ))}
            </ol>
          )}

          <h3>What went well</h3>
          <ListOrEmpty items={review.strengths} empty="No recorded event supports a positive observation." />

          <h3>Opportunities</h3>
          <ListOrEmpty items={review.improvementAreas} empty="No unresolved issues were recorded." />

          <h3>Suggested next steps</h3>
          <ListOrEmpty items={review.nextActions} empty="No next steps: there was not enough evidence." />

          <h3>Limitations</h3>
          <ListOrEmpty items={review.limitations} empty="None listed." />
        </section>

        <section className="panel review-timeline" aria-labelledby="timeline-title">
          <div className="section-head">
            <h2 id="timeline-title">Event timeline</h2>
            <span className="kind kind-recorded">Recorded</span>
          </div>
          {events.length === 0 ? (
            <p className="muted">No events were recorded.</p>
          ) : (
            <ol className="timeline">
              {events.map((e) => (
                <li key={e.id} id={`event-${e.id}`} className={`timeline-item t-${e.type}`} tabIndex={-1}>
                  <span className="timeline-time">{formatClock(e.time)}</span>
                  <span className="timeline-type">{EVENT_LABEL[e.type] ?? e.type}</span>
                  <span className="timeline-summary">{e.summary}</span>
                  <span className="timeline-id">event {e.id.split('-').pop()}</span>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>

      <section className="panel" aria-labelledby="recs-title">
        <div className="section-head">
          <h2 id="recs-title">Recommendations this session</h2>
          <span className="kind kind-recorded">Recorded</span>
        </div>
        {recommendations.length === 0 ? (
          <p className="muted">No recommendations were shown during this session.</p>
        ) : (
          <div className="review-recs">
            {recommendations.map((r) => (
              <article key={r.id} className={`review-rec card-${r.status}`}>
                <div className="card-tags">
                  <span className={`badge badge-${r.urgency}`}>{r.urgency === 'important' ? 'Important' : 'Suggestion'}</span>
                  <span className={`badge badge-status-${r.status}`}>{REC_STATUS_LABEL[r.status]}</span>
                  <span className="card-time">shown {formatClock(r.createdAt)}</span>
                </div>
                <h3>{r.title}</h3>
                <p>{r.shortAdvice}</p>
                {r.voiceRequestedAt && (
                  <p className="muted small">Voice explanation requested at {formatClock(r.voiceRequestedAt)}.</p>
                )}
                <PlayerContext players={selectRelatedPlayers(r, session)} />
                <EvidenceList items={selectEvidence(r, observations)} compact />
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
