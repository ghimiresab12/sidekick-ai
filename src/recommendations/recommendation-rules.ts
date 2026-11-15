/**
 * Pure recommendation lifecycle rules. No I/O, no clock — callers pass `nowMs`.
 * Kept separate from the engine so the rules can be unit-tested directly.
 */
import type { Recommendation, RecommendationStatus, ScreenObservation } from '../contracts/types.js';

/** Domain predicate only; the coordinator/engine enforce time, generation and lifecycle. */
export type ResolutionRule = (recommendation: Recommendation, observation: ScreenObservation) => boolean;

/** The only automatic resolution rule enabled by the production bridge. No prose inference. */
export const controlledSoccerResolution: ResolutionRule = (rec, screen) =>
  rec.fingerprint === 'left_defense_uncovered' &&
  screen.evidenceQuality === 'clear' &&
  screen.facts?.leftZoneVisible === true &&
  screen.facts.leftZoneUncovered === false;

export type ProposalDecision =
  | { kind: 'create' }
  | { kind: 'merge'; existing: Recommendation }
  | { kind: 'suppress'; existing: Recommendation };

const ms = (iso: string): number => Date.parse(iso);

/** Statuses whose recurrence is held back by the cooldown. */
const COOLDOWN_STATUSES: ReadonlySet<RecommendationStatus> = new Set(['dismissed', 'resolved']);

/**
 * Decide what to do with a new candidate for `fingerprint`:
 *  1. An `active` card with the same fingerprint exists → merge (no new card).
 *  2. The most recent same-fingerprint card was dismissed/resolved less than
 *     `cooldownMs` ago → suppress.
 *  3. Otherwise → create. A `stale` card does not block: it describes an earlier
 *     moment, so fresh evidence of the same issue deserves a new, current card.
 */
export function decideProposal(
  recommendations: Iterable<Recommendation>,
  fingerprint: string,
  nowMs: number,
  cooldownMs: number,
): ProposalDecision {
  let latestClosed: Recommendation | undefined;
  for (const rec of recommendations) {
    if (rec.fingerprint !== fingerprint) continue;
    if (rec.status === 'active') return { kind: 'merge', existing: rec };
    if (
      COOLDOWN_STATUSES.has(rec.status) &&
      (!latestClosed || ms(rec.statusChangedAt) > ms(latestClosed.statusChangedAt))
    ) {
      latestClosed = rec;
    }
  }
  if (latestClosed && nowMs - ms(latestClosed.statusChangedAt) < cooldownMs) {
    return { kind: 'suppress', existing: latestClosed };
  }
  return { kind: 'create' };
}

/** True when the newest condition evidence is older than the stale window. */
export function isConditionStale(lastConditionAt: string, nowMs: number, staleAfterMs: number): boolean {
  return nowMs - ms(lastConditionAt) > staleAfterMs;
}

/**
 * Newest first by `createdAt`. Input order is the stable tie-breaker
 * (later insertion = newer), so equal timestamps still order deterministically.
 */
export function newestFirst(recommendations: readonly Recommendation[]): Recommendation[] {
  return recommendations
    .map((rec, index) => ({ rec, index }))
    .sort((a, b) => ms(b.rec.createdAt) - ms(a.rec.createdAt) || b.index - a.index)
    .map((e) => e.rec);
}

/** The single prominent card: an active card, `important` before `normal`, then newest. */
export function pickProminent(recommendations: readonly Recommendation[]): Recommendation | undefined {
  const active = newestFirst(recommendations).filter((r) => r.status === 'active');
  return active.find((r) => r.urgency === 'important') ?? active[0];
}
