/**
 * BACKEND-SIDE text generation for an explanation (engineering.md §3.2: "backend
 * generates text from `context`"). Deterministic template, not a model.
 *
 * Grounding rules:
 * - Uses only the `ExplanationContext` the engine returned for this recommendation.
 * - Roles come from `contextAtCreation` (what was true when the advice was made),
 *   later corrections are stated separately, never merged in.
 * - Screen evidence is restated from its structured summary. Transcript text is
 *   NEVER quoted: the role is described from engine state instead.
 * - Stale advice is phrased as earlier, not as a live alert.
 *
 * Used by the in-process backend. The HTTP bridge should produce equivalent text
 * server-side (see overlay/README.md, GAP 1).
 */
import type { ExplanationContext } from '../contracts/shared';

export function buildExplanationText(context: ExplanationContext): string {
  const parts: string[] = [];
  const roles = context.contextAtCreation.participants.filter((p) => p.role);
  if (roles.length > 0) {
    const list = roles.map((p) => `${p.displayName} to ${p.role}`).join(', ');
    parts.push(`When this advice was made, the group had assigned ${list}.`);
  }
  if (context.contextAtCreation.goal) {
    parts.push(`The group's stated goal was: ${context.contextAtCreation.goal.text}.`);
  }
  for (const obs of context.conditionEvidence) {
    if (obs.source === 'screen') parts.push(`The shared screen showed: ${ensurePeriod(obs.summary)}`);
  }
  parts.push(ensurePeriod(context.recommendation.shortAdvice));
  for (const change of context.changesSinceCreation) {
    if (change.kind === 'role_changed') {
      parts.push(
        change.change.kind === 'assigned'
          ? `Since then, ${change.displayName}'s role changed to ${change.change.role}.`
          : `Since then, ${change.displayName}'s role was cleared.`,
      );
    } else {
      parts.push(`Since then, the goal "${change.text}" was retired.`);
    }
  }
  if (context.isStale) parts.push('This is based on an earlier observation and may no longer be current.');
  return parts.join(' ');
}

const ensurePeriod = (s: string) => (/[.!?]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);
