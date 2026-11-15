/** Structural boundary matching Sabik's types at 1bc0e9f.
 * No session state is owned here. Full engine snapshots/observations are assignable.
 * Keep the compatibility check in tools/reasoning/check-contracts.mjs green.
 */
export type Activity = 'unconfirmed' | 'gaming' | 'planning' | 'social';
export interface ParticipantContext {
  id: string;
  displayName: string;
  role?: string;
  lastRoleChange?: {
    revision: number;
    effectiveAt: string;
    source: 'transcript' | 'participant_report' | 'manual';
    sourceObservationId?: string;
  };
}
export interface GoalContext {
  id: string;
  text: string;
  active: boolean;
  sourceObservationId?: string;
}
export interface SessionContext {
  id: string;
  status: 'starting' | 'active' | 'paused' | 'ended';
  consentGiven: boolean;
  activity: Activity;
  activityConfirmed: boolean;
  contextRevision: number;
  captureGeneration: number;
  participants: ParticipantContext[];
  goals: GoalContext[];
}
interface ObservationBase {
  id: string;
  sessionId: string;
  captureGeneration: number;
  observedAt: string;
  receivedAt: string;
}
export interface ConversationObservation extends ObservationBase {
  source: 'transcript';
  text: string;
  speakerParticipantId?: string;
}
export interface ScreenObservation extends ObservationBase {
  source: 'screen';
  summary: string;
  evidenceQuality: 'clear' | 'partial' | 'unknown';
  facts?: Record<string, string | number | boolean>;
  frameRef?: string;
}
export type Observation = ConversationObservation | ScreenObservation;
export interface ReasoningInput {
  session: SessionContext;
  observations: Observation[];
  /** Engine clock. Fixed in fixtures; never use a model-generated timestamp. */
  now: string;
  /** Pass EngineConfig.staleAfterMs; there is deliberately no production default. */
  staleAfterMs: number;
  /** Source-clock tolerance only, 0–5000 ms; default 0. Never shifts timestamps. */
  maxClockSkewMs?: number;
}
export interface EvidenceQuote { observationId: string; quote: string }
interface ProposalBase {
  sourceObservationIds: string[];
  /** Exact supporting excerpt, checked locally; not a proof of semantic truth. */
  evidenceQuotes: EvidenceQuote[];
}
export type ContextProposal = ProposalBase & (
  | { type: 'role_assignment'; participantId: string; role: string }
  | { type: 'group_goal'; text: string }
  | { type: 'activity_identification'; activity: 'gaming' }
  | { type: 'participant_decision'; text: string; participantIds: string[] }
);
/** Structurally assignable to the engine's RecommendationCandidate. */
export interface RecommendationCandidate {
  fingerprint: string;
  title: string;
  shortAdvice: string;
  urgency: 'normal' | 'important';
  conditionObservationIds: string[];
  contextObservationIds: string[];
  relatedParticipantIds?: string[];
  relatedGoalId?: string;
  basedOnContextRevision: number;
}
export interface CandidateProposal extends Omit<RecommendationCandidate, 'basedOnContextRevision'> {
  evidenceQuotes: EvidenceQuote[];
  /** Model interpretation for the single supported MVP tactical rule. */
  situation: {
    leftZoneVisible: boolean;
    leftZoneUncovered: boolean;
    certainty: 'clear' | 'uncertain';
  };
}
export interface ModelOutput {
  contextUpdates: ContextProposal[];
  recommendationCandidates: CandidateProposal[];
  uncertainties: string[];
}
export interface ReasoningOutput {
  sessionId: string;
  basedOnContextRevision: number;
  captureGeneration: number;
  contextUpdates: ContextProposal[];
  recommendationCandidates: RecommendationCandidate[];
  uncertainties: string[];
  withheld: Array<{ category: 'context' | 'recommendation'; index: number; reason: string }>;
}
export type ReasoningResult =
  | { ok: true; value: ReasoningOutput }
  | { ok: false; error: 'invalid_input' | 'inactive_session' | 'invalid_output' | 'provider_error' | 'aborted' };
export interface ReasoningProvider {
  generate(input: ReasoningInput, signal?: AbortSignal): Promise<unknown>;
}
