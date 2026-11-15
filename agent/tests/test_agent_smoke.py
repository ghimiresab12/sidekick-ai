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


if __name__ == "__main__":
    unittest.main()
