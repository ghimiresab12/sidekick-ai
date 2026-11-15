/**
 * ⚠️ PENDING APPROVAL — proposed contract additions, NOT part of docs/engineering.md.
 *
 * Owner for approval: Sabik (session coordinator / shared contracts).
 * These exist so the overlay can be built against mocks today. Each addition is
 * additive (it never changes an agreed field), so dropping or renaming one later
 * only touches the overlay. See overlay/README.md → "Contract proposals for Sabik".
 *
 * UPDATE: the approved engine contracts (src/contracts/types.ts) now cover most
 * of these — session_paused/resumed and recommendation_stale events, cancelled
 * voice status (VoiceRequest), relatedParticipants, subscribe/pause/resume/dismiss.
 * Remaining gap: who turns ExplanationContext into spoken text (P3).
 */
import type { Recommendation, SessionEvent } from './sidekick';

/**
 * P1 — Event types the review needs to tell an honest story about pauses,
 * cancelled/failed voice and cards that went stale. Agreed list lacks them.
 */
export type ProposedEventType =
  | 'session_paused'
  | 'session_resumed'
  | 'recommendation_stale'
  | 'voice_cancelled'
  | 'voice_failed';

export type TimelineEventType = SessionEvent['type'] | ProposedEventType;

/** A SessionEvent whose `type` may also be one of the proposed types. */
export type TimelineEvent = Omit<SessionEvent, 'type'> & { type: TimelineEventType };

/**
 * P2 — Player context. The agreed Recommendation has no link to participants,
 * so the card cannot show "Alex · left defense". Proposed optional field,
 * resolved through Session.participants.
 */
export type RecommendationWithContext = Recommendation & {
  relatedParticipantIds?: string[];
};

/**
 * P3 — Return type of `requestVoiceExplanation` (engineering.md §9 names the
 * operation but defines no payload). Text only: the UI does local TTS.
 */
export interface VoiceExplanation {
  recommendationId: string;
  text: string;
  /** True when the card is stale/earlier: the text must not read as a live alert. */
  refersToEarlierObservation: boolean;
  evidenceObservationIds: string[];
  generatedAt: string;
}

/**
 * P4 — The browser owns live playback, so it reports outcomes back for the
 * event log. 'cancelled' has no equivalent in Recommendation.voiceDeliveryStatus.
 */
export type VoicePlaybackReport = 'playing' | 'finished' | 'cancelled' | 'failed';
