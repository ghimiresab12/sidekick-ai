"""Quiet, consent-gated LiveKit STT participant for Sidekick."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os

from dotenv import load_dotenv
from livekit import rtc
from livekit.agents import (
    Agent,
    AgentServer,
    AgentSession,
    JobContext,
    cli,
    inference,
    room_io,
)
from livekit.plugins import ai_coustics

from livekit_sidekick_adapter import LiveKitSidekickAdapter
from sidekick_bridge import BridgeClient, BridgeError
from stt_runtime import ConsentGatedSTTRuntime, speak_connection_greeting
from transcript_forwarder import TranscriptForwarder
from video_avatar import HEIGHT, WIDTH, make_ai_avatar_frame

logger = logging.getLogger("agent-sidekick-ai")

load_dotenv(".env.local")


class SidekickAgent(Agent):
    """No conversational model; speaks only the single connection greeting."""

    def __init__(self, *, greet: bool) -> None:
        super().__init__(
            instructions="You are a quiet transcription participant. Never answer or initiate conversation."
        )
        self._greet = greet

    async def on_enter(self) -> None:
        if self._greet:
            await speak_connection_greeting(self.session)
        self.session.output.set_audio_enabled(False)


server = AgentServer()


async def publish_ai_avatar(ctx: JobContext) -> None:
    """Publish a synthetic, AI-labeled still avatar alongside the agent's audio."""
    if os.getenv("SIDEKICK_AGENT_VIDEO", "placeholder").lower() in {
        "0",
        "false",
        "off",
        "no",
    }:
        logger.info("synthetic AI avatar video is disabled")
        return

    source = rtc.VideoSource(WIDTH, HEIGHT)
    track = rtc.LocalVideoTrack.create_video_track("sidekick-ai-avatar", source)
    options = rtc.TrackPublishOptions(
        source=rtc.TrackSource.SOURCE_CAMERA,
        video_encoding=rtc.VideoEncoding(max_framerate=1, max_bitrate=160_000),
    )

    try:
        await ctx.agent.publish_track(track, options)
    except Exception:
        logger.exception("could not publish the synthetic AI avatar video track")
        return

    frame = make_ai_avatar_frame()

    async def send_avatar_frames() -> None:
        while True:
            source.capture_frame(frame)
            await asyncio.sleep(1)

    task = asyncio.create_task(send_avatar_frames(), name="sidekick-ai-avatar-video")

    async def stop_avatar(_: str) -> None:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task

    ctx.add_shutdown_callback(stop_avatar)
    logger.info("published synthetic AI-labeled avatar video track")


async def start_transcription_session(ctx: JobContext, greet: bool) -> AgentSession:
    """Create a fresh STT stream, gated before room audio is attached."""
    session = AgentSession(
        stt=inference.STT(model="deepgram/nova-3"),
        tts=inference.TTS(model="cartesia/sonic-3"),
    )
    # AgentInput's enabled state is applied when RoomIO attaches its AudioInput.
    session.input.set_audio_enabled(False)
    try:
        await session.start(
            agent=SidekickAgent(greet=greet),
            room=ctx.room,
            room_options=room_io.RoomOptions(
                audio_input=room_io.AudioInputOptions(
                    noise_cancellation=ai_coustics.audio_enhancement(
                        model=ai_coustics.EnhancerModel.QUAIL_VF_S,
                    ),
                ),
                text_input=False,
                text_output=False,
            ),
            record=False,
        )
    except BaseException:
        session.shutdown(drain=False)
        await session.aclose()
        raise
    return session


@server.rtc_session(agent_name="sidekick-ai")
async def entrypoint(ctx: JobContext) -> None:
    await publish_ai_avatar(ctx)
    bridge: BridgeClient | None = None
    bridge_adapter: LiveKitSidekickAdapter | None = None
    forwarder: TranscriptForwarder | None = None
    transcription_runtime: ConsentGatedSTTRuntime | None = None

    async def shutdown(_: str) -> None:
        if transcription_runtime is not None:
            await transcription_runtime.close()
        if forwarder is not None:
            await forwarder.close()
        if bridge_adapter is not None:
            await bridge_adapter.close()
        elif bridge is not None:
            await bridge.close()

    ctx.add_shutdown_callback(shutdown)
    try:
        bridge = BridgeClient.from_env(poll_interval=0.25, max_state_age=0.75)
        await bridge.start(ctx.room.name)
        forwarder = TranscriptForwarder(bridge, max_pending=16)
        forwarder.start()
        bridge_adapter = LiveKitSidekickAdapter(bridge, ctx.room)
        await bridge_adapter.start()
        transcription_runtime = ConsentGatedSTTRuntime(
            bridge,
            forwarder,
            lambda greet: start_transcription_session(ctx, greet),
        )
        await transcription_runtime.start()
    except BridgeError as error:
        logger.error(
            "Sidekick transcription disabled by bridge error: %s", type(error).__name__
        )
        await shutdown("bridge_error")
        raise


if __name__ == "__main__":
    cli.run_app(server)
