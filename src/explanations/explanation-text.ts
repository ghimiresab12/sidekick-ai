/**
 * Server-side explanation text for one recommendation (engineering.md §3.2: "the
 * backend generates text from `context`"). Deterministic template, not a model.
 * Derived from the overlay's interim template (overlay/src/backend/explanationText.ts),
 * which the overlay should replace with this module; tightened for privacy (M5).
 *
 * Grounding rules:
 * - Uses only the `ExplanationContext` the engine returned for this recommendation.
 * - Roles come from `contextAtCreation` (what was true when the advice was made); later
 *   corrections are stated separately, never merged in.
 * - Screen evidence is restated from its structured summary. Transcript-derived free text
 *   is NEVER included: goal wording is withheld (goals are stored as the exact utterance),
 *   and roles appear only as safe labels (`safeRoleLabel`), else "assigned role".
 * - Stale advice is phrased as earlier, not as a live alert.
 * - No scores, outcomes, identities or claims beyond those fields are ever added.
 */
import type { ExplanationContext } from '../contracts/types.js';
import { safeRoleLabel } from '../privacy/browser-projection.js';

const ensurePeriod = (s: string) => (/[.!?]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);

export function buildExplanationText(context: ExplanationContext): string {
  const parts: string[] = [];
  const roles = context.contextAtCreation.participants.filter((p) => p.role);
  if (roles.length > 0) {
    const list = roles.map((p) => `${p.displayName} to ${safeRoleLabel(p.role)}`).join(', ');
    parts.push(`When this advice was made, the group had assigned ${list}.`);
  }
  if (context.contextAtCreation.goal) {
    parts.push('The group had stated a goal related to this advice.');
  }
  for (const obs of context.conditionEvidence) {
    if (obs.source === 'screen') parts.push(`The shared screen showed: ${ensurePeriod(obs.summary)}`);
  }
  parts.push(ensurePeriod(context.recommendation.shortAdvice));
  for (const change of context.changesSinceCreation) {
    if (change.kind === 'role_changed') {
      parts.push(
        change.change.kind === 'assigned'
          ? `Since then, ${change.displayName}'s role changed to ${safeRoleLabel(change.change.role)}.`
          : `Since then, ${change.displayName}'s role was cleared.`,
      );
    } else {
      parts.push('Since then, a related group goal was retired.');
    }
  }
  if (context.isStale) parts.push('This is based on an earlier observation and may no longer be current.');
  return parts.join(' ');
}
