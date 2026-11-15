/**
 * Server-Sent Events writer for the versioned OverlayState feed.
 *
 * - Each frame: `id: <version>`, `event: state`, `data: <OverlayState JSON>`.
 * - Back-pressure: if the socket is not draining, only the NEWEST pending state is kept
 *   and written on 'drain' (versions never go backwards; stale snapshots are dropped).
 * - Heartbeat comment lines keep idle connections alive and detect dead peers.
 * - `discarded()` sends `event: discarded` and ends the stream.
 */
import type { ServerResponse } from 'node:http';
import type { OverlayState } from '../contracts/types.js';

export interface StateStream {
  send(state: OverlayState): void;
  discarded(): void;
  close(): void;
  readonly closed: boolean;
}

export function openStateStream(
  res: ServerResponse,
  options: { heartbeatMs: number; onClose: () => void; onHeartbeat?: () => void },
): StateStream {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-content-type-options': 'nosniff',
    'x-accel-buffering': 'no',
  });
  res.write(': connected\n\n');
  let closed = false;
  let pending: OverlayState | undefined;
  let blocked = false;
  let lastVersion = -1;

  const frame = (s: OverlayState) => `id: ${s.version}\nevent: state\ndata: ${JSON.stringify(s)}\n\n`;
  const write = (s: OverlayState) => {
    if (s.version <= lastVersion) return; // never deliver an older or duplicate version
    lastVersion = s.version;
    if (!res.write(frame(s))) blocked = true;
  };
  const onDrain = () => {
    blocked = false;
    const next = pending;
    pending = undefined;
    if (next && !closed) write(next);
  };
  const heartbeat = setInterval(() => {
    if (closed) return;
    options.onHeartbeat?.();
    if (!blocked && !res.write(': hb\n\n')) blocked = true; // respect back-pressure
  }, options.heartbeatMs);
  heartbeat.unref?.();

  const finish = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    res.off('drain', onDrain);
    pending = undefined;
    options.onClose();
  };
  res.on('drain', onDrain);
  res.on('close', finish);

  return {
    send(state) {
      if (closed) return;
      if (blocked) pending = state; // coalesce: keep only the newest
      else write(state);
    },
    discarded() {
      if (closed) return;
      res.write('event: discarded\ndata: {}\n\n');
      res.end();
      finish();
    },
    close() {
      if (closed) return;
      res.end();
      finish();
    },
    get closed() {
      return closed;
    },
  };
}
