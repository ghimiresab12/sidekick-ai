/**
 * ⚠️ SUPERSEDED — interim copy of the ORIGINAL (pre-revision) docs/engineering.md §3 and §8 types.
 *
 * The approved shared contracts now live in `src/contracts/types.ts` (session
 * engine, owned by the session/contracts workstream). This file is kept only so
 * the mock prototype keeps compiling until the overlay migrates to
 * `OverlayState` / `RecommendationView` (see docs/techstack.md §8). Do not extend
 * it; do not treat it as the source of truth.
 */

export type SessionStatus = 'starting' | 'active' | 'paused' | 'ended';
export type Activity = 'unconfirmed' | 'gaming' | 'planning' | 'social';
export type RecommendationStatus = 'active' | 'dismissed' | 'resolved' | 'stale';

export interface Session {
  id: string;                          // server-generated; never trust arbitrary client IDs
  status: SessionStatus;
  consentActive: boolean;               // true only after session permission granted
  activity: Activity;
  activityConfirmed: boolean;
  startedAt: string;
  endedAt?: string;
  participants: Record<string, { displayName?: string; role?: string }>;
  goals: string[];                     // explicit session goals only
  latestObservationIds: string[];
  recommendationIds: string[];
}

export interface Observation {
  id: string;
  sessionId: string;
  observedAt: string;
  source: 'transcript' | 'screen' | 'participant_report';
  summary: string;                     // short, no raw frames/audio
  speakerId?: string;                  // absent when not verified
  evidenceQuality: 'clear' | 'partial' | 'unknown';
  frameRef?: string;                   // ephemeral ref only; do not persist raw media
}

export interface Recommendation {
  id: string;
  sessionId: string;
  createdAt: string;
  status: RecommendationStatus;
  title: string;
  shortAdvice: string;
  evidenceObservationIds: string[];
  relatedGoal?: string;
  urgency: 'normal' | 'important';
  voiceRequestedAt?: string;
  voiceDeliveryStatus?: 'pending' | 'playing_locally' | 'finished' | 'failed';
}

export interface SessionEvent {
  id: string;
  sessionId: string;
  time: string;
  type: 'role_updated' | 'activity_confirmed' | 'observation' |
    'recommendation_created' | 'recommendation_dismissed' |
    'recommendation_resolved' | 'voice_requested' | 'voice_finished' |
    'session_started' | 'session_ended';
  observationIds?: string[];
  recommendationId?: string;
  summary: string;
}

/** docs/engineering.md §8 — proposed review contract. */
export interface SessionReview {
  sessionId: string;
  generatedAt: string;
  activity: string;
  overview: string;
  keyMoments: Array<{ eventIds: string[]; time?: string; whatHappened: string }>;
  strengths: string[];                 // omit if no supporting evidence
  improvementAreas: string[];          // cite observed events in UI when possible
  nextActions: string[];
  limitations: string[];               // gaps, uncertain identities, sparse sampling
}
