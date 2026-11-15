/** Display labels and formatting shared by components. */
import type {
  ObservationSource,
  RecommendationStatus,
  SessionEvent,
  SessionStatus,
  StaleReason,
  VoiceRequestStatus,
} from '../contracts/shared';

/** "12:45:03" in the viewer's locale, or "time unknown" (design.md §4). */
export function formatClock(iso?: string): string {
  if (!iso) return 'time unknown';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'time unknown';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export const SOURCE_LABEL: Record<ObservationSource, string> = {
  screen: 'Screen',
  transcript: 'Conversation',
};

/** RecommendationView.evidence[].kind: what the observation shows. */
export const EVIDENCE_KIND_LABEL: Record<'condition' | 'context', string> = {
  condition: 'shows the situation',
  context: 'context',
};

export const REC_STATUS_LABEL: Record<RecommendationStatus, string> = {
  active: 'Current',
  stale: 'Earlier · not currently verified',
  resolved: 'Resolved by later observation',
  dismissed: 'Dismissed',
};

/** Why a card is earlier advice (engine `staleReason`). */
export const STALE_REASON_LABEL: Record<StaleReason, string> = {
  no_recent_condition_evidence: 'No recent observation has re-confirmed it.',
  session_paused: 'Observation was paused, so it has not been re-checked.',
  session_ended: 'The session ended.',
  role_changed: 'A related role changed after this advice was made.',
  goal_changed: 'A related goal changed after this advice was made.',
};

export const SESSION_STATUS_LABEL: Record<SessionStatus, string> = {
  starting: 'Not started',
  active: 'Observing',
  paused: 'Paused',
  ended: 'Ended',
};

export const VOICE_REQUEST_LABEL: Record<VoiceRequestStatus, string> = {
  pending: 'Explanation requested',
  playing_locally: 'Explanation playing',
  finished: 'Explanation finished',
  failed: 'Explanation failed',
  cancelled: 'Explanation stopped',
};

const EVENT_LABEL: Record<SessionEvent['type'], string> = {
  session_started: 'Session started',
  session_ended: 'Session ended',
  session_paused: 'Paused',
  session_resumed: 'Resumed',
  participant_added: 'Participant added',
  activity_confirmed: 'Activity confirmed',
  role_updated: 'Role recorded',
  goal_set: 'Goal recorded',
  goal_retired: 'Goal retired',
  decision_recorded: 'Decision recorded',
  observation: 'Observation',
  recommendation_created: 'Recommendation shown',
  recommendation_dismissed: 'Dismissed',
  recommendation_resolved: 'Resolved',
  recommendation_stale: 'Marked earlier',
  voice_requested: 'Voice requested',
  voice_finished: 'Voice finished',
};

/** Timeline label. `voice_finished` carries its real outcome (finished / stopped / failed). */
export function eventLabel(event: SessionEvent): string {
  if (event.type === 'voice_finished') {
    if (event.outcome === 'cancelled') return event.cancelReason === 'user' ? 'Voice stopped' : 'Voice cancelled';
    if (event.outcome === 'failed') return 'Voice failed';
  }
  return EVENT_LABEL[event.type] ?? event.type;
}

export function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}
