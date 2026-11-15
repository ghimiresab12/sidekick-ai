import type { SessionReview as Review } from '../contracts/pending';
import type { BrowserSessionTimeline as SessionTimeline } from '../contracts/shared';
import type { OverlayState } from '../contracts/shared';
import { allCards } from '../session/selectors';
import { capitalize, eventLabel, formatClock, REC_STATUS_LABEL, VOICE_REQUEST_LABEL } from '../ui/format';
import { EvidenceList } from './EvidenceList';
import { PlayerContext } from './PlayerContext';

interface Props {
  overlay: OverlayState;
  timeline: SessionTimeline;
  review: Review;
  discarding: boolean;
  disabled: boolean;
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

const shortId = (id: string) => id.slice(0, 8);

/**
 * End-of-session review (design.md §8). Two clearly separated kinds of content:
 *  - GENERATED summary (rule-based, from recorded events) — interpretation.
 *  - RECORDED events — the engine timeline, with ids and times.
 * Every key moment links to the recorded event it is based on.
 */
export function SessionReview({ overlay, timeline, review, discarding, disabled, onRequestDiscard }: Props) {
  const { events, truncated } = timeline;
  const eventIds = new Set(events.map((e) => e.id));
  const started = events.find((e) => e.type === 'session_started')?.time;
  const ended = events.find((e) => e.type === 'session_ended')?.time;
  const cards = allCards(overlay);

  return (
    <div className="review">
      <header className="review-header">
        <div>
          <p className="eyebrow">Session review</p>
          <h1>{capitalize(review.activity)} session · Ended</h1>
          <p className="muted">
            {formatClock(started)}–{formatClock(ended)} · {events.length} recorded events
            {truncated ? ' (event log truncated)' : ''}
          </p>
        </div>
        <button
          type="button"
          className="btn btn-danger-outline"
          onClick={onRequestDiscard}
          disabled={discarding || disabled}
        >
          {discarding ? 'Discarding…' : 'Discard session'}
        </button>
      </header>

      <div className="legend" aria-label="Legend">
        <span className="kind kind-generated">Generated summary</span>
        <span>Interpretation produced from the recorded events.</span>
        <span className="kind kind-recorded">Recorded event</span>
        <span>Logged by the session engine as it happened, with time and event id.</span>
      </div>

      <div className="review-grid">
        <section className="panel review-summary" aria-labelledby="summary-title">
          <div className="section-head">
            <h2 id="summary-title">Summary</h2>
            <span className="kind kind-generated">Generated</span>
          </div>
          <p className="provenance">
            Produced at {formatClock(review.generatedAt)} by a rule-based summary of this session’s recorded events.
            Not AI.
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
                          event {shortId(id)}
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
                  <span className="timeline-type">{eventLabel(e)}</span>
                  <span className="timeline-summary">{e.summary}</span>
                  <span className="timeline-id">event {shortId(e.id)}</span>
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
        {cards.length === 0 ? (
          <p className="muted">No recommendations were shown during this session.</p>
        ) : (
          <div className="review-recs">
            {cards.map((r) => (
              <article key={r.id} className={`review-rec card-${r.status}`}>
                <div className="card-tags">
                  <span className={`badge badge-${r.urgency}`}>{r.urgency === 'important' ? 'Important' : 'Suggestion'}</span>
                  <span className={`badge badge-status-${r.status}`}>{REC_STATUS_LABEL[r.status]}</span>
                  <span className="card-time">shown {formatClock(r.createdAt)}</span>
                </div>
                <h3>{r.title}</h3>
                <p>{r.shortAdvice}</p>
                {r.voice && <p className="muted small">{VOICE_REQUEST_LABEL[r.voice.status]}.</p>}
                <PlayerContext players={r.relatedParticipants} contextChanged={r.contextChangedSinceCreation} />
                <EvidenceList items={r.evidence} compact />
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
