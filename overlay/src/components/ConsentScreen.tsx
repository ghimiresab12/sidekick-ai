import { useId, useState } from 'react';
import type { Session } from '../contracts/sidekick';
import { capitalize } from '../ui/format';

interface Props {
  session: Session;
  starting: boolean;
  onStart: () => void;
}

/** Session setup/consent (design.md §2.1, §7): explicit opt-in before anything is processed. */
export function ConsentScreen({ session, starting, onStart }: Props) {
  const [agreed, setAgreed] = useState(false);
  const checkId = useId();
  const names = Object.values(session.participants)
    .map((p) => p.displayName)
    .filter(Boolean)
    .join(', ');

  return (
    <section className="panel consent" aria-labelledby="consent-title">
      <p className="eyebrow">Session setup</p>
      <h1 id="consent-title">Start a Sidekick session</h1>
      <p className="lead">Sidekick gives your group short, quiet text tips during this session.</p>

      <ul className="consent-list">
        <li>
          <strong>Continuous processing while active.</strong> Group conversation audio and the shared screen are
          processed for as long as the session is active, even though Sidekick stays quiet.
        </li>
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
          <dt>Participants</dt>
          <dd>{names || 'None listed'}</dd>
        </div>
        <div>
          <dt>Activity</dt>
          <dd>
            {capitalize(session.activity)} {session.activityConfirmed ? '(confirmed)' : '(not confirmed)'}
          </dd>
        </div>
        <div>
          <dt>Screen share</dt>
          <dd>Unknown: mock session, no live Chert connection</dd>
        </div>
      </dl>

      <label className="checkbox" htmlFor={checkId}>
        <input id={checkId} type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
        <span>Everyone on the call knows Sidekick will process conversation audio and the shared screen, and agrees.</span>
      </label>

      <button type="button" className="btn btn-primary btn-large" disabled={!agreed || starting} onClick={onStart}>
        {starting ? 'Starting…' : 'Start observing'}
      </button>
    </section>
  );
}
