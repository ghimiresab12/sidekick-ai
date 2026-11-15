/**
 * Pure "derive what to show" helpers. Kept out of components so the rules
 * (design.md §4: one prominent card, evidence, player context) are testable.
 */
import type { Observation, Session } from '../contracts/sidekick';
import type { RecommendationWithContext } from '../contracts/proposed';

type Rec = RecommendationWithContext;

/** Only open cards can be prominent. Stale stays visible (labelled "earlier"). */
export const isOpen = (r: Rec) => r.status === 'active' || r.status === 'stale';

const statusRank = (r: Rec) => (r.status === 'active' ? 0 : 1);
const urgencyRank = (r: Rec) => (r.urgency === 'important' ? 0 : 1);

/** Active before stale, important before normal, newest first. */
export function rankOpenRecommendations(recs: Rec[]): Rec[] {
  return recs
    .filter(isOpen)
    .sort(
      (a, b) =>
        statusRank(a) - statusRank(b) ||
        urgencyRank(a) - urgencyRank(b) ||
        b.createdAt.localeCompare(a.createdAt),
    );
}

/** The single prominent card: the user's selection if still open, else top-ranked. */
export function selectProminent(recs: Rec[], selectedId: string | null): Rec | null {
  if (selectedId) {
    const selected = recs.find((r) => r.id === selectedId && isOpen(r));
    if (selected) return selected;
  }
  return rankOpenRecommendations(recs)[0] ?? null;
}

/** Everything except the prominent card, newest first. */
export function selectHistory(recs: Rec[], prominentId: string | null): Rec[] {
  return recs.filter((r) => r.id !== prominentId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export interface EvidenceItem {
  id: string;
  /** Undefined when the referenced observation is missing — shown honestly, not hidden. */
  observation?: Observation;
}

export function selectEvidence(rec: Rec, observations: Observation[]): EvidenceItem[] {
  const byId = new Map(observations.map((o) => [o.id, o]));
  return rec.evidenceObservationIds.map((id) => ({ id, observation: byId.get(id) }));
}

export interface PlayerContextItem {
  id: string;
  displayName?: string;
  role?: string;
}

/** Resolves PROPOSED relatedParticipantIds through Session.participants. */
export function selectRelatedPlayers(rec: Rec, session: Session): PlayerContextItem[] {
  return (rec.relatedParticipantIds ?? []).map((id) => ({ id, ...session.participants[id] }));
}
