/**
 * Pure "derive what to show" helpers over the shared `OverlayState`.
 *
 * The ENGINE decides which card is prominent (an active card, important first,
 * then newest) and orders history. The UI adds only one thing: a user may bring
 * an open card from history to the front ("Show"). Stale cards are never promoted
 * automatically, so earlier advice is not presented as current.
 */
import type { OverlayState, RecommendationView } from '../contracts/shared';

/** Every card the session showed, prominent first then history. */
export function allCards(state: OverlayState | null): RecommendationView[] {
  if (!state) return [];
  return state.prominent ? [state.prominent, ...state.history] : [...state.history];
}

export const isOpen = (c: RecommendationView) => c.status === 'active' || c.status === 'stale';

/** The card in the main slot: the user's open selection, else the engine's prominent card. */
export function selectMainCard(state: OverlayState, selectedId: string | null): RecommendationView | null {
  if (selectedId) {
    const selected = allCards(state).find((c) => c.id === selectedId && isOpen(c));
    if (selected) return selected;
  }
  return state.prominent ?? null;
}

/** Every other card, keeping the engine's newest-first order. */
export function selectHistory(state: OverlayState, mainId: string | null): RecommendationView[] {
  return allCards(state).filter((c) => c.id !== mainId);
}

/** Earlier (stale) advice that exists while nothing is current: used by the empty state. */
export function countEarlierAdvice(state: OverlayState): number {
  return state.history.filter((c) => c.status === 'stale').length;
}
