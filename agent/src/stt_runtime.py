"""Consent-gated lifecycle for the LiveKit STT session; no provider imports."""

from __future__ import annotations

import asyncio
import logging
import math
from collections.abc import Awaitable, Callable
from typing import Any, Protocol

from sidekick_bridge import BridgeClient, CaptureState
from transcript_forwarder import TranscriptForwarder

logger = logging.getLogger("sidekick.stt_runtime")


class _Session(Protocol):
    input: Any

    def on(self, event: str, callback: Callable[[object], None]) -> Any: ...

    def off(self, event: str, callback: Callable[[object], None]) -> Any: ...

    def shutdown(self, *, drain: bool = True) -> None: ...

    async def aclose(self) -> None: ...


SessionFactory = Callable[[bool], Awaitable[_Session]]
CaptureKey = tuple[str, int, int]
GREETING_TEXT = "Sidekick connected."


async def speak_connection_greeting(session: Any) -> None:
    """Wait for one fixed greeting; input must remain disabled throughout."""
    await session.say(GREETING_TEXT, allow_interruptions=False)


class ConsentGatedSTTRuntime:
    """Replace STT streams at session/generation boundaries; never relabel finals.

    The factory returns a started session whose input was disabled BEFORE startup,
    with any greeting finished and audio output disabled. All methods run on the
    same event loop. BridgeClient and TranscriptForwarder remain owned by the job.
    """

    def __init__(
        self,
        bridge: BridgeClient,
        forwarder: TranscriptForwarder,
        session_factory: SessionFactory,
        *,
        poll_interval: float = 0.25,
    ) -> None:
        if (
            isinstance(poll_interval, bool)
            or not isinstance(poll_interval, (int, float))
            or not math.isfinite(poll_interval)
            or poll_interval <= 0
        ):
            raise ValueError("poll_interval must be finite and positive")
        self._bridge = bridge
        self._forwarder = forwarder
        self._session_factory = session_factory
        self._poll_interval = poll_interval
        self._session: _Session | None = None
        self._callback: Callable[[object], None] | None = None
        self._active_key: CaptureKey | None = None
        self._closing = False
        self._lock = asyncio.Lock()
        self._start_task: asyncio.Task[None] | None = None
        self._watch_task: asyncio.Task[None] | None = None
        self._close_task: asyncio.Task[None] | None = None
        self._retiring: set[asyncio.Task[None]] = set()

    @property
    def session(self) -> _Session | None:
        return self._session

    @property
    def active(self) -> bool:
        return (
            self._session is not None
            and self._active_key is not None
            and self._active_key == self._current_key()
        )

    def _current_key(self) -> CaptureKey | None:
        state = self._bridge.capture_state
        if (
            self._closing
            or self._bridge.auth_failed
            or not self._bridge.accepting_input
            or state.status != "active"
            or not state.consent_given
            or not state.accepting_input
            or not state.session_id
        ):
            return None
        return state.session_id, self._bridge.epoch, state.generation

    async def start(self) -> None:
        """Single-flight initialization, including the one greeting."""
        if self._closing:
            raise RuntimeError("runtime is closed")
        if self._start_task is None:
            self._start_task = asyncio.create_task(self._start())
        await asyncio.shield(self._start_task)

    async def _start(self) -> None:
        async with self._lock:
            if self._closing:
                return
            await self._replace_session(greeting=True)
            if not self._closing:
                self._watch_task = asyncio.create_task(
                    self._watch_capture(), name="sidekick-consent-watch"
                )

    async def _watch_capture(self) -> None:
        try:
            while not self._closing:
                await self.reconcile(self._bridge.capture_state)
                if self._bridge.auth_failed:
                    return
                await asyncio.sleep(self._poll_interval)
        except Exception as error:
            # Fail closed; do not log SDK exceptions that might contain speech.
            logger.warning("STT watcher stopped: %s", type(error).__name__)
            async with self._lock:
                await self._deactivate()

    async def reconcile(self, state: CaptureState) -> None:
        """Reconcile fresh state; ignore stale snapshots supplied by delayed callers."""
        async with self._lock:
            key = self._current_key()
            if key is None:
                await self._deactivate()
                return
            if (state.session_id, self._bridge.epoch, state.generation) != key:
                return
            if self._active_key == key and self._session is not None:
                return
            if self._active_key is not None:
                await self._deactivate()
            if self._session is None:
                await self._replace_session(greeting=False)
            # Consent, epoch or generation may have changed during factory/teardown.
            if key != self._current_key():
                await self._deactivate()
                return
            if self._session is not None:
                self._active_key = key
                self._session.input.set_audio_enabled(True)

    async def _replace_session(self, *, greeting: bool) -> None:
        session = await self._session_factory(greeting)
        try:
            session.input.set_audio_enabled(False)
            callback = self._make_transcript_callback(session)
            if not self._closing:
                session.on("user_input_transcribed", callback)
        except BaseException:
            await self._retire(session)
            raise
        if self._closing:
            await self._retire(session)
            return
        self._session = session
        self._callback = callback

    def _make_transcript_callback(self, owner: _Session) -> Callable[[object], None]:
        def on_transcript(event: object) -> None:
            # Check current bridge key NOW, not only at the next watcher tick.
            if self._session is not owner or not self.active:
                return
            transcript = getattr(event, "transcript", None)
            if (
                getattr(event, "is_final", False) is True
                and isinstance(transcript, str)
                and transcript.strip()
            ):
                self._forwarder.submit_final(transcript, is_final=True)

        return on_transcript

    async def _deactivate(self) -> None:
        self._active_key = None
        self._forwarder.clear_pending()
        session, self._session = self._session, None
        callback, self._callback = self._callback, None
        if session is not None:
            session.input.set_audio_enabled(False)
            if callback is not None:
                session.off("user_input_transcribed", callback)
            await self._retire(session)

    async def _retire(self, session: _Session) -> None:
        async def finish() -> None:
            try:
                session.shutdown(drain=False)
            finally:
                await session.aclose()

        task = asyncio.create_task(finish())
        self._retiring.add(task)
        try:
            await asyncio.shield(task)
        finally:
            if task.done():
                self._retiring.discard(task)

    async def close(self) -> None:
        """Revoke callbacks now; finish shared cleanup despite waiter cancellation."""
        if self._close_task is None:
            self._closing = True
            self._active_key = None
            self._forwarder.clear_pending()
            if self._session is not None:
                self._session.input.set_audio_enabled(False)
            self._close_task = asyncio.create_task(self._finish_close())
        await asyncio.shield(self._close_task)

    async def _finish_close(self) -> None:
        tasks = [t for t in (self._start_task, self._watch_task) if t is not None]
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        async with self._lock:
            await self._deactivate()
        if self._retiring:
            await asyncio.gather(*self._retiring, return_exceptions=True)
            self._retiring.clear()
