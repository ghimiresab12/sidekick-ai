/**
 * MOCK stand-in for the backend's `generateReview` (engineering.md §8).
 *
 * Deterministic and rule-based (no AI): it only restates what the recorded
 * events and observations of THIS session contain. It never invents scores,
 * outcomes, confidence values or player assessments. When there is too little
 * evidence it says so (design.md §8).
 */
import type { SessionReview } from '../contracts/sidekick';
import type { TimelineEventType } from '../contracts/proposed';
import type { SessionSnapshot } from './SidekickDataSource';

export const NOT_ENOUGH_EVIDENCE = 'Not enough observations for a performance assessment.';

const KEY_MOMENT_TYPES = new Set<TimelineEventType>([
  'role_updated',
  'recommendation_created',
  'recommendation_resolved',
  'recommendation_dismissed',
  'voice_requested',
]);

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function generateMockReview(snapshot: SessionSnapshot, now: Date): SessionReview {
  const { session, events, recommendations, observations } = snapshot;
  const recById = new Map(recommendations.map((r) => [r.id, r]));
  const obsById = new Map(observations.map((o) => [o.id, o]));

  const keyMoments = events
    .filter((e) => KEY_MOMENT_TYPES.has(e.type))
    .map((e) => ({ eventIds: [e.id], time: e.time, whatHappened: e.summary }));

  const createdIds = events
    .filter((e) => e.type === 'recommendation_created' && e.recommendationId)
    .map((e) => e.recommendationId as string);
  const resolvedEvents = events.filter((e) => e.type === 'recommendation_resolved');
  const screenObs = observations.filter((o) => o.source === 'screen');
  const enoughEvidence = createdIds.length > 0 && screenObs.length > 0;

  let overview: string;
  if (!enoughEvidence) {
    overview = `${NOT_ENOUGH_EVIDENCE} Sidekick recorded ${plural(events.length, 'event')} but no grounded recommendation was shown.`;
  } else {
    const titles = createdIds.map((id) => `“${recById.get(id)?.title ?? id}”`).join(', ');
    overview =
      `During this ${session.activity} session Sidekick showed ${plural(createdIds.length, 'recommendation')} ` +
      `(${titles}), based on ${plural(screenObs.length, 'sampled screen observation')} and roles stated in conversation.`;
    if (resolvedEvents.length > 0) {
      overview += ` ${plural(resolvedEvents.length, 'issue')} later appeared resolved in a subsequent observation.`;
    }
  }

  // Strengths: ONLY when a later observation supports a resolution.
  const strengths = resolvedEvents.flatMap((e) => {
    const rec = e.recommendationId ? recById.get(e.recommendationId) : undefined;
    const later = (e.observationIds ?? []).map((id) => obsById.get(id)).filter(Boolean);
    if (!rec || later.length === 0) return [];
    return [`After “${rec.title}”, a later screen observation showed: ${later.map((o) => o!.summary).join(' ')}`];
  });

  // Opportunities: issues raised that no later observation showed resolved.
  const improvementAreas = createdIds.flatMap((id) => {
    const rec = recById.get(id);
    if (!rec || rec.status === 'resolved') return [];
    const screen = rec.evidenceObservationIds
      .map((oid) => obsById.get(oid))
      .find((o) => o?.source === 'screen');
    const seen = screen ? ` Observed: ${screen.summary}` : '';
    return [`“${rec.title}” — no later observation confirmed it was resolved.${seen}`];
  });

  const nextActions = [
    ...new Set(createdIds.map((id) => recById.get(id)?.shortAdvice).filter((a): a is string => !!a)),
  ].map((advice) => `Agree a plan for next time: ${advice}`);

  const limitations = [
    'Mock session: observations are scripted demo data, not live Chert screen share or transcripts.',
    'Based on sampled observations only; no scoreline, match result or player performance metrics are tracked.',
    'Requesting a voice explanation shows interest in the advice, not that it was followed.',
  ];
  if (events.some((e) => e.type === 'recommendation_dismissed')) {
    limitations.push('Dismissing a recommendation hides it; it does not mean the issue was resolved.');
  }
  if (observations.some((o) => o.source === 'transcript' && !o.speakerId)) {
    limitations.push('Speaker identity was not verified; roles come from names stated in conversation.');
  }
  if (!enoughEvidence) limitations.unshift(NOT_ENOUGH_EVIDENCE);

  return {
    sessionId: session.id,
    generatedAt: now.toISOString(),
    activity: session.activity,
    overview,
    keyMoments,
    strengths,
    improvementAreas,
    nextActions,
    limitations,
  };
}
