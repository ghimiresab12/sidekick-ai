import type { Observation, Session } from '../contracts/sidekick';
import type { RecommendationWithContext } from '../contracts/proposed';
import { selectEvidence, selectRelatedPlayers } from '../session/selectors';
import { formatClock, REC_STATUS_LABEL } from '../ui/format';
import type { VoiceApi } from '../voice/useVoiceExplanation';
import { EvidenceList } from './EvidenceList';
import { PlayerContext } from './PlayerContext';
import { VoiceControls } from './VoiceControls';

interface Props {
  rec: RecommendationWithContext;
  session: Session;
  observations: Observation[];
  voice: VoiceApi;
  dismissing: boolean;
  dismissDisabled: boolean;
  onDismiss: (id: string) => void;
}

/** The single prominent recommendation (design.md §3–4). */
export function RecommendationCard({ rec, session, observations, voice, dismissing, dismissDisabled, onDismiss }: Props) {
  const titleId = `rec-${rec.id}-title`;
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
        <p className="stale-note">Observed earlier. Sidekick has not re-confirmed this since, so it may no longer apply.</p>
      )}
      {rec.relatedGoal && (
        <p className="card-goal">
          <span className="section-label">Group goal</span> {rec.relatedGoal}
        </p>
      )}

      <div className="card-context">
        <PlayerContext players={selectRelatedPlayers(rec, session)} />
        <EvidenceList items={selectEvidence(rec, observations)} />
      </div>

      <VoiceControls rec={rec} voice={voice} sessionStatus={session.status} />

      <div className="card-actions">
        <button type="button" className="btn btn-ghost" onClick={() => onDismiss(rec.id)} disabled={dismissDisabled}>
          {dismissing ? 'Dismissing…' : 'Dismiss'}
        </button>
      </div>
    </article>
  );
}
