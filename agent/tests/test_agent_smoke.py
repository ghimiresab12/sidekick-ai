"""Exercise the actual entrypoint with fake SDK objects; never load secret files."""

from __future__ import annotations

import asyncio
import importlib.util
import sys
import unittest
from pathlib import Path
from types import ModuleType, SimpleNamespace
from typing import ClassVar
from unittest.mock import patch

_SRC = Path(__file__).parents[1] / "src"


class FakeAgent:
    def __init__(self, **options):
        self.options = options


class FakeServer:
    def rtc_session(self, **options):
        return lambda callback: callback


class FakeSession:
    created: ClassVar[list[FakeSession]] = []

    def __init__(self, **options):
        self.options = options
        self.enabled = True
        self.output_enabled = True
        self.closed = False
        self.spoken = []
        self.input = SimpleNamespace(set_audio_enabled=self.set_input)
        self.output = SimpleNamespace(set_audio_enabled=self.set_output)
        self.created.append(self)

    def on(self, event, callback):
        pass

    def off(self, event, callback):
        pass

    def set_input(self, enabled):
        self.enabled = enabled

    def set_output(self, enabled):
        self.output_enabled = enabled

    async def start(self, **options):
        assert self.enabled is False
        self.start_options = options

    async def say(self, text, *, allow_interruptions):
        assert self.enabled is False
        assert allow_interruptions is False
        self.spoken.append(text)

    def shutdown(self, *, drain):
        pass

    async def aclose(self):
        self.closed = True


def load_agent():
    """Import with only fake LiveKit/dotenv; no credentials, sockets or providers."""
    agents = ModuleType("livekit.agents")
    agents.Agent = FakeAgent
    agents.AgentServer = FakeServer
    agents.AgentSession = FakeSession
    agents.AutoSubscribe = SimpleNamespace(AUDIO_ONLY="audio_only")
    agents.JobContext = object
    agents.cli = SimpleNamespace(run_app=lambda _: None)
    agents.inference = SimpleNamespace(STT=lambda **kw: kw, TTS=lambda **kw: kw)
    agents.room_io = SimpleNamespace(
        RoomOptions=lambda **kw: kw, AudioInputOptions=lambda **kw: kw
    )
    plugins = ModuleType("livekit.plugins")
    plugins.ai_coustics = SimpleNamespace(
        audio_enhancement=lambda **kw: kw,
        EnhancerModel=SimpleNamespace(QUAIL_VF_S="fake-model"),
    )
    dotenv = ModuleType("dotenv")
    dotenv.load_dotenv = lambda _: None
    modules = {
        "livekit": ModuleType("livekit"),
        "livekit.agents": agents,
        "livekit.plugins": plugins,
        "dotenv": dotenv,
    }
    spec = importlib.util.spec_from_file_location("sidekick_agent", _SRC / "agent.py")
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    with (
        patch.dict(sys.modules, modules),
        patch.object(sys, "path", [str(_SRC), *sys.path]),
    ):
        spec.loader.exec_module(module)
    return module


class AgentWiringTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        FakeSession.created = []
        self.agent = load_agent()

    async def test_stt_only_configuration_greeting_and_privacy(self):
        session = await self.agent.start_transcription_session(
            SimpleNamespace(room=object()), True
        )
        self.assertNotIn("llm", session.options)
        self.assertEqual(session.options["stt"], {"model": "deepgram/nova-3"})
        self.assertEqual(session.spoken, ["Sidekick connected."])
        self.assertFalse(session.enabled)
        self.assertFalse(session.output_enabled)
        self.assertFalse(session.start_options["record"])
        room_options = session.start_options["room_options"]
        self.assertFalse(room_options["text_input"])
        self.assertFalse(room_options["text_output"])
        next_session = await self.agent.start_transcription_session(
            SimpleNamespace(room=object()), False
        )
        self.assertEqual(next_session.spoken, [])
        self.assertFalse(next_session.output_enabled)

    async def test_greeting_failure_closes_session(self):
        async def fail(*args, **kwargs):
            raise RuntimeError("provider unavailable")

        with (
            patch.object(self.agent, "speak_connection_greeting", fail),
            self.assertRaises(RuntimeError),
        ):
            await self.agent.start_transcription_session(
                SimpleNamespace(room=object()), True
            )
        self.assertTrue(FakeSession.created[0].closed)

    async def test_entrypoint_failure_closes_bridge_and_registers_shutdown(self):
        class BrokenBridge:
            closed = False

            async def start(self, room):
                raise RuntimeError("startup unavailable")

            async def close(self):
                self.closed = True

        bridge = BrokenBridge()
        hooks = []
        ctx = SimpleNamespace(
            room=SimpleNamespace(name="same-room"), add_shutdown_callback=hooks.append
        )
        with (
            patch.object(self.agent.BridgeClient, "from_env", return_value=bridge),
            self.assertRaises(RuntimeError),
        ):
            await self.agent.entrypoint(ctx)
        self.assertTrue(bridge.closed)
        self.assertEqual(len(hooks), 1)
        await asyncio.gather(hooks[0]("shutdown"), hooks[0]("shutdown"))

    async def run_entrypoint(self, env):
        events = []

        class Bridge:
            async def start(self, room):
                events.append("bridge_start")

            async def close(self):
                events.append("bridge_close")

        class Diagnostic:
            def __init__(self, bridge, room):
                events.append("diagnostic_created")

            def start(self):
                events.append("diagnostic_start")

            async def close(self):
                events.append("diagnostic_close")

        class Runtime:
            def __init__(self, *args):
                pass

            async def start(self):
                events.append("runtime_start")

            async def close(self):
                events.append("runtime_close")

        class Forwarder:
            def __init__(self, *args, **kwargs):
                pass

            def start(self):
                pass

            async def close(self):
                events.append("forwarder_close")

        async def connect(**options):
            events.append(("connect", options))

        hooks = []
        ctx = SimpleNamespace(
            room=SimpleNamespace(name="same-room"),
            add_shutdown_callback=hooks.append,
            connect=connect,
        )
        with (
            patch.dict("os.environ", env, clear=True),
            patch.object(self.agent.BridgeClient, "from_env", return_value=Bridge()),
            patch.object(self.agent, "VideoTrackDiagnostic", Diagnostic),
            patch.object(self.agent, "ConsentGatedSTTRuntime", Runtime),
            patch.object(self.agent, "TranscriptForwarder", Forwarder),
        ):
            await self.agent.entrypoint(ctx)
            await hooks[0]("shutdown")
        return events

    async def test_video_diagnostic_is_off_by_default(self):
        events = await self.run_entrypoint({})
        self.assertEqual(
            events,
            [
                "bridge_start",
                "runtime_start",
                "runtime_close",
                "forwarder_close",
                "bridge_close",
            ],
        )

    async def test_video_diagnostic_opt_in_connects_audio_only_first(self):
        events = await self.run_entrypoint({"SIDEKICK_VIDEO_DIAGNOSTIC": "1"})
        self.assertEqual(
            events,
            [
                "bridge_start",
                ("connect", {"auto_subscribe": "audio_only"}),
                "diagnostic_created",
                "diagnostic_start",
                "runtime_start",
                "diagnostic_close",
                "runtime_close",
                "forwarder_close",
                "bridge_close",
            ],
        )

    async def test_video_diagnostic_stays_off_for_non_opt_in_values(self):
        for value in ("0", "false", "off", ""):
            events = await self.run_entrypoint({"SIDEKICK_VIDEO_DIAGNOSTIC": value})
            self.assertNotIn("diagnostic_created", events)
            self.assertFalse([e for e in events if isinstance(e, tuple)], value)

    async def test_early_connect_failure_cleans_up_without_starting_stt(self):
        events = []

        class Bridge:
            async def start(self, room):
                events.append("bridge_start")

            async def close(self):
                events.append("bridge_close")

        async def connect(**options):
            raise RuntimeError("room unavailable")

        def forbidden(*args, **kwargs):
            raise AssertionError("must not be constructed")

        hooks = []
        ctx = SimpleNamespace(
            room=SimpleNamespace(name="same-room"),
            add_shutdown_callback=hooks.append,
            connect=connect,
        )
        with (
            patch.dict("os.environ", {"SIDEKICK_VIDEO_DIAGNOSTIC": "1"}, clear=True),
            patch.object(self.agent.BridgeClient, "from_env", return_value=Bridge()),
            patch.object(self.agent, "VideoTrackDiagnostic", forbidden),
            patch.object(self.agent, "ConsentGatedSTTRuntime", forbidden),
            self.assertRaises(RuntimeError),
        ):
            await self.agent.entrypoint(ctx)
        self.assertEqual(events, ["bridge_start", "bridge_close"])

    async def test_diagnostic_close_failure_still_closes_everything_else(self):
        events = []

        class Bridge:
            async def start(self, room):
                pass

            async def close(self):
                events.append("bridge_close")

        class Diagnostic:
            def __init__(self, bridge, room):
                pass

            def start(self):
                pass

            async def close(self):
                raise RuntimeError("detach failed")

        class Runtime:
            def __init__(self, *args):
                pass

            async def start(self):
                pass

            async def close(self):
                events.append("runtime_close")

        class Forwarder:
            def __init__(self, *args, **kwargs):
                pass

            def start(self):
                pass

            async def close(self):
                events.append("forwarder_close")

        async def connect(**options):
            pass

        hooks = []
        ctx = SimpleNamespace(
            room=SimpleNamespace(name="same-room"),
            add_shutdown_callback=hooks.append,
            connect=connect,
        )
        with (
            patch.dict("os.environ", {"SIDEKICK_VIDEO_DIAGNOSTIC": "1"}, clear=True),
            patch.object(self.agent.BridgeClient, "from_env", return_value=Bridge()),
            patch.object(self.agent, "VideoTrackDiagnostic", Diagnostic),
            patch.object(self.agent, "ConsentGatedSTTRuntime", Runtime),
            patch.object(self.agent, "TranscriptForwarder", Forwarder),
        ):
            await self.agent.entrypoint(ctx)
            with self.assertRaises(RuntimeError):
                await hooks[0]("shutdown")
        self.assertEqual(events, ["runtime_close", "forwarder_close", "bridge_close"])

    async def run_real_lifecycle(self, env):
        """Real STT runtime, real diagnostic and real session factory; fake SDK."""
        from sidekick_bridge import CaptureState

        log = []
        FakeSession.created = []

        class Bridge:
            epoch = 1
            auth_failed = False
            accepting_input = False
            capture_state = CaptureState(
                session_id="s", status="starting", generation=1
            )

            async def start(self, room):
                pass

            async def close(self):
                pass

            def consent(self, active, generation=1):
                self.accepting_input = active
                self.capture_state = CaptureState(
                    session_id="s",
                    status="active" if active else "paused",
                    accepting_input=active,
                    generation=generation,
                    consent_given=True,
                )

        class Forwarder:
            def __init__(self, *args, **kwargs):
                pass

            def start(self):
                pass

            def clear_pending(self):
                pass

            def submit_final(self, *args, **kwargs):
                return True

            async def close(self):
                pass

        class Video:
            sid, name, kind, source = "TR_v", "facetime-remote-video", 2, 1
            width = height = 0
            mime_type, simulcasted, muted, subscribed = (
                "video/h264",
                False,
                False,
                False,
            )

            def set_subscribed(self, value):
                self.subscribed = value
                log.append(("video_subscribed", value))

        video = Video()
        room = SimpleNamespace(
            name="same-room",
            remote_participants={
                "bridge-001": SimpleNamespace(
                    identity="bridge-001", kind=6, track_publications={"TR_v": video}
                )
            },
            on=lambda event, callback: None,
            off=lambda event, callback: None,
        )

        async def connect(**options):
            log.append(("connect", options))

        async def settle():
            await asyncio.sleep(0.6)  # two 0.25 s watcher ticks

        def stt():
            return [
                (s.enabled, s.output_enabled, s.spoken) for s in FakeSession.created
            ]

        bridge = Bridge()
        hooks = []
        ctx = SimpleNamespace(
            room=room, add_shutdown_callback=hooks.append, connect=connect
        )
        snapshots = []
        with (
            patch.dict("os.environ", env, clear=True),
            patch.object(self.agent.BridgeClient, "from_env", return_value=bridge),
            patch.object(self.agent, "TranscriptForwarder", Forwarder),
        ):
            await self.agent.entrypoint(ctx)
            snapshots.append(("before_consent", stt()))
            bridge.consent(True)
            await settle()
            snapshots.append(("consented", stt()))
            bridge.consent(False)
            await settle()
            snapshots.append(("paused", stt()))
            bridge.consent(True, generation=2)
            await settle()
            snapshots.append(("resumed", stt()))
            await hooks[0]("shutdown")
            snapshots.append(("closed", [s.closed for s in FakeSession.created]))
        return snapshots, log

    async def test_diagnostic_does_not_change_greeting_or_consent_gated_stt(self):
        plain, plain_log = await self.run_real_lifecycle({})
        enabled, enabled_log = await self.run_real_lifecycle(
            {"SIDEKICK_VIDEO_DIAGNOSTIC": "1"}
        )
        # Identical STT sessions, greeting and gating with the flag on or off.
        self.assertEqual(plain, enabled)
        before, consented, paused, resumed, closed = (s for _, s in plain)
        self.assertEqual(before, [(False, False, ["Sidekick connected."])])
        # Main's runtime retires the greeting session and opens a fresh one on consent.
        self.assertEqual(
            consented,
            [(False, False, ["Sidekick connected."]), (True, False, [])],
        )
        self.assertFalse(any(enabled_input for enabled_input, _, _ in paused))
        self.assertEqual(resumed[-1], (True, False, []))  # new session, no greeting
        self.assertEqual(sum(len(s[2]) for s in resumed), 1)  # greeted exactly once
        self.assertTrue(all(closed))
        # Flag off: no early connect and no video subscription management at all.
        self.assertEqual(plain_log, [])
        # Flag on: audio-only connect first; video follows consent exactly.
        self.assertEqual(
            enabled_log,
            [
                ("connect", {"auto_subscribe": "audio_only"}),
                ("video_subscribed", True),
                ("video_subscribed", False),
                ("video_subscribed", True),
                ("video_subscribed", False),
            ],
        )


if __name__ == "__main__":
    unittest.main()
