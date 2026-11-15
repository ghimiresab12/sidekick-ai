"""Async client for Sidekick's localhost Node HTTP bridge (the Python capture side).

This module is the ONLY place the Python agent talks to the bridge. It has no LiveKit or
Chert imports, so it can be tested without either.

What it does
    * registers (or recovers) the bridge session for a LiveKit room;
    * polls capture state in the background (``acceptingInput``, ``captureGeneration``);
    * hands out an immutable ``CaptureContext`` at observation time and requires it for
      every send, so an observation can only ever go to the session, generation and
      timestamp it was captured under;
    * sends final transcripts and sampled JPEG/PNG frames, each at most once;
    * maps every documented bridge response to a small ``Outcome``.

What it never does
    * grant consent, pause, resume, end or discard a session (operator / UI only);
    * hold or accept the control token;
    * capture or send while the latest poll does not say ``acceptingInput: true``;
    * move an observation from a replaced session into its replacement;
    * retry an observation;
    * log transcript text, image bytes, tokens or headers. Only route names, status
      codes, error codes, session IDs and observation IDs are logged.

Contract source: ``docs/engineering.md`` ("Python adapter contract", "Routes") and
``src/bridge/http-bridge.ts``.

Typical use from the agent::

    bridge = BridgeClient.from_env()
    await bridge.start(ctx.room.name)
    ...
    # AT CAPTURE TIME (final transcript received / frame sampled) - synchronous:
    context = bridge.capture()
    if context is not None:                       # None: capture is not allowed now
        result = await bridge.send_transcript(text, context)
        result = await bridge.send_frame(jpeg_bytes, context)
    ...
    await bridge.close()

Dependency: ``aiohttp`` (>= 3.10) is REQUIRED. It is already installed with
``livekit-agents``; declare it directly in ``agent/pyproject.toml`` because this module
imports it. There is no fallback transport: without aiohttp, constructing a client
raises ``BridgeDependencyError``.
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import os
import struct
import time
import weakref
import zlib
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Protocol
from urllib.parse import urlsplit

__all__ = [
    "MAX_FRAME_BYTES",
    "MAX_TRANSCRIPT_CHARS",
    "BridgeAuthError",
    "BridgeClient",
    "BridgeConfigError",
    "BridgeDependencyError",
    "BridgeError",
    "BridgeUnavailableError",
    "CaptureContext",
    "CaptureState",
    "Outcome",
    "SendResult",
    "Transport",
    "utc_timestamp",
]

logger = logging.getLogger("sidekick.bridge")

# Spelled this way so the module also imports on Python < 3.11 (tests run there too).
_UTC = timezone.utc  # noqa: UP017

# Limits enforced by the bridge (src/contracts/validate.ts, src/bridge/http-bridge.ts).
MAX_TRANSCRIPT_CHARS = 1000
MAX_FRAME_BYTES = 5 * 1024 * 1024
_MAX_ROOM_NAME_CHARS = 256
_MAX_SPEAKER_REF_CHARS = 128
_MAX_TIMESTAMP_CHARS = 64
_MAX_GENERATION = 10**16 - 1  # bridge accepts 1..16 digits
_MIN_TOKEN_CHARS = 32
_LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "::1"})
_JPEG_MAGIC = b"\xff\xd8\xff"
_PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


def _valid_png(image: bytes) -> bool:
    """Check PNG chunk bounds and checksums before transmitting image bytes."""
    if not image.startswith(_PNG_MAGIC):
        return False
    offset = len(_PNG_MAGIC)
    chunk_index = 0
    has_idat = False
    while offset + 12 <= len(image):
        length = struct.unpack_from(">I", image, offset)[0]
        kind_start = offset + 4
        data_start = offset + 8
        crc_start = data_start + length
        chunk_end = crc_start + 4
        if chunk_end > len(image):
            return False
        kind = image[kind_start:data_start]
        data = image[data_start:crc_start]
        expected_crc = struct.unpack_from(">I", image, crc_start)[0]
        if zlib.crc32(kind + data) & 0xFFFFFFFF != expected_crc:
            return False
        if chunk_index == 0:
            if kind != b"IHDR" or length != 13:
                return False
            width, height = struct.unpack_from(">II", data)
            if width == 0 or height == 0:
                return False
        elif kind == b"IHDR":
            return False
        if kind == b"IDAT":
            has_idat = True
        offset = chunk_end
        chunk_index += 1
        if kind == b"IEND":
            return length == 0 and has_idat and offset == len(image)
    return False


class BridgeError(Exception):
    """Base class for errors raised by ``BridgeClient``."""


class BridgeConfigError(BridgeError):
    """Invalid local configuration (URL, token, environment, numeric options)."""


class BridgeDependencyError(BridgeConfigError):
    """A required package (aiohttp) is not installed."""


class BridgeAuthError(BridgeError):
    """The bridge refused the agent token (401/403). Terminal: fix the configuration."""


class BridgeUnavailableError(BridgeError):
    """The bridge could not be reached or answered unexpectedly during ``start``."""


# `str, Enum` rather than StrEnum so the module also imports on Python < 3.11.
class Outcome(str, Enum):  # noqa: UP042
    """What happened to one observation. Only ``ACCEPTED`` means it was stored."""

    ACCEPTED = "accepted"
    #: Not sent: capture state is not (or no longer known to be) ``acceptingInput``.
    NOT_ACCEPTING = "not_accepting"
    #: Dropped: the context's session was replaced, its generation is not current
    #: (frames), or the bridge answered 409 invalid_generation / stale_evidence.
    STALE = "stale"
    #: Bridge says the session is not active (409 consent_required/session_not_active/aborted).
    SESSION_INACTIVE = "session_inactive"
    #: A frame is already in flight here, or in vision on the bridge (429 vision_busy). Dropped.
    BUSY = "busy"
    #: Not sent: frame uploads are backing off after a transient failure. Dropped.
    BACKING_OFF = "backing_off"
    #: The bridge stopped storing observations for this session (429 observation_limit_reached).
    LIMIT_REACHED = "limit_reached"
    #: The input itself is unacceptable (400/413/415/422, or failed a local check). Dropped.
    REJECTED = "rejected"
    #: Transient failure: network, timeout, 5xx (vision failed/unavailable/timeout). Dropped.
    UNAVAILABLE = "unavailable"
    #: The bridge no longer knows the session (404). The client re-registers in the background.
    SESSION_LOST = "session_lost"
    #: 401/403. Terminal for this client; nothing more is sent.
    AUTH_FAILED = "auth_failed"
    #: ``close()`` was called before or during the send. See ``SendResult.transmitted``.
    CLOSED = "closed"


@dataclass(frozen=True)
class SendResult:
    """Result of ``send_transcript`` / ``send_frame``. Contains no observation content."""

    outcome: Outcome
    #: HTTP status, if a request was made and answered.
    status: int | None = None
    #: Bridge error code (e.g. ``stale_evidence``) or a local reason (e.g. ``too_long``).
    error: str | None = None
    observation_id: str | None = None
    #: True if the request was handed to the HTTP transport. When True and the outcome
    #: is not ``ACCEPTED`` because of a cancellation, timeout or network error, the
    #: bridge MAY still have stored the observation: cancelling cannot undo that.
    #: False guarantees nothing was transmitted.
    transmitted: bool = False

    @property
    def accepted(self) -> bool:
        return self.outcome is Outcome.ACCEPTED


@dataclass(frozen=True)
class CaptureState:
    """Read-only snapshot of the bridge's capture state for this session."""

    session_id: str | None = None
    #: ``starting`` | ``active`` | ``paused`` | ``ended`` | ``unknown``
    status: str = "unknown"
    accepting_input: bool = False
    generation: int = 0
    consent_given: bool = False


@dataclass(frozen=True, eq=False)
class CaptureContext:
    """Where and when one observation was captured. Immutable; create with ``capture()``.

    A context binds an observation to the exact bridge session, the client's local
    session epoch, the capture generation and the capture timestamp that were current
    at the moment of capture. ``send_transcript`` / ``send_frame`` use ONLY these
    values; they never substitute the client's current session or generation.

    Only the EXACT object returned by ``BridgeClient.capture()`` is accepted, and only
    by the client that issued it. A copy (``dataclasses.replace``, ``copy.copy``, a
    hand-built instance) is refused even if every field is identical, and so is an
    issued object whose fields were changed afterwards. Keep the object itself with the
    captured media. Equality and hashing are by identity (``eq=False``).
    """

    #: Bridge session the observation belongs to.
    session_id: str
    #: Local counter that increases every time this client is bound to a different
    #: bridge session (re-registration after a bridge restart or a discard).
    epoch: int
    #: ``captureGeneration`` at capture time.
    generation: int
    #: ISO 8601 capture time; sent unchanged as ``observedAt``.
    observed_at: str


class Transport(Protocol):
    """HTTP transport seam. Production always uses aiohttp; tests may inject another.

    Implementations must not follow redirects or use proxies, must abort network I/O
    when the request coroutine is cancelled, and must refuse requests after ``close``.
    """

    async def request(
        self,
        method: str,
        url: str,
        headers: Mapping[str, str],
        body: bytes | None,
        timeout: float,
    ) -> tuple[int, dict[str, Any] | None]:
        """Returns ``(status, parsed JSON object or None)``. Raises on network failure."""
        ...

    async def close(self) -> None: ...


def _parse_json(raw: bytes) -> dict[str, Any] | None:
    try:
        value = json.loads(raw.decode("utf-8")) if raw else None
    except (ValueError, UnicodeDecodeError):
        return None
    return value if isinstance(value, dict) else None


class _AiohttpTransport:
    """The production transport: one ``aiohttp.ClientSession`` per client.

    * explicit total timeout on every request;
    * redirects disabled, proxies disabled (``trust_env=False``, ``proxy=None``), no
      cookie storage: the bearer token only ever goes to the configured loopback URL;
    * cancelling the request coroutine aborts the connection (aiohttp closes the
      socket), so a cancelled upload stops sending bytes;
    * ``close()`` closes the session and its connector; later requests are refused.
    """

    def __init__(self) -> None:
        try:
            import aiohttp
        except ImportError as error:
            raise BridgeDependencyError(
                "aiohttp is required by sidekick_bridge (add 'aiohttp>=3.10' to "
                "agent/pyproject.toml dependencies); there is no fallback transport"
            ) from error
        self._aiohttp = aiohttp
        self._session: Any = None
        self._closed = False

    async def request(
        self,
        method: str,
        url: str,
        headers: Mapping[str, str],
        body: bytes | None,
        timeout: float,
    ) -> tuple[int, dict[str, Any] | None]:
        if self._closed:
            raise RuntimeError("transport is closed")
        if self._session is None:
            aiohttp = self._aiohttp
            self._session = aiohttp.ClientSession(
                trust_env=False,
                cookie_jar=aiohttp.DummyCookieJar(),
                connector=aiohttp.TCPConnector(limit=4),
                timeout=aiohttp.ClientTimeout(total=timeout),
            )
        async with self._session.request(
            method,
            url,
            data=body,
            headers=dict(headers),
            allow_redirects=False,
            proxy=None,
            timeout=self._aiohttp.ClientTimeout(total=timeout),
        ) as response:
            return response.status, _parse_json(await response.read())

    async def close(self) -> None:
        self._closed = True
        session, self._session = self._session, None
        if session is not None:
            await session.close()


def utc_timestamp(moment: datetime | None = None) -> str:
    """ISO 8601 UTC timestamp with milliseconds, e.g. ``2026-11-15T09:37:43.897Z``."""
    value = moment if moment is not None else datetime.now(_UTC)
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("timestamp must be timezone-aware")
    text = value.astimezone(_UTC).isoformat(timespec="milliseconds")
    return text.replace("+00:00", "Z")


def _observed_at(value: str | datetime) -> str | None:
    """Capture time as the exact string to send, or None if it is unusable."""
    if isinstance(value, datetime):
        try:
            return utc_timestamp(value)
        except ValueError:
            return None
    if isinstance(value, str) and 0 < len(value) <= _MAX_TIMESTAMP_CHARS:
        return value  # passed through unchanged
    return None


def _valid_generation(value: object) -> bool:
    return (
        isinstance(value, int)
        and not isinstance(value, bool)
        and 1 <= value <= _MAX_GENERATION
    )


def _positive(name: str, value: object) -> float:
    """A strictly positive, finite number. Rejects bool, NaN, infinity, zero, negatives."""
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(value)
        or value <= 0
    ):
        raise BridgeConfigError(f"{name} must be a finite number greater than zero")
    return float(value)


class _Dispatch:
    """Whether one send reached the transport (so cancellation can report it honestly)."""

    __slots__ = ("transmitted",)

    def __init__(self) -> None:
        self.transmitted = False


class BridgeClient:
    """Capture-side client for one LiveKit room. Create one per job; not thread-safe.

    All coroutines must run on the same event loop. ``send_transcript`` and
    ``send_frame`` never raise for bridge or network problems: they return a
    ``SendResult``. Only ``start`` raises (``BridgeAuthError``, ``BridgeUnavailableError``,
    ``BridgeError`` when closed).
    """

    def __init__(
        self,
        base_url: str,
        agent_token: str,
        *,
        poll_interval: float = 1.0,
        request_timeout: float = 3.0,
        frame_timeout: float = 12.0,
        max_state_age: float | None = None,
        max_backoff: float = 30.0,
        max_live_contexts: int = 1024,
        allow_non_loopback: bool = False,
        transport: Transport | None = None,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        """
        :param base_url: e.g. ``http://127.0.0.1:8787`` (loopback only, by default).
        :param agent_token: ``SIDEKICK_AGENT_TOKEN``. Never pass the control token.
        :param poll_interval: seconds between capture-state polls.
        :param request_timeout: seconds for session/capture/transcript requests.
        :param frame_timeout: seconds for a frame upload; keep it a little above the
            bridge's 10 s frame deadline.
        :param max_state_age: capture state older than this is treated as "not
            accepting". Default: three poll intervals (at least 2 s).
        :param max_backoff: ceiling, in seconds, for poll and frame back-off.
        :param max_live_contexts: how many issued, still-referenced ``CaptureContext``
            objects are tracked. When exceeded, the OLDEST is forgotten and can no
            longer be sent (``REJECTED``, ``invalid_context``). Positive integer.
        :param transport: TESTS ONLY. Production leaves this unset and uses aiohttp;
            if aiohttp is missing, ``BridgeDependencyError`` is raised.

        Every numeric option must be a finite number greater than zero.
        """
        parts = urlsplit(base_url if isinstance(base_url, str) else "")
        if parts.scheme not in ("http", "https") or not parts.hostname:
            raise BridgeConfigError("bridge URL must be http(s)://host[:port]")
        if parts.username or parts.password or parts.query or parts.fragment:
            raise BridgeConfigError(
                "bridge URL must not contain credentials or a query"
            )
        if parts.path not in ("", "/"):
            raise BridgeConfigError("bridge URL must not contain a path")
        if parts.hostname not in _LOOPBACK_HOSTS and not allow_non_loopback:
            raise BridgeConfigError(
                "bridge URL must be loopback (the bridge binds 127.0.0.1 only)"
            )
        if (
            not isinstance(agent_token, str)
            or len(agent_token) < _MIN_TOKEN_CHARS
            or agent_token.strip() != agent_token
        ):
            raise BridgeConfigError(
                f"agent token must be at least {_MIN_TOKEN_CHARS} characters"
            )
        self._poll_interval = _positive("poll_interval", poll_interval)
        self._request_timeout = _positive("request_timeout", request_timeout)
        self._frame_timeout = _positive("frame_timeout", frame_timeout)
        self._max_backoff = _positive("max_backoff", max_backoff)
        if (
            isinstance(max_live_contexts, bool)
            or not isinstance(max_live_contexts, int)
            or max_live_contexts < 1
        ):
            raise BridgeConfigError("max_live_contexts must be a positive integer")
        self._max_live_contexts = max_live_contexts
        self._max_state_age = (
            _positive("max_state_age", max_state_age)
            if max_state_age is not None
            else max(3 * self._poll_interval, 2.0)
        )

        host = f"[{parts.hostname}]" if ":" in parts.hostname else parts.hostname
        port = f":{parts.port}" if parts.port is not None else ""
        self._base = f"{parts.scheme}://{host}{port}"
        self._auth = {"Authorization": f"Bearer {agent_token}"}
        # Raises BridgeDependencyError when aiohttp is missing: no silent fallback.
        self._transport: Transport = (
            transport if transport is not None else _AiohttpTransport()
        )
        self._sleep = sleep
        self._monotonic = monotonic
        # Issuance registry: id(context) -> (weak reference to THAT object, issued fields).
        # Holds no observation content and no strong reference: an entry disappears when
        # the caller drops the context, and the registry is capped (oldest evicted first).
        self._issued: dict[
            int, tuple[weakref.ref[CaptureContext], tuple[str, int, int, str]]
        ] = {}

        self._room: str | None = None
        self._state = CaptureState()
        self._state_at: float | None = None
        self._epoch = 0
        self._limit_reached = False
        self._auth_failed = False
        self._closed = False
        self._start_task: asyncio.Task[str] | None = None
        self._close_task: asyncio.Task[None] | None = None
        self._poll_task: asyncio.Task[None] | None = None
        self._wake: asyncio.Event | None = None
        self._sends: set[asyncio.Task[SendResult]] = set()
        self._frame_in_flight = False
        self._frame_failures = 0
        self._frame_retry_at = 0.0

    # -- Construction from the agent's environment -----------------------------

    @classmethod
    def from_env(
        cls, env: Mapping[str, str] | None = None, **kwargs: Any
    ) -> BridgeClient:
        """Builds a client from ``SIDEKICK_BRIDGE_URL`` and ``SIDEKICK_AGENT_TOKEN``.

        Refuses to start if ``SIDEKICK_CONTROL_TOKEN`` is present: the capture agent must
        never hold the operator token (it could grant consent or resume capture).
        """
        source = os.environ if env is None else env
        if source.get("SIDEKICK_CONTROL_TOKEN"):
            raise BridgeConfigError(
                "SIDEKICK_CONTROL_TOKEN must not be set in the agent's environment"
            )
        url = source.get("SIDEKICK_BRIDGE_URL", "").strip()
        token = source.get("SIDEKICK_AGENT_TOKEN", "")
        if not url:
            raise BridgeConfigError("SIDEKICK_BRIDGE_URL is not set")
        if not token:
            raise BridgeConfigError("SIDEKICK_AGENT_TOKEN is not set")
        return cls(url, token, **kwargs)

    # -- Read-only state -------------------------------------------------------

    @property
    def session_id(self) -> str | None:
        return self._state.session_id

    @property
    def epoch(self) -> int:
        """Local session epoch: increases each time the client is bound to a new session."""
        return self._epoch

    @property
    def capture_state(self) -> CaptureState:
        """Latest known state. ``accepting_input`` is False if the state is not fresh."""
        if self._state.accepting_input and not self.accepting_input:
            s = self._state
            return CaptureState(
                s.session_id, s.status, False, s.generation, s.consent_given
            )
        return self._state

    @property
    def accepting_input(self) -> bool:
        """True only while a RECENT poll said the bridge is accepting input.

        False before ``start``, before consent, while paused, after end, after
        ``close``, after an auth failure, and whenever polling has failed for longer
        than ``max_state_age`` (fail closed).
        """
        if self._closed or self._auth_failed or self._state_at is None:
            return False
        if self._poll_task is None:
            return False
        if self._monotonic() - self._state_at > self._max_state_age:
            return False
        return self._state.accepting_input

    @property
    def generation(self) -> int:
        """Latest known ``captureGeneration`` (informational; sends use ``capture()``)."""
        return self._state.generation

    @property
    def auth_failed(self) -> bool:
        return self._auth_failed

    @property
    def closed(self) -> bool:
        return self._closed

    # -- Capture context -------------------------------------------------------

    def capture(
        self, observed_at: str | datetime | None = None
    ) -> CaptureContext | None:
        """Records WHERE and WHEN an observation is being captured. Synchronous and atomic.

        Call it at the moment the final transcript arrives or the frame is sampled,
        and keep the returned context with that item until it is sent.

        Returns ``None`` when capture is not allowed right now (not started, no consent,
        paused, ended, session full, auth failed, closed, or capture state not fresh):
        drop the media, do not buffer it.

        :param observed_at: capture time. Default: now (UTC). A string is used
            unchanged; a datetime must be timezone-aware.
        :raises ValueError: if ``observed_at`` is unusable (naive datetime, empty or
            over-long string).
        """
        stamp = utc_timestamp() if observed_at is None else _observed_at(observed_at)
        if stamp is None:
            raise ValueError(
                "observed_at must be a timezone-aware datetime or an ISO 8601 string"
            )
        if not self.accepting_input or self._limit_reached:
            return None
        session_id, generation = self._state.session_id, self._state.generation
        if session_id is None or not _valid_generation(generation):
            return None
        return self._issue(session_id, self._epoch, generation, stamp)

    def _issue(
        self, session_id: str, epoch: int, generation: int, stamp: str
    ) -> CaptureContext:
        """Creates a context and records that exact object, with its fields, as issued."""
        context = CaptureContext(session_id, epoch, generation, stamp)
        key = id(context)
        registry = self._issued

        def forget(reference: weakref.ref[CaptureContext]) -> None:
            entry = registry.get(key)
            if (
                entry is not None and entry[0] is reference
            ):  # not a later object reusing the id
                del registry[key]

        while len(registry) >= self._max_live_contexts:
            del registry[
                next(iter(registry))
            ]  # dicts keep insertion order: oldest first
        registry[key] = (
            weakref.ref(context, forget),
            (session_id, epoch, generation, stamp),
        )
        return context

    def _is_issued(self, context: object) -> bool:
        """True only for an exact, unmodified object this client issued and still tracks."""
        if type(context) is not CaptureContext:
            return False
        entry = self._issued.get(id(context))
        if entry is None or entry[0]() is not context:
            return False
        return entry[1] == (
            context.session_id,
            context.epoch,
            context.generation,
            context.observed_at,
        )

    # -- Lifecycle -------------------------------------------------------------

    async def start(self, room_name: str) -> str:
        """Registers, or recovers, the bridge session for ``room_name`` and starts polling.

        Single-flight: concurrent calls share ONE registration and ONE poller and all
        return the same session ID. Idempotent across agent restarts (the bridge returns
        the same session for the same room while it has not ended). After a failed
        attempt, calling ``start`` again retries safely.

        Raises ``BridgeAuthError`` (401/403), ``BridgeUnavailableError`` (bridge
        unreachable or unexpected answer) or ``BridgeError`` (client closed, including
        when ``close()`` is called while registration is in progress).
        """
        if self._closed:
            raise BridgeError("client is closed")
        if (
            not isinstance(room_name, str)
            or not 0 < len(room_name) <= _MAX_ROOM_NAME_CHARS
        ):
            raise BridgeConfigError("room name must be 1-256 characters")
        if self._auth_failed:
            raise BridgeAuthError("bridge refused the agent token")
        if self._room is not None and room_name != self._room:
            raise BridgeError("client is already bound to another room")
        if self._poll_task is not None and self._state.session_id is not None:
            return self._state.session_id
        if self._start_task is None or self._start_task.done():
            self._room = room_name
            self._start_task = asyncio.get_running_loop().create_task(self._start())
            # Always consume the outcome, so a failure whose callers were all cancelled
            # does not surface as "Task exception was never retrieved".
            self._start_task.add_done_callback(lambda t: t.cancelled() or t.exception())
        task = self._start_task
        try:
            # shield: one cancelled caller must not cancel the registration others share.
            return await asyncio.shield(task)
        except asyncio.CancelledError:
            if self._closed and task.cancelled():
                raise BridgeError("client is closed") from None
            raise

    async def _start(self) -> str:
        failure = await self._register()
        # Re-check after the await: close() may have run while we were registering.
        if self._closed:
            raise BridgeError("client is closed")
        if failure is not None:
            if self._auth_failed:
                raise BridgeAuthError("bridge refused the agent token")
            raise BridgeUnavailableError(f"session registration failed: {failure}")
        session_id = self._state.session_id
        if session_id is None:  # defensive: _register succeeded, so this cannot happen
            raise BridgeUnavailableError("session registration failed: no session")
        # No await between the closed check above and creating the poller.
        self._wake = asyncio.Event()
        self._poll_task = asyncio.get_running_loop().create_task(self._poll_loop())
        return session_id

    async def close(self) -> None:
        """Stops everything this client owns. Idempotent; concurrent calls share one shutdown.

        After it returns: no registration, polling or send task of this client is
        running, no new one can be created, and the HTTP transport is closed.

        * Sends not yet handed to the transport are prevented (``CLOSED``,
          ``transmitted=False``).
        * Sends already in flight are cancelled and their network I/O aborted
          (``CLOSED``, ``transmitted=True``). The bridge may already have stored such
          an observation; cancellation cannot undo that.
        * It does NOT end or discard the bridge session: lifecycle belongs to the
          operator/UI.
        """
        if self._close_task is None:
            self._closed = True  # synchronous: from here nothing new can start
            self._close_task = asyncio.get_running_loop().create_task(self._shutdown())
        await asyncio.shield(self._close_task)

    async def _shutdown(self) -> None:
        tasks: list[asyncio.Task[Any]] = list(self._sends)
        for owned in (self._start_task, self._poll_task):
            if owned is not None and not owned.done():
                tasks.append(owned)
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        # A registration that finished between the checks cannot have created a poller
        # (it re-checks `_closed`), but verify rather than assume.
        if self._poll_task is not None and not self._poll_task.done():
            self._poll_task.cancel()
            await asyncio.gather(self._poll_task, return_exceptions=True)
        self._poll_task = None
        self._sends.clear()
        self._issued.clear()  # every issued context is void once the client is closed
        try:
            await self._transport.close()
        except Exception as error:
            logger.warning("bridge transport close failed: %s", type(error).__name__)
        logger.info("bridge client closed session=%s", self._state.session_id)

    async def __aenter__(self) -> BridgeClient:
        return self

    async def __aexit__(self, *_: object) -> None:
        await self.close()

    # -- Observations ----------------------------------------------------------

    async def send_transcript(
        self,
        text: str,
        context: CaptureContext,
        speaker_ref: str | None = None,
    ) -> SendResult:
        """Sends ONE final transcript to the session in ``context``. At most once.

        :param text: final (not interim) transcript, at most 1000 characters.
        :param context: from ``capture()`` at the moment the transcript arrived.
            A context from an EARLIER generation of the SAME session is still sent
            (the bridge accepts speech captured in an earlier active period). A
            context from a replaced session is refused (``STALE``, ``session_replaced``).
        :param speaker_ref: ONLY a verified speaker handle. Chert delivers one mixed
            audio track for the whole FaceTime call, so leave this ``None`` unless
            attribution has been verified live. Diarization labels are not identities.
        """
        gate = self._gate(context)
        if gate is not None:
            return gate
        if not isinstance(text, str) or not text.strip():
            return SendResult(Outcome.REJECTED, error="empty_text")
        if len(text) > MAX_TRANSCRIPT_CHARS:
            return SendResult(Outcome.REJECTED, error="too_long")
        payload: dict[str, Any] = {
            "captureGeneration": context.generation,
            "observedAt": context.observed_at,
            "text": text,
        }
        if speaker_ref is not None:
            if (
                not isinstance(speaker_ref, str)
                or not 0 < len(speaker_ref) <= _MAX_SPEAKER_REF_CHARS
            ):
                return SendResult(Outcome.REJECTED, error="invalid_speaker_ref")
            payload["speakerRef"] = speaker_ref
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers = {"Content-Type": "application/json"}
        # Bound to the ORIGINATING session here, synchronously, before any task exists.
        path = f"/v1/sessions/{context.session_id}/transcripts"
        dispatch = _Dispatch()
        return await self._tracked(
            self._post_observation(
                path, context, headers, body, self._request_timeout, False, dispatch
            ),
            dispatch,
        )

    async def send_frame(
        self,
        jpeg_bytes: bytes,
        context: CaptureContext,
        media_source: str = "screen_share",
    ) -> SendResult:
        """Uploads ONE sampled JPEG or PNG frame to the session in ``context``. At most once.

        Returns immediately, without transmitting, with ``BUSY`` if another frame is
        still uploading, ``BACKING_OFF`` after a recent transient failure, and
        ``STALE`` if the context's session was replaced or its generation is no longer
        current (the bridge refuses such frames without analysing them). Never queued,
        never retried: drop the frame and sample the next one.
        """
        gate = self._gate(context)
        if gate is not None:
            return gate
        if not isinstance(jpeg_bytes, (bytes, bytearray, memoryview)):
            return SendResult(Outcome.REJECTED, error="invalid_frame")
        size = len(jpeg_bytes)
        image_bytes = bytes(jpeg_bytes)
        is_jpeg = image_bytes.startswith(_JPEG_MAGIC)
        is_png = _valid_png(image_bytes)
        if size == 0 or not (is_jpeg or is_png):
            return SendResult(Outcome.REJECTED, error="invalid_frame")
        if size > MAX_FRAME_BYTES:
            return SendResult(Outcome.REJECTED, error="payload_too_large")
        if media_source not in {"camera", "screen_share"}:
            return SendResult(Outcome.REJECTED, error="invalid_media_source")
        if context.generation != self._state.generation:
            return SendResult(Outcome.STALE, error="stale_generation")
        if self._frame_in_flight:
            return SendResult(Outcome.BUSY, error="frame_in_flight")
        if self._monotonic() < self._frame_retry_at:
            return SendResult(Outcome.BACKING_OFF, error="backing_off")
        headers = {
            "Content-Type": "image/jpeg" if is_jpeg else "image/png",
            "X-Media-Source": media_source,
            "X-Capture-Generation": str(context.generation),
            "X-Observed-At": context.observed_at,
        }
        path = f"/v1/sessions/{context.session_id}/frames"  # originating session
        dispatch = _Dispatch()
        self._frame_in_flight = (
            True  # set synchronously: no await since the check above
        )
        try:
            return await self._tracked(
                self._post_observation(
                    path,
                    context,
                    headers,
                    image_bytes,
                    self._frame_timeout,
                    True,
                    dispatch,
                ),
                dispatch,
            )
        finally:
            # Also released when the caller or close() cancels before the upload starts.
            self._frame_in_flight = False

    # -- Internals -------------------------------------------------------------

    def _context_error(self, context: object) -> str | None:
        """Why a context may not be used now, or None. Never falls back to current state."""
        # Authenticity first: the exact issued object, with the fields it was issued with.
        # Copies, hand-built instances, other clients' contexts and tampered objects fail
        # here, so their (untrusted) fields are never even compared with current state.
        if not self._is_issued(context):
            return "invalid_context"
        assert isinstance(context, CaptureContext)
        # Authentic, but issued for a session this client is no longer bound to.
        if context.epoch != self._epoch or context.session_id != self._state.session_id:
            return "session_replaced"
        return None

    def _gate(self, context: object) -> SendResult | None:
        """Local checks shared by every observation. None means "may send"."""
        if self._closed:
            return SendResult(Outcome.CLOSED, error="closed_before_send")
        if self._auth_failed:
            return SendResult(Outcome.AUTH_FAILED)
        problem = self._context_error(context)
        if problem == "invalid_context":
            return SendResult(Outcome.REJECTED, error=problem)
        if problem is not None:
            return SendResult(Outcome.STALE, error=problem)
        if self._poll_task is None or self._state.session_id is None:
            return SendResult(Outcome.NOT_ACCEPTING, error="not_started")
        if not self.accepting_input:
            return SendResult(Outcome.NOT_ACCEPTING, error=self._state.status)
        if self._limit_reached:
            return SendResult(Outcome.LIMIT_REACHED, error="observation_limit_reached")
        return None

    async def _tracked(
        self, work: Awaitable[SendResult], dispatch: _Dispatch
    ) -> SendResult:
        """Runs a send as a task that ``close()`` can cancel.

        Called with no await since ``_gate`` returned, so a closed client never gets here.
        """
        task: asyncio.Task[SendResult] = asyncio.ensure_future(work)
        self._sends.add(task)
        try:
            return await task
        except asyncio.CancelledError:
            if self._closed and task.cancelled():
                if dispatch.transmitted:
                    # In flight: I/O aborted, but the bridge may already have stored it.
                    return SendResult(
                        Outcome.CLOSED, error="closed_in_flight", transmitted=True
                    )
                return SendResult(Outcome.CLOSED, error="closed_before_send")
            raise  # the caller itself was cancelled: propagate
        finally:
            self._sends.discard(task)

    async def _call(
        self,
        method: str,
        path: str,
        headers: Mapping[str, str] | None,
        body: bytes | None,
        timeout: float,
        dispatch: _Dispatch | None = None,
    ) -> tuple[int | None, dict[str, Any] | None]:
        """One request. Returns ``(None, None)`` on network failure, timeout or when closed."""
        if self._closed:
            return None, None
        if dispatch is not None:
            dispatch.transmitted = True
        try:
            # Outer wait_for: a hard ceiling even if a transport ignores its timeout.
            # Cancelling this coroutine cancels the transport request (I/O aborted).
            return await asyncio.wait_for(
                self._transport.request(
                    method,
                    self._base + path,
                    {**self._auth, **(headers or {})},
                    body,
                    timeout,
                ),
                timeout + 1.0,
            )
        except asyncio.CancelledError:
            raise
        except Exception as error:
            # Type name only: exception text may echo request details.
            logger.debug(
                "bridge %s %s failed: %s",
                method,
                path.rsplit("/", 1)[-1],
                type(error).__name__,
            )
            return None, None

    def _apply(self, body: dict[str, Any] | None) -> bool:
        """Stores a lifecycle view (`sessionId`, `status`, ...). False if it is malformed."""
        if not body or body.get("ok") is not True:
            return False
        session_id = body.get("sessionId")
        generation = body.get("captureGeneration")
        status = body.get("status")
        if (
            not isinstance(session_id, str)
            or not session_id
            or not isinstance(status, str)
        ):
            return False
        if (
            not isinstance(generation, int)
            or isinstance(generation, bool)
            or generation < 0
        ):
            return False
        previous = self._state
        if previous.session_id != session_id:
            # Bound to a different bridge session: every earlier CaptureContext is void.
            self._epoch += 1
            self._limit_reached = False
        self._state = CaptureState(
            session_id=session_id,
            status=status,
            accepting_input=body.get("acceptingInput") is True,
            generation=generation,
            consent_given=body.get("consentGiven") is True,
        )
        self._state_at = self._monotonic()
        if (previous.status, previous.generation, previous.session_id) != (
            status,
            generation,
            session_id,
        ):
            logger.info(
                "bridge capture state session=%s epoch=%d status=%s accepting=%s generation=%d",
                session_id,
                self._epoch,
                status,
                self._state.accepting_input,
                generation,
            )
        return True

    def _stop_accepting(self) -> None:
        """Fail closed until the next successful poll says otherwise."""
        s = self._state
        if s.accepting_input:
            self._state = CaptureState(
                s.session_id, s.status, False, s.generation, s.consent_given
            )

    def _refresh_soon(self) -> None:
        if self._wake is not None:
            self._wake.set()

    def _auth_failure(self, status: int) -> None:
        if not self._auth_failed:
            logger.error(
                "bridge refused the agent token (HTTP %d); capture stopped", status
            )
        self._auth_failed = True
        self._stop_accepting()
        self._refresh_soon()  # lets the poll loop notice and exit

    async def _register(self) -> str | None:
        """POST /v1/sessions for the bound room. Returns None on success, else a reason."""
        body = json.dumps({"externalRef": self._room}).encode("utf-8")
        status, data = await self._call(
            "POST",
            "/v1/sessions",
            {"Content-Type": "application/json"},
            body,
            self._request_timeout,
        )
        if (
            self._closed
        ):  # re-check after the await: never apply state to a closed client
            return "client closed"
        if status is None:
            return "bridge unreachable"
        if status in (401, 403):
            self._auth_failure(status)
            return f"HTTP {status}"
        if status in (200, 201) and self._apply(data):
            logger.info(
                "bridge session %s session=%s",
                "created" if status == 201 else "recovered",
                self._state.session_id,
            )
            return None
        code = data.get("error") if data else None
        return f"HTTP {status}" + (f" {code}" if isinstance(code, str) else "")

    async def _poll_once(self) -> bool:
        """One capture-state read. True if the state was refreshed."""
        session_id = self._state.session_id
        status, data = await self._call(
            "GET",
            f"/v1/sessions/{session_id}/capture",
            None,
            None,
            self._request_timeout,
        )
        if self._closed:
            return False
        if status == 200:
            # Only accept an answer about the session that was asked for.
            if data and data.get("sessionId") == session_id and self._apply(data):
                return True
            self._stop_accepting()
            return False
        if status in (401, 403):
            self._auth_failure(status)
            return False
        self._stop_accepting()
        if status == 404:
            # Bridge restarted (sessions are in memory) or the session was discarded.
            # A re-registered session starts at "starting": the operator must consent
            # again, and `_apply` bumps the epoch so buffered contexts are void.
            logger.warning(
                "bridge lost session=%s; registering the room again", session_id
            )
            return await self._register() is None
        return False

    async def _poll_loop(self) -> None:
        failures = 0
        wake = self._wake
        if wake is None:  # created together with this task in `_start`
            return
        while not self._closed and not self._auth_failed:
            delay = (
                self._poll_interval
                if failures == 0
                else min(
                    self._poll_interval * 2 ** min(failures, 10), self._max_backoff
                )
            )
            sleeper = asyncio.ensure_future(self._sleep(delay))
            waker = asyncio.ensure_future(wake.wait())
            try:
                await asyncio.wait(
                    {sleeper, waker}, return_when=asyncio.FIRST_COMPLETED
                )
            finally:
                sleeper.cancel()
                waker.cancel()
                await asyncio.gather(sleeper, waker, return_exceptions=True)
            wake.clear()
            if self._closed or self._auth_failed:
                return
            try:
                refreshed = await self._poll_once()
            except asyncio.CancelledError:
                raise
            except Exception as error:  # never let the poller die silently
                logger.warning("bridge poll error: %s", type(error).__name__)
                refreshed = False
            failures = 0 if refreshed else failures + 1

    async def _post_observation(
        self,
        path: str,
        context: CaptureContext,
        headers: dict[str, str],
        body: bytes,
        timeout: float,
        is_frame: bool,
        dispatch: _Dispatch,
    ) -> SendResult:
        kind = "frames" if is_frame else "transcripts"
        # Last checks before transmission (this task may start after state changed).
        if self._closed:
            return SendResult(Outcome.CLOSED, error="closed_before_send")
        if self._context_error(context) is not None:
            return SendResult(Outcome.STALE, error="session_replaced")
        status, data = await self._call("POST", path, headers, body, timeout, dispatch)
        code = data.get("error") if data else None
        error = code if isinstance(code, str) else None
        # Side effects (state changes, re-registration) apply only while the answer is
        # still about the session this client is bound to.
        current = self._context_error(context) is None and not self._closed
        result = self._classify(status, data, error, is_frame, current)
        log = logger.debug if result.accepted else logger.info
        log(
            "bridge %s session=%s status=%s outcome=%s error=%s observation=%s",
            kind,
            context.session_id,
            status,
            result.outcome.value,
            error,
            result.observation_id,
        )
        return result

    def _frame_backoff(self) -> None:
        self._frame_failures += 1
        delay = min(2.0 ** (self._frame_failures - 1), self._max_backoff)
        self._frame_retry_at = self._monotonic() + delay

    def _classify(
        self,
        status: int | None,
        data: dict[str, Any] | None,
        error: str | None,
        is_frame: bool,
        current: bool,
    ) -> SendResult:
        """Maps a bridge answer to an outcome and applies its side effects (contract section 7).

        ``current`` is False when the answer concerns a session this client is no longer
        bound to: the outcome is still reported, but client state is left alone.
        """
        sent = True
        if status is None:
            if is_frame:
                self._frame_backoff()
            return SendResult(
                Outcome.UNAVAILABLE, error="network_error", transmitted=sent
            )
        if status in (200, 202):
            observation = data.get("observationId") if data else None
            if data and data.get("ok") is True and isinstance(observation, str):
                if is_frame:
                    self._frame_failures = 0
                    self._frame_retry_at = 0.0
                return SendResult(
                    Outcome.ACCEPTED,
                    status,
                    observation_id=observation,
                    transmitted=sent,
                )
            return SendResult(
                Outcome.UNAVAILABLE, status, "invalid_response", transmitted=sent
            )
        if status in (401, 403):
            self._auth_failure(status)
            return SendResult(Outcome.AUTH_FAILED, status, error, transmitted=sent)
        if status == 404:
            if current:
                self._stop_accepting()
                self._refresh_soon()
            return SendResult(Outcome.SESSION_LOST, status, error, transmitted=sent)
        if status == 409:
            if current:
                self._refresh_soon()  # re-read capture state / refresh the generation
            if error in ("invalid_generation", "stale_evidence"):
                return SendResult(Outcome.STALE, status, error, transmitted=sent)
            # consent_required, session_not_active, aborted (and anything unexpected): stop.
            if current:
                self._stop_accepting()
            return SendResult(Outcome.SESSION_INACTIVE, status, error, transmitted=sent)
        if status == 429:
            if error == "observation_limit_reached":
                if current:
                    self._limit_reached = True
                return SendResult(
                    Outcome.LIMIT_REACHED, status, error, transmitted=sent
                )
            # vision_busy: a frame is already in vision. Drop this one, send the next sample.
            return SendResult(Outcome.BUSY, status, error, transmitted=sent)
        if status in (400, 413, 415, 422):
            # 422 timestamp_out_of_range: also refresh state in case the clock or session moved.
            if status == 422 and current:
                self._refresh_soon()
            return SendResult(Outcome.REJECTED, status, error, transmitted=sent)
        if is_frame:
            self._frame_backoff()  # 502 / 503 / 504 and anything else unexpected
        return SendResult(Outcome.UNAVAILABLE, status, error, transmitted=sent)
