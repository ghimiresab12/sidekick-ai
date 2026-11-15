/**
 * Shape of mock-session.json, plus a small hand-written validator.
 *
 * The seed is a SCRIPT: `feed` steps play over time once the session starts,
 * simulating what the backend would push (observations → recommendations →
 * later observation that resolves an issue). IDs, sessionId and timestamps
 * are stamped by the mock data source when a step plays.
 */
import type { Observation, Recommendation, Session } from '../contracts/sidekick';

export type ObservationTemplate = Pick<Observation, 'id' | 'source' | 'summary' | 'evidenceQuality' | 'speakerId'>;

export type RecommendationTemplate = Pick<
  Recommendation,
  'id' | 'title' | 'shortAdvice' | 'evidenceObservationIds' | 'urgency' | 'relatedGoal'
> & { relatedParticipantIds?: string[] };

export interface FeedStep {
  afterMs: number;
  observations?: ObservationTemplate[];
  roleUpdates?: Array<{ participantId: string; role: string; observationId: string }>;
  recommendations?: RecommendationTemplate[];
  /** Recommendation IDs this step's observations show as resolved. */
  resolves?: string[];
}

export interface MockSeed {
  session: Session;
  feed: FeedStep[];
  explanations: Record<string, { text: string }>;
}

class SeedError extends Error {}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);

function need(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new SeedError(msg);
}

const SOURCES = ['transcript', 'screen', 'participant_report'];
const QUALITIES = ['clear', 'partial', 'unknown'];
const URGENCIES = ['normal', 'important'];
const ACTIVITIES = ['unconfirmed', 'gaming', 'planning', 'social'];

/**
 * Throws an Error describing the first problem; returns the typed seed if valid.
 * Also checks cross-references: every recommendation must cite observations
 * that exist by the time it plays, and resolutions need a new observation.
 */
export function validateSeed(raw: unknown): MockSeed {
  try {
    need(isObj(raw), 'seed must be an object');
    const s = raw.session;
    need(isObj(s), 'session missing');
    need(isStr(s.id) && s.id.length > 0, 'session.id missing');
    need(s.status === 'starting', 'mock session must start in "starting" so consent is shown');
    need(isStr(s.activity) && ACTIVITIES.includes(s.activity), 'session.activity invalid');
    need(typeof s.activityConfirmed === 'boolean', 'session.activityConfirmed must be boolean');
    need(isObj(s.participants), 'session.participants missing');
    need(isStrArr(s.goals), 'session.goals must be string[]');

    need(Array.isArray(raw.feed), 'feed must be an array');
    need(isObj(raw.explanations), 'explanations missing');

    const seenObs = new Set<string>();
    const seenRecs = new Set<string>();
    raw.feed.forEach((step: unknown, i: number) => {
      const at = `feed[${i}]`;
      need(isObj(step), `${at} must be an object`);
      need(typeof step.afterMs === 'number' && step.afterMs >= 0, `${at}.afterMs must be >= 0`);
      const obs = (step.observations ?? []) as unknown[];
      need(Array.isArray(obs), `${at}.observations must be an array`);
      obs.forEach((o, j) => {
        need(isObj(o) && isStr(o.id) && isStr(o.summary), `${at}.observations[${j}] needs id + summary`);
        need(SOURCES.includes(o.source as string), `${at}.observations[${j}].source invalid`);
        need(QUALITIES.includes(o.evidenceQuality as string), `${at}.observations[${j}].evidenceQuality invalid`);
        need(!seenObs.has(o.id), `duplicate observation id ${o.id}`);
        seenObs.add(o.id);
      });
      const roles = (step.roleUpdates ?? []) as unknown[];
      need(Array.isArray(roles), `${at}.roleUpdates must be an array`);
      roles.forEach((r, j) => {
        need(isObj(r) && isStr(r.participantId) && isStr(r.role) && isStr(r.observationId), `${at}.roleUpdates[${j}] incomplete`);
        need(r.participantId in (s.participants as object), `${at}.roleUpdates[${j}] unknown participant`);
        need(seenObs.has(r.observationId), `${at}.roleUpdates[${j}] cites unknown observation`);
      });
      const recs = (step.recommendations ?? []) as unknown[];
      need(Array.isArray(recs), `${at}.recommendations must be an array`);
      recs.forEach((r, j) => {
        const rat = `${at}.recommendations[${j}]`;
        need(isObj(r) && isStr(r.id) && isStr(r.title) && isStr(r.shortAdvice), `${rat} needs id, title, shortAdvice`);
        need(URGENCIES.includes(r.urgency as string), `${rat}.urgency invalid`);
        need(isStrArr(r.evidenceObservationIds) && r.evidenceObservationIds.length > 0, `${rat} must cite evidence`);
        r.evidenceObservationIds.forEach((id) => need(seenObs.has(id), `${rat} cites unknown observation ${id}`));
        if (r.relatedParticipantIds !== undefined) {
          need(isStrArr(r.relatedParticipantIds), `${rat}.relatedParticipantIds must be string[]`);
        }
        need(!seenRecs.has(r.id), `duplicate recommendation id ${r.id}`);
        seenRecs.add(r.id);
      });
      const resolves = (step.resolves ?? []) as unknown[];
      need(isStrArr(resolves), `${at}.resolves must be string[]`);
      if (resolves.length > 0) need(obs.length > 0, `${at} resolves without a new observation`);
      resolves.forEach((id) => need(seenRecs.has(id), `${at} resolves unknown recommendation ${id}`));
    });

    for (const [id, e] of Object.entries(raw.explanations)) {
      need(isObj(e) && isStr(e.text) && e.text.length > 0, `explanations.${id}.text missing`);
    }
    return raw as unknown as MockSeed;
  } catch (e) {
    if (e instanceof SeedError) throw new Error(`Mock data is invalid: ${e.message}`);
    throw e;
  }
}
