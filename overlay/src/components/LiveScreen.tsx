import type { SessionSnapshot } from '../data/SidekickDataSource';
import { selectHistory, selectProminent } from '../session/selectors';
import type { SessionCommand } from '../session/sessionMachine';
import type { PendingAction } from '../session/sessionReducer';
import type { VoiceApi } from '../voice/useVoiceExplanation';
import { RecommendationCard } from './RecommendationCard';
import { RecommendationHistory } from './RecommendationHistory';
import { StatusBar } from './StatusBar';

interface Props {
  snapshot: SessionSnapshot;
  selectedId: string | null;
  pending: PendingAction | null;
  allowed: (cmd: SessionCommand) => boolean;
  voice: VoiceApi;
  onPause: () => void;
  onResume: () => void;
  onRequestEnd: () => void;
  onDismiss: (id: string) => void;
  onSelect: (id: string) => void;
}

/** The minimal gaming overlay: status, one prominent card, collapsed history. */
export function LiveScreen(props: Props) {
  const { snapshot, selectedId, pending, voice } = props;
  const { session, recommendations, observations } = snapshot;
  const prominent = selectProminent(recommendations, selectedId);
  const history = selectHistory(recommendations, prominent?.id ?? null);
  const speakingRec =
    voice.busy && voice.state.recommendationId !== prominent?.id
      ? recommendations.find((r) => r.id === voice.state.recommendationId)
      : undefined;

  return (
    <div className="overlay">
      <StatusBar
        session={session}
        pending={pending}
        allowed={props.allowed}
        onPause={props.onPause}
        onResume={props.onResume}
        onRequestEnd={props.onRequestEnd}
      />

      {speakingRec && (
        <div className="now-playing" role="status">
          <span>
            <span aria-hidden="true">🔊 </span>Explaining: <strong>{speakingRec.title}</strong>
          </span>
          <button type="button" className="btn btn-small" onClick={voice.stop}>
            ■ Stop voice
          </button>
        </div>
      )}

      {prominent ? (
        <RecommendationCard
          key={prominent.id}
          rec={prominent}
          session={session}
          observations={observations}
          voice={voice}
          dismissing={pending === `dismiss:${prominent.id}`}
          dismissDisabled={pending !== null}
          onDismiss={props.onDismiss}
        />
      ) : (
        <div className="empty-card" role="status">
          {session.status === 'paused' ? (
            <>
              <h2>Paused</h2>
              <p>No new recommendations while paused. Resume to continue observing.</p>
            </>
          ) : (
            <>
              <h2>No current recommendations</h2>
              <p>
                Sidekick is observing quietly. New advice appears here as text. It never speaks on its own.
              </p>
            </>
          )}
        </div>
      )}

      <RecommendationHistory items={history} onShow={props.onSelect} />
    </div>
  );
}
