"""Consent-gated lifecycle for the LiveKit STT session."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import Any, Protocol

from sidekick_bridge import BridgeClient, CaptureState
from transcript_forwarder import TranscriptForwarder


class _Session(Protocol):
    input: Any

    def on(self, event: str, callback: Callable[[object], None]) -> Any: ...

    def off(self, event: str, callback: Callable[[object], None]) -> Any: ...

    def shutdown(self, *, drain: bool = True) -> None: ...

    async def aclose(self) -> None: ...


SessionFactory = Callable[[bool], Awaitable[_Session]]
GREETING_TEXT = "Sidekick connected."


async def speak_connection_greeting(session: Any) -> None:
    """Speak the one fixed connection greeting; never generate a model reply."""
    await session.say(GREETING_TEXT)


class ConsentGatedSTTRuntime:
    """Owns gated session startup, lifecycle replacement, and final transcript input.

    The factory must return a started session whose audio input was disabled before
    ``start``. Each capture-generation change gets a new session object and callback.
    That identity boundary rejects late finals from any retired STT stream.
    """

    def __init__(
        self,
        bridge: BridgeClient,
        forwarder: TranscriptForwarder,
        session_factory: SessionFactory,
        *,
        poll_interval: float = 0.25,
    ) -> None:
        if poll_interval <= 0:
            raise ValueError("poll_interval must be positive")
        self._bridge = bridge
        self._forwarder = forwarder
        self._session_factory = session_factory
        self._poll_interval = poll_interval
        self._session: _Session | None = None
        self._callback: Callable[[object], None] | None = None
        self._active_key: tuple[str | None, int, int] | None = None
        self._greeting_sent = False
        self._closing = False
        self._watch_task: asyncio.Task[None] | None = None

    @property
    def session(self) -> _Session | None:
        return self._session

    @property
    def active(self) -> bool:
        return self._active_key is not None and self._session is not None

    async def start(self) -> None:
        if self._closing:
            raise RuntimeError("runtime is closed")
        if self._watch_task is not None:
            return
        await self._replace_session(greeting=not self._greeting_sent)
        self._greeting_sent = True
        self._watch_task = asyncio.create_task(
            self._watch_capture(), name="sidekick-consent-watch"
        )

    async def _watch_capture(self) -> None:
        while not self._closing:
            if self._bridge.auth_failed:
                await self._deactivate()
                return
            await self.reconcile(self._bridge.capture_state)
            await asyncio.sleep(self._poll_interval)

    async def reconcile(self, state: CaptureState) -> None:
        """Apply a bridge snapshot; exposed to make lifecycle checks deterministic."""
        if self._closing or self._bridge.auth_failed:
            await self._deactivate()
            return

        key = (state.session_id, self._bridge.epoch, state.generation)
        if (
            state.status != "active"
            or not state.consent_given
            or not state.accepting_input
            or not self._bridge.accepting_input
        ):
            await self._deactivate()
            return

        if self._active_key == key and self._session is not None:
            return

        # The initial session was created with input disabled. If the first usable
        # snapshot already has consent, it can be safely enabled without replacing
        # the greeting session that has not received any audio.
        if self._active_key is None and self._session is not None:
            self._active_key = key
            self._session.input.set_audio_enabled(True)
            return

        # Revoke the old stream before awaiting its shutdown. Its callback checks both
        # object identity and the active state, so delayed finals cannot be relabeled.
        await self._deactivate()
        await self._replace_session(greeting=False)
        session = self._session
        if session is None:  # defensive; _replace_session either returns or raises
            return
        self._active_key = key
        session.input.set_audio_enabled(True)

    async def _replace_session(self, *, greeting: bool) -> None:
        session = await self._session_factory(greeting)
        session.input.set_audio_enabled(False)
        callback = self._make_transcript_callback(session)
        session.on("user_input_transcribed", callback)
        self._session = session
        self._callback = callback

    def _make_transcript_callback(self, owner: _Session) -> Callable[[object], None]:
        def on_transcript(event: object) -> None:
            if self._closing or self._session is not owner or not self.active:
                return
            transcript = getattr(event, "transcript", None)
            is_final = getattr(event, "is_final", False)
            if is_final is True and isinstance(transcript, str) and transcript.strip():
                self._forwarder.submit_final(transcript, is_final=True)

        return on_transcript

    async def _deactivate(self) -> None:
        # Synchronous gate closure happens before any await or stream teardown.
        self._active_key = None
        self._forwarder.clear_pending()
        session, self._session = self._session, None
        callback, self._callback = self._callback, None
        if session is None:
            return
        session.input.set_audio_enabled(False)
        if callback is not None:
            session.off("user_input_transcribed", callback)
        session.shutdown(drain=False)
        await session.aclose()

    async def close(self) -> None:
        if self._closing:
            return
        self._closing = True
        task, self._watch_task = self._watch_task, None
        if task is not None and task is not asyncio.current_task():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        await self._deactivate()
