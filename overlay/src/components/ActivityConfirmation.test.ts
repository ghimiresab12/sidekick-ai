/**
 * Regression: "Confirm gaming" disappeared when operator consent came before activity
 * confirmation, because it was rendered only on the `starting` screen. Consent and activity
 * confirmation are separate engine states; the control must stay available until the engine
 * reports `activityConfirmed`, in whichever order the states are reached.
 *
 * States come from the REAL engine (through the browser projection the bridge applies), and
 * the real components are rendered to markup.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SidekickEngine } from '../../../src/engine';
import { projectOverlayState } from '../../../src/privacy/browser-projection';
import type { SetupControls } from '../backend/SidekickBackend';
import type { OverlayState } from '../contracts/shared';
import { IDLE_VOICE_STATE } from '../voice/voiceController';
import type { VoiceApi } from '../voice/useVoiceExplanation';
import { ConsentScreen } from './ConsentScreen';
import { LiveScreen } from './LiveScreen';
import { needsActivityConfirmation } from './ActivityConfirmation';

const setup: SetupControls = {
  listParticipants: vi.fn(async () => []),
  addParticipant: vi.fn(async (displayName: string) => ({ id: 'p', displayName })),
  confirmGaming: vi.fn(async () => {}),
};

function engineSession() {
  const engine = new SidekickEngine();
  const id = engine.createSession() as unknown as { ok: true; value: { id: string } };
  const sessionId = id.value.id;
  const state = (): OverlayState => {
    let latest: OverlayState | undefined;
    const sub = engine.subscribe(sessionId, (s) => (latest = projectOverlayState(s)));
    if (sub.ok) sub.value();
    return latest!;
  };
  return {
    state,
    consent: () => expect(engine.startWithConsent(sessionId).ok).toBe(true),
    detect: () => expect(engine.suggestActivity(sessionId, 'gaming').ok).toBe(true),
    confirm: () => expect(engine.confirmActivity(sessionId, 'gaming').ok).toBe(true),
    pause: () => expect(engine.pause(sessionId).ok).toBe(true),
  };
}

const voice = {
  state: IDLE_VOICE_STATE,
  busy: false,
  explain: async () => {},
  stop: () => {},
  stopIfFor: () => {},
  silenceForLifecycle: () => null,
  syncActiveRequest: () => {},
  interruptForConnectionLoss: () => {},
  connectionRestored: () => {},
  cancelOnBackend: () => {},
  reset: () => {},
} as unknown as VoiceApi;

/** Renders the screen App.tsx shows for this state (ConsentScreen while starting, else LiveScreen). */
function render(overlay: OverlayState): string {
  if (overlay.status === 'starting') {
    return renderToStaticMarkup(
      createElement(ConsentScreen, {
        overlay,
        syntheticInput: false,
        consent: 'operator',
        setup,
        starting: false,
        disabled: false,
        onStart: () => {},
      }),
    );
  }
  return renderToStaticMarkup(
    createElement(LiveScreen, {
      overlay,
      live: true,
      syntheticInput: false,
      selectedId: null,
      pending: null,
      allowed: () => true,
      operatorResumes: true,
      setup,
      voice,
      onPause: () => {},
      onResume: () => {},
      onRequestEnd: () => {},
      onDismiss: () => {},
      onSelect: () => {},
    }),
  );
}

const offersConfirm = (html: string) => />Confirm gaming</.test(html);

describe('Confirm gaming stays available until the activity is confirmed', () => {
  it('operator consent FIRST, then activity detection: consent does not confirm the activity', () => {
    const s = engineSession();
    expect(offersConfirm(render(s.state()))).toBe(true); // starting, nothing yet
    s.consent();
    expect(s.state()).toMatchObject({ status: 'active', activityConfirmed: false });
    expect(needsActivityConfirmation(s.state(), setup)).toBe(true);
    expect(offersConfirm(render(s.state()))).toBe(true); // the old bug: this was gone
    s.detect();
    expect(s.state()).toMatchObject({ suggestedActivity: 'gaming', activityConfirmed: false });
    const html = render(s.state());
    expect(offersConfirm(html)).toBe(true);
    expect(html).toContain('Gaming detected, not confirmed yet.');
  });

  it('activity detection FIRST, then operator consent', () => {
    const s = engineSession();
    s.detect();
    expect(offersConfirm(render(s.state()))).toBe(true);
    s.consent();
    expect(s.state()).toMatchObject({ status: 'active', suggestedActivity: 'gaming', activityConfirmed: false });
    expect(offersConfirm(render(s.state()))).toBe(true);
  });

  it('remains available while paused, and in every open state until confirmed', () => {
    const s = engineSession();
    s.consent();
    s.pause();
    expect(s.state().status).toBe('paused');
    expect(offersConfirm(render(s.state()))).toBe(true);
  });

  it('confirming gaming (after consent) replaces the control with the confirmed state', () => {
    const s = engineSession();
    s.consent();
    s.detect();
    s.confirm();
    expect(s.state()).toMatchObject({ status: 'active', activity: 'gaming', activityConfirmed: true });
    expect(needsActivityConfirmation(s.state(), setup)).toBe(false);
    const html = render(s.state());
    expect(offersConfirm(html)).toBe(false);
    expect(html).toContain('Gaming confirmed');
  });

  it('confirming gaming BEFORE consent shows the confirmed state on the waiting screen and after consent', () => {
    const s = engineSession();
    s.confirm();
    const waiting = render(s.state());
    expect(offersConfirm(waiting)).toBe(false);
    expect(waiting).toContain('Gaming confirmed.');
    s.consent();
    expect(offersConfirm(render(s.state()))).toBe(false);
  });

  it('is never offered without setup controls (simulation) or after the session ended', () => {
    const s = engineSession();
    s.consent();
    expect(needsActivityConfirmation(s.state(), undefined)).toBe(false);
    expect(needsActivityConfirmation({ ...s.state(), status: 'ended' }, setup)).toBe(false);
  });
});
