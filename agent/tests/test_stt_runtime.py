"""Offline tests for consent-gated LiveKit STT session lifecycle."""

from __future__ import annotations

import asyncio
import importlib.util
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

_SRC = Path(__file__).parents[1] / "src"
for _name in ("sidekick_bridge", "transcript_forwarder", "stt_runtime"):
    if _name not in sys.modules:
        _spec = importlib.util.spec_from_file_location(_name, _SRC / f"{_name}.py")
        assert _spec and _spec.loader
        _module = importlib.util.module_from_spec(_spec)
        sys.modules[_name] = _module
        _spec.loader.exec_module(_module)

from sidekick_bridge import CaptureState  # noqa: E402
from stt_runtime import (  # noqa: E402
    GREETING_TEXT,
    ConsentGatedSTTRuntime,
    speak_connection_greeting,
)


class FakeBridge:
    def __init__(self) -> None:
        self.epoch = 1
        self.auth_failed = False
        self.accepting_input = False
        self.capture_state = CaptureState(
            session_id="session-a", status="starting", generation=1
        )


class FakeForwarder:
    def __init__(self) -> None:
        self.submitted: list[str] = []
        self.clears = 0

    def submit_final(self, transcript: str, *, is_final: bool = True) -> bool:
        self.submitted.append(transcript)
        return True

    def clear_pending(self) -> None:
        self.clears += 1


class FakeInput:
    def __init__(self) -> None:
        self.audio_enabled = True
        self.transitions: list[bool] = []

    def set_audio_enabled(self, enabled: bool) -> None:
        self.audio_enabled = enabled
        self.transitions.append(enabled)


class FakeSession:
    def __init__(self, greeting: bool) -> None:
        self.greeting = greeting
        self.input = FakeInput()
        self.callbacks: dict[str, object] = {}
        self.closed = False
        self.shutdown_drain: bool | None = None
        self.spoken: list[str] = []

    async def say(self, text: str, *, allow_interruptions: bool = True) -> None:
        self.spoken.append(text)

    def on(self, event: str, callback: object) -> None:
        self.callbacks[event] = callback

    def off(self, event: str, callback: object) -> None:
        if self.callbacks.get(event) is callback:
            del self.callbacks[event]

    def emit(self, transcript: str, is_final: bool = True) -> None:
        callback = self.callbacks.get("user_input_transcribed")
        if callback is not None:
            callback(SimpleNamespace(transcript=transcript, is_final=is_final))

    def shutdown(self, *, drain: bool = True) -> None:
        self.shutdown_drain = drain

    async def aclose(self) -> None:
        self.closed = True


class RuntimeTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.bridge = FakeBridge()
        self.forwarder = FakeForwarder()
        self.sessions: list[FakeSession] = []
        self.greeting_arguments: list[bool] = []

    async def make_runtime(self) -> ConsentGatedSTTRuntime:
        async def factory(greet: bool) -> FakeSession:
            self.greeting_arguments.append(greet)
            session = FakeSession(greet)
            self.sessions.append(session)
            return session

        runtime = ConsentGatedSTTRuntime(
            self.bridge, self.forwarder, factory, poll_interval=60
        )
        await runtime.start()
        return runtime

    def authorize(self, generation: int = 1, session_id: str = "session-a") -> None:
        self.bridge.accepting_input = True
        self.bridge.capture_state = CaptureState(
            session_id=session_id,
            status="active",
            accepting_input=True,
            generation=generation,
            consent_given=True,
        )

    async def test_starts_audio_disabled_and_greets_once(self) -> None:
        runtime = await self.make_runtime()
        first = self.sessions[0]
        self.assertEqual(self.greeting_arguments, [True])
        self.assertTrue(first.input.transitions)
        self.assertFalse(any(first.input.transitions))
        self.assertFalse(runtime.active)
        first.emit("must not pass before consent")
        self.assertEqual(self.forwarder.submitted, [])
        await runtime.close()

    async def test_connection_greeting_is_exact_and_deterministic(self) -> None:
        session = FakeSession(greeting=True)
        await speak_connection_greeting(session)
        self.assertEqual(GREETING_TEXT, "Sidekick connected.")
        self.assertEqual(session.spoken, ["Sidekick connected."])

    async def test_only_final_nonempty_text_passes_after_consent(self) -> None:
        runtime = await self.make_runtime()
        self.authorize()
        await runtime.reconcile(self.bridge.capture_state)
        active = self.sessions[-1]
        self.assertTrue(active.input.audio_enabled)
        active.emit("interim", is_final=False)
        active.emit("   ")
        active.emit("final words")
        self.assertEqual(self.forwarder.submitted, ["final words"])
        await runtime.close()

    async def test_pause_resume_replaces_stream_and_rejects_delayed_final(self) -> None:
        runtime = await self.make_runtime()
        self.authorize()
        await runtime.reconcile(self.bridge.capture_state)
        old_session = self.sessions[-1]
        self.bridge.accepting_input = False
        self.bridge.capture_state = CaptureState(
            session_id="session-a", status="paused", generation=2
        )
        await runtime.reconcile(self.bridge.capture_state)
        self.assertTrue(old_session.closed)
        old_session.emit("late words")
        self.authorize(generation=3)
        await runtime.reconcile(self.bridge.capture_state)
        new_session = self.sessions[-1]
        old_session.emit("late after resume")
        new_session.emit("current words")
        self.assertEqual(self.forwarder.submitted, ["current words"])
        self.assertFalse(old_session.input.audio_enabled)
        await runtime.close()

    async def test_generation_and_session_replacement_rebuild_stream(self) -> None:
        runtime = await self.make_runtime()
        self.authorize()
        await runtime.reconcile(self.bridge.capture_state)
        first_active = self.sessions[-1]
        self.bridge.epoch = 2
        self.authorize(generation=4, session_id="replacement")
        await runtime.reconcile(self.bridge.capture_state)
        second_active = self.sessions[-1]
        self.assertIsNot(first_active, second_active)
        self.assertFalse(first_active.input.audio_enabled)
        self.assertEqual(self.greeting_arguments.count(True), 1)
        self.assertFalse(self.greeting_arguments[-1])
        first_active.emit("old session final")
        second_active.emit("new session final")
        self.assertEqual(self.forwarder.submitted, ["new session final"])
        await runtime.close()

    async def test_auth_failure_closes_audio_and_blocks_finals(self) -> None:
        runtime = await self.make_runtime()
        self.authorize()
        await runtime.reconcile(self.bridge.capture_state)
        active = self.sessions[-1]
        self.bridge.auth_failed = True
        await runtime.reconcile(self.bridge.capture_state)
        active.emit("must not pass")
        self.assertFalse(runtime.active)
        self.assertTrue(active.closed)
        self.assertEqual(self.forwarder.submitted, [])
        await runtime.close()

    async def test_revoked_consent_fails_closed_even_if_accepting_flag_is_stale(
        self,
    ) -> None:
        runtime = await self.make_runtime()
        self.authorize()
        await runtime.reconcile(self.bridge.capture_state)
        active = self.sessions[-1]
        self.bridge.capture_state = CaptureState(
            session_id="session-a",
            status="active",
            accepting_input=True,
            generation=2,
            consent_given=False,
        )
        await runtime.reconcile(self.bridge.capture_state)
        active.emit("after revocation")
        self.assertTrue(active.closed)
        self.assertFalse(runtime.active)
        self.assertEqual(self.forwarder.submitted, [])
        await runtime.close()

    async def test_shutdown_removes_callback_disables_input_and_cancels_watcher(
        self,
    ) -> None:
        runtime = await self.make_runtime()
        self.authorize()
        await runtime.reconcile(self.bridge.capture_state)
        active = self.sessions[-1]
        await runtime.close()
        active.emit("after shutdown")
        self.assertTrue(active.closed)
        self.assertFalse(active.input.audio_enabled)
        self.assertEqual(active.callbacks, {})
        self.assertEqual(self.forwarder.submitted, [])

    async def test_generation_change_blocks_callback_before_watcher_runs(self) -> None:
        runtime = await self.make_runtime()
        self.authorize()
        await runtime.reconcile(self.bridge.capture_state)
        callback = runtime.session.callbacks["user_input_transcribed"]
        self.authorize(generation=3)
        callback(SimpleNamespace(transcript="old generation", is_final=True))
        self.assertEqual(self.forwarder.submitted, [])
        await runtime.reconcile(self.bridge.capture_state)
        callback(SimpleNamespace(transcript="retired callback", is_final=True))
        self.assertEqual(self.forwarder.submitted, [])
        runtime.session.emit("new generation")
        self.assertEqual(self.forwarder.submitted, ["new generation"])
        await runtime.close()

    async def test_same_generation_replacement_blocks_old_callback(self) -> None:
        runtime = await self.make_runtime()
        self.authorize()
        await runtime.reconcile(self.bridge.capture_state)
        callback = runtime.session.callbacks["user_input_transcribed"]
        self.bridge.epoch += 1
        self.authorize(session_id="session-b")
        callback(SimpleNamespace(transcript="session A", is_final=True))
        self.assertEqual(self.forwarder.submitted, [])
        await runtime.close()

    async def test_stale_state_blocks_final_before_watcher(self) -> None:
        runtime = await self.make_runtime()
        self.authorize()
        await runtime.reconcile(self.bridge.capture_state)
        self.bridge.accepting_input = False
        runtime.session.emit("stale final")
        self.assertEqual(self.forwarder.submitted, [])
        await runtime.reconcile(self.bridge.capture_state)
        self.assertIsNone(runtime.session)
        await runtime.close()

    async def test_pause_during_factory_never_enables_replacement(self) -> None:
        runtime = await self.make_runtime()
        self.authorize()
        await runtime.reconcile(self.bridge.capture_state)
        entered, release = asyncio.Event(), asyncio.Event()

        async def factory(greet):
            entered.set()
            await release.wait()
            session = FakeSession(greet)
            self.sessions.append(session)
            return session

        runtime._session_factory = factory
        self.authorize(generation=3)
        pending = asyncio.create_task(runtime.reconcile(self.bridge.capture_state))
        await entered.wait()
        self.bridge.accepting_input = False
        release.set()
        await pending
        replacement = self.sessions[-1]
        self.assertFalse(any(replacement.input.transitions))
        self.assertTrue(replacement.closed)
        self.assertFalse(runtime.active)
        await runtime.close()

    async def test_concurrent_start_and_close_during_start(self) -> None:
        entered, release = asyncio.Event(), asyncio.Event()
        calls = []

        async def factory(greet):
            calls.append(greet)
            entered.set()
            await release.wait()
            return FakeSession(greet)

        runtime = ConsentGatedSTTRuntime(self.bridge, self.forwarder, factory)
        first = asyncio.create_task(runtime.start())
        second = asyncio.create_task(runtime.start())
        await entered.wait()
        await runtime.close()
        await asyncio.gather(first, second, return_exceptions=True)
        self.assertEqual(calls, [True])
        self.assertTrue(runtime._start_task.done())
        self.assertIsNone(runtime._watch_task)
        self.assertIsNone(runtime.session)

    async def test_close_during_teardown_waits_for_resource_cleanup(self) -> None:
        runtime = await self.make_runtime()
        self.authorize()
        await runtime.reconcile(self.bridge.capture_state)
        session = runtime.session
        entered, release = asyncio.Event(), asyncio.Event()

        async def slow_close():
            entered.set()
            await release.wait()
            session.closed = True

        session.aclose = slow_close
        self.bridge.accepting_input = False
        retiring = asyncio.create_task(runtime.reconcile(self.bridge.capture_state))
        await entered.wait()
        retiring.cancel()
        await asyncio.gather(retiring, return_exceptions=True)
        closing = asyncio.create_task(runtime.close())
        await asyncio.sleep(0)
        self.assertFalse(closing.done())
        release.set()
        await closing
        self.assertTrue(session.closed)
        self.assertEqual(runtime._retiring, set())

    async def test_cancelled_close_waiter_and_repeated_close(self) -> None:
        runtime = await self.make_runtime()
        first = asyncio.create_task(runtime.close())
        await asyncio.sleep(0)
        first.cancel()
        await asyncio.gather(first, return_exceptions=True)
        await runtime.close()
        self.assertTrue(runtime._watch_task.done())
        self.assertIsNone(runtime.session)
        with self.assertRaises(RuntimeError):
            await runtime.start()

    async def test_end_blocks_final_immediately_and_retires_stream(self) -> None:
        runtime = await self.make_runtime()
        self.authorize()
        await runtime.reconcile(self.bridge.capture_state)
        session = runtime.session
        self.bridge.capture_state = CaptureState(
            session_id="session-a",
            status="ended",
            generation=2,
            consent_given=True,
            accepting_input=False,
        )
        session.emit("after end")
        self.assertEqual(self.forwarder.submitted, [])
        await runtime.reconcile(self.bridge.capture_state)
        self.assertTrue(session.closed)
        await runtime.close()

    async def test_watcher_error_fails_closed_without_sensitive_exception_text(
        self,
    ) -> None:
        runtime = await self.make_runtime()
        runtime._watch_task.cancel()
        await asyncio.gather(runtime._watch_task, return_exceptions=True)
        await runtime._deactivate()
        self.authorize()

        async def fail(greet):
            raise RuntimeError("private sentence and credential")

        runtime._session_factory = fail
        with self.assertLogs("sidekick.stt_runtime", level="WARNING") as captured:
            await runtime._watch_capture()
        self.assertNotIn("private sentence", str(captured.output))
        self.assertNotIn("credential", str(captured.output))
        self.assertIn("RuntimeError", str(captured.output))
        self.assertFalse(runtime.active)
        await runtime.close()

    async def test_invalid_poll_configuration(self) -> None:
        for value in (True, False, 0, -1, float("nan"), float("inf"), "1"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                ConsentGatedSTTRuntime(
                    self.bridge, self.forwarder, lambda _: None, poll_interval=value
                )


if __name__ == "__main__":
    unittest.main()
