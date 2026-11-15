/**
 * Chooses which engine-ingested observations go into one reasoning call, and decides
 * whether newer screen evidence supersedes a finished call. Pure apart from read-only
 * `listObservations` calls.
 *
 * Batch priority (highest first), deduplicated, capped at `maxBatch` (reasoning accepts ≤100):
 *  1. Source utterances of current roles and active goals — reasoning needs them as
 *     context evidence even when they are old or from an earlier capture generation.
 *  2. Current-generation screens inside the stale window — the only valid condition
 *     evidence; all of them, so reasoning can see the newest frame.
 *  3. Recent transcripts — for new role/goal/decision extraction. Oldest dropped first.
 *
 * Timestamp tolerance: the engine admits `observedAt` up to `maxClockSkewMs` ahead of
 * its clock, but reasoning rejects the whole batch if any observation is in the future.
 * Every query therefore asks only for ALREADY-ELIGIBLE observations (`observedAt` ≤ now)
 * before any limit is applied, so high-frequency future-stamped input can never crowd
 * eligible evidence out of `maxScreens`/`maxTranscripts`. One separate query finds the
 * earliest future observation; `nextEligibleAtMs` reports when it becomes eligible.
 */
import type { Observation, Result, ScreenObservation, SessionSnapshot } from '../contracts/types.js';
import type { SidekickEngine } from '../engine.js';

/** Reasoning's input limit (src/reasoning/validation.mts: observations ≤ 100). */
export const REASONING_MAX_OBSERVATIONS = 100;

export interface SelectionLimits {
  /** Lookback for transcripts considered for new context extraction. */
  transcriptWindowMs: number;
  maxTranscripts: number;
  maxScreens: number;
  /** Hard cap for the whole batch; at most `REASONING_MAX_OBSERVATIONS`. */
  maxBatch: number;
}

export const DEFAULT_SELECTION_LIMITS: Readonly<SelectionLimits> = Object.freeze({
  transcriptWindowMs: 60_000,
  maxTranscripts: 30,
  maxScreens: 20,
  maxBatch: REASONING_MAX_OBSERVATIONS,
});

/** Throws RangeError for limits reasoning or `listObservations` cannot honour. */
export function validateSelectionLimits(limits: SelectionLimits): void {
  const positive = (key: keyof SelectionLimits, max: number) => {
    const v = limits[key];
    if (!Number.isSafeInteger(v) || v < 1 || v > max) throw new RangeError(`${key} must be an integer from 1 to ${max}`);
  };
  positive('maxBatch', REASONING_MAX_OBSERVATIONS);
  positive('maxScreens', REASONING_MAX_OBSERVATIONS);
  positive('maxTranscripts', REASONING_MAX_OBSERVATIONS);
  if (!Number.isSafeInteger(limits.transcriptWindowMs) || limits.transcriptWindowMs < 0) {
    throw new RangeError('transcriptWindowMs must be a non-negative integer');
  }
}

export interface Selection {
  /** Eligible observations only (`observedAt` ≤ now), oldest first by source time. */
  observations: Observation[];
  /** Earliest `observedAt` among excluded future-stamped observations, if any. */
  nextEligibleAtMs?: number;
  /** True if lower-priority observations were dropped to respect `maxBatch`. */
  truncated: boolean;
}

const iso = (ms: number): string => new Date(ms).toISOString();
const t = (o: Observation): number => Date.parse(o.observedAt);

export function selectObservations(
  engine: Pick<SidekickEngine, 'listObservations'>,
  snapshot: SessionSnapshot,
  nowMs: number,
  staleAfterMs: number,
  limits: SelectionLimits = DEFAULT_SELECTION_LIMITS,
): Result<Selection> {
  const referenced = [
    ...snapshot.participants.flatMap((p) =>
      p.role !== undefined && p.lastRoleChange?.sourceObservationId ? [p.lastRoleChange.sourceObservationId] : []),
    ...snapshot.goals.flatMap((g) => (g.active && g.sourceObservationId ? [g.sourceObservationId] : [])),
  ];
  const uniqueRefs = [...new Set(referenced)].slice(0, 100);

  const until = iso(nowMs);
  const refs = uniqueRefs.length === 0
    ? { ok: true as const, value: [] as Observation[] }
    : engine.listObservations(snapshot.id, { ids: uniqueRefs, observedUntil: until, limit: 100 });
  if (!refs.ok) return refs;
  const screens = engine.listObservations(snapshot.id, {
    source: 'screen',
    captureGeneration: snapshot.captureGeneration,
    observedSince: iso(nowMs - staleAfterMs),
    observedUntil: until,
    limit: limits.maxScreens,
  });
  if (!screens.ok) return screens;
  const transcripts = engine.listObservations(snapshot.id, {
    source: 'transcript',
    observedSince: iso(nowMs - limits.transcriptWindowMs),
    observedUntil: until,
    limit: limits.maxTranscripts,
  });
  if (!transcripts.ok) return transcripts;
  // Earliest observation that is not yet eligible (any source) — only used for scheduling.
  const future = engine.listObservations(snapshot.id, { observedSince: iso(nowMs + 1), keep: 'oldest', limit: 1 });
  if (!future.ok) return future;

  const chosen = new Map<string, Observation>();
  let truncated = false;
  const add = (list: Observation[], newestFirst: boolean) => {
    for (const o of newestFirst ? [...list].reverse() : list) {
      if (chosen.has(o.id)) continue;
      if (chosen.size >= limits.maxBatch) {
        truncated = true;
        return;
      }
      chosen.set(o.id, o);
    }
  };
  add(refs.value, false);
  add(screens.value, true);
  add(transcripts.value, true);

  const selection: Selection = { observations: [...chosen.values()].sort((a, b) => t(a) - t(b)), truncated };
  const earliestFuture = future.value[0];
  if (earliestFuture) selection.nextEligibleAtMs = t(earliestFuture);
  return { ok: true, value: selection };
}

const normalizedSummary = (o: ScreenObservation): string => o.summary.trim().replace(/\s+/g, ' ').toLowerCase();

function sameFacts(a: ScreenObservation, b: ScreenObservation): boolean {
  const fa = a.facts ?? {};
  const fb = b.facts ?? {};
  const ka = Object.keys(fa);
  return ka.length === Object.keys(fb).length && ka.every((k) => Object.hasOwn(fb, k) && fa[k] === fb[k]);
}

/**
 * Whether a newer frame is known to show the SAME condition as the batch frame.
 * Deliberately strict: no text interpretation, and model-generated facts are not assumed
 * complete. Equivalence holds only when both frames are `clear` and either
 *  (a) their summaries are identical (whitespace/case-normalized) AND their facts are
 *      identical (both empty counts), or
 *  (b) every key in `conditionFactKeys` — the structured condition the rule depends on,
 *      configured by the wiring — is present on BOTH frames with equal values.
 * Partial or generic facts (e.g. only `leftZoneVisible`) never establish equivalence when
 * summaries differ. Anything else counts as potentially superseding.
 */
export function framesEquivalent(a: ScreenObservation, b: ScreenObservation, conditionFactKeys: readonly string[]): boolean {
  if (a.evidenceQuality !== 'clear' || b.evidenceQuality !== 'clear') return false;
  if (normalizedSummary(a) === normalizedSummary(b) && sameFacts(a, b)) return true;
  if (conditionFactKeys.length === 0 || !a.facts || !b.facts) return false;
  return conditionFactKeys.every(
    (k) => Object.hasOwn(a.facts!, k) && Object.hasOwn(b.facts!, k) && a.facts![k] === b.facts![k],
  );
}

/**
 * After a reasoning call, returns a current-generation screen that supersedes the batch's
 * condition evidence, if any. A screen supersedes when it is eligible (`observedAt` ≤ now),
 * was not in the batch, is at least as new as the batch's newest screen, and is not
 * `framesEquivalent` to it.
 * Transcripts never supersede condition evidence. Batches without screens cannot yield
 * condition-based candidates, so nothing supersedes them.
 */
export function findSupersedingScreen(
  engine: Pick<SidekickEngine, 'listObservations'>,
  sessionId: string,
  captureGeneration: number,
  batch: Observation[],
  nowMs: number,
  conditionFactKeys: readonly string[] = [],
): Result<ScreenObservation | undefined> {
  const batchScreens = batch.filter(
    (o): o is ScreenObservation => o.source === 'screen' && o.captureGeneration === captureGeneration,
  );
  if (batchScreens.length === 0) return { ok: true, value: undefined };
  const newest = batchScreens.reduce((a, b) => (t(b) > t(a) ? b : a));
  const inBatch = new Set(batch.map((o) => o.id));
  const later = engine.listObservations(sessionId, {
    source: 'screen',
    captureGeneration,
    observedSince: newest.observedAt,
    observedUntil: iso(nowMs),
    limit: 500,
  });
  if (!later.ok) return later;
  const superseding = later.value.find(
    (o): o is ScreenObservation =>
      o.source === 'screen' && !inBatch.has(o.id) && !framesEquivalent(newest, o, conditionFactKeys),
  );
  return { ok: true, value: superseding };
}
