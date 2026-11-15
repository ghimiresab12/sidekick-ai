import { useState } from 'react';
import { errorMessage, type SetupControls } from '../backend/SidekickBackend';
import type { OverlayState } from '../contracts/shared';
import { capitalize } from '../ui/format';

/**
 * Whether the page must offer "Confirm gaming". Operator consent (`status`) and activity
 * confirmation (`activityConfirmed`) are SEPARATE engine states: consent never confirms the
 * activity, so the control stays available in every open session state (starting, active,
 * paused), whichever happened first, until the engine reports `activityConfirmed`.
 * Only backends with setup controls (the bridge) offer it.
 */
export function needsActivityConfirmation(overlay: OverlayState, setup: SetupControls | undefined): boolean {
  return !!setup && !overlay.activityConfirmed && overlay.status !== 'ended';
}

interface Props {
  overlay: OverlayState;
  setup: SetupControls;
  disabled: boolean;
}

/** "Confirm gaming" (engineering.md milestone 4). The only source of truth is `OverlayState`. */
export function ActivityConfirmation({ overlay, setup, disabled }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (overlay.activityConfirmed) {
    return <p className="small">{capitalize(overlay.activity)} confirmed.</p>;
  }

  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await setup.confirmGaming();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="activity-confirm">
      <p className="small">
        {overlay.suggestedActivity
          ? `${capitalize(overlay.suggestedActivity)} detected, not confirmed yet.`
          : 'Activity not confirmed yet.'}{' '}
        Sidekick gives advice only after the group confirms the activity.
      </p>
      <button type="button" className="btn btn-small" onClick={() => void confirm()} disabled={disabled || busy}>
        {busy ? 'Confirming…' : 'Confirm gaming'}
      </button>
      {error && (
        <p className="error-text small" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
