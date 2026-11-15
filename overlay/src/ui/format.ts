/** Display labels and formatting shared by components. */
import type { Observation, RecommendationStatus, SessionStatus } from '../contracts/sidekick';
import type { TimelineEventType } from '../contracts/proposed';

/** "12:45:03" in the viewer's locale, or "time unknown" (design.md §4). */
export function formatClock(iso?: string): string {
  if (!iso) return 'time unknown';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'time unknown';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export const SOURCE_LABEL: Record<Observation['source'], string> = {
  screen: 'Screen',
  transcript: 'Conversation',
  participant_report: 'Participant report',
};

/** Evidence quality as words — never a confidence percentage. */
export const QUALITY_LABEL: Record<Observation['evidenceQuality'], string> = {
  clear: 'Clear',
  partial: 'Partial view',
  unknown: 'Unclear',
};

export const REC_STATUS_LABEL: Record<RecommendationStatus, string> = {
  active: 'Current',
  stale: 'Earlier · not currently verified',
  resolved: 'Resolved by later observation',
  dismissed: 'Dismissed',
};

export const SESSION_STATUS_LABEL: Record<SessionStatus, string> = {
  starting: 'Not started',
  active: 'Observing',
  paused: 'Paused',
  ended: 'Ended',
};

export const EVENT_LABEL: Record<TimelineEventType, string> = {
  session_started: 'Session started',
  session_ended: 'Session ended',
  session_paused: 'Paused',
  session_resumed: 'Resumed',
  activity_confirmed: 'Activity confirmed',
  role_updated: 'Role recorded',
  observation: 'Observation',
  recommendation_created: 'Recommendation shown',
  recommendation_dismissed: 'Dismissed',
  recommendation_resolved: 'Resolved',
  recommendation_stale: 'Marked earlier',
  voice_requested: 'Voice requested',
  voice_finished: 'Voice finished',
  voice_cancelled: 'Voice stopped',
  voice_failed: 'Voice failed',
};

export function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}
