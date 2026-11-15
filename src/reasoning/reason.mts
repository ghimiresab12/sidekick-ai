import type { ReasoningInput, ReasoningOutput, ReasoningProvider, ReasoningResult, EvidenceQuote, Observation, ContextProposal, CandidateProposal } from './contracts.mts';
import { time, validateInput, validateModelOutput } from './validation.mts';

function excerpt(o: Observation) { return o.source === 'transcript' ? o.text : o.summary; }
function escaped(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function grounded(ids: string[], quotes: EvidenceQuote[], observations: Map<string, Observation>) {
  return quotes.every(q => ids.includes(q.observationId) && observations.get(q.observationId) && excerpt(observations.get(q.observationId)!).includes(q.quote)) &&
    ids.every(id => observations.has(id) && quotes.some(q => q.observationId === id));
}
function contextReason(u: ContextProposal, input: ReasoningInput, observations: Map<string, Observation>): string | undefined {
  if (!grounded(u.sourceObservationIds, u.evidenceQuotes, observations)) return 'unsupported_context_evidence';
  const sources = u.sourceObservationIds.map(id => observations.get(id)!);
  if (u.type === 'activity_identification') return undefined; // A suggestion, never confirmation.
  if (sources.some(o => o.source !== 'transcript')) return 'context_requires_conversation';
  const quotes = u.evidenceQuotes.map(q => q.quote).join('\n');
  if (u.type === 'role_assignment') {
    const p = input.session.participants.find(p => p.id === u.participantId);
    if (!p) return 'unknown_participant';
    // Conservative affirmative grammar prevents "Alex is NOT responsible" becoming a role.
    const named = new RegExp(`^${escaped(p.displayName)} (?:is responsible for|covers|is assigned to|defends|protects|handles) ${escaped(u.role)}[.!]?$`, 'i');
    const firstPerson = new RegExp(`^I (?:am responsible for|cover|am assigned to|defend|protect|handle) ${escaped(u.role)}[.!]?$`, 'i');
    const supported = u.evidenceQuotes.some(q => {
      const o = observations.get(q.observationId)!;
      return named.test(q.quote.trim()) || (o.source === 'transcript' && o.speakerParticipantId === p.id && firstPerson.test(q.quote.trim()));
    });
    if (!supported) return 'role_not_explicit';
    const last = p.lastRoleChange;
    if (last && (last.source !== 'transcript' || sources.some(o => time(o.observedAt) < time(last.effectiveAt)))) return 'role_correction_takes_precedence';
  } else {
    // Extractive context updates avoid fabricated paraphrases or decisions.
    if (!quotes.includes(u.text)) return 'context_text_not_quoted';
    if (u.type === 'group_goal' && !/^(?:Our (?:goal|objective|aim) is|We want to)\s+[^?]+[.!]?$/i.test(u.text.trim())) return 'goal_not_explicit';
    if (u.type === 'participant_decision') {
      if (!/^We (?:decided|agreed|will)\s+[^?]+[.!]?$/i.test(u.text.trim())) return 'decision_not_explicit';
      if (u.participantIds.some(id => {
        const p = input.session.participants.find(p => p.id === id);
        return !p || !sources.some(o => o.source === 'transcript' && (o.text.includes(p.displayName) || o.speakerParticipantId === id));
      })) return 'unsupported_decision_participant';
    }
  }
  return undefined;
}

function candidateReason(c: CandidateProposal, input: ReasoningInput, observations: Map<string, Observation>): string | undefined {
  if (!input.session.activityConfirmed || input.session.activity !== 'gaming') return 'gaming_not_confirmed';
  if (c.fingerprint !== 'left_defense_uncovered') return 'unsupported_situation';
  if (!grounded([...c.conditionObservationIds, ...c.contextObservationIds], c.evidenceQuotes, observations)) return 'unsupported_evidence';
  const condition = c.conditionObservationIds.map(id => observations.get(id)!);
  if (condition.some(o => o.source !== 'screen')) return 'condition_requires_screen';
  if (condition.some(o => o.captureGeneration !== input.session.captureGeneration)) return 'old_capture_generation';
  if (condition.some(o => time(input.now) - time(o.observedAt) > input.staleAfterMs)) return 'stale_condition';
  if (condition.some(o => o.source === 'screen' && o.evidenceQuality !== 'clear')) return 'insufficient_visual_evidence';
  if (!c.situation.leftZoneVisible || !c.situation.leftZoneUncovered || c.situation.certainty !== 'clear') return 'uncertain_situation';
  const screens = input.observations.filter(o => o.source === 'screen' && o.captureGeneration === input.session.captureGeneration);
  const newest = Math.max(...screens.map(o => time(o.observedAt)));
  const newestConditions = condition.filter(o => time(o.observedAt) === newest);
  // A newer frame (even ambiguous) invalidates a claim based solely on an older frame.
  if (!newestConditions.length) return 'superseded_screen';
  if (screens.some(o => time(o.observedAt) === newest && !c.conditionObservationIds.includes(o.id))) return 'conflicting_latest_frames';
  if (condition.some(o => o.source === 'screen' && (o.facts?.leftZoneVisible === false || o.facts?.leftZoneUncovered === false))) return 'contradictory_screen_facts';
  for (const id of c.relatedParticipantIds ?? []) {
    const p = input.session.participants.find(p => p.id === id);
    if (!p) return 'unknown_participant';
    // Do not treat a same-batch proposed role as already accepted by the engine.
    if (!p.role || !/left.*defen|defen.*left/i.test(p.role)) return 'role_not_accepted';
    const roleEvidence = p.lastRoleChange?.sourceObservationId;
    if (p.lastRoleChange?.source === 'transcript' && (!roleEvidence || !c.contextObservationIds.includes(roleEvidence))) return 'missing_role_evidence';
  }
  if (c.relatedGoalId !== undefined) {
    const g = input.session.goals.find(g => g.id === c.relatedGoalId && g.active);
    if (!g) return 'unknown_or_inactive_goal';
    if (g.sourceObservationId && !c.contextObservationIds.includes(g.sourceObservationId)) return 'missing_goal_evidence';
  }
  // Output must remain tentative; evidence checks cannot prove natural-language entailment.
  if (!/\b(appears|may|might|possibly)\b/i.test(c.title + ' ' + c.shortAdvice)) return 'missing_uncertainty_language';
  return undefined;
}

/** Pure post-model boundary. Never mutates caller state or accepts model-generated IDs/revisions. */
export function evaluateOutput(input: ReasoningInput, raw: unknown): ReasoningOutput {
  validateInput(input);
  if (input.session.status !== 'active' || !input.session.consentGiven) throw Error('Inactive session');
  validateModelOutput(raw);
  const observations = new Map(input.observations.map(o => [o.id, o]));
  const result: ReasoningOutput = {
    sessionId: input.session.id, basedOnContextRevision: input.session.contextRevision,
    captureGeneration: input.session.captureGeneration, contextUpdates: [], recommendationCandidates: [],
    uncertainties: [...raw.uncertainties], withheld: []
  };
  raw.contextUpdates.forEach((u, index) => {
    const reason = contextReason(u, input, observations);
    if (reason) result.withheld.push({ category: 'context', index, reason });
    else result.contextUpdates.push(structuredClone(u));
  });
  raw.recommendationCandidates.forEach((c, index) => {
    const reason = candidateReason(c, input, observations);
    if (reason) result.withheld.push({ category: 'recommendation', index, reason });
    else {
      const { evidenceQuotes: _quotes, situation: _situation, ...candidate } = c;
      const participant = input.session.participants.find(p => p.id === candidate.relatedParticipantIds?.[0]);
      // Only one tactical rule is implemented. Render its bounded wording locally so arbitrary
      // model prose cannot add invented scores, identities, outcomes or instructions to the card.
      result.recommendationCandidates.push({ ...structuredClone(candidate),
        title: 'Left defense appears exposed',
        shortAdvice: participant ? `Ask ${participant.displayName} to cover left defense or arrange backup coverage.` : 'Arrange coverage for the left defensive zone.',
        basedOnContextRevision: input.session.contextRevision });
    }
  });
  return result;
}

/** The caller must re-read engine state before accepting results; revisions are not refreshed here. */
export async function reason(input: unknown, provider: ReasoningProvider, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<ReasoningResult> {
  let snapshot: ReasoningInput;
  try { validateInput(input); snapshot = structuredClone(input); } catch { return { ok: false, error: 'invalid_input' }; }
  if (snapshot.session.status !== 'active' || !snapshot.session.consentGiven) return { ok: false, error: 'inactive_session' };
  const timeout = options.timeoutMs ?? 15_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120_000) return { ok: false, error: 'invalid_input' };
  if (options.signal?.aborted) return { ok: false, error: 'aborted' };
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, timeout);
  let onAbort: () => void = () => {};
  try {
    const cancelled = new Promise<never>((_, reject) => {
      onAbort = () => reject(Error('Aborted'));
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    // A separate copy protects the validation snapshot from provider mutation.
    const raw = await Promise.race([provider.generate(structuredClone(snapshot), controller.signal), cancelled]);
    if (controller.signal.aborted) return { ok: false, error: 'aborted' };
    try { return { ok: true, value: evaluateOutput(snapshot, raw) }; }
    catch { return { ok: false, error: 'invalid_output' }; }
  } catch {
    return { ok: false, error: controller.signal.aborted ? 'aborted' : 'provider_error' };
  } finally {
    clearTimeout(timer); options.signal?.removeEventListener('abort', abort);
    controller.signal.removeEventListener('abort', onAbort);
  }
}
