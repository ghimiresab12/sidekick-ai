"""Quiet, consent-gated LiveKit STT participant for Sidekick."""

from __future__ import annotations

import asyncio

from dotenv import load_dotenv
from livekit.agents import (
    Agent,
    AgentServer,
    AgentSession,
    AutoSubscribe,
    JobContext,
    cli,
    inference,
    room_io,
)
from livekit.plugins import ai_coustics

from sidekick_bridge import BridgeClient
from stt_runtime import ConsentGatedSTTRuntime, speak_connection_greeting
from transcript_forwarder import TranscriptForwarder
from video_diagnostic import VideoTrackDiagnostic, video_diagnostic_enabled

load_dotenv(".env.local")


class SidekickAgent(Agent):
    """No conversational model; speech is explicitly scheduled once by the job."""

    def __init__(self) -> None:
        super().__init__(
            instructions="You are a quiet transcription participant. Never answer or initiate conversation."
        )


server = AgentServer()


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
            agent=SidekickAgent(),
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
        # Wait for greeting playout while input is still disabled. Never use an LLM.
        if greet:
            await speak_connection_greeting(session)
        session.output.set_audio_enabled(False)
    except BaseException:
        session.shutdown(drain=False)
        await session.aclose()
        raise
    return session


@server.rtc_session(agent_name="sidekick-ai")
async def entrypoint(ctx: JobContext) -> None:
    bridge: BridgeClient | None = None
    forwarder: TranscriptForwarder | None = None
    transcription_runtime: ConsentGatedSTTRuntime | None = None
    video_diagnostic: VideoTrackDiagnostic | None = None
    cleanup_task: asyncio.Task[None] | None = None

    async def cleanup() -> None:
        try:
            if video_diagnostic is not None:
                await video_diagnostic.close()
        finally:
            try:
                if transcription_runtime is not None:
                    await transcription_runtime.close()
            finally:
                try:
                    if forwarder is not None:
                        await forwarder.close()
                finally:
                    if bridge is not None:
                        await bridge.close()

    async def shutdown(_reason: str | None = None) -> None:
        nonlocal cleanup_task
        if cleanup_task is None:
            cleanup_task = asyncio.create_task(cleanup())
        await asyncio.shield(cleanup_task)

    ctx.add_shutdown_callback(shutdown)
    try:
        bridge = BridgeClient.from_env(poll_interval=0.25, max_state_age=0.75)
        await bridge.start(ctx.room.name)
        forwarder = TranscriptForwarder(bridge, max_pending=16)
        forwarder.start()
        if video_diagnostic_enabled():
            # Opt-in, metadata only. Audio-only auto-subscription keeps the SDK from
            # subscribing to video; the diagnostic subscribes only under consent.
            await ctx.connect(auto_subscribe=AutoSubscribe.AUDIO_ONLY)
            video_diagnostic = VideoTrackDiagnostic(bridge, ctx.room)
            video_diagnostic.start()
        transcription_runtime = ConsentGatedSTTRuntime(
            bridge,
            forwarder,
            lambda greet: start_transcription_session(ctx, greet),
        )
        await transcription_runtime.start()
    except BaseException:
        # Cleanup also covers SDK/provider errors and cancellation during startup.
        await shutdown("startup_failed")
        raise


if __name__ == "__main__":
    cli.run_app(server)
