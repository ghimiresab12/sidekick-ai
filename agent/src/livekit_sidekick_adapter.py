"""Forward consented LiveKit observations to Sidekick's local bridge."""

from __future__ import annotations

import asyncio
import logging
import struct
import time
import zlib
from collections.abc import Coroutine
from typing import Any

from livekit import rtc

from sidekick_bridge import BridgeClient, BridgeError, Outcome

logger = logging.getLogger("sidekick.livekit_adapter")

_FRAME_INTERVAL_SECONDS = 2.0
_MAX_FRAME_EDGE = 1280


class LiveKitSidekickAdapter:
    """Thin SDK adapter; consent and session lifecycle remain owned by the bridge."""

    def __init__(self, bridge: BridgeClient, room: rtc.Room) -> None:
        self._bridge = bridge
        self._room = room
        self._tasks: set[asyncio.Task[None]] = set()
        self._video_tasks: dict[str, asyncio.Task[None]] = {}
        self._last_frame_at: dict[str, float] = {}
        self._closed = False

    async def start(self) -> None:
        try:
            await self._bridge.start(self._room.name)
        except BridgeError as error:
            logger.warning(
                "Sidekick bridge unavailable at startup: %s", type(error).__name__
            )
            return

        self._room.on("track_subscribed", self._on_track_subscribed)
        logger.info("Sidekick bridge session registered for LiveKit room")

    def _schedule(self, coroutine: Coroutine[Any, Any, None], *, name: str) -> None:
        if self._closed:
            coroutine.close()
            return
        task = asyncio.create_task(coroutine, name=name)
        self._tasks.add(task)
        task.add_done_callback(self._task_finished)

    def _task_finished(self, task: asyncio.Task[None]) -> None:
        self._tasks.discard(task)
        if task.cancelled():
            return
        error = task.exception()
        if error is not None:
            logger.warning(
                "LiveKit observation forwarding failed: %s", type(error).__name__
            )

    def _on_track_subscribed(
        self,
        track: rtc.Track,
        publication: rtc.RemoteTrackPublication,
        _participant: rtc.RemoteParticipant,
    ) -> None:
        if self._closed:
            return
        if not isinstance(track, rtc.RemoteVideoTrack):
            return
        if publication.source == rtc.TrackSource.SOURCE_SCREENSHARE:
            media_source = "screen_share"
        elif publication.source == rtc.TrackSource.SOURCE_CAMERA:
            media_source = "camera"
        else:
            return

        key = publication.sid
        old_task = self._video_tasks.pop(key, None)
        if old_task is not None:
            old_task.cancel()
        task = asyncio.create_task(
            self._consume_video(track, key, media_source),
            name=f"sidekick-video-{media_source}",
        )
        self._video_tasks[key] = task
        self._tasks.add(task)
        task.add_done_callback(self._task_finished)

    async def _consume_video(
        self, track: rtc.RemoteVideoTrack, key: str, media_source: str
    ) -> None:
        stream = rtc.VideoStream.from_track(track=track, capacity=1)
        try:
            async for event in stream:
                now = time.monotonic()
                if now - self._last_frame_at.get(key, 0.0) < _FRAME_INTERVAL_SECONDS:
                    continue
                # Consent and provenance are checked at frame receipt; do not buffer
                # frames while the bridge is paused or consent has not been granted.
                context = self._bridge.capture()
                if context is None:
                    continue
                self._last_frame_at[key] = now
                png = self._encode_png(event.frame)
                if png is None:
                    continue
                result = await self._bridge.send_frame(
                    png, context, media_source=media_source
                )
                self._log_result(media_source, result.outcome)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            logger.warning(
                "LiveKit %s stream ended: %s", media_source, type(error).__name__
            )
        finally:
            await stream.aclose()
            self._last_frame_at.pop(key, None)
            if self._video_tasks.get(key) is asyncio.current_task():
                self._video_tasks.pop(key, None)

    @staticmethod
    def _encode_png(frame: rtc.VideoFrame) -> bytes | None:
        try:
            rgb = frame.convert(rtc.VideoBufferType.RGB24)
            width, height = rgb.width, rgb.height
            pixels = bytes(rgb.data)
            if width > _MAX_FRAME_EDGE or height > _MAX_FRAME_EDGE:
                scale = min(_MAX_FRAME_EDGE / width, _MAX_FRAME_EDGE / height)
                width, height = max(1, int(width * scale)), max(1, int(height * scale))
                pixels = _resize_rgb(pixels, rgb.width, rgb.height, width, height)
            # PNG uses only the standard library; encode one unfiltered RGB scanline
            # per row so this adapter needs no image-codec dependency.
            rows = b"".join(
                b"\x00" + pixels[row * width * 3 : (row + 1) * width * 3]
                for row in range(height)
            )
            return (
                b"\x89PNG\r\n\x1a\n"
                + _png_chunk(
                    b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
                )
                + _png_chunk(b"IDAT", zlib.compress(rows, level=3))
                + _png_chunk(b"IEND", b"")
            )
        except Exception as error:
            logger.warning(
                "Could not encode a LiveKit video frame: %s", type(error).__name__
            )
            return None

    @staticmethod
    def _log_result(source: str, outcome: Outcome) -> None:
        if outcome is not Outcome.ACCEPTED:
            logger.debug("Sidekick dropped %s observation: %s", source, outcome.value)

    async def close(self, _reason: str | None = None) -> None:
        if self._closed:
            return
        self._closed = True
        self._room.off("track_subscribed", self._on_track_subscribed)
        tasks = list(self._tasks)
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        await self._bridge.close()


def _resize_rgb(
    pixels: bytes, source_width: int, source_height: int, width: int, height: int
) -> bytes:
    """Nearest-neighbor downscale to bound bridge upload size."""
    output = bytearray(width * height * 3)
    for y in range(height):
        source_y = min(source_height - 1, y * source_height // height)
        for x in range(width):
            source_x = min(source_width - 1, x * source_width // width)
            source_offset = (source_y * source_width + source_x) * 3
            target_offset = (y * width + x) * 3
            output[target_offset : target_offset + 3] = pixels[
                source_offset : source_offset + 3
            ]
    return bytes(output)


def _png_chunk(kind: bytes, data: bytes) -> bytes:
    payload = kind + data
    return (
        struct.pack(">I", len(data))
        + payload
        + struct.pack(">I", zlib.crc32(payload) & 0xFFFFFFFF)
    )
