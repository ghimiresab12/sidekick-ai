/**
 * The ONLY boundary between the overlay UI and the rest of Sidekick.
 *
 * UI components never import Chert, model, or backend code. They receive a
 * SidekickDataSource. Today it is `createMockDataSource`; later the integrator
 * implements this same interface over whatever transport the Chert starter uses.
 *
 * Operation names follow docs/engineering.md §9 ("internal operations").
 * Anything not listed there is marked PROPOSED and needs agreement with Sabik.
 */
import type { Observation, Session, SessionReview } from '../contracts/sidekick';
import type {
  RecommendationWithContext,
  TimelineEvent,
  VoiceExplanation,
  VoicePlaybackReport,
} from '../contracts/proposed';

/** Everything the overlay renders for one session (UI-side aggregation). */
export interface SessionSnapshot {
  session: Session;
  recommendations: RecommendationWithContext[];
  observations: Observation[];
  events: TimelineEvent[];
}

export interface SidekickDataSource {
  /** 'mock' sources must be labelled as such in the UI. */
  readonly mode: 'mock' | 'live';

  /** §9 getSessionState + getRecommendations, combined into one snapshot. */
  getSnapshot(): Promise<SessionSnapshot>;
  /** PROPOSED — push updates (new cards, status changes). Returns unsubscribe. */
  subscribe(listener: (snapshot: SessionSnapshot) => void): () => void;

  /** PROPOSED — explicit consent → 'active'. */
  startSession(): Promise<void>;
  /** PROPOSED — design.md §7 Pause/Resume. */
  pauseSession(): Promise<void>;
  resumeSession(): Promise<void>;
  /** §9 endSession — stops observation processing. */
  endSession(): Promise<void>;
  /** §9 discardSession — clears in-memory event/context data. */
  discardSession(): Promise<void>;

  /** PROPOSED — design.md §4 Dismiss (event preserved for review). */
  dismissRecommendation(recommendationId: string): Promise<void>;
  /** §9 requestVoiceExplanation — grounded TEXT for local TTS; no audio. */
  requestVoiceExplanation(recommendationId: string): Promise<VoiceExplanation>;
  /** PROPOSED — UI reports local playback outcome for the event log. */
  reportVoicePlayback(recommendationId: string, report: VoicePlaybackReport): void;

  /** §9 generateReview — only for an ended session. */
  generateReview(): Promise<SessionReview>;
}

export type DataSourceErrorCode =
  | 'invalid_transition'
  | 'invalid_state'
  | 'not_found'
  | 'discarded'
  | 'invalid_data';

export class DataSourceError extends Error {
  readonly code: DataSourceErrorCode;
  constructor(code: DataSourceErrorCode, message: string) {
    super(message);
    this.name = 'DataSourceError';
    this.code = code;
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return 'Something went wrong. Please try again.';
}
