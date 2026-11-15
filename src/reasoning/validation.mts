import type { ReasoningInput, ModelOutput } from './contracts.mts';

type Obj = Record<string, unknown>;
export function object(value: unknown): asserts value is Obj {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw Error('Expected object');
}
function text(value: unknown, max = 128): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw Error('Invalid text');
}
function integer(value: unknown, min = 0): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < min) throw Error('Invalid integer');
}
function boolean(value: unknown): asserts value is boolean {
  if (typeof value !== 'boolean') throw Error('Invalid boolean');
}
function oneOf(value: unknown, values: readonly string[]) {
  if (!values.includes(value as string)) throw Error('Invalid enum');
}
function list(value: unknown, max: number): asserts value is unknown[] {
  if (!Array.isArray(value) || value.length > max) throw Error('Invalid array');
}
function ids(value: unknown, required = false, max = 50): asserts value is string[] {
  list(value, max);
  value.forEach(v => text(v));
  if ((required && value.length === 0) || new Set(value).size !== value.length) throw Error('Invalid evidence IDs');
}
function keys(value: Obj, allowed: string[]) {
  if (Object.keys(value).some(k => !allowed.includes(k))) throw Error('Unexpected field');
}
export function time(value: unknown): number {
  text(value, 64);
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!m) throw Error('Invalid timestamp');
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number) as number[];
  const leap = year! % 4 === 0 && (year! % 100 !== 0 || year! % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month! < 1 || month! > 12 || day! < 1 || day! > days[month! - 1]! || hour! > 23 || minute! > 59 || second! > 59 || Number(m[8] ?? 0) > 23 || Number(m[9] ?? 0) > 59) throw Error('Invalid calendar time');
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw Error('Invalid time');
  return ms;
}

/** Reads unknown JSON safely; extra engine snapshot fields are allowed but not forwarded. */
export function validateInput(value: unknown): asserts value is ReasoningInput {
  object(value);
  const now = time(value.now);
  integer(value.staleAfterMs, 1);
  if (value.staleAfterMs > 3_600_000) throw Error('Unbounded freshness window');
  const skew = value.maxClockSkewMs === undefined ? 0 : value.maxClockSkewMs;
  integer(skew);
  if (skew > 5000) throw Error('Unbounded clock skew');
  object(value.session);
  const s = value.session;
  text(s.id); integer(s.contextRevision); integer(s.captureGeneration, 1);
  oneOf(s.status, ['starting', 'active', 'paused', 'ended']);
  oneOf(s.activity, ['unconfirmed', 'gaming', 'planning', 'social']);
  boolean(s.consentGiven); boolean(s.activityConfirmed);
  list(s.participants, 20); list(s.goals, 50);
  const participantIds = new Set<string>();
  for (const p of s.participants) {
    object(p); text(p.id); text(p.displayName, 80);
    if (participantIds.has(p.id)) throw Error('Duplicate participant');
    participantIds.add(p.id);
    if (p.role !== undefined) text(p.role, 80);
    if (p.lastRoleChange !== undefined) {
      object(p.lastRoleChange);
      integer(p.lastRoleChange.revision); time(p.lastRoleChange.effectiveAt);
      oneOf(p.lastRoleChange.source, ['transcript', 'manual', 'participant_report']);
      if (p.lastRoleChange.sourceObservationId !== undefined) text(p.lastRoleChange.sourceObservationId);
    }
  }
  const goalIds = new Set<string>();
  for (const g of s.goals) {
    object(g); text(g.id); text(g.text, 200); boolean(g.active);
    if (goalIds.has(g.id)) throw Error('Duplicate goal');
    goalIds.add(g.id);
    if (g.sourceObservationId !== undefined) text(g.sourceObservationId);
  }
  list(value.observations, 100);
  const seen = new Set<string>();
  for (const o of value.observations) {
    object(o); text(o.id); text(o.sessionId); integer(o.captureGeneration, 1);
    if (o.sessionId !== s.id || seen.has(o.id) || o.captureGeneration > s.captureGeneration) throw Error('Invalid observation scope');
    seen.add(o.id);
    const observed = time(o.observedAt); const received = time(o.receivedAt);
    // Only source clocks may differ. receivedAt is produced by the engine's clock.
    if (observed - now > skew || received > now) throw Error('Future evidence');
    if (o.source === 'transcript') {
      text(o.text, 1000);
      if (o.speakerParticipantId !== undefined && !participantIds.has(o.speakerParticipantId as string)) throw Error('Unknown speaker');
    } else if (o.source === 'screen') {
      oneOf(o.mediaSource, ['camera', 'screen_share']);
      text(o.summary, 500); oneOf(o.evidenceQuality, ['clear', 'partial', 'unknown']);
      if (o.frameRef !== undefined) {
        text(o.frameRef, 256);
        if (o.frameRef.startsWith('data:')) throw Error('Raw media forbidden');
      }
      if (o.facts !== undefined) {
        object(o.facts);
        if (Object.keys(o.facts).length > 50) throw Error('Too many facts');
        for (const [k, v] of Object.entries(o.facts)) {
          text(k, 64);
          if (!(typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.length <= 200))) throw Error('Invalid fact');
        }
      }
    } else throw Error('Invalid source');
  }
}

function quotes(value: unknown) {
  list(value, 50);
  if (!value.length) throw Error('Missing excerpts');
  for (const q of value) {
    object(q); keys(q, ['observationId', 'quote']); text(q.observationId); text(q.quote, 1000);
  }
}

export function validateModelOutput(value: unknown): asserts value is ModelOutput {
  object(value); keys(value, ['contextUpdates', 'recommendationCandidates', 'uncertainties']);
  list(value.contextUpdates, 20); list(value.recommendationCandidates, 5); list(value.uncertainties, 10);
  value.uncertainties.forEach(v => text(v, 300));
  for (const u of value.contextUpdates) {
    object(u); ids(u.sourceObservationIds, true); quotes(u.evidenceQuotes);
    const base = ['type', 'sourceObservationIds', 'evidenceQuotes'];
    switch (u.type) {
      case 'role_assignment': keys(u, [...base, 'participantId', 'role']); text(u.participantId); text(u.role, 80); break;
      case 'group_goal': keys(u, [...base, 'text']); text(u.text, 200); break;
      case 'participant_decision': keys(u, [...base, 'text', 'participantIds']); text(u.text, 300); ids(u.participantIds, false, 20); break;
      case 'activity_identification': keys(u, [...base, 'activity']); oneOf(u.activity, ['gaming']); break;
      default: throw Error('Invalid proposal type');
    }
  }
  for (const c of value.recommendationCandidates) {
    object(c);
    keys(c, ['fingerprint', 'title', 'shortAdvice', 'urgency', 'conditionObservationIds', 'contextObservationIds', 'relatedParticipantIds', 'relatedGoalId', 'evidenceQuotes', 'situation']);
    text(c.fingerprint, 100); text(c.title, 80); text(c.shortAdvice, 200);
    if (!/^[A-Za-z0-9_.:-]+$/.test(c.fingerprint)) throw Error('Invalid fingerprint');
    oneOf(c.urgency, ['normal', 'important']);
    ids(c.conditionObservationIds, true); ids(c.contextObservationIds);
    const contextIds = c.contextObservationIds;
    if (c.conditionObservationIds.some(id => contextIds.includes(id))) throw Error('Evidence overlap');
    if (c.relatedParticipantIds !== undefined) ids(c.relatedParticipantIds, false, 20);
    if (c.relatedGoalId !== undefined) text(c.relatedGoalId);
    quotes(c.evidenceQuotes); object(c.situation);
    keys(c.situation, ['leftZoneVisible', 'leftZoneUncovered', 'certainty']);
    boolean(c.situation.leftZoneVisible); boolean(c.situation.leftZoneUncovered);
    oneOf(c.situation.certainty, ['clear', 'uncertain']);
  }
}
