import { useEffect, useId, useState } from 'react';
import { errorMessage, type BrowserParticipant, type SetupControls } from '../backend/SidekickBackend';
import type { OverlayState } from '../contracts/shared';
import { ActivityConfirmation } from './ActivityConfirmation';

interface Props {
  setup: SetupControls;
  overlay: OverlayState;
  disabled: boolean;
}

/**
 * Bridge-mode session setup (engineering.md milestone 4, "UI controls"): register
 * participant names and confirm the gaming activity. The bridge normalizes names, so the
 * name it returns is the one displayed. Consent is NOT here: it is operator-only.
 */
export function SessionSetup({ setup, overlay, disabled }: Props) {
  const [participants, setParticipants] = useState<BrowserParticipant[] | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<'add' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<string | null>(null);
  const nameId = useId();

  useEffect(() => {
    let mounted = true;
    setup.listParticipants().then(
      (list) => mounted && setParticipants(list),
      (e: unknown) => mounted && setError(errorMessage(e)),
    );
    return () => {
      mounted = false;
    };
  }, [setup]);

  const add = async () => {
    if (!name.trim() || busy) return;
    setBusy('add');
    setError(null);
    setAdded(null);
    try {
      const p = await setup.addParticipant(name);
      setParticipants((prev) => [...(prev ?? []), p]);
      setAdded(p.displayName);
      setName('');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="setup">
      <h2 className="setup-title">Participants</h2>
      {participants === null ? (
        <p className="muted small">Loading participants…</p>
      ) : participants.length === 0 ? (
        <p className="muted small">No participants registered yet.</p>
      ) : (
        <ul className="setup-list">
          {participants.map((p) => (
            <li key={p.id}>{p.displayName}</li>
          ))}
        </ul>
      )}
      <form
        className="setup-form"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <label htmlFor={nameId}>Add a participant</label>
        <input
          id={nameId}
          type="text"
          value={name}
          maxLength={64}
          autoComplete="off"
          onChange={(e) => setName(e.target.value)}
          disabled={disabled || busy !== null}
        />
        <button type="submit" className="btn btn-small" disabled={disabled || busy !== null || !name.trim()}>
          {busy === 'add' ? 'Adding…' : 'Add'}
        </button>
      </form>
      {added && (
        <p className="muted small" role="status">
          Added as “{added}”.
        </p>
      )}

      <h2 className="setup-title">Activity</h2>
      <ActivityConfirmation overlay={overlay} setup={setup} disabled={disabled} />
      {error && (
        <p className="error-text small" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
