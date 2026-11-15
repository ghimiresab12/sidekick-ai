import type { SessionEvent } from '../contracts/types.js';

interface Entry {
  event: SessionEvent;
  timeMs: number;
  seq: number;
}

/**
 * Append-only, in-memory event recorder for one session.
 * `list()` orders by event time (source time for observations), breaking ties by
 * insertion order, so late-arriving observations land where they happened.
 */
export class Timeline {
  readonly #entries: Entry[] = [];
  #seq = 0;

  record(event: SessionEvent, timeMs: number): void {
    this.#entries.push({ event: { ...event }, timeMs, seq: this.#seq++ });
  }

  list(): SessionEvent[] {
    return [...this.#entries]
      .sort((a, b) => a.timeMs - b.timeMs || a.seq - b.seq)
      .map((e) => structuredClone(e.event));
  }

  get size(): number {
    return this.#entries.length;
  }

  clear(): void {
    this.#entries.length = 0;
  }
}
