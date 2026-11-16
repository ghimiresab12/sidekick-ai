/**
 * Regressions found in the cohesion audit:
 * - When the session's single explanation slot is taken (another device, or a request the
 *   bridge has not released yet), the engine sets `canExplain: false` and the hint wrongly
 *   said explanations need "open advice while Sidekick is observing".
 * - After "Reconnect", the connection is `connecting` again, and the banner disappeared
 *   while actions stayed disabled.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { RecommendationView } from '../contracts/shared';
import { IDLE_VOICE_STATE } from '../voice/voiceController';
import type { VoiceApi } from '../voice/useVoiceExplanation';
import { ConnectionBanner } from './StateScreens';
import { VoiceControls } from './VoiceControls';

const rec = (over: Partial<RecommendationView> = {}): RecommendationView => ({
  id: 'r1',
  status: 'active',
  title: 'Left defense appears exposed',
  shortAdvice: 'Ask Alex to cover left defense.',
  urgency: 'important',
  createdAt: '2026-11-15T12:00:00.000Z',
  lastConditionAt: '2026-11-15T12:00:00.000Z',
  evidence: [],
  relatedParticipants: [],
  contextChangedSinceCreation: false,
  canExplain: true,
  ...over,
});
const voice = { state: IDLE_VOICE_STATE, busy: false, explain: async () => {}, stop: () => {} } as unknown as VoiceApi;
const controls = (r: RecommendationView, sessionVoiceBusy: boolean) =>
  renderToStaticMarkup(createElement(VoiceControls, { rec: r, live: true, voice, sessionVoiceBusy }));

describe('Explain hint', () => {
  it('says another explanation holds the slot when the session voice is busy', () => {
    const html = controls(rec({ canExplain: false }), true);
    expect(html).toContain('Another explanation is in progress in this session');
    expect(html).not.toContain('while Sidekick is observing');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*Explain with voice/);
  });

  it('keeps the observing hint when the card cannot be explained for another reason', () => {
    expect(controls(rec({ status: 'stale', canExplain: false }), false)).toContain('while Sidekick is observing');
    expect(controls(rec({ canExplain: false }), false)).toContain('while Sidekick is observing');
  });

  it('shows no hint and an enabled button when the card can be explained', () => {
    const html = controls(rec(), false);
    expect(html).not.toContain('class="hint"');
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>.*Explain with voice/);
  });
});

describe('Connection banner', () => {
  const banner = (status: 'connected' | 'connecting' | 'reconnecting' | 'unavailable') =>
    renderToStaticMarkup(createElement(ConnectionBanner, { status, detail: null, onRetry: () => {} }));

  it('is visible during a manual reconnect (connecting with a state already shown)', () => {
    expect(banner('connecting')).toContain('Reconnecting');
    expect(banner('reconnecting')).toContain('Reconnecting');
  });

  it('offers Reconnect only when unavailable, and hides when connected', () => {
    expect(banner('unavailable')).toContain('Reconnect</button>');
    expect(banner('connecting')).not.toContain('Reconnect</button>');
    expect(banner('connected')).toBe('');
  });
});
