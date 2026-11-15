import type { OverlayState } from '../contracts/shared';
import { allCards, countEarlierAdvice, selectHistory, selectMainCard } from '../session/selectors';
import type { SessionCommand } from '../session/sessionMachine';
import type { PendingAction } from '../session/sessionReducer';
import type { VoiceApi } from '../voice/useVoiceExplanation';
import { RecommendationCard } from './RecommendationCard';
import { RecommendationHistory } from './RecommendationHistory';
import { StatusBar } from './StatusBar';

interface Props {
  overlay: OverlayState;
  live: boolean;
  syntheticInput: boolean;
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

/** The minimal gaming overlay: status, one card, collapsed history. */
export function LiveScreen(props: Props) {
  const { overlay, live, selectedId, pending, voice } = props;
  const main = selectMainCard(overlay, selectedId);
  const history = selectHistory(overlay, main?.id ?? null);
  const earlier = countEarlierAdvice(overlay);
  const speakingRec =
    voice.busy && voice.state.recommendationId !== main?.id
      ? allCards(overlay).find((r) => r.id === voice.state.recommendationId)
      : undefined;

  return (
    <div className="overlay">
      <StatusBar
        overlay={overlay}
        syntheticInput={props.syntheticInput}
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

      {main ? (
        <RecommendationCard
          key={main.id}
          rec={main}
          live={live}
          voice={voice}
          dismissing={pending === `dismiss:${main.id}`}
          dismissDisabled={pending !== null}
          onDismiss={props.onDismiss}
        />
      ) : (
        <div className="empty-card" role="status">
          {overlay.status === 'paused' ? (
            <>
              <h2>Paused</h2>
              <p>No new recommendations while paused. Resume to continue observing.</p>
            </>
          ) : (
            <>
              <h2>No current recommendations</h2>
              <p>Sidekick is observing quietly. New advice appears here as text. It never speaks on its own.</p>
            </>
          )}
          {earlier > 0 && (
            <p className="muted small">
              {earlier} earlier {earlier === 1 ? 'recommendation is' : 'recommendations are'} in History, marked as not
              currently verified.
            </p>
          )}
        </div>
      )}

      <RecommendationHistory items={history} onShow={props.onSelect} />
    </div>
  );
}
