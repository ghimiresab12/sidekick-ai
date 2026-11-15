import type { RecommendationView } from '../contracts/shared';

interface Props {
  players: RecommendationView['relatedParticipants'];
  /** RecommendationView.contextChangedSinceCreation */
  contextChanged?: boolean;
}

/** Related players and their roles AS THEY WERE when the advice was made. */
export function PlayerContext({ players, contextChanged = false }: Props) {
  if (players.length === 0 && !contextChanged) return null;
  return (
    <section className="players" aria-label="Related players">
      <h3 className="section-label">Player context</h3>
      {players.length > 0 && (
        <ul>
          {players.map((p) => (
            <li key={p.id} className="player-chip">
              <strong>{p.displayName}</strong>
              <span>{p.role ? p.role : 'role not stated'}</span>
            </li>
          ))}
        </ul>
      )}
      {contextChanged && (
        <p className="hint">A related role or goal was corrected after this advice was made.</p>
      )}
    </section>
  );
}
