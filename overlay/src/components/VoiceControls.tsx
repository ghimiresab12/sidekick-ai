import { useId } from 'react';
import type { RecommendationWithContext } from '../contracts/proposed';
import type { SessionStatus } from '../contracts/sidekick';
import type { VoiceApi } from '../voice/useVoiceExplanation';
import type { VoiceStatus } from '../voice/voiceController';

interface Props {
  rec: RecommendationWithContext;
  voice: VoiceApi;
  sessionStatus: SessionStatus;
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
 * Sound only ever starts from this button press — never on card creation.
 */
export function VoiceControls({ rec, voice, sessionStatus }: Props) {
  const noteId = useId();
  const mine = voice.state.recommendationId === rec.id;
  const status: VoiceStatus = mine ? voice.state.status : 'idle';
  const canExplain = sessionStatus === 'active' && !voice.busy;
  const canStop = mine && voice.busy;

  let hint: string | null = null;
  if (sessionStatus !== 'active') hint = 'Voice explanations are available while Sidekick is observing.';
  else if (voice.busy && !mine) hint = 'Another explanation is playing. Stop it first.';

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
        {mine && voice.state.explanation?.refersToEarlierObservation && status === 'speaking'
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
