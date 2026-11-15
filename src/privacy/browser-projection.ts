/**
 * Explicit server-side projection of everything a paired browser may see.
 *
 * Raw evidence stays in the engine for reasoning. Browsers receive:
 * - NO goal or decision wording (it is stored as the exact spoken utterance, because
 *   reasoning requires verbatim quotes);
 * - role text ONLY when it is one of the canonical roles of the controlled gaming demo
 *   (`CANONICAL_ROLES`); any other role becomes the fixed label "assigned role";
 * - timeline summaries REBUILT from structured fields, never the engine's summary text
 *   (the one exception is screen observations, whose summary is the vision adapter's
 *   fixed, image-derived wording — the same text the explanation uses);
 * - objects CONSTRUCTED field by field from an approved list. Nothing here spreads an
 *   internal object, so a field added to an engine type later never leaks by default.
 *
 * `projectTimelineEvent` uses an exhaustive switch: a new event type is a compile error
 * here until someone decides what browsers may see of it.
 */
import type {
  BrowserDecision,
  BrowserSessionEvent,
  OverlayState,
  Participant,
  RecommendationView,
  RoleChange,
  SessionEvent,
  StaleReason,
  VoiceRequest,
} from '../contracts/types.js';

export const ROLE_FALLBACK = 'assigned role';

/**
 * Canonical display label → accepted spellings (compared after `roleKey`). These are the
 * positions of the controlled soccer demo. Spelling variants (defence/defense,
 * centre/center) collapse to one label; distinct positions keep their own word. Extending the list is a privacy decision:
 * only add generic game positions, never free text.
 */
const ROLE_SPELLINGS: Record<string, string[]> = {
  'left defense': ['left defense', 'left defence', 'left defender', 'left defensive zone', 'left defensive side'],
  'right defense': ['right defense', 'right defence', 'right defender', 'right defensive zone'],
  'center defense': ['center defense', 'centre defense', 'center defence', 'centre defence', 'central defense', 'central defence'],
  'left back': ['left back', 'leftback'],
  'right back': ['right back', 'rightback'],
  'center back': ['center back', 'centre back', 'centreback', 'centerback'],
  defense: ['defense', 'defence'],
  defender: ['defender'],
  goalkeeper: ['goalkeeper', 'goal keeper'],
  goalie: ['goalie'],
  keeper: ['keeper'],
  midfield: ['midfield'],
  midfielder: ['midfielder'],
  'left wing': ['left wing'],
  'right wing': ['right wing'],
  'left winger': ['left winger'],
  'right winger': ['right winger'],
  attack: ['attack'],
  attacker: ['attacker'],
  forward: ['forward'],
  striker: ['striker'],
  'backup coverage': ['backup coverage'],
  backup: ['backup'],
};
const ROLE_LOOKUP = new Map<string, string>(
  Object.entries(ROLE_SPELLINGS).flatMap(([label, spellings]) => spellings.map((s) => [s, label] as [string, string])),
);
export const CANONICAL_ROLES: readonly string[] = Object.freeze(Object.keys(ROLE_SPELLINGS));

/** Lower-case, NFKC, hyphens/underscores as spaces, collapsed whitespace, leading article removed. */
function roleKey(role: string): string {
  return role
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!]$/, '')
    .replace(/^(?:the|our|their) /, '');
}

/** A canonical role label if `role` is on the allowlist; otherwise "assigned role". */
export function safeRoleLabel(role: string | undefined): string | undefined {
  if (role === undefined) return undefined;
  return ROLE_LOOKUP.get(roleKey(role)) ?? ROLE_FALLBACK;
}

type BrowserPerson = { id: string; displayName: string; role?: string };
function person(id: string, displayName: string, role: string | undefined): BrowserPerson {
  const label = safeRoleLabel(role);
  return label !== undefined ? { id, displayName, role: label } : { id, displayName };
}

export function projectParticipant(p: Participant): BrowserPerson {
  return person(p.id, p.displayName, p.role);
}

/** A voice request as the browser sees it (explicit fields). */
export function projectVoiceRequest(r: VoiceRequest): VoiceRequest {
  const out: VoiceRequest = {
    id: r.id,
    sessionId: r.sessionId,
    recommendationId: r.recommendationId,
    status: r.status,
    requestedAt: r.requestedAt,
    updatedAt: r.updatedAt,
  };
  if (r.requesterParticipantId !== undefined) out.requesterParticipantId = r.requesterParticipantId;
  if (r.cancelReason !== undefined) out.cancelReason = r.cancelReason;
  return out;
}

function projectView(v: RecommendationView): RecommendationView {
  const out: RecommendationView = {
    id: v.id,
    status: v.status,
    title: v.title,
    shortAdvice: v.shortAdvice,
    urgency: v.urgency,
    createdAt: v.createdAt,
    lastConditionAt: v.lastConditionAt,
    evidence: v.evidence.map((e) => ({ observationId: e.observationId, kind: e.kind, source: e.source, observedAt: e.observedAt })),
    relatedParticipants: v.relatedParticipants.map((p) => person(p.id, p.displayName, p.role)),
    contextChangedSinceCreation: v.contextChangedSinceCreation,
    canExplain: v.canExplain,
  };
  if (v.staleReason !== undefined) out.staleReason = v.staleReason;
  if (v.voice !== undefined) out.voice = { requestId: v.voice.requestId, status: v.voice.status };
  return out;
}

/** The live OverlayState as a browser may see it. */
export function projectOverlayState(state: OverlayState): OverlayState {
  const out: OverlayState = {
    sessionId: state.sessionId,
    version: state.version,
    status: state.status,
    activity: state.activity,
    activityConfirmed: state.activityConfirmed,
    history: state.history.map(projectView),
    voiceBusy: state.voiceBusy,
  };
  if (state.suggestedActivity !== undefined) out.suggestedActivity = state.suggestedActivity;
  if (state.prominent !== undefined) out.prominent = projectView(state.prominent);
  if (state.activeVoiceRequest !== undefined) {
    const a = state.activeVoiceRequest;
    out.activeVoiceRequest = { requestId: a.requestId, recommendationId: a.recommendationId, status: a.status };
  }
  return out;
}

function projectRoleChange(c: RoleChange): RoleChange {
  const out: RoleChange = {
    revision: c.revision,
    kind: c.kind,
    participantId: c.participantId,
    effectiveAt: c.effectiveAt,
    recordedAt: c.recordedAt,
    source: c.source,
  };
  if (c.role !== undefined) out.role = safeRoleLabel(c.role)!;
  if (c.previousRole !== undefined) out.previousRole = safeRoleLabel(c.previousRole)!;
  if (c.sourceObservationId !== undefined) out.sourceObservationId = c.sourceObservationId;
  return out;
}

/** Same fixed wording as the engine's stale summaries. */
const STALE_LABELS: Record<StaleReason, string> = {
  no_recent_condition_evidence: 'No recent condition evidence',
  session_paused: 'Session paused; advice no longer verified',
  session_ended: 'Session ended; advice refers to an earlier moment',
  role_changed: 'Related role changed',
  goal_changed: 'Related goal changed',
};

/** What the timeline projection may look up: names and card titles the browser already sees. */
export interface TimelineLookup {
  names: ReadonlyMap<string, string>;
  /** recommendation id → title (identical to the card title in the live state). */
  titles?: ReadonlyMap<string, string>;
}

/** One timeline event as a browser may see it. */
export function projectTimelineEvent(e: SessionEvent, { names, titles }: TimelineLookup): BrowserSessionEvent {
  const who = (id: string | undefined) => (id !== undefined ? names.get(id) : undefined) ?? 'A participant';
  const advice = (id: string) => titles?.get(id) ?? 'advice';
  const base = (summary: string) => ({ id: e.id, sessionId: e.sessionId, time: e.time, recordedAt: e.recordedAt, summary });
  switch (e.type) {
    case 'session_started':
      return { ...base('Session started with participant consent'), type: e.type };
    case 'session_paused':
      return { ...base('Observation paused'), type: e.type };
    case 'session_resumed':
      return { ...base('Observation resumed'), type: e.type };
    case 'session_ended':
      return { ...base('Session ended; observation stopped'), type: e.type };
    case 'participant_added':
      return { ...base(`Participant added: ${who(e.participantId)}`), type: e.type, participantId: e.participantId, displayName: who(e.participantId) };
    case 'activity_confirmed':
      return { ...base(`Activity confirmed: ${e.activity}`), type: e.type, activity: e.activity };
    case 'goal_set':
    case 'goal_retired': {
      const out = {
        ...base(e.type === 'goal_set' ? 'Group goal stated' : 'Group goal retired'),
        type: e.type, goalId: e.goalId, source: e.source, revision: e.revision,
      };
      return e.sourceObservationId !== undefined ? { ...out, sourceObservationId: e.sourceObservationId } : out;
    }
    case 'decision_recorded': {
      const d = e.decision;
      const decision: BrowserDecision = {
        id: d.id, decidedAt: d.decidedAt, recordedAt: d.recordedAt, source: d.source,
        sourceObservationIds: [...d.sourceObservationIds], participantIds: [...d.participantIds],
      };
      if (d.relatedRecommendationId !== undefined) decision.relatedRecommendationId = d.relatedRecommendationId;
      if (d.relatedGoalId !== undefined) decision.relatedGoalId = d.relatedGoalId;
      return { ...base('Group decision recorded'), type: e.type, decision };
    }
    case 'role_updated': {
      const change = projectRoleChange(e.change);
      const summary = change.kind === 'assigned'
        ? `${who(change.participantId)} assigned role: ${change.role}`
        : `${who(change.participantId)} role cleared`;
      return { ...base(summary), type: e.type, change };
    }
    case 'observation': {
      const summary = e.source === 'transcript'
        ? `Speech observed (${e.speakerParticipantId ? who(e.speakerParticipantId) : 'speaker unverified'})`
        : e.summary; // screen: the vision adapter's fixed, image-derived wording
      const out = { ...base(summary), type: e.type, observationId: e.observationId, source: e.source };
      return e.source === 'transcript' && e.speakerParticipantId !== undefined ? { ...out, speakerParticipantId: e.speakerParticipantId } : out;
    }
    case 'recommendation_created': {
      const out = {
        ...base(`Advice shown: ${advice(e.recommendationId)}`), type: e.type, recommendationId: e.recommendationId,
        fingerprint: e.fingerprint, conditionObservationIds: [...e.conditionObservationIds],
        contextObservationIds: [...e.contextObservationIds], relatedParticipantIds: [...e.relatedParticipantIds],
        contextRevision: e.contextRevision,
      };
      return e.relatedGoalId !== undefined ? { ...out, relatedGoalId: e.relatedGoalId } : out;
    }
    case 'recommendation_dismissed':
      return { ...base(`Advice dismissed: ${advice(e.recommendationId)}`), type: e.type, recommendationId: e.recommendationId };
    case 'recommendation_resolved':
      return { ...base(`Issue appears resolved: ${advice(e.recommendationId)}`), type: e.type, recommendationId: e.recommendationId, observationId: e.observationId };
    case 'recommendation_stale': {
      const out: BrowserSessionEvent = {
        ...base(`${STALE_LABELS[e.reason]}: ${advice(e.recommendationId)}`),
        type: e.type, recommendationId: e.recommendationId, reason: e.reason,
      };
      if (e.participantId !== undefined) out.participantId = e.participantId;
      if (e.goalId !== undefined) out.goalId = e.goalId;
      return out;
    }
    case 'voice_requested': {
      const out = { ...base(`Explanation requested: ${advice(e.recommendationId)}`), type: e.type, recommendationId: e.recommendationId, voiceRequestId: e.voiceRequestId };
      return e.requesterParticipantId !== undefined ? { ...out, requesterParticipantId: e.requesterParticipantId } : out;
    }
    case 'voice_finished': {
      const out = { ...base(`Explanation ${e.outcome}: ${advice(e.recommendationId)}`), type: e.type, recommendationId: e.recommendationId, voiceRequestId: e.voiceRequestId, outcome: e.outcome };
      return e.cancelReason !== undefined ? { ...out, cancelReason: e.cancelReason } : out;
    }
    default: {
      const unreachable: never = e;
      return unreachable;
    }
  }
}
