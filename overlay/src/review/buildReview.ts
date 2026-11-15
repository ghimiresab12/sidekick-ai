/**
 * End-of-session review built ONLY from shared data the backend already provides:
 * the engine timeline (`getTimeline`, typed `SessionEvent`s) and the final
 * `OverlayState` (card titles and advice). Deterministic rules, no model.
 *
 * INTERIM: engineering.md §1 assigns review generation to a backend "review
 * service", which does not exist yet (GAP 2). This function is a pure presentation
 * of recorded events, so it can be replaced by a backend `generateReview` without
 * touching components. It never invents scores, outcomes, confidence values or
 * player assessments, and says when there is not enough evidence (design.md §8).
 */
import type { SessionReview, SessionTimeline } from '../contracts/pending';
import type { OverlayState, SessionEvent } from '../contracts/shared';
import { allCards } from '../session/selectors';

export const NOT_ENOUGH_EVIDENCE = 'Not enough observations for a performance assessment.';

const KEY_MOMENT_TYPES = new Set<SessionEvent['type']>([
  'role_updated',
  'goal_set',
  'decision_recorded',
  'recommendation_created',
  'recommendation_resolved',
  'recommendation_dismissed',
  'voice_requested',
]);

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export interface ReviewOptions {
  /** Backend honesty note, e.g. "Synthetic inputs". Added to limitations verbatim. */
  inputNote?: string;
  now?: Date;
}

export function buildReview(timeline: SessionTimeline, state: OverlayState | null, options: ReviewOptions = {}): SessionReview {
  const { events, truncated } = timeline;
  const cards = new Map(allCards(state).map((c) => [c.id, c]));
  const title = (id: string) => cards.get(id)?.title ?? 'an earlier recommendation';

  const keyMoments = events
    .filter((e) => KEY_MOMENT_TYPES.has(e.type))
    .map((e) => ({ eventIds: [e.id], time: e.time, whatHappened: e.summary }));

  const created = events.filter((e): e is Extract<SessionEvent, { type: 'recommendation_created' }> => e.type === 'recommendation_created');
  const resolved = events.filter((e): e is Extract<SessionEvent, { type: 'recommendation_resolved' }> => e.type === 'recommendation_resolved');
  const screenObservations = events.filter((e) => e.type === 'observation' && e.source === 'screen');
  const enoughEvidence = created.length > 0 && screenObservations.length > 0;
  const activity = state?.activity ?? 'unconfirmed';

  let overview: string;
  if (!enoughEvidence) {
    overview = `${NOT_ENOUGH_EVIDENCE} Sidekick recorded ${plural(events.length, 'event')} but showed no grounded recommendation.`;
  } else {
    const titles = created.map((e) => `“${title(e.recommendationId)}”`).join(', ');
    overview =
      `During this ${activity} session Sidekick showed ${plural(created.length, 'recommendation')} (${titles}), ` +
      `based on ${plural(screenObservations.length, 'screen observation')} and context stated in conversation.`;
    if (resolved.length > 0) overview += ` ${plural(resolved.length, 'issue')} later appeared resolved in a subsequent observation.`;
  }

  // Strengths: ONLY when a recorded later observation resolved an issue.
  const strengths = resolved.map(
    (e) => `A later screen observation supported resolving “${title(e.recommendationId)}”.`,
  );

  const resolvedIds = new Set(resolved.map((e) => e.recommendationId));
  const improvementAreas = created
    .filter((e) => !resolvedIds.has(e.recommendationId))
    .map((e) => `“${title(e.recommendationId)}”: no later observation confirmed it was resolved.`);

  const nextActions = [
    ...new Set(created.map((e) => cards.get(e.recommendationId)?.shortAdvice).filter((a): a is string => !!a)),
  ].map((advice) => `Agree a plan for next time: ${advice}`);

  const limitations: string[] = [];
  if (!enoughEvidence) limitations.push(NOT_ENOUGH_EVIDENCE);
  if (options.inputNote) limitations.push(options.inputNote);
  limitations.push('Based on sampled observations only; no scoreline, match result or player performance metrics are tracked.');
  if (events.some((e) => e.type === 'voice_requested')) {
    limitations.push('Requesting a voice explanation shows interest in the advice, not that it was followed.');
  }
  if (events.some((e) => e.type === 'recommendation_dismissed')) {
    limitations.push('Dismissing a recommendation hides it; it does not mean the issue was resolved.');
  }
  if (events.some((e) => e.type === 'observation' && e.source === 'transcript' && !e.speakerParticipantId)) {
    limitations.push('Speaker identity was not verified; roles come from names stated in conversation.');
  }
  if (truncated) limitations.push('The event log reached its size limit; later events were not recorded.');

  return {
    sessionId: state?.sessionId ?? events[0]?.sessionId ?? 'unknown',
    generatedAt: (options.now ?? new Date()).toISOString(),
    activity,
    overview,
    keyMoments,
    strengths,
    improvementAreas,
    nextActions,
    limitations,
  };
}
