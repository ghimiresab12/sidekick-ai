import { useId } from 'react';
import type { RecommendationView } from '../contracts/shared';
import type { VoiceApi } from '../voice/useVoiceExplanation';
import type { VoiceStatus } from '../voice/voiceController';

interface Props {
  rec: RecommendationView;
  live: boolean;
  voice: VoiceApi;
}

const STATUS_TEXT: Record<VoiceStatus, string> = {
  idle: 'Quiet. Press to hear a private explanation of this card.',
  preparing: 'Preparing explanation…',
  speaking: 'Speaking locally on this device…',
  finished: 'Finished. Back to quiet mode.',
  cancelled: 'Voice stopped. Back to quiet mode.',
  failed: 'Unable to speak.',
};

/**
 * Explain with voice / Stop voice for ONE recommendation (scoped by id).
 * Sound only ever starts from this button press, never on card creation.
 * Whether Explain is offered is the ENGINE's decision (`RecommendationView.canExplain`).
 */
export function VoiceControls({ rec, live, voice }: Props) {
  const noteId = useId();
  const mine = voice.state.recommendationId === rec.id;
  const status: VoiceStatus = mine ? voice.state.status : 'idle';
  const canExplain = live && rec.canExplain && !voice.busy;
  const canStop = mine && voice.busy;

  let hint: string | null = null;
  if (!live) hint = 'Reconnect to the Sidekick service to request an explanation.';
  else if (voice.busy && !mine) hint = 'Another explanation is playing. Stop it first.';
  else if (!rec.canExplain && !mine) hint = 'Voice explanations are available for open advice while Sidekick is observing.';

  return (
    <section className="voice" aria-label="Voice explanation">
      <div className="voice-buttons">
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void voice.explain(rec.id)}
          disabled={!canExplain}
          aria-describedby={noteId}
        >
          <span aria-hidden="true">🔊 </span>
          {status === 'preparing' ? 'Preparing…' : rec.status === 'stale' ? 'Explain earlier advice' : 'Explain with voice'}
        </button>
        <button type="button" className="btn" onClick={voice.stop} disabled={!canStop}>
          <span aria-hidden="true">■ </span>Stop voice
        </button>
      </div>

      <p className={`voice-status voice-${status}`} aria-live="polite">
        {STATUS_TEXT[status]}
        {mine && voice.state.script?.refersToEarlierObservation && status === 'speaking'
          ? ' (about an earlier observation)'
          : ''}
      </p>
      {hint && <p className="hint">{hint}</p>}

      {mine && voice.state.fallback && (
        <div className="fallback" role="note">
          <strong>Text fallback · voice unavailable</strong>
          <p className="fallback-reason">{voice.state.fallback.reason}</p>
          {voice.state.fallback.text && <p className="fallback-text">{voice.state.fallback.text}</p>}
        </div>
      )}

      <p id={noteId} className="voice-note">
        <span aria-hidden="true">🎧 </span>
        Plays only on this device, never into the FaceTime call. Use headphones: speakers can be picked up by
        your microphone.
      </p>
    </section>
  );
}
