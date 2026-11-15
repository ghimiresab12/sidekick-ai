import type { ContextProposal, ModelOutput, ReasoningInput, ReasoningProvider } from '../../reasoning/contracts.mts';

/** Deliberately narrow deterministic simulator, NOT Gemini or a visual perception model. */
export function createMockProvider(): ReasoningProvider {
  return { async generate(input: ReasoningInput): Promise<ModelOutput> {
    const contextUpdates: ContextProposal[] = [];
    const uncertainties: string[] = [];
    for (const o of input.observations) {
      if (o.source !== 'transcript') continue;
      const base = { sourceObservationIds: [o.id], evidenceQuotes: [{ observationId: o.id, quote: o.text }] };
      const role = /^(.+?) (?:is responsible for|covers|am responsible for|cover) (.+?)\.?$/i.exec(o.text);
      if (role) {
        const matches = input.session.participants.filter(p => p.displayName.toLowerCase() === role[1]!.toLowerCase() ||
          (role[1]!.toLowerCase() === 'i' && p.id === o.speakerParticipantId));
        if (matches.length === 1) contextUpdates.push({ ...base, type: 'role_assignment', participantId: matches[0]!.id, role: role[2]! });
        else uncertainties.push('Role speaker or participant is not uniquely identified.');
      }
      if (/^(?:Our goal is|We want to) /i.test(o.text)) contextUpdates.push({ ...base, type: 'group_goal', text: o.text });
      if (/^We (?:decided|agreed) /i.test(o.text)) contextUpdates.push({ ...base, type: 'participant_decision', text: o.text, participantIds: [] });
      if (/^We are playing (?:soccer|a soccer simulation)\.?$/i.test(o.text)) contextUpdates.push({ ...base, type: 'activity_identification', activity: 'gaming' });
    }
    const screens = input.observations.filter(o => o.source === 'screen' && o.captureGeneration === input.session.captureGeneration)
      .sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt));
    const screen = screens[0];
    if (!screen || screen.source !== 'screen' || screen.evidenceQuality !== 'clear' || screen.facts?.leftZoneVisible !== true || screen.facts?.leftZoneUncovered !== true) {
      return { contextUpdates, recommendationCandidates: [], uncertainties: [...uncertainties, 'No clear structured left-defense condition in mock input.'] };
    }
    const defender = input.session.participants.find(p => p.role && /left.*defen|defen.*left/i.test(p.role));
    const roleId = defender?.lastRoleChange?.sourceObservationId;
    const context = input.observations.filter(o => o.id === roleId);
    const related = defender && context.length ? [defender.id] : [];
    return {
      contextUpdates, uncertainties,
      recommendationCandidates: [{
        fingerprint: 'left_defense_uncovered', title: 'Left defense appears exposed',
        shortAdvice: related.length ? `Ask ${defender!.displayName} to cover left defense or arrange backup coverage.` : 'Arrange coverage for the left defensive zone.',
        urgency: 'normal', conditionObservationIds: [screen.id], contextObservationIds: context.map(o => o.id),
        relatedParticipantIds: related,
        evidenceQuotes: [screen, ...context].map(o => ({ observationId: o.id, quote: o.source === 'screen' ? o.summary : o.text })),
        situation: { leftZoneVisible: true, leftZoneUncovered: true, certainty: 'clear' }
      }]
    };
  } };
}
