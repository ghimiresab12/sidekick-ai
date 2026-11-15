"""Bounded final-STT forwarding; no LiveKit imports, logging, or automatic retries."""

from __future__ import annotations

import asyncio

from sidekick_bridge import (
    MAX_TRANSCRIPT_CHARS,
    BridgeClient,
    CaptureContext,
    SendResult,
)


class TranscriptForwarder:
    """One worker, at most ``max_pending`` queued texts and one in-flight send.

    Call all methods on the same running event loop. BridgeClient must already be
    started and remains owned by the job. ``submit_final`` belongs directly in the
    synchronous STT event callback; do not defer that call into another task.
    """

    def __init__(self, bridge: BridgeClient, *, max_pending: int = 16) -> None:
        if isinstance(max_pending, bool) or not isinstance(max_pending, int):
            raise ValueError("max_pending must be a positive integer")
        if max_pending <= 0:
            raise ValueError("max_pending must be a positive integer")
        self._bridge = bridge
        self._queue: asyncio.Queue[tuple[str, CaptureContext]] = asyncio.Queue(
            maxsize=max_pending
        )
        self._worker: asyncio.Task[None] | None = None
        self._closing: asyncio.Task[None] | None = None
        self._closed = False
        self.last_result: SendResult | None = None
        self.failed_count = 0

    def start(self) -> None:
        """Start once; repeated calls are harmless. Cannot restart after close."""
        if self._closed:
            raise RuntimeError("forwarder is closed")
        if self._worker is None:
            self._worker = asyncio.create_task(self._run())

    def submit_final(self, text: str, *, is_final: bool = True) -> bool:
        """Capture NOW and enqueue without awaiting; False means dropped locally."""
        if self._closed or self._worker is None or self._worker.done():
            return False
        if is_final is not True or not isinstance(text, str):
            return False
        if not text.strip() or len(text) > MAX_TRANSCRIPT_CHARS or self._queue.full():
            return False
        context = self._bridge.capture()
        if context is None:
            return False
        self._queue.put_nowait((text, context))
        return True

    def clear_pending(self) -> None:
        """Drop queued text only. In-flight acceptance cannot be undone."""
        while not self._queue.empty():
            self._queue.get_nowait()
            self._queue.task_done()

    async def wait_idle(self) -> None:
        """Wait for all currently queued sends (no retry on failure)."""
        await self._queue.join()

    async def close(self) -> None:
        """Stop accepting; shield shared cleanup from caller cancellation."""
        if self._closing is None:
            self._closed = True
            self.clear_pending()
            self._closing = asyncio.create_task(self._finish_close())
        await asyncio.shield(self._closing)

    async def _finish_close(self) -> None:
        if self._worker is not None:
            self._worker.cancel()
            await asyncio.gather(self._worker, return_exceptions=True)

    async def _run(self) -> None:
        while True:
            text, context = await self._queue.get()
            try:
                self.last_result = await self._bridge.send_transcript(text, context)
            except Exception:
                # Do not retain exceptions: transport messages may contain text.
                self.failed_count += 1
            finally:
                self._queue.task_done()
                # Release private content even while the worker waits for its next item.
                del text, context
