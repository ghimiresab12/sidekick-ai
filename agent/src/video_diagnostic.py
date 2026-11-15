"""Metadata-only diagnostic for incoming LiveKit video tracks. Off by default.

Purpose: learn how Chert exposes FaceTime video (track kind, source, signalled
dimensions, publication/subscription events) before any frame pipeline is built.

What it never does
    * open an ``rtc.VideoStream`` or read, decode, encode, store, upload or display a
      frame - it has no code path that touches pixels or a track object;
    * talk to the Node bridge, Gemini or any provider - it only READS the capture
      state the existing ``BridgeClient`` already polls;
    * log participant identities, display names, attributes, metadata, track names
      or SDK error text - in any consent state. A participant appears only as a
      hash salted per process (not reversible by guessing phone numbers, not
      correlatable across runs). A track name is reduced to a fixed class: whether
      it equals one of Chert's two documented constants, or is "other".

Consent
    Structural publication metadata (kind, source, signalled size, sid) is signalling
    data and is logged whenever the diagnostic is enabled. Video is SUBSCRIBED only while the bridge reports an active, consented,
    fresh capture state, and is unsubscribed as soon as that stops being true. The
    entrypoint connects with audio-only auto-subscription when this is enabled, so the
    SDK does not subscribe to video on its own.

SDK contract (checked against livekit 1.2.1 / livekit-agents 1.8.12)
    ``rtc.Room.on/off`` events and their argument order:
        track_published(publication, participant)
        track_unpublished(publication, participant)
        track_subscribed(track, publication, participant)
        track_unsubscribed(track, publication, participant)
        track_subscription_failed(participant, track_sid, error)
        track_muted(participant, publication) / track_unmuted(participant, publication)
    ``RemoteTrackPublication``: sid, name, kind, source, width, height, mime_type,
    simulcasted, muted, subscribed, set_subscribed(bool).
    ``RemoteParticipant``: identity, kind, track_publications.
    No livekit import is needed: the enum values below are the protocol's integers.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import math
import os
import re
import secrets
from collections.abc import Callable
from typing import Any

from sidekick_bridge import BridgeClient

__all__ = ["ENV_FLAG", "VideoTrackDiagnostic", "video_diagnostic_enabled"]

logger = logging.getLogger("sidekick.video_diagnostic")

ENV_FLAG = "SIDEKICK_VIDEO_DIAGNOSTIC"
LOG_PREFIX = "video_track_diagnostic"

# livekit protocol enum values (rtc.TrackKind / rtc.TrackSource / rtc.ParticipantKind).
KIND_VIDEO = 2
_KINDS = {0: "unknown", 1: "audio", 2: "video"}
_SOURCES = {
    0: "unknown",
    1: "camera",
    2: "microphone",
    3: "screen_share",
    4: "screen_share_audio",
}
_PARTICIPANT_KINDS = {
    0: "standard",
    1: "ingress",
    2: "egress",
    3: "sip",
    4: "agent",
    5: "connector",
    6: "bridge",
}

# Track names Chert documents for its FaceTime bridge. Only a match against these
# constants is reported; the name itself is never logged.
_TRACK_NAME_CLASSES = {
    "facetime-remote-video": "chert_remote_video",
    "facetime-remote-audio": "chert_remote_audio",
}
# Server-generated values only; anything else is dropped rather than logged.
_TRACK_SID = re.compile(r"TR_[A-Za-z0-9]{1,40}")
_MIME_TYPE = re.compile(r"(?:audio|video)/[A-Za-z0-9.+\-]{1,32}")


def video_diagnostic_enabled(env: Any = None) -> bool:
    """True only for an explicit opt-in value of ``SIDEKICK_VIDEO_DIAGNOSTIC``."""
    source = os.environ if env is None else env
    return str(source.get(ENV_FLAG, "")).strip().lower() in {"1", "true", "on", "yes"}


def _strict(pattern: re.Pattern[str], value: object) -> str | None:
    """The value only if it fully matches a server-generated shape, else nothing."""
    if isinstance(value, str) and pattern.fullmatch(value):
        return value
    return None


def _track_name_class(value: object) -> str:
    if not isinstance(value, str) or not value:
        return "empty"
    return _TRACK_NAME_CLASSES.get(value, "other")


def _ref(value: object, salt: bytes) -> str:
    """Short salted one-way reference to correlate one participant's events in a run."""
    if not isinstance(value, str) or not value:
        return ""
    digest = hashlib.sha256(salt + value.encode("utf-8", "replace"))
    return digest.hexdigest()[:10]


def _name(table: dict[int, str], value: object) -> str:
    return table.get(value, "unrecognized") if isinstance(value, int) else "unknown"


def _dimension(value: object) -> int | None:
    """Signalled size only. 0 / missing means the publisher did not announce one."""
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        return None
    return value


class VideoTrackDiagnostic:
    """Logs remote track metadata; subscribes to video only while consent is active.

    All methods run on the job's event loop. The bridge client stays owned by the
    job: this class never starts, closes or sends through it.
    """

    _EVENTS = (
        "track_published",
        "track_unpublished",
        "track_subscribed",
        "track_unsubscribed",
        "track_subscription_failed",
        "track_muted",
        "track_unmuted",
    )

    def __init__(
        self,
        bridge: BridgeClient,
        room: Any,
        *,
        poll_interval: float = 0.25,
        emit: Callable[[dict[str, Any]], None] | None = None,
    ) -> None:
        if (
            isinstance(poll_interval, bool)
            or not isinstance(poll_interval, (int, float))
            or not math.isfinite(poll_interval)
            or poll_interval <= 0
        ):
            raise ValueError("poll_interval must be finite and positive")
        self._bridge = bridge
        self._room = room
        self._poll_interval = poll_interval
        self._emit = emit or self._log
        self._handlers: dict[str, Callable[..., None]] = {}
        self._salt = secrets.token_bytes(16)
        self._gate_open = False
        self._started = False
        self._closed = False
        self._watch_task: asyncio.Task[None] | None = None

    # -- Lifecycle -------------------------------------------------------------

    def start(self) -> None:
        """Registers handlers, reports tracks already published, starts the watcher.

        Call it right after the room is connected, with no ``await`` in between, so
        no publication event can be missed.
        """
        if self._started or self._closed:
            return
        self._started = True
        for event in self._EVENTS:
            handler = self._guarded(getattr(self, f"_on_{event}"))
            self._handlers[event] = handler
            self._room.on(event, handler)
        self._emit({"event": "diagnostic_started", "consent": self._consented()})
        for participant, publication in self._publications():
            self._report("existing_publication", publication, participant)
        self._reconcile()
        self._watch_task = asyncio.create_task(
            self._watch(), name="sidekick-video-diagnostic"
        )

    async def close(self) -> None:
        """Removes handlers, stops the watcher and drops any video subscription."""
        if self._closed:
            return
        self._closed = True
        for event, handler in self._handlers.items():
            try:
                self._room.off(event, handler)
            except Exception as error:
                logger.warning(
                    "video diagnostic detach failed: %s", type(error).__name__
                )
        self._handlers.clear()
        task, self._watch_task = self._watch_task, None
        if task is not None:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        self._gate_open = False
        self._unsubscribe_all("diagnostic_closed")
        if self._started:
            self._emit({"event": "diagnostic_stopped"})

    # -- Consent gate ----------------------------------------------------------

    def _consented(self) -> bool:
        """Same condition the STT runtime uses; any doubt means no."""
        if self._closed:
            return False
        try:
            bridge = self._bridge
            state = bridge.capture_state
            return bool(
                not bridge.auth_failed
                and bridge.accepting_input
                and state.status == "active"
                and state.consent_given
                and state.accepting_input
                and state.session_id
            )
        except Exception:
            return False

    async def _watch(self) -> None:
        try:
            while not self._closed:
                self._reconcile()
                await asyncio.sleep(self._poll_interval)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            # Fail closed: never keep a video subscription without a working gate.
            logger.warning("video diagnostic watcher stopped: %s", type(error).__name__)
            self._gate_open = False
            self._unsubscribe_all("watcher_failed")

    def _reconcile(self) -> None:
        consented = self._consented()
        if consented == self._gate_open:
            return
        self._gate_open = consented
        self._emit({"event": "consent_gate", "consent": consented})
        if consented:
            for participant, publication in self._publications():
                self._subscribe(publication, participant)
        else:
            self._unsubscribe_all("consent_inactive")

    def _subscribe(self, publication: Any, participant: Any) -> None:
        if not self._is_video(publication) or getattr(publication, "subscribed", False):
            return
        # Re-check now, not only at the last watcher tick.
        if not self._consented():
            return
        try:
            publication.set_subscribed(True)
        except Exception as error:
            self._report(
                "subscribe_request_failed",
                publication,
                participant,
                error=type(error).__name__,
            )
            return
        self._report("subscribe_requested", publication, participant)

    def _unsubscribe_all(self, reason: str) -> None:
        for participant, publication in self._publications():
            if self._is_video(publication) and getattr(
                publication, "subscribed", False
            ):
                self._unsubscribe(publication, participant, reason)

    def _unsubscribe(self, publication: Any, participant: Any, reason: str) -> None:
        try:
            publication.set_subscribed(False)
        except Exception as error:
            self._report(
                "unsubscribe_request_failed",
                publication,
                participant,
                reason=reason,
                error=type(error).__name__,
            )
            return
        self._report("unsubscribe_requested", publication, participant, reason=reason)

    # -- Room events (argument order per the SDK contract above) ---------------

    def _on_track_published(self, publication: Any, participant: Any) -> None:
        self._report("track_published", publication, participant)
        self._reconcile()
        if self._gate_open:
            self._subscribe(publication, participant)

    def _on_track_unpublished(self, publication: Any, participant: Any) -> None:
        self._report("track_unpublished", publication, participant)

    def _on_track_subscribed(
        self, _track: Any, publication: Any, participant: Any
    ) -> None:
        # ``_track`` is deliberately unused: no stream is ever attached to it.
        self._reconcile()
        self._report("track_subscribed", publication, participant)
        if (
            self._is_video(publication)
            and not self._gate_open
            and getattr(publication, "subscribed", True)
        ):
            self._unsubscribe(publication, participant, "subscribed_without_consent")

    def _on_track_unsubscribed(
        self, _track: Any, publication: Any, participant: Any
    ) -> None:
        self._report("track_unsubscribed", publication, participant)

    def _on_track_subscription_failed(
        self, participant: Any, track_sid: Any, _error: Any
    ) -> None:
        # The SDK error text is not logged; it is provider-controlled.
        record = self._participant_fields(participant)
        record.update(
            event="track_subscription_failed", track_sid=_strict(_TRACK_SID, track_sid)
        )
        self._emit(record)

    def _on_track_muted(self, participant: Any, publication: Any) -> None:
        self._report("track_muted", publication, participant)

    def _on_track_unmuted(self, participant: Any, publication: Any) -> None:
        self._report("track_unmuted", publication, participant)

    # -- Reporting -------------------------------------------------------------

    def _guarded(self, handler: Callable[..., None]) -> Callable[..., None]:
        def run(*args: Any) -> None:
            if self._closed:
                return
            try:
                handler(*args)
            except Exception as error:  # never raise into the SDK's event emitter
                logger.warning(
                    "video diagnostic handler failed: %s", type(error).__name__
                )

        return run

    def _publications(self) -> list[tuple[Any, Any]]:
        try:
            participants = list(self._room.remote_participants.values())
        except Exception:
            return []
        found = []
        for participant in participants:
            try:
                publications = list(participant.track_publications.values())
            except Exception:
                continue
            found.extend((participant, publication) for publication in publications)
        return found

    @staticmethod
    def _is_video(publication: Any) -> bool:
        return getattr(publication, "kind", None) == KIND_VIDEO

    def _participant_fields(self, participant: Any) -> dict[str, Any]:
        # The identity is only ever hashed; it is never placed in a record.
        identity = getattr(participant, "identity", None)
        return {
            "participant_ref": _ref(identity, self._salt),
            "participant_kind": _name(
                _PARTICIPANT_KINDS, getattr(participant, "kind", None)
            ),
        }

    def _report(
        self, event: str, publication: Any, participant: Any, **extra: Any
    ) -> None:
        record = self._participant_fields(participant)
        record.update(
            event=event,
            track_sid=_strict(_TRACK_SID, getattr(publication, "sid", None)),
            track_name_class=_track_name_class(getattr(publication, "name", None)),
            kind=_name(_KINDS, getattr(publication, "kind", None)),
            source=_name(_SOURCES, getattr(publication, "source", None)),
            width=_dimension(getattr(publication, "width", None)),
            height=_dimension(getattr(publication, "height", None)),
            mime_type=_strict(_MIME_TYPE, getattr(publication, "mime_type", None)),
            simulcasted=bool(getattr(publication, "simulcasted", False)),
            muted=bool(getattr(publication, "muted", False)),
            subscribed=bool(getattr(publication, "subscribed", False)),
            consent=self._gate_open,
        )
        record.update(extra)
        self._emit(record)

    @staticmethod
    def _log(record: dict[str, Any]) -> None:
        logger.info("%s %s", LOG_PREFIX, json.dumps(record, sort_keys=True))
