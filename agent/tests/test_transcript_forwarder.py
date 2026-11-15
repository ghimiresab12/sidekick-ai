"""Offline tests: real BridgeClient, no sockets, LiveKit, dotenv or providers."""

from __future__ import annotations

import asyncio
import importlib.util
import json
import sys
import unittest
from pathlib import Path

_SRC = Path(__file__).parents[1] / "src"
for _name in ("sidekick_bridge", "transcript_forwarder"):
    if _name not in sys.modules:
        _spec = importlib.util.spec_from_file_location(_name, _SRC / f"{_name}.py")
        assert _spec and _spec.loader
        _module = importlib.util.module_from_spec(_spec)
        sys.modules[_name] = _module
        _spec.loader.exec_module(_module)

from sidekick_bridge import BridgeClient, Outcome  # noqa: E402
from transcript_forwarder import TranscriptForwarder  # noqa: E402


class MemoryTransport:
    def __init__(self):
        self.session = "session-a"
        self.generation = 1
        self.active = False
        self.closed = False
        self.requests = []
        self.entered = asyncio.Event()
        self.release = asyncio.Event()
        self.release.set()
        self.failure = False

    def state(self):
        return {
            "ok": True,
            "sessionId": self.session,
            "status": "active" if self.active else "paused",
            "captureGeneration": self.generation,
            "consentGiven": self.active,
            "acceptingInput": self.active,
        }

    async def request(self, method, url, headers, body, timeout):
        if url.endswith("/transcripts"):
            self.requests.append((url, json.loads(body)))
            self.entered.set()
            await self.release.wait()
            if self.failure:
                raise OSError("private transport detail")
            return 202, {"ok": True, "observationId": "observation-1"}
        return 200, self.state()

    async def close(self):
        self.closed = True


class ForwarderTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.transport = MemoryTransport()
        self.bridge = BridgeClient(
            "http://127.0.0.1:8787",
            "a" * 40,
            transport=self.transport,
            poll_interval=60,
        )
        await self.bridge.start("room")
        self.forwarder = TranscriptForwarder(self.bridge, max_pending=2)
        self.forwarder.start()

    async def asyncTearDown(self):
        await self.forwarder.close()
        await self.bridge.close()

    def activate(self, generation=1, session="session-a"):
        self.transport.active = True
        self.transport.generation = generation
        self.transport.session = session
        # Apply a successful poll immediately, without timing-dependent sleeps.
        self.bridge._apply(self.transport.state())

    async def test_no_consent_no_capture_or_post(self):
        self.assertFalse(self.forwarder.submit_final("hello"))
        await self.forwarder.wait_idle()
        self.assertEqual(self.transport.requests, [])

    async def test_exact_context_is_captured_in_callback_not_worker(self):
        self.activate()
        original = self.bridge.capture
        contexts = []

        def capture():
            context = original("2026-11-15T12:34:56.123Z")
            contexts.append(context)
            return context

        self.bridge.capture = capture
        original_send = self.bridge.send_transcript
        sent_contexts = []

        async def send(text, context):
            sent_contexts.append(context)
            return await original_send(text, context)

        self.bridge.send_transcript = send
        self.assertTrue(self.forwarder.submit_final("Alex defends left"))
        self.assertEqual(len(contexts), 1)  # worker has not run yet
        self.activate(generation=3)
        await self.forwarder.wait_idle()
        self.assertIs(sent_contexts[0], contexts[0])
        body = self.transport.requests[0][1]
        self.assertEqual(
            body,
            {
                "text": "Alex defends left",
                "captureGeneration": 1,
                "observedAt": "2026-11-15T12:34:56.123Z",
            },
        )
        self.assertTrue(self.forwarder.last_result.accepted)

    async def test_reject_interim_empty_and_oversized(self):
        self.activate()
        for text in ("", "  ", "x" * 1001, None):
            self.assertFalse(self.forwarder.submit_final(text))
        self.assertFalse(self.forwarder.submit_final("interim", is_final=False))
        self.assertEqual(self.transport.requests, [])

    async def test_queue_bound_drops_newest_with_one_in_flight(self):
        self.activate()
        self.transport.release.clear()
        self.assertTrue(self.forwarder.submit_final("first"))
        await self.transport.entered.wait()
        self.assertTrue(self.forwarder.submit_final("second"))
        self.assertTrue(self.forwarder.submit_final("third"))
        self.assertFalse(self.forwarder.submit_final("fourth"))
        self.transport.release.set()
        await self.forwarder.wait_idle()
        self.assertEqual(
            [body["text"] for _, body in self.transport.requests],
            ["first", "second", "third"],
        )

    async def test_ambiguous_transport_failure_is_not_retried(self):
        self.activate()
        self.transport.failure = True
        self.forwarder.submit_final("private sentence")
        await self.forwarder.wait_idle()
        self.assertEqual(len(self.transport.requests), 1)
        self.assertEqual(self.forwarder.last_result.outcome, Outcome.UNAVAILABLE)
        self.assertTrue(self.forwarder.last_result.transmitted)
        self.transport.failure = False
        self.forwarder.submit_final("next sentence")
        await self.forwarder.wait_idle()
        self.assertEqual(len(self.transport.requests), 2)

    async def test_pause_before_worker_prevents_transmission(self):
        self.activate()
        self.forwarder.submit_final("captured before pause")
        self.transport.active = False
        self.bridge._apply(self.transport.state())
        self.assertFalse(self.forwarder.submit_final("during pause"))
        await self.forwarder.wait_idle()
        self.assertEqual(self.transport.requests, [])
        self.assertEqual(self.forwarder.last_result.outcome, Outcome.NOT_ACCEPTING)
        self.activate(3)
        self.forwarder.submit_final("after resume")
        await self.forwarder.wait_idle()
        self.assertEqual(self.transport.requests[0][1]["captureGeneration"], 3)

    async def test_replacement_with_same_generation_cannot_retarget_queue(self):
        self.activate()
        self.forwarder.submit_final("belongs to A")
        self.activate(session="session-b")
        await self.forwarder.wait_idle()
        self.assertEqual(self.transport.requests, [])
        self.assertEqual(self.forwarder.last_result.outcome, Outcome.STALE)
        self.forwarder.submit_final("belongs to B")
        await self.forwarder.wait_idle()
        self.assertIn("/session-b/", self.transport.requests[0][0])

    async def test_auth_failure_prevents_queued_and_new_transcripts(self):
        self.activate()
        self.forwarder.submit_final("queued")
        self.bridge._auth_failure(401)
        self.assertFalse(self.forwarder.submit_final("after auth failure"))
        await self.forwarder.wait_idle()
        self.assertEqual(self.transport.requests, [])
        self.assertEqual(self.forwarder.last_result.outcome, Outcome.AUTH_FAILED)

    async def test_end_prevents_queued_transcript(self):
        self.activate()
        self.forwarder.submit_final("queued before end")
        ended = self.transport.state()
        ended.update(status="ended", acceptingInput=False, captureGeneration=2)
        self.bridge._apply(ended)
        await self.forwarder.wait_idle()
        self.assertEqual(self.transport.requests, [])
        self.assertFalse(self.forwarder.submit_final("after end"))

    async def test_clear_pending_releases_queue_without_replaying(self):
        self.activate()
        self.forwarder.submit_final("discard this")
        self.forwarder.clear_pending()
        await self.forwarder.wait_idle()
        self.assertEqual(self.transport.requests, [])

    async def test_close_cancels_inflight_and_drops_pending(self):
        self.activate()
        self.transport.release.clear()
        self.forwarder.submit_final("in flight")
        await self.transport.entered.wait()
        self.forwarder.submit_final("pending")
        await asyncio.gather(self.forwarder.close(), self.forwarder.close())
        await self.forwarder.wait_idle()
        self.assertTrue(self.forwarder._worker.done())
        self.assertEqual(len(self.transport.requests), 1)
        self.assertFalse(self.transport.closed)  # caller owns BridgeClient
        self.assertFalse(self.forwarder.submit_final("after close"))
        with self.assertRaises(RuntimeError):
            self.forwarder.start()

    async def test_unexpected_error_does_not_kill_worker_or_retain_exception(self):
        self.activate()
        original = self.bridge.send_transcript

        async def fail(text, context):
            raise RuntimeError("secret transcript and credential")

        self.bridge.send_transcript = fail
        self.forwarder.submit_final("first")
        await self.forwarder.wait_idle()
        self.assertEqual(self.forwarder.failed_count, 1)
        self.assertIsNone(self.forwarder.last_result)
        self.bridge.send_transcript = original
        self.forwarder.submit_final("second")
        await self.forwarder.wait_idle()
        self.assertTrue(self.forwarder.last_result.accepted)

    async def test_start_is_idempotent_and_submit_before_start_drops(self):
        fresh = TranscriptForwarder(self.bridge)
        self.assertFalse(fresh.submit_final("not started"))
        fresh.start()
        worker = fresh._worker
        fresh.start()
        self.assertIs(fresh._worker, worker)
        await fresh.close()

    async def test_cancelled_close_waiter_does_not_cancel_cleanup(self):
        task = asyncio.create_task(self.forwarder.close())
        await asyncio.sleep(0)
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        await self.forwarder.close()
        self.assertTrue(self.forwarder._worker.done())

    async def test_invalid_queue_limits(self):
        for value in (True, False, 0, -1, 1.5, float("nan"), float("inf"), "2"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                TranscriptForwarder(self.bridge, max_pending=value)


if __name__ == "__main__":
    unittest.main()
