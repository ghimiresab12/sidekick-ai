import type { RecommendationView } from '../contracts/shared';
import { formatClock, REC_STATUS_LABEL, STALE_REASON_LABEL } from '../ui/format';
import type { VoiceApi } from '../voice/useVoiceExplanation';
import { EvidenceList } from './EvidenceList';
import { PlayerContext } from './PlayerContext';
import { VoiceControls } from './VoiceControls';

interface Props {
  rec: RecommendationView;
  /** False while the connection is interrupted: the card may be out of date. */
  live: boolean;
  voice: VoiceApi;
  dismissing: boolean;
  dismissDisabled: boolean;
  onDismiss: (id: string) => void;
}

/** The single card in the main slot (design.md §3–4). */
export function RecommendationCard({ rec, live, voice, dismissing, dismissDisabled, onDismiss }: Props) {
  const titleId = `rec-${rec.id}-title`;
  const open = rec.status === 'active' || rec.status === 'stale';
  return (
    <article className={`card card-${rec.status} urgency-${rec.urgency}`} aria-labelledby={titleId}>
      <div className="card-tags">
        <span className={`badge badge-${rec.urgency}`}>
          {rec.urgency === 'important' ? (
            <>
              <span aria-hidden="true">! </span>Important
            </>
          ) : (
            'Suggestion'
          )}
        </span>
        <span className={`badge badge-status-${rec.status}`}>{REC_STATUS_LABEL[rec.status]}</span>
        <span className="card-time">shown {formatClock(rec.createdAt)}</span>
      </div>

      <h2 id={titleId} className="card-title">
        {rec.title}
      </h2>
      <p className="card-advice">{rec.shortAdvice}</p>
      {rec.status === 'stale' && (
        <p className="stale-note">
          Observed earlier, last confirmed {formatClock(rec.lastConditionAt)}.{' '}
          {rec.staleReason ? STALE_REASON_LABEL[rec.staleReason] : 'It may no longer apply.'}
        </p>
      )}
      {!live && <p className="stale-note">Connection interrupted: this card may be out of date.</p>}

      <div className="card-context">
        <PlayerContext players={rec.relatedParticipants} contextChanged={rec.contextChangedSinceCreation} />
        <EvidenceList items={rec.evidence} />
      </div>

      <VoiceControls rec={rec} live={live} voice={voice} />

      {open && (
        <div className="card-actions">
          <button type="button" className="btn btn-ghost" onClick={() => onDismiss(rec.id)} disabled={dismissDisabled || !live}>
            {dismissing ? 'Dismissing…' : 'Dismiss'}
          </button>
        </div>
      )}
    </article>
  );
}
