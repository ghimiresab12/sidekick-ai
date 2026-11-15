import { useId, useState } from 'react';
import type { SetupControls } from '../backend/SidekickBackend';
import type { OverlayState } from '../contracts/shared';
import { capitalize } from '../ui/format';
import { SessionSetup } from './SessionSetup';

interface Props {
  overlay: OverlayState;
  syntheticInput: boolean;
  /** `operator`: consent is given by the operator for the whole group; no consent button here. */
  consent: 'local' | 'operator';
  setup: SetupControls | undefined;
  starting: boolean;
  disabled: boolean;
  onStart: () => void;
}

/**
 * Session setup/consent (design.md §2.1, §7): explicit opt-in before anything is processed.
 * With the bridge, consent is operator-only (engineering.md milestone 4): the operator
 * attests that every participant agreed, so this page only waits and never offers a button.
 */
export function ConsentScreen({ overlay, syntheticInput, consent, setup, starting, disabled, onStart }: Props) {
  const [agreed, setAgreed] = useState(false);
  const checkId = useId();

  return (
    <section className="panel consent" aria-labelledby="consent-title">
      <p className="eyebrow">Session setup</p>
      <h1 id="consent-title">Start a Sidekick session</h1>
      <p className="lead">Sidekick gives your group short, quiet text tips during this session.</p>

      <ul className="consent-list">
        {syntheticInput ? (
          <li>
            <strong>Synthetic demo inputs only.</strong> This simulation does not access your microphone, camera,
            screen share or FaceTime call.
          </li>
        ) : (
          <li>
            <strong>Continuous processing while active.</strong> Group conversation audio and the shared screen are
            processed for as long as the session is active, even though Sidekick stays quiet.
          </li>
        )}
        <li>
          <strong>Quiet by default.</strong> Advice appears as text. Sidekick never speaks on its own.
        </li>
        <li>
          <strong>Private voice, only when you ask.</strong> “Explain with voice” plays on this device only, never into
          the FaceTime call. Headphones recommended.
        </li>
        <li>
          <strong>You stay in control.</strong> Pause or end at any time. After ending, review or discard the session.
        </li>
      </ul>

      <dl className="facts">
        <div>
          <dt>Activity</dt>
          <dd>
            {overlay.activityConfirmed
              ? `${capitalize(overlay.activity)} (confirmed)`
              : overlay.suggestedActivity
                ? `${capitalize(overlay.suggestedActivity)} (suggested, not confirmed)`
                : 'Not confirmed'}
          </dd>
        </div>
        <div>
          <dt>Input</dt>
          <dd>{syntheticInput ? 'Synthetic demo feed, no live Chert connection' : 'From the call agent via the local bridge (live Chert capture not yet verified)'}</dd>
        </div>
      </dl>

      {setup && <SessionSetup setup={setup} overlay={overlay} disabled={disabled} />}

      {consent === 'operator' ? (
        <div className="waiting" role="status" aria-live="polite">
          <strong>Waiting for the operator.</strong> Observation starts only after the operator confirms that everyone
          on the call agreed. Nothing is processed until then.
        </div>
      ) : (
        <>
      <label className="checkbox" htmlFor={checkId}>
        <input id={checkId} type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
        <span>
          {syntheticInput
            ? 'I understand this simulation uses synthetic transcript and screen observations, not live call media.'
            : 'Everyone on the call knows Sidekick will process conversation audio and the shared screen, and agrees.'}
        </span>
      </label>

      <button type="button" className="btn btn-primary btn-large" disabled={!agreed || starting || disabled} onClick={onStart}>
        {starting ? 'Starting…' : 'Start observing'}
      </button>
        </>
      )}
    </section>
  );
}
