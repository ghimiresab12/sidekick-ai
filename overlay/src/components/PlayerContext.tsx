import type { PlayerContextItem } from '../session/selectors';

/** Related players and their stated roles (proposed relatedParticipantIds). */
export function PlayerContext({ players }: { players: PlayerContextItem[] }) {
  if (players.length === 0) return null;
  return (
    <section className="players" aria-label="Related players">
      <h3 className="section-label">Player context</h3>
      <ul>
        {players.map((p) => (
          <li key={p.id} className="player-chip">
            <strong>{p.displayName ?? 'Unnamed participant'}</strong>
            <span>{p.role ? p.role : 'role not stated'}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
