/**
 * Boundary validation for everything that enters the engine from adapters,
 * the reasoning layer or the UI. Hand-written on purpose (no schema dependency
 * until the Chert starter shows which library, if any, it already uses).
 *
 * Every check accepts `unknown` and never throws, so malformed input from any
 * caller becomes a `Result` error instead of an exception.
 */
import type { Activity, ContextSource, EngineError, EvidenceQuality, Urgency, VoiceCancelReason } from './types.js';

export const LIMITS = {
  id: 128,
  transcriptText: 1000,
  screenSummary: 500,
  frameRef: 256,
  externalRef: 256,
  displayName: 80,
  role: 80,
  goalText: 200,
  decisionText: 300,
  fingerprint: 100,
  title: 80,
  shortAdvice: 200,
  factKeys: 50,
  factKey: 64,
  factStringValue: 200,
  evidenceIds: 50,
  relatedIds: 20,
  listObservationsDefault: 100,
  listObservationsMax: 500,
  listObservationIds: 100,
} as const;

export type Check = { ok: true } | { ok: false; error: EngineError; detail: string };

const OK: Check = { ok: true };
const fail = (error: EngineError, detail: string): Check => ({ ok: false, error, detail });

const ISO_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?(Z|[+-](\d{2}):(\d{2}))$/;

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Parses a strict ISO 8601 timestamp with an explicit timezone and returns epoch ms,
 * or `undefined` if invalid. Rejects calendar overflow such as Feb 30, which
 * `Date.parse` silently rolls over.
 */
export function parseIsoTime(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const m = ISO_RE.exec(value);
  if (!m) return undefined;
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number) as [
    number, number, number, number, number, number,
  ];
  if (month < 1 || month > 12) return undefined;
  if (day < 1 || day > daysInMonth(year, month)) return undefined;
  if (hour > 23 || minute > 59 || second > 59) return undefined;
  if (m[8] !== 'Z' && (Number(m[9]) > 23 || Number(m[10]) > 59)) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isNonEmptyString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

export function isId(value: unknown): value is string {
  return isNonEmptyString(value, LIMITS.id);
}

function checkString(name: string, value: unknown, max: number): Check {
  return isNonEmptyString(value, max)
    ? OK
    : fail('invalid_input', `${name} must be a non-empty string of at most ${max} characters`);
}

function checkOptionalString(name: string, value: unknown, max: number): Check {
  return value === undefined ? OK : checkString(name, value, max);
}

function checkGeneration(value: unknown): Check {
  return Number.isSafeInteger(value) && (value as number) >= 1
    ? OK
    : fail('invalid_generation', 'captureGeneration must be a positive integer read from the session');
}

function checkTimestamp(name: string, value: unknown): Check {
  return parseIsoTime(value) === undefined
    ? fail('invalid_timestamp', `${name} must be an ISO 8601 timestamp with timezone`)
    : OK;
}

const EVIDENCE_QUALITIES: readonly EvidenceQuality[] = ['clear', 'partial', 'unknown'];
const URGENCIES: readonly Urgency[] = ['normal', 'important'];
const CONTEXT_SOURCES: readonly ContextSource[] = ['transcript', 'participant_report', 'manual'];
const ACTIVITIES: readonly Activity[] = ['unconfirmed', 'gaming', 'planning', 'social'];
const CLIENT_CANCEL_REASONS: readonly VoiceCancelReason[] = ['user', 'client_disconnected'];
const FINGERPRINT_RE = /^[A-Za-z0-9_.:-]+$/;

function firstFailure(...checks: Check[]): Check {
  return checks.find((c) => !c.ok) ?? OK;
}

export function checkFacts(value: unknown): Check {
  if (value === undefined) return OK;
  if (!isObject(value)) return fail('invalid_input', 'facts must be an object');
  const entries = Object.entries(value);
  if (entries.length > LIMITS.factKeys) {
    return fail('invalid_input', `facts may have at most ${LIMITS.factKeys} keys`);
  }
  for (const [key, v] of entries) {
    if (key.length === 0 || key.length > LIMITS.factKey) {
      return fail('invalid_input', `fact key "${key}" has invalid length`);
    }
    const okValue =
      typeof v === 'boolean' ||
      (typeof v === 'number' && Number.isFinite(v)) ||
      (typeof v === 'string' && v.length <= LIMITS.factStringValue);
    if (!okValue) return fail('invalid_input', `fact "${key}" must be a boolean, finite number or short string`);
  }
  return OK;
}

export function checkIdList(name: string, value: unknown, max: number, required: boolean): Check {
  if (value === undefined && !required) return OK;
  if (!Array.isArray(value)) return fail('invalid_input', `${name} must be an array`);
  if (required && value.length === 0) return fail('invalid_input', `${name} must not be empty`);
  if (value.length > max) return fail('invalid_input', `${name} may have at most ${max} entries`);
  if (!value.every(isId)) return fail('invalid_input', `${name} must contain non-empty string IDs`);
  return OK;
}

export function checkCreateSessionOptions(input: unknown): Check {
  if (input === undefined) return OK;
  if (!isObject(input)) return fail('invalid_input', 'options must be an object');
  return checkOptionalString('externalRef', input.externalRef, LIMITS.externalRef);
}

export function checkParticipantInput(input: unknown): Check {
  if (!isObject(input)) return fail('invalid_input', 'participant input must be an object');
  return firstFailure(
    checkString('displayName', input.displayName, LIMITS.displayName),
    checkOptionalString('externalRef', input.externalRef, LIMITS.externalRef),
  );
}

/** Shape-only check of `ContextOptions`; session-level provenance is checked by the engine. */
export function checkContextOptions(input: unknown): Check {
  if (!isObject(input)) return fail('invalid_input', 'options must be an object with a source');
  if (!isContextSource(input.source)) {
    return fail('invalid_input', 'source must be transcript | participant_report | manual');
  }
  if (input.sourceObservationId !== undefined && !isId(input.sourceObservationId)) {
    return fail('invalid_input', 'sourceObservationId must be a string ID');
  }
  if (input.source === 'transcript' && input.sourceObservationId === undefined) {
    return fail('invalid_input', 'transcript-derived context requires sourceObservationId');
  }
  return OK;
}

export function checkConversationInput(input: unknown): Check {
  if (!isObject(input)) return fail('invalid_input', 'conversation input must be an object');
  return firstFailure(
    checkGeneration(input.captureGeneration),
    checkTimestamp('observedAt', input.observedAt),
    checkString('text', input.text, LIMITS.transcriptText),
    checkOptionalString('speakerRef', input.speakerRef, LIMITS.externalRef),
  );
}

export function checkScreenInput(input: unknown): Check {
  if (!isObject(input)) return fail('invalid_input', 'screen input must be an object');
  const frameRef = input.frameRef;
  return firstFailure(
    input.mediaSource === 'camera' || input.mediaSource === 'screen_share'
      ? OK
      : fail('invalid_input', 'mediaSource must be camera | screen_share'),
    checkGeneration(input.captureGeneration),
    checkTimestamp('observedAt', input.observedAt),
    checkString('summary', input.summary, LIMITS.screenSummary),
    EVIDENCE_QUALITIES.includes(input.evidenceQuality as EvidenceQuality)
      ? OK
      : fail('invalid_input', 'evidenceQuality must be clear | partial | unknown'),
    checkFacts(input.facts),
    checkOptionalString('frameRef', frameRef, LIMITS.frameRef),
    typeof frameRef === 'string' && frameRef.startsWith('data:')
      ? fail('invalid_input', 'frameRef must be a reference, not inline media')
      : OK,
  );
}

export function checkCandidate(input: unknown): Check {
  if (!isObject(input)) return fail('invalid_input', 'recommendation candidate must be an object');
  const shape = firstFailure(
    checkString('fingerprint', input.fingerprint, LIMITS.fingerprint),
    typeof input.fingerprint === 'string' && !FINGERPRINT_RE.test(input.fingerprint)
      ? fail('invalid_input', 'fingerprint may contain only letters, digits and _ . : -')
      : OK,
    checkString('title', input.title, LIMITS.title),
    checkString('shortAdvice', input.shortAdvice, LIMITS.shortAdvice),
    checkIdList('conditionObservationIds', input.conditionObservationIds, LIMITS.evidenceIds, true),
    checkIdList('contextObservationIds', input.contextObservationIds, LIMITS.evidenceIds, false),
    checkIdList('relatedParticipantIds', input.relatedParticipantIds, LIMITS.relatedIds, false),
    input.relatedGoalId === undefined || isId(input.relatedGoalId)
      ? OK
      : fail('invalid_input', 'relatedGoalId must be a string ID'),
    URGENCIES.includes(input.urgency as Urgency)
      ? OK
      : fail('invalid_input', 'urgency must be normal | important'),
    Number.isSafeInteger(input.basedOnContextRevision) && (input.basedOnContextRevision as number) >= 0
      ? OK
      : fail('invalid_input', 'basedOnContextRevision must be the contextRevision read from the session'),
  );
  if (!shape.ok) return shape;
  const condition = new Set(input.conditionObservationIds as string[]);
  const context = (input.contextObservationIds as string[] | undefined) ?? [];
  if (context.some((id) => condition.has(id))) {
    return fail('invalid_input', 'an observation cannot be both condition and context evidence');
  }
  return OK;
}

export function checkDecisionInput(input: unknown): Check {
  if (!isObject(input)) return fail('invalid_input', 'decision input must be an object');
  const shape = firstFailure(
    checkString('text', input.text, LIMITS.decisionText),
    isContextSource(input.source)
      ? OK
      : fail('invalid_input', 'source must be transcript | participant_report | manual'),
    checkIdList('sourceObservationIds', input.sourceObservationIds, LIMITS.evidenceIds, false),
    checkIdList('participantIds', input.participantIds, LIMITS.relatedIds, false),
    input.relatedRecommendationId === undefined || isId(input.relatedRecommendationId)
      ? OK
      : fail('invalid_input', 'relatedRecommendationId must be a string ID'),
    input.relatedGoalId === undefined || isId(input.relatedGoalId)
      ? OK
      : fail('invalid_input', 'relatedGoalId must be a string ID'),
  );
  if (!shape.ok) return shape;
  const ids = input.sourceObservationIds as string[] | undefined;
  if (input.source === 'transcript' && (!ids || ids.length === 0)) {
    return fail('invalid_input', 'transcript-derived decisions require sourceObservationIds');
  }
  return OK;
}

export function checkListObservationsQuery(input: unknown): Check {
  if (input === undefined) return OK;
  if (!isObject(input)) return fail('invalid_input', 'query must be an object');
  return firstFailure(
    input.source === undefined || input.source === 'transcript' || input.source === 'screen'
      ? OK
      : fail('invalid_input', 'source must be transcript | screen'),
    input.captureGeneration === undefined ||
      (Number.isSafeInteger(input.captureGeneration) && (input.captureGeneration as number) >= 0)
      ? OK
      : fail('invalid_input', 'captureGeneration must be a non-negative integer'),
    input.observedSince === undefined ? OK : checkTimestamp('observedSince', input.observedSince),
    input.observedUntil === undefined ? OK : checkTimestamp('observedUntil', input.observedUntil),
    input.keep === undefined || input.keep === 'newest' || input.keep === 'oldest'
      ? OK
      : fail('invalid_input', 'keep must be newest | oldest'),
    checkIdList('ids', input.ids, LIMITS.listObservationIds, false),
    input.limit === undefined ||
      (Number.isSafeInteger(input.limit) && (input.limit as number) >= 1 && (input.limit as number) <= LIMITS.listObservationsMax)
      ? OK
      : fail('invalid_input', `limit must be an integer from 1 to ${LIMITS.listObservationsMax}`),
  );
}

export function checkExplanationOptions(input: unknown): Check {
  if (input === undefined) return OK;
  if (!isObject(input)) return fail('invalid_input', 'options must be an object');
  return input.requesterParticipantId === undefined || isId(input.requesterParticipantId)
    ? OK
    : fail('invalid_input', 'requesterParticipantId must be a string ID');
}

export function isContextSource(value: unknown): value is ContextSource {
  return CONTEXT_SOURCES.includes(value as ContextSource);
}

export function isActivity(value: unknown): value is Activity {
  return ACTIVITIES.includes(value as Activity);
}

/** Reasons a client may give when cancelling; engine-only reasons are rejected. */
export function isClientCancelReason(value: unknown): value is VoiceCancelReason {
  return CLIENT_CANCEL_REASONS.includes(value as VoiceCancelReason);
}
