"""Tests for ``sidekick_bridge.BridgeClient`` against a fake local HTTP bridge.

No LiveKit, Chert, Gemini or Node process is involved. The fake bridge mirrors the
documented routes, authorization, lifecycle gates and error codes of
``src/bridge/http-bridge.ts`` and records every request it receives.

Runs under ``pytest`` (the project's runner) and under plain ``python -m unittest``.

The contract tests run once per transport:
* ``StreamTransportTests`` uses a TEST-ONLY transport built on asyncio streams. It exists
  so the client's logic can be tested where aiohttp is not installed. It is not part of
  the product: production always uses aiohttp.
* ``AiohttpTransportTests`` uses the real production transport and is skipped when
  aiohttp is not installed.
"""

from __future__ import annotations

import asyncio
import copy
import dataclasses
import gc
import importlib.util
import json
import logging
import pickle
import sys
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

try:
    import aiohttp

    HAVE_AIOHTTP = True
except ImportError:
    HAVE_AIOHTTP = False

UTC = timezone.utc  # noqa: UP017 - the tests also run on Python < 3.11

_PATH = Path(__file__).parents[1] / "src" / "sidekick_bridge.py"
_SPEC = importlib.util.spec_from_file_location("sidekick_bridge", _PATH)
assert _SPEC is not None and _SPEC.loader is not None
sb = importlib.util.module_from_spec(_SPEC)
sys.modules["sidekick_bridge"] = sb  # dataclasses resolve annotations via sys.modules
_SPEC.loader.exec_module(sb)

Outcome = sb.Outcome

AGENT = "agent-token-0123456789-abcdefghijklmnop"
CONTROL = "control-token-0123456789-abcdefghijklmn"
ROOM = "harness-room"
TEXT = "ZEBRA-TRANSCRIPT-MARKER Alex is responsible for left defense."
JPEG = b"\xff\xd8\xff\xe0" + b"ZEBRA-IMAGE-MARKER" + b"\x00" * 64
LIFECYCLE_PATHS = (
    "/consent",
    "/pause",
    "/resume",
    "/end",
    "/pairings",
    "/participants",
    "/activity",
)


class StreamTransport:
    """TEST-ONLY HTTP/1.1 transport on asyncio streams. Cancellation closes the socket."""

    def __init__(self) -> None:
        self.closed = False
        self.active = 0

    async def request(
        self, method: str, url: str, headers: Any, body: bytes | None, timeout: float
    ) -> Any:
        if self.closed:
            raise RuntimeError("transport is closed")
        return await asyncio.wait_for(
            self._request(method, url, headers, body), timeout
        )

    async def _request(
        self, method: str, url: str, headers: Any, body: bytes | None
    ) -> Any:
        parts = urlsplit(url)
        reader, writer = await asyncio.open_connection(parts.hostname, parts.port)
        self.active += 1
        try:
            lines = [
                f"{method} {parts.path} HTTP/1.1",
                f"Host: {parts.netloc}",
                "Connection: close",
            ]
            lines += [f"{key}: {value}" for key, value in headers.items()]
            if body is not None:
                lines.append(f"Content-Length: {len(body)}")
            writer.write(
                ("\r\n".join(lines) + "\r\n\r\n").encode("latin-1") + (body or b"")
            )
            await writer.drain()
            raw = await reader.read(-1)
            head, _, payload = raw.partition(b"\r\n\r\n")
            if not head:
                raise ConnectionError("no response")
            return int(head.split()[1]), sb._parse_json(payload)
        finally:
            self.active -= 1
            writer.close()

    async def close(self) -> None:
        self.closed = True


class FakeBridge:
    """In-process stand-in for the Node bridge. Operator actions are plain methods."""

    def __init__(self) -> None:
        self.agent_token = AGENT
        self.requests: list[dict[str, Any]] = []
        self.sessions: dict[str, dict[str, Any]] = {}
        self.rooms: dict[str, str] = {}
        self.next_id = 0
        self.vision = "ok"  # ok | none
        #: route kind -> queue of forced answers: (status, error) or "drop"
        self.forced: dict[str, list[Any]] = {}
        #: holds a frame BEFORE it is stored (like a frame still being analysed)
        self.frame_gate: asyncio.Event | None = None
        #: holds the RESPONSE of a frame that was already stored
        self.frame_gate_after: asyncio.Event | None = None
        #: holds POST /v1/sessions
        self.register_gate: asyncio.Event | None = None
        self.frames_started = 0
        self.registrations_started = 0
        self.server: asyncio.AbstractServer | None = None
        self.url = ""

    async def start(self) -> None:
        self.server = await asyncio.start_server(self._handle, "127.0.0.1", 0)
        port = self.server.sockets[0].getsockname()[1]
        self.url = f"http://127.0.0.1:{port}"

    def release(self) -> None:
        for gate in (self.frame_gate, self.frame_gate_after, self.register_gate):
            if gate is not None:
                gate.set()

    async def stop(self) -> None:
        self.release()
        if self.server is not None:
            self.server.close()
            await self.server.wait_closed()
            self.server = None

    # Operator / lifecycle (what the control token or the UI would do) -------------

    def session(self, sid: str | None = None) -> dict[str, Any]:
        return self.sessions[sid] if sid else next(iter(self.sessions.values()))

    def consent(self, sid: str | None = None) -> None:
        s = self.session(sid)
        s.update(status="active", consent=True, generation=s["generation"] + 1)
        s["active"].add(s["generation"])

    def pause(self) -> None:
        s = self.session()
        s.update(status="paused", generation=s["generation"] + 1)

    def resume(self) -> None:
        s = self.session()
        s.update(status="active", generation=s["generation"] + 1)
        s["active"].add(s["generation"])

    def end(self) -> None:
        s = self.session()
        s.update(status="ended", generation=s["generation"] + 1)

    def discard(self) -> dict[str, Any]:
        """Operator DELETE: the session and its room mapping are gone. Returns the old record."""
        sid, record = next(iter(self.sessions.items()))
        del self.sessions[sid]
        self.rooms = {room: s for room, s in self.rooms.items() if s != sid}
        return record

    def restart(self) -> None:
        """A bridge restart: all in-memory sessions are gone."""
        self.sessions.clear()
        self.rooms.clear()

    def calls(self, method: str, suffix: str) -> list[dict[str, Any]]:
        return [
            r
            for r in self.requests
            if r["method"] == method and r["path"].endswith(suffix)
        ]

    # HTTP ------------------------------------------------------------------------

    def _view(self, sid: str) -> dict[str, Any]:
        s = self.sessions[sid]
        return {
            "ok": True,
            "sessionId": sid,
            "status": s["status"],
            "consentGiven": s["consent"],
            "captureGeneration": s["generation"],
            "acceptingInput": s["status"] == "active",
        }

    async def _handle(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        try:
            head = (await reader.readuntil(b"\r\n\r\n")).decode("latin-1")
            lines = head.split("\r\n")
            method, target, _ = lines[0].split(" ", 2)
            headers = {}
            for line in lines[1:]:
                if ":" in line:
                    key, value = line.split(":", 1)
                    headers[key.strip().lower()] = value.strip()
            length = int(headers.get("content-length", "0") or "0")
            body = await reader.readexactly(length) if length else b""
            self.requests.append(
                {"method": method, "path": target, "headers": headers, "body": body}
            )
            answer = await self._route(method, target, headers, body, reader)
            if answer == "drop":
                return
            status, payload = answer
            raw = json.dumps(payload).encode()
            writer.write(
                f"HTTP/1.1 {status} X\r\nContent-Type: application/json\r\n"
                f"Content-Length: {len(raw)}\r\nConnection: close\r\n\r\n".encode()
                + raw
            )
            await writer.drain()
        except (asyncio.IncompleteReadError, ConnectionError):
            pass
        finally:
            writer.close()

    async def _route(
        self,
        method: str,
        path: str,
        headers: dict[str, str],
        body: bytes,
        reader: asyncio.StreamReader,
    ) -> Any:
        def fail(status: int, error: str) -> tuple[int, dict[str, Any]]:
            return status, {"ok": False, "error": error}

        if "origin" in headers:
            return fail(403, "forbidden_origin")
        if headers.get("authorization") != f"Bearer {self.agent_token}":
            return fail(401, "unauthorized")
        parts = path.strip("/").split("/")
        if method == "POST" and path == "/v1/sessions":
            self.registrations_started += 1
            if self.register_gate is not None:
                await self.register_gate.wait()
            queue = self.forced.get("sessions")
            if queue:
                forced = queue.pop(0)
                return forced if forced == "drop" else fail(*forced)
            data = json.loads(body)
            if set(data) != {"externalRef"} or not isinstance(data["externalRef"], str):
                return fail(400, "invalid_input")
            room = data["externalRef"]
            existing = self.rooms.get(room)
            if existing and self.sessions[existing]["status"] != "ended":
                return 200, self._view(existing)
            self.next_id += 1
            sid = f"session-{self.next_id}"
            self.sessions[sid] = {
                "status": "starting",
                "consent": False,
                "generation": 0,
                "active": set(),
                "obs": [],
            }
            self.rooms[room] = sid
            return 201, self._view(sid)
        if len(parts) != 4 or parts[:2] != ["v1", "sessions"]:
            return fail(404, "not_found")
        sid, kind = parts[2], parts[3]
        if kind in ("consent", "pause", "resume", "end"):
            return fail(
                403, "forbidden"
            )  # the agent token may never change the lifecycle
        if sid not in self.sessions:
            return fail(404, "session_not_found")
        s = self.sessions[sid]
        if method == "GET" and kind == "capture":
            if body or "transfer-encoding" in headers:
                return fail(400, "unexpected_body")
            queue = self.forced.get("capture")
            if queue:
                return 200, queue.pop(0)
            return 200, self._view(sid)
        if method != "POST" or kind not in ("transcripts", "frames"):
            return fail(404, "not_found")
        if kind == "frames":
            self.frames_started += 1
            if self.frame_gate is not None:
                await self.frame_gate.wait()
                await asyncio.sleep(0.02)
                if reader.at_eof():
                    return "drop"  # like Node: a client that disconnected is never ingested
        queue = self.forced.get(kind)
        if queue:
            forced = queue.pop(0)
            return forced if forced == "drop" else fail(*forced)

        if kind == "transcripts":
            if headers.get("content-type") != "application/json":
                return fail(415, "unsupported_media_type")
            data = json.loads(body)
            if not set(data) <= {
                "captureGeneration",
                "observedAt",
                "text",
                "speakerRef",
            }:
                return fail(400, "invalid_input")
            generation, observed, text = (
                data.get("captureGeneration"),
                data.get("observedAt"),
                data.get("text"),
            )
            if not isinstance(generation, int) or generation < 1:
                return fail(400, "invalid_generation")
        else:
            if headers.get("content-type") != "image/jpeg":
                return fail(415, "unsupported_media_type")
            raw_generation, observed, text = (
                headers.get("x-capture-generation", ""),
                headers.get("x-observed-at"),
                None,
            )
            if not raw_generation.isdigit() or int(raw_generation) < 1:
                return fail(400, "invalid_generation")
            generation = int(raw_generation)
        if s["status"] == "starting":
            return fail(409, "consent_required")
        if s["status"] != "active":
            return fail(409, "session_not_active")
        if kind == "frames" and generation < s["generation"]:
            return fail(409, "stale_evidence")
        if generation > s["generation"] or generation not in s["active"]:
            return fail(409, "invalid_generation")
        try:
            parsed = datetime.fromisoformat(str(observed).replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                raise ValueError
        except ValueError:
            return fail(400, "invalid_timestamp")
        if parsed > datetime.now(UTC) + timedelta(seconds=5):
            return fail(422, "timestamp_out_of_range")
        if kind == "transcripts" and (
            not isinstance(text, str) or not text.strip() or len(text) > 1000
        ):
            return fail(400, "invalid_input")
        if kind == "frames":
            if body[:3] != b"\xff\xd8\xff":
                return fail(400, "invalid_input")
            if self.vision == "none":
                return fail(503, "vision_unavailable")
        oid = f"{sid}-obs-{len(s['obs']) + 1}"
        s["obs"].append(
            {"id": oid, "kind": kind, "generation": generation, "observedAt": observed}
        )
        if kind == "frames" and self.frame_gate_after is not None:
            await self.frame_gate_after.wait()  # stored, but the answer is delayed
        return (202 if kind == "transcripts" else 200), {
            "ok": True,
            "observationId": oid,
            "captureGeneration": generation,
            "observedAt": observed,
        }


async def until(predicate: Any, timeout: float = 3.0) -> None:
    deadline = time.monotonic() + timeout
    while not predicate():
        if time.monotonic() > deadline:
            raise AssertionError("condition not reached in time")
        await asyncio.sleep(0.005)


def owned_tasks() -> list[str]:
    """Names of running tasks that belong to a BridgeClient (poller, registration, sends)."""
    names = []
    for task in asyncio.all_tasks():
        coro = task.get_coro()
        name = getattr(coro, "__qualname__", "")
        if name.startswith("BridgeClient.") and not task.done():
            names.append(name)
    return sorted(names)


class _Contract:
    """Contract tests. Concrete classes choose the transport."""

    def make_transport(self) -> Any:  # pragma: no cover - overridden
        raise NotImplementedError

    def transport_closed(self, transport: Any) -> bool:  # pragma: no cover - overridden
        raise NotImplementedError

    async def asyncSetUp(self) -> None:
        self.bridge = FakeBridge()
        await self.bridge.start()
        self.clients: list[Any] = []
        self.transports: list[Any] = []
        self.skew = 0.0
        self.addAsyncCleanup(self._cleanup)

    async def _cleanup(self) -> None:
        self.bridge.release()
        for client in self.clients:
            await client.close()
        await self.bridge.stop()

    def client(self, token: str = AGENT, **kwargs: Any) -> Any:
        transport = self.make_transport()
        self.transports.append(transport)
        options: dict[str, Any] = {
            "poll_interval": 0.02,
            "request_timeout": 1.0,
            "frame_timeout": 2.0,
            "transport": transport,
            "monotonic": lambda: time.monotonic() + self.skew,
        }
        options.update(kwargs)
        client = sb.BridgeClient(self.bridge.url, token, **options)
        self.clients.append(client)
        return client

    async def consented(self, client: Any) -> None:
        self.bridge.consent(client.session_id)
        client._refresh_soon()  # do not wait a whole (possibly long) poll interval
        await until(lambda: client.accepting_input)

    async def ready(self, **kwargs: Any) -> Any:
        """A started client on a consented, active session (generation 1)."""
        client = self.client(**kwargs)
        await client.start(ROOM)
        await self.consented(client)
        return client

    # -- Session registration ------------------------------------------------

    async def test_start_registers_the_room_with_the_exact_request_shape(self) -> None:
        client = self.client()
        sid = await client.start(ROOM)
        self.assertEqual(sid, "session-1")
        self.assertEqual((client.session_id, client.epoch), (sid, 1))
        (request,) = self.bridge.calls("POST", "/v1/sessions")
        self.assertEqual(json.loads(request["body"]), {"externalRef": ROOM})
        self.assertEqual(request["headers"]["authorization"], f"Bearer {AGENT}")
        self.assertEqual(request["headers"]["content-type"], "application/json")
        self.assertNotIn("origin", request["headers"])
        state = client.capture_state
        self.assertEqual(
            (
                state.status,
                state.accepting_input,
                state.generation,
                state.consent_given,
            ),
            ("starting", False, 0, False),
        )

    async def test_registration_is_idempotent_across_restarts_and_repeat_calls(
        self,
    ) -> None:
        first = self.client()
        sid = await first.start(ROOM)
        self.assertEqual(
            await first.start(ROOM), sid, "second start on the same client"
        )
        self.assertEqual(
            len(self.bridge.calls("POST", "/v1/sessions")),
            1,
            "no duplicate registration",
        )
        with self.assertRaises(sb.BridgeError):
            await first.start("another-room")
        await first.close()
        restarted = self.client()  # an agent process restart
        self.assertEqual(
            await restarted.start(ROOM), sid, "same room recovers the same session"
        )
        self.assertEqual(len(self.bridge.sessions), 1)

    async def test_start_failures_are_explicit(self) -> None:
        with self.assertRaises(sb.BridgeAuthError):
            await self.client(token="wrong-token-0123456789-abcdefghijklmnop").start(
                ROOM
            )
        await self.bridge.stop()
        offline = self.client()
        with self.assertRaises(sb.BridgeUnavailableError):
            await offline.start(ROOM)
        self.assertFalse(offline.accepting_input)
        self.assertEqual(owned_tasks(), [])

    # -- M2: coordinated startup and shutdown --------------------------------

    async def test_simultaneous_starts_share_one_registration_and_one_poller(
        self,
    ) -> None:
        client = self.client()
        self.bridge.register_gate = asyncio.Event()
        calls = [asyncio.ensure_future(client.start(ROOM)) for _ in range(5)]
        await until(lambda: self.bridge.registrations_started == 1)
        await asyncio.sleep(
            0.05
        )  # every caller is now waiting on the same registration
        self.assertEqual(
            self.bridge.registrations_started, 1, "single-flight registration"
        )
        self.assertEqual(
            owned_tasks().count("BridgeClient._poll_loop"),
            0,
            "no poller before registration completes",
        )
        self.bridge.register_gate.set()
        self.assertEqual(await asyncio.gather(*calls), ["session-1"] * 5)
        await asyncio.sleep(0.05)
        self.assertEqual(
            owned_tasks(), ["BridgeClient._poll_loop"], "exactly one poller"
        )
        self.assertEqual(len(self.bridge.calls("POST", "/v1/sessions")), 1)
        self.assertEqual(await client.start(ROOM), "session-1")
        self.assertEqual(owned_tasks(), ["BridgeClient._poll_loop"])

    async def test_a_cancelled_start_caller_does_not_break_the_shared_registration(
        self,
    ) -> None:
        client = self.client()
        self.bridge.register_gate = asyncio.Event()
        impatient = asyncio.ensure_future(client.start(ROOM))
        patient = asyncio.ensure_future(client.start(ROOM))
        await until(lambda: self.bridge.registrations_started == 1)
        impatient.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await impatient
        self.bridge.register_gate.set()
        self.assertEqual(await patient, "session-1")
        self.assertEqual(self.bridge.registrations_started, 1)
        self.assertEqual(owned_tasks(), ["BridgeClient._poll_loop"])

    async def test_close_during_registration_creates_no_poller_and_leaves_nothing_running(
        self,
    ) -> None:
        client = self.client()
        self.bridge.register_gate = asyncio.Event()
        starting = asyncio.ensure_future(client.start(ROOM))
        second = asyncio.ensure_future(client.start(ROOM))
        await until(lambda: self.bridge.registrations_started == 1)
        started = time.monotonic()
        await client.close()
        # Checked IMMEDIATELY: close() must not return while registration is still running.
        self.assertEqual(
            owned_tasks(), [], "no registration or poller survives close()"
        )
        self.assertLess(
            time.monotonic() - started,
            0.5,
            "close cancels the registration; it does not wait for a timeout",
        )
        self.assertTrue(self.transport_closed(self.transports[-1]))
        for call in (starting, second):
            with self.assertRaises(sb.BridgeError) as raised:
                await call
            self.assertNotIsInstance(raised.exception, sb.BridgeUnavailableError)
            self.assertIn("closed", str(raised.exception))
        self.bridge.register_gate.set()  # the bridge answers late: nobody is listening
        await asyncio.sleep(0.1)
        self.assertEqual(owned_tasks(), [])
        self.assertEqual(
            self.bridge.calls("GET", "/capture"), [], "polling never started"
        )
        self.assertFalse(client.accepting_input)
        self.assertIsNone(client.capture())

    async def test_registration_that_completes_after_close_never_starts_a_poller(
        self,
    ) -> None:
        # Simulates a registration step that does not honour cancellation (possible with
        # an uncooperative transport on Python 3.12+): its answer arrives although close()
        # cancelled it. The re-checks after the awaited step must still stop the client.
        client = self.client()
        real_register = client._register

        async def uncancellable_register() -> Any:
            work = asyncio.ensure_future(real_register())
            while True:
                try:
                    return await asyncio.shield(work)
                except asyncio.CancelledError:
                    if work.done():
                        raise

        client._register = uncancellable_register
        self.bridge.register_gate = asyncio.Event()
        starting = asyncio.ensure_future(client.start(ROOM))
        await until(lambda: self.bridge.registrations_started == 1)
        closing = asyncio.ensure_future(client.close())
        await asyncio.sleep(0.05)
        self.assertFalse(closing.done(), "close waits for the registration it owns")
        self.bridge.register_gate.set()  # the bridge answers 201 after close() began
        await closing
        with self.assertRaises(sb.BridgeError) as raised:
            await starting
        self.assertNotIsInstance(raised.exception, sb.BridgeAuthError)
        await asyncio.sleep(0.1)
        self.assertEqual(owned_tasks(), [], "no poller was created after close")
        self.assertIsNone(client._poll_task)
        self.assertEqual(self.bridge.calls("GET", "/capture"), [])
        self.assertEqual(
            len(self.bridge.sessions),
            1,
            "the bridge did create the session; the client never uses it",
        )
        self.assertIsNone(
            client.session_id, "a closed client does not adopt the late answer"
        )
        self.assertFalse(client.accepting_input)
        self.assertIsNone(client.capture())

    async def test_start_after_close_is_refused_without_any_request(self) -> None:
        client = self.client()
        await client.close()
        for _ in range(3):
            with self.assertRaises(sb.BridgeError):
                await client.start(ROOM)
        self.assertEqual(self.bridge.requests, [])
        self.assertEqual(owned_tasks(), [])
        started = await self.ready()
        await started.close()
        with self.assertRaises(sb.BridgeError):
            await started.start(ROOM)
        self.assertEqual(owned_tasks(), [])

    async def test_registration_failure_can_be_retried_safely(self) -> None:
        client = self.client()
        self.bridge.forced["sessions"] = [(500, "internal_error"), "drop"]
        for _ in range(2):
            with self.assertRaises(sb.BridgeUnavailableError):
                await client.start(ROOM)
            self.assertEqual(owned_tasks(), [], "a failed start leaves no poller")
            self.assertIsNone(client.session_id)
            self.assertIsNone(client.capture())
        self.assertEqual(await client.start(ROOM), "session-1")
        self.assertEqual(owned_tasks(), ["BridgeClient._poll_loop"])
        self.assertEqual(len(self.bridge.calls("POST", "/v1/sessions")), 3)
        await self.consented(client)
        self.assertEqual(
            (await client.send_transcript(TEXT, client.capture())).outcome,
            Outcome.ACCEPTED,
        )

    async def test_concurrent_and_repeated_close_share_one_shutdown(self) -> None:
        client = await self.ready()
        await asyncio.gather(client.close(), client.close(), client.close())
        await client.close()
        self.assertTrue(client.closed)
        self.assertEqual(owned_tasks(), [])
        self.assertTrue(self.transport_closed(self.transports[-1]))

    # -- Consent gating and capture-state polling ----------------------------

    async def test_nothing_is_captured_or_sent_before_consent(self) -> None:
        client = self.client()
        self.assertIsNone(client.capture(), "not started")
        await client.start(ROOM)
        await until(lambda: len(self.bridge.calls("GET", "/capture")) >= 2)
        self.assertFalse(client.accepting_input)
        self.assertIsNone(client.capture(), "no consent: no capture context")
        self.assertEqual(
            self.bridge.calls("POST", "/transcripts")
            + self.bridge.calls("POST", "/frames"),
            [],
        )
        self.assertEqual(
            self.bridge.session()["status"], "starting", "only the operator can consent"
        )

    async def test_polling_tracks_consent_and_generation(self) -> None:
        client = self.client()
        await client.start(ROOM)
        self.assertEqual(client.generation, 0)
        self.bridge.consent()
        await until(lambda: client.accepting_input)
        self.assertEqual(
            (
                client.generation,
                client.capture_state.status,
                client.capture_state.consent_given,
            ),
            (1, "active", True),
        )
        context = client.capture()
        self.assertEqual(
            (context.session_id, context.epoch, context.generation), ("session-1", 1, 1)
        )
        poll = self.bridge.calls("GET", "/capture")[0]
        self.assertEqual(poll["path"], "/v1/sessions/session-1/capture")
        self.assertEqual(poll["body"], b"")
        self.assertNotIn("content-type", poll["headers"])
        self.assertEqual(
            poll["headers"].get("content-length", "0"),
            "0",
            "capture polls carry no body",
        )

    async def test_a_capture_answer_about_another_session_is_not_adopted(self) -> None:
        client = await self.ready(poll_interval=30.0, max_state_age=10_000.0)
        foreign = {
            "ok": True,
            "sessionId": "session-999",
            "status": "active",
            "consentGiven": True,
            "captureGeneration": 5,
            "acceptingInput": True,
        }
        malformed = {
            "ok": True,
            "sessionId": "session-1",
            "status": "active",
            "captureGeneration": "1",
            "acceptingInput": True,
        }
        for answer in (foreign, malformed):
            polls = len(self.bridge.calls("GET", "/capture"))
            self.bridge.forced["capture"] = [answer]
            client._refresh_soon()
            await until(
                lambda polls=polls: len(self.bridge.calls("GET", "/capture")) > polls
            )
            await asyncio.sleep(0.05)
            self.assertEqual(
                (client.session_id, client.epoch, client.generation),
                ("session-1", 1, 1),
            )
            self.assertFalse(client.accepting_input, "an unusable answer fails closed")
            self.assertIsNone(client.capture())
            client._refresh_soon()
            await until(
                lambda: client.accepting_input
            )  # the next good poll restores capture

    async def test_stale_capture_state_fails_closed(self) -> None:
        client = await self.ready(poll_interval=30.0, max_state_age=5.0)
        context = client.capture()
        self.assertIsNotNone(context)
        self.skew = 6.0  # no successful poll for longer than max_state_age
        self.assertFalse(client.accepting_input)
        self.assertFalse(client.capture_state.accepting_input)
        self.assertIsNone(client.capture())
        result = await client.send_transcript(TEXT, context)
        self.assertEqual(
            (result.outcome, result.transmitted), (Outcome.NOT_ACCEPTING, False)
        )
        self.assertEqual(self.bridge.calls("POST", "/transcripts"), [])

    # -- CaptureContext ------------------------------------------------------

    async def test_capture_context_is_immutable_and_records_the_moment_of_capture(
        self,
    ) -> None:
        client = await self.ready()
        before = datetime.now(UTC) - timedelta(milliseconds=2)
        context = client.capture()
        after = datetime.now(UTC) + timedelta(milliseconds=2)
        self.assertRegex(
            context.observed_at, r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$"
        )
        stamped = datetime.fromisoformat(context.observed_at.replace("Z", "+00:00"))
        self.assertTrue(before <= stamped <= after)
        with self.assertRaises(dataclasses.FrozenInstanceError):
            context.generation = 9
        with self.assertRaises(dataclasses.FrozenInstanceError):
            context.session_id = "session-2"
        self.assertEqual(repr(context).count("session-1"), 1)
        self.assertNotEqual(
            context,
            dataclasses.replace(context),
            "equality is identity, not field values",
        )
        self.assertEqual(context, context)
        self.assertEqual(len({context, dataclasses.replace(context)}), 2)
        explicit = client.capture("2026-11-15T15:07:43.897+05:30")
        self.assertEqual(
            explicit.observed_at,
            "2026-11-15T15:07:43.897+05:30",
            "strings are kept unchanged",
        )
        moment = datetime(2026, 11, 15, 9, 37, 43, 897000, tzinfo=UTC)
        self.assertEqual(client.capture(moment).observed_at, "2026-11-15T09:37:43.897Z")
        for bad in (datetime(2026, 11, 15, 9, 0, 0), "", "x" * 65, 12345):
            with self.assertRaises(ValueError):
                client.capture(bad)

    async def _rejected(self, client: Any, context: Any, label: str) -> None:
        """Both send methods refuse `context` as not authentic, without transmitting."""
        for result in (
            await client.send_transcript(TEXT, context),
            await client.send_frame(JPEG, context),
        ):
            self.assertEqual(
                (result.outcome, result.error, result.status, result.transmitted),
                (Outcome.REJECTED, "invalid_context", None, False),
                label,
            )

    def observation_posts(self) -> list[dict[str, Any]]:
        return self.bridge.calls("POST", "/transcripts") + self.bridge.calls(
            "POST", "/frames"
        )

    async def test_authentic_context_succeeds_and_any_copy_is_rejected(self) -> None:
        client = await self.ready()
        context = client.capture()
        copies = {
            "dataclasses.replace with no changes": dataclasses.replace(context),
            "copy.copy": copy.copy(context),
            "copy.deepcopy": copy.deepcopy(context),
            "pickle round trip": pickle.loads(pickle.dumps(context)),
            "rebuilt from its fields": sb.CaptureContext(
                context.session_id,
                context.epoch,
                context.generation,
                context.observed_at,
            ),
            "rebuilt via asdict": sb.CaptureContext(**dataclasses.asdict(context)),
            "rewritten observed_at": dataclasses.replace(
                context, observed_at=sb.utc_timestamp()
            ),
            "rewritten generation": dataclasses.replace(
                context, generation=context.generation + 1
            ),
            "not a context": {
                "session_id": context.session_id,
                "epoch": 1,
                "generation": 1,
                "observed_at": context.observed_at,
            },
            "None": None,
        }
        for label, forged in copies.items():
            if isinstance(forged, sb.CaptureContext) and "rewritten" not in label:
                self.assertEqual(
                    dataclasses.astuple(forged),
                    dataclasses.astuple(context),
                    "identical fields",
                )
            await self._rejected(client, forged, label)
        self.assertEqual(self.observation_posts(), [], "no copy was transmitted")
        # 1. The authentic original still works afterwards.
        speech = await client.send_transcript(TEXT, context)
        self.assertEqual((speech.outcome, speech.transmitted), (Outcome.ACCEPTED, True))
        self.assertEqual(
            (await client.send_frame(JPEG, context)).outcome, Outcome.ACCEPTED
        )
        body = json.loads(self.bridge.calls("POST", "/transcripts")[0]["body"])
        self.assertEqual(
            (body["captureGeneration"], body["observedAt"]),
            (context.generation, context.observed_at),
        )

    async def test_an_issued_context_whose_fields_were_changed_in_place_is_rejected(
        self,
    ) -> None:
        client = await self.ready()
        context = client.capture()
        original = context.observed_at
        for name, value in (
            ("observed_at", "2020-01-01T00:00:00Z"),
            ("session_id", "session-2"),
            ("epoch", 2),
            ("generation", 5),
        ):
            kept = getattr(context, name)
            object.__setattr__(context, name, value)  # bypasses the frozen dataclass
            await self._rejected(client, context, f"tampered {name}")
            object.__setattr__(context, name, kept)
        self.assertEqual(self.observation_posts(), [])
        self.assertEqual(context.observed_at, original)
        self.assertEqual(
            (await client.send_transcript(TEXT, context)).outcome, Outcome.ACCEPTED
        )

    async def test_a_context_from_another_client_is_rejected(self) -> None:
        client = await self.ready()
        other = self.client()
        await other.start(ROOM)  # the SAME room and session, a different client object
        await until(lambda: other.accepting_input)
        foreign, mine = other.capture(), client.capture()
        self.assertEqual(
            (foreign.session_id, foreign.epoch, foreign.generation),
            (mine.session_id, mine.epoch, mine.generation),
        )
        await self._rejected(client, foreign, "another client's context")
        await self._rejected(other, mine, "this client's context on the other client")
        self.assertEqual(self.observation_posts(), [])
        self.assertEqual(
            (await client.send_transcript(TEXT, mine)).outcome, Outcome.ACCEPTED
        )
        self.assertEqual(
            (await other.send_transcript(TEXT, foreign)).outcome, Outcome.ACCEPTED
        )

    async def test_a_copy_retargeted_at_the_replacement_session_is_rejected(
        self,
    ) -> None:
        # The reproduced attack: take an old session-A context and rewrite session_id and
        # epoch to the CURRENT session B values.
        client = await self.ready()
        old = client.capture()  # captured under session A
        self.bridge.discard()
        client._refresh_soon()
        await until(lambda: client.session_id == "session-2")
        await self.consented(client)
        self.assertEqual((client.epoch, client.generation), (2, old.generation))
        seen = len(self.bridge.requests)
        retargeted = dataclasses.replace(
            old, session_id=client.session_id, epoch=client.epoch
        )
        fresh = client.capture()
        self.assertEqual(
            (retargeted.session_id, retargeted.epoch, retargeted.generation),
            (fresh.session_id, fresh.epoch, fresh.generation),
            "indistinguishable from a genuine session-B context by its fields",
        )
        self.assertEqual(retargeted.observed_at, old.observed_at)
        await self._rejected(client, retargeted, "old context retargeted at session B")
        await self._rejected(
            client,
            dataclasses.replace(retargeted, observed_at=fresh.observed_at),
            "retargeted and re-stamped",
        )
        await self._rejected(
            client, dataclasses.replace(fresh), "copy of a genuine session-B context"
        )
        # 6. The authentic old context is stale, not forged.
        for result in (
            await client.send_transcript(TEXT, old),
            await client.send_frame(JPEG, old),
        ):
            self.assertEqual(
                (result.outcome, result.error, result.transmitted),
                (Outcome.STALE, "session_replaced", False),
            )
        self.assertEqual(
            [r for r in self.bridge.requests[seen:] if r["method"] == "POST"],
            [],
            "nothing captured under A was transmitted",
        )
        self.assertEqual(self.bridge.session("session-2")["obs"], [])
        # 7. A fresh context from the replacement session succeeds.
        accepted = await client.send_transcript(TEXT, fresh)
        self.assertEqual(
            (accepted.outcome, accepted.observation_id),
            (Outcome.ACCEPTED, "session-2-obs-1"),
        )
        self.assertEqual(
            json.loads(self.bridge.calls("POST", "/transcripts")[-1]["body"])[
                "observedAt"
            ],
            fresh.observed_at,
        )

    async def test_many_simultaneous_contexts_stay_valid_and_keep_their_own_values(
        self,
    ) -> None:
        client = await self.ready()
        stamps = [f"2026-11-15T09:37:{second:02d}.000Z" for second in range(40)]
        contexts = [client.capture(stamp) for stamp in stamps]
        self.assertEqual(len({id(c) for c in contexts}), 40)
        self.assertEqual(len(client._issued), 40)
        results = await asyncio.gather(
            *(client.send_transcript(f"{TEXT} {i}", c) for i, c in enumerate(contexts))
        )
        self.assertEqual({r.outcome for r in results}, {Outcome.ACCEPTED})
        sent = {
            json.loads(r["body"])["text"]: json.loads(r["body"])
            for r in self.bridge.calls("POST", "/transcripts")
        }
        for i, context in enumerate(contexts):
            body = sent[f"{TEXT} {i}"]
            self.assertEqual(
                (body["observedAt"], body["captureGeneration"]),
                (stamps[i], 1),
                "each observation keeps its own context",
            )
            self.assertEqual(
                (context.session_id, context.epoch, context.observed_at),
                ("session-1", 1, stamps[i]),
            )
        # Contexts stay usable after other contexts were used, and across a pause/resume.
        self.bridge.pause()
        await until(lambda: not client.accepting_input)
        self.bridge.resume()
        await until(lambda: client.accepting_input)
        later = client.capture()
        both = await asyncio.gather(
            client.send_transcript(TEXT, contexts[0]),
            client.send_transcript(TEXT, later),
        )
        self.assertEqual(
            [r.outcome for r in both], [Outcome.ACCEPTED, Outcome.ACCEPTED]
        )
        self.assertEqual((later.generation, contexts[0].generation), (3, 1))

    async def test_context_tracking_is_bounded_weak_and_cleared_on_close(self) -> None:
        client = await self.ready(max_live_contexts=8)
        # Weak: contexts the caller dropped are not retained.
        for _ in range(2_000):
            client.capture()
        gc.collect()
        self.assertLessEqual(len(client._issued), 1, "dropped contexts are forgotten")
        # A new object reusing a freed id is tracked correctly.
        for _ in range(200):
            context = client.capture()
            self.assertTrue(client._is_issued(context))
            del context
        # A stale registry entry under a reused id must not authenticate a different object.
        genuine = client.capture()
        impostor = sb.CaptureContext(
            genuine.session_id, genuine.epoch, genuine.generation, genuine.observed_at
        )
        client._issued[id(impostor)] = client._issued[
            id(genuine)
        ]  # entry points at `genuine`
        self.assertFalse(client._is_issued(impostor))
        await self._rejected(client, impostor, "id collision with a stale entry")
        del client._issued[id(impostor)]
        self.assertTrue(client._is_issued(genuine))
        del genuine, impostor
        # Bounded: at most `max_live_contexts` are tracked even if the caller keeps them all.
        held = [client.capture() for _ in range(20)]
        self.assertEqual(len(client._issued), 8)
        for context in held[:12]:
            await self._rejected(client, context, "evicted (oldest) context")
        for context in held[12:]:
            self.assertEqual(
                (await client.send_transcript(TEXT, context)).outcome, Outcome.ACCEPTED
            )
        self.assertEqual(len(self.bridge.calls("POST", "/transcripts")), 8)
        # The registry holds metadata only: no text, no image bytes.
        dump = repr(client._issued)
        self.assertNotIn("ZEBRA", dump)
        # Cleared on close, even while the caller still holds the objects.
        await client.close()
        self.assertEqual(len(client._issued), 0)
        self.assertEqual(len(held), 20)
        self.assertIsNone(client.capture())
        self.assertEqual(len(client._issued), 0, "nothing is issued after close")
        result = await client.send_transcript(TEXT, held[-1])
        self.assertEqual((result.outcome, result.transmitted), (Outcome.CLOSED, False))
        transport = self.make_transport()
        self.transports.append(transport)
        for bad in (0, -1, True, False, 1.5, float("nan"), float("inf"), "8", None):
            with self.assertRaises(sb.BridgeConfigError, msg=repr(bad)):
                sb.BridgeClient(
                    "http://127.0.0.1:8787",
                    AGENT,
                    transport=transport,
                    max_live_contexts=bad,
                )

    # -- M1: cross-session isolation -----------------------------------------

    async def test_observations_captured_in_a_discarded_session_never_enter_its_replacement(
        self,
    ) -> None:
        client = await self.ready()
        # Session A accepts observations.
        self.assertEqual(
            (await client.send_transcript(TEXT, client.capture())).observation_id,
            "session-1-obs-1",
        )
        self.assertEqual(
            (await client.send_frame(JPEG, client.capture())).observation_id,
            "session-1-obs-2",
        )
        # Media captured in A but not sent yet (e.g. buffered by the agent).
        buffered_speech, buffered_frame = client.capture(), client.capture()
        self.assertEqual(
            (
                buffered_speech.session_id,
                buffered_speech.epoch,
                buffered_speech.generation,
            ),
            ("session-1", 1, 1),
        )
        # A is discarded; the client registers B; B gets FRESH operator consent.
        record_a = self.bridge.discard()
        client._refresh_soon()
        await until(lambda: client.session_id == "session-2")
        self.assertEqual(
            (client.epoch, client.capture_state.status, client.accepting_input),
            (2, "starting", False),
        )
        self.assertIsNone(client.capture(), "B has no consent yet")
        await self.consented(client)
        self.assertEqual(
            client.generation,
            buffered_speech.generation,
            "same generation number as A: the dangerous case",
        )
        seen = len(self.bridge.requests)
        # Buffered observations from A are rejected, without transmitting anything.
        for result in (
            await client.send_transcript(TEXT, buffered_speech),
            await client.send_frame(JPEG, buffered_frame),
        ):
            self.assertEqual(
                (result.outcome, result.error, result.status, result.transmitted),
                (Outcome.STALE, "session_replaced", None, False),
            )
        posts = [r for r in self.bridge.requests[seen:] if r["method"] == "POST"]
        self.assertEqual(posts, [], "nothing from A was sent to A or to B")
        self.assertEqual(self.bridge.session("session-2")["obs"], [])
        # Fresh observations from B are accepted, into B.
        fresh = client.capture()
        self.assertEqual(
            (fresh.session_id, fresh.epoch, fresh.generation), ("session-2", 2, 1)
        )
        self.assertEqual(
            (await client.send_transcript(TEXT, fresh)).observation_id,
            "session-2-obs-1",
        )
        self.assertEqual(
            (await client.send_frame(JPEG, client.capture())).observation_id,
            "session-2-obs-2",
        )
        self.assertEqual(
            len(record_a["obs"]), 2, "A kept only what it accepted while it existed"
        )
        self.assertEqual(
            [o["id"] for o in self.bridge.session("session-2")["obs"]],
            ["session-2-obs-1", "session-2-obs-2"],
        )
        for request in self.bridge.calls("POST", "/transcripts") + self.bridge.calls(
            "POST", "/frames"
        ):
            expected = (
                "session-1" if request in self.bridge.requests[:seen] else "session-2"
            )
            self.assertIn(f"/v1/sessions/{expected}/", request["path"])

    async def test_a_send_racing_a_session_replacement_goes_to_the_original_session_only(
        self,
    ) -> None:
        client = await self.ready(
            poll_interval=30.0
        )  # the poller will not notice by itself
        context = client.capture()
        self.bridge.restart()  # A is gone, the client does not know yet
        result = await client.send_transcript(TEXT, context)
        self.assertEqual(
            (result.outcome, result.status, result.error, result.transmitted),
            (Outcome.SESSION_LOST, 404, "session_not_found", True),
        )
        self.assertEqual(
            self.bridge.calls("POST", "/transcripts")[0]["path"],
            "/v1/sessions/session-1/transcripts",
        )
        await until(lambda: client.session_id == "session-2")
        await self.consented(client)
        again = await client.send_transcript(TEXT, context)
        self.assertEqual(
            (again.outcome, again.error, again.transmitted),
            (Outcome.STALE, "session_replaced", False),
        )
        self.assertEqual(
            len(self.bridge.calls("POST", "/transcripts")),
            1,
            "the lost transcript is never resent",
        )
        self.assertEqual(self.bridge.session("session-2")["obs"], [])

    async def test_a_late_answer_about_a_replaced_session_does_not_disturb_the_new_one(
        self,
    ) -> None:
        client = await self.ready()
        context = client.capture()
        self.bridge.frame_gate = asyncio.Event()  # A's frame is held "in vision"
        pending = asyncio.ensure_future(client.send_frame(JPEG, context))
        await until(lambda: self.bridge.frames_started == 1)
        self.bridge.discard()
        client._refresh_soon()
        await until(lambda: client.session_id == "session-2")
        await self.consented(client)
        self.bridge.forced["frames"] = [(409, "session_not_active")]
        self.bridge.frame_gate.set()
        late = await pending
        self.assertEqual(
            (late.outcome, late.transmitted), (Outcome.SESSION_INACTIVE, True)
        )
        self.assertTrue(
            client.accepting_input, "an answer about A must not stop capture in B"
        )
        self.bridge.frame_gate = None
        self.assertEqual(
            (await client.send_frame(JPEG, client.capture())).observation_id,
            "session-2-obs-1",
        )

    # -- Request shapes and preserved capture metadata -----------------------

    async def test_transcript_request_shape_and_preserved_timestamp(self) -> None:
        client = await self.ready()
        context = client.capture("2026-11-15T09:37:43.897Z")
        await asyncio.sleep(0.05)  # upload happens later than capture
        result = await client.send_transcript(TEXT, context)
        self.assertEqual(
            (result.outcome, result.status, result.observation_id, result.transmitted),
            (Outcome.ACCEPTED, 202, "session-1-obs-1", True),
        )
        self.assertTrue(result.accepted)
        (request,) = self.bridge.calls("POST", "/transcripts")
        self.assertEqual(request["path"], "/v1/sessions/session-1/transcripts")
        self.assertEqual(
            json.loads(request["body"]),
            {
                "captureGeneration": 1,
                "observedAt": "2026-11-15T09:37:43.897Z",
                "text": TEXT,
            },
        )
        self.assertEqual(request["headers"]["content-type"], "application/json")
        self.assertEqual(request["headers"]["authorization"], f"Bearer {AGENT}")
        self.assertNotIn("origin", request["headers"])

    async def test_speaker_ref_is_sent_only_when_given(self) -> None:
        client = await self.ready()
        await client.send_transcript(
            TEXT, client.capture(), speaker_ref="verified-speaker-1"
        )
        await client.send_transcript(TEXT, client.capture())
        first, second = (
            json.loads(r["body"]) for r in self.bridge.calls("POST", "/transcripts")
        )
        self.assertEqual(first["speakerRef"], "verified-speaker-1")
        self.assertNotIn("speakerRef", second)

    async def test_frame_request_shape_and_preserved_metadata(self) -> None:
        client = await self.ready()
        context = client.capture()
        await asyncio.sleep(0.05)
        result = await client.send_frame(JPEG, context)
        self.assertEqual(
            (result.outcome, result.status, result.observation_id, result.transmitted),
            (Outcome.ACCEPTED, 200, "session-1-obs-1", True),
        )
        (request,) = self.bridge.calls("POST", "/frames")
        self.assertEqual(request["path"], "/v1/sessions/session-1/frames")
        self.assertEqual(request["body"], JPEG)
        self.assertEqual(request["headers"]["content-type"], "image/jpeg")
        self.assertEqual(request["headers"]["x-capture-generation"], "1")
        self.assertEqual(request["headers"]["x-observed-at"], context.observed_at)
        self.assertEqual(request["headers"]["content-length"], str(len(JPEG)))
        self.assertNotIn("origin", request["headers"])

    # -- Pause, resume, end --------------------------------------------------

    async def test_pause_stops_capture_and_resume_brings_a_new_generation(self) -> None:
        client = await self.ready()
        earlier = client.capture()
        self.bridge.pause()
        await until(lambda: not client.accepting_input)
        self.assertEqual(
            (client.generation, client.capture_state.status), (2, "paused")
        )
        self.assertIsNone(client.capture(), "nothing is captured while paused")
        paused = await client.send_transcript(TEXT, earlier)
        self.assertEqual(
            (paused.outcome, paused.error, paused.transmitted),
            (Outcome.NOT_ACCEPTING, "paused", False),
        )
        self.assertEqual(self.bridge.calls("POST", "/transcripts"), [])
        self.assertEqual(
            self.bridge.session()["status"], "paused", "the client never resumes"
        )

        self.bridge.resume()
        await until(lambda: client.accepting_input)
        self.assertEqual((client.generation, client.epoch), (3, 1))
        stale_frame = await client.send_frame(JPEG, earlier)
        self.assertEqual(
            (stale_frame.outcome, stale_frame.error, stale_frame.transmitted),
            (Outcome.STALE, "stale_generation", False),
        )
        self.assertEqual(
            self.bridge.calls("POST", "/frames"),
            [],
            "pre-pause frames are dropped locally",
        )
        self.assertEqual(
            (await client.send_frame(JPEG, client.capture())).outcome, Outcome.ACCEPTED
        )
        # Same session, earlier generation: a transcript keeps ITS generation and is still sent.
        kept = await client.send_transcript(TEXT, earlier)
        self.assertEqual(kept.outcome, Outcome.ACCEPTED)
        body = json.loads(self.bridge.calls("POST", "/transcripts")[0]["body"])
        self.assertEqual(
            (body["captureGeneration"], body["observedAt"]), (1, earlier.observed_at)
        )

    async def test_pause_seen_first_through_a_409_stops_capture_immediately(
        self,
    ) -> None:
        client = await self.ready(
            poll_interval=30.0
        )  # the poller will not notice by itself
        context = client.capture()
        self.bridge.pause()
        result = await client.send_transcript(TEXT, context)
        self.assertEqual(
            (result.outcome, result.status, result.error),
            (Outcome.SESSION_INACTIVE, 409, "session_not_active"),
        )
        self.assertFalse(client.accepting_input, "fail closed at once")
        self.assertIsNone(client.capture())
        await until(
            lambda: client.generation == 2
        )  # the 409 triggered an immediate re-read
        self.assertEqual(
            len(self.bridge.calls("POST", "/transcripts")), 1, "not retried"
        )

    async def test_ended_session_stops_capture_and_is_not_recreated(self) -> None:
        client = await self.ready()
        context = client.capture()
        self.bridge.end()
        await until(lambda: client.capture_state.status == "ended")
        self.assertFalse(client.accepting_input)
        self.assertIsNone(client.capture())
        self.assertEqual(
            (await client.send_frame(JPEG, context)).outcome, Outcome.NOT_ACCEPTING
        )
        await asyncio.sleep(0.1)
        self.assertEqual(
            len(self.bridge.calls("POST", "/v1/sessions")),
            1,
            "no new session after end",
        )

    async def test_the_client_never_calls_a_lifecycle_or_operator_route(self) -> None:
        client = await self.ready()
        await client.send_transcript(TEXT, client.capture())
        self.bridge.pause()
        await until(lambda: not client.accepting_input)
        self.bridge.resume()
        await until(lambda: client.accepting_input)
        await client.send_frame(JPEG, client.capture())
        self.bridge.end()
        await until(lambda: client.capture_state.status == "ended")
        await client.close()
        for request in self.bridge.requests:
            self.assertFalse(request["path"].endswith(LIFECYCLE_PATHS), request["path"])
            self.assertNotEqual(request["method"], "DELETE")
            self.assertEqual(request["headers"]["authorization"], f"Bearer {AGENT}")
        source = _PATH.read_text()
        for route in ("/consent", "/resume", "/pause", "/end", "/pairings", "DELETE"):
            self.assertNotIn(
                f'"{route}',
                source.replace("'", '"'),
                f"client must not implement {route}",
            )

    # -- Authorization failures ----------------------------------------------

    async def test_auth_failure_after_start_is_terminal(self) -> None:
        client = await self.ready()
        context = client.capture()
        self.bridge.agent_token = "rotated-token-0123456789-abcdefghijklmn"
        result = await client.send_transcript(TEXT, context)
        self.assertEqual((result.outcome, result.status), (Outcome.AUTH_FAILED, 401))
        self.assertTrue(client.auth_failed)
        self.assertFalse(client.accepting_input)
        self.assertIsNone(client.capture())
        await asyncio.sleep(0.1)
        seen = len(self.bridge.requests)
        self.assertEqual(
            (await client.send_frame(JPEG, context)).outcome, Outcome.AUTH_FAILED
        )
        await asyncio.sleep(0.1)
        self.assertEqual(len(self.bridge.requests), seen, "polling and sending stopped")
        self.assertEqual(owned_tasks(), [], "the poller exited")
        with self.assertRaises(sb.BridgeAuthError):
            await client.start(ROOM)

    async def test_auth_failure_seen_by_the_poller_stops_capture(self) -> None:
        client = await self.ready()
        context = client.capture()
        self.bridge.agent_token = "rotated-token-0123456789-abcdefghijklmn"
        await until(lambda: client.auth_failed)
        self.assertFalse(client.accepting_input)
        self.assertEqual(
            (await client.send_transcript(TEXT, context)).outcome, Outcome.AUTH_FAILED
        )

    async def test_configuration_is_validated_and_the_control_token_is_refused(
        self,
    ) -> None:
        transport = self.make_transport()
        self.transports.append(transport)
        for url in (
            "http://example.com:8787",
            "ftp://127.0.0.1",
            "http://user:pw@127.0.0.1:8787",
            "http://127.0.0.1:8787/v1",
            "",
            "127.0.0.1:8787",
        ):
            with self.assertRaises(sb.BridgeConfigError, msg=url):
                sb.BridgeClient(url, AGENT, transport=transport)
        for bad in ("short", " " + AGENT, None):
            with self.assertRaises(sb.BridgeConfigError):
                sb.BridgeClient("http://127.0.0.1:8787", bad, transport=transport)
        for option in (
            "poll_interval",
            "request_timeout",
            "frame_timeout",
            "max_backoff",
            "max_state_age",
        ):
            for bad in (
                float("nan"),
                float("inf"),
                float("-inf"),
                0,
                0.0,
                -1,
                -0.5,
                True,
                False,
                "1",
                [1],
            ):
                with self.assertRaises(sb.BridgeConfigError, msg=f"{option}={bad!r}"):
                    sb.BridgeClient(
                        "http://127.0.0.1:8787",
                        AGENT,
                        transport=transport,
                        **{option: bad},
                    )
            sb.BridgeClient(
                "http://127.0.0.1:8787", AGENT, transport=transport, **{option: 0.5}
            )
            sb.BridgeClient(
                "http://127.0.0.1:8787", AGENT, transport=transport, **{option: 2}
            )
        env = {"SIDEKICK_BRIDGE_URL": self.bridge.url, "SIDEKICK_AGENT_TOKEN": AGENT}
        client = sb.BridgeClient.from_env(env, transport=transport)
        self.clients.append(client)
        self.assertEqual(await client.start(ROOM), "session-1")
        with self.assertRaises(sb.BridgeConfigError):
            sb.BridgeClient.from_env(
                {**env, "SIDEKICK_CONTROL_TOKEN": CONTROL}, transport=transport
            )
        with self.assertRaises(sb.BridgeConfigError):
            sb.BridgeClient.from_env(
                {"SIDEKICK_BRIDGE_URL": self.bridge.url}, transport=transport
            )
        with self.assertRaises(sb.BridgeConfigError):
            sb.BridgeClient.from_env(
                {"SIDEKICK_AGENT_TOKEN": AGENT}, transport=transport
            )

    # -- Invalid and stale requests ------------------------------------------

    async def test_locally_invalid_observations_are_rejected_without_a_request(
        self,
    ) -> None:
        client = await self.ready()
        context = client.capture()
        cases = [
            (client.send_transcript("", context), "empty_text"),
            (client.send_transcript("   ", context), "empty_text"),
            (client.send_transcript(None, context), "empty_text"),
            (client.send_transcript("x" * 1001, context), "too_long"),
            (
                client.send_transcript(TEXT, context, speaker_ref=""),
                "invalid_speaker_ref",
            ),
            (
                client.send_transcript(TEXT, context, speaker_ref="x" * 129),
                "invalid_speaker_ref",
            ),
            (client.send_frame(b"", context), "invalid_frame"),
            (
                client.send_frame(b"\x89PNG\r\n\x1a\n" + b"\x00" * 16, context),
                "invalid_frame",
            ),
            (client.send_frame("not-bytes", context), "invalid_frame"),
            (
                client.send_frame(
                    b"\xff\xd8\xff" + b"\x00" * sb.MAX_FRAME_BYTES, context
                ),
                "payload_too_large",
            ),
        ]
        for pending, error in cases:
            result = await pending
            self.assertEqual(
                (result.outcome, result.error, result.status, result.transmitted),
                (Outcome.REJECTED, error, None, False),
            )
        self.assertEqual(
            self.bridge.calls("POST", "/transcripts")
            + self.bridge.calls("POST", "/frames"),
            [],
        )
        self.assertEqual(
            (await client.send_transcript("x" * 1000, context)).outcome,
            Outcome.ACCEPTED,
        )

    async def test_bridge_rejections_are_dropped_and_never_retried(self) -> None:
        client = await self.ready()
        future = sb.utc_timestamp(datetime.now(UTC) + timedelta(seconds=60))
        for stamp, status, error in (
            ("not-a-time", 400, "invalid_timestamp"),
            (future, 422, "timestamp_out_of_range"),
        ):
            result = await client.send_transcript(TEXT, client.capture(stamp))
            self.assertEqual(
                (result.outcome, result.status, result.error, result.transmitted),
                (Outcome.REJECTED, status, error, True),
            )
        self.bridge.forced["transcripts"] = [(409, "invalid_generation")]
        stale = await client.send_transcript(TEXT, client.capture())
        self.assertEqual(
            (stale.outcome, stale.status, stale.error),
            (Outcome.STALE, 409, "invalid_generation"),
        )
        self.bridge.forced["frames"] = [
            (409, "stale_evidence"),
            (413, "payload_too_large"),
            (400, "invalid_input"),
            (409, "aborted"),
        ]
        expected = [
            (Outcome.STALE, "stale_evidence"),
            (Outcome.REJECTED, "payload_too_large"),
            (Outcome.REJECTED, "invalid_input"),
            (Outcome.SESSION_INACTIVE, "aborted"),
        ]
        for outcome, error in expected:
            await until(lambda: client.accepting_input)
            result = await client.send_frame(JPEG, client.capture())
            self.assertEqual((result.outcome, result.error), (outcome, error))
        await asyncio.sleep(0.1)
        self.assertEqual(
            len(self.bridge.calls("POST", "/transcripts")),
            3,
            "one request per transcript",
        )
        self.assertEqual(
            len(self.bridge.calls("POST", "/frames")), 4, "one request per frame"
        )
        self.assertEqual(self.bridge.session()["obs"], [])

    async def test_network_failures_drop_the_observation_and_fail_closed(self) -> None:
        client = await self.ready()
        self.bridge.forced["transcripts"] = ["drop"]
        result = await client.send_transcript(TEXT, client.capture())
        self.assertEqual(
            (result.outcome, result.status, result.error, result.transmitted),
            (Outcome.UNAVAILABLE, None, "network_error", True),
        )
        self.assertEqual(
            len(self.bridge.calls("POST", "/transcripts")), 1, "not retried"
        )
        context = client.capture()
        await self.bridge.stop()  # the bridge goes away entirely
        await until(lambda: not client.accepting_input)
        self.assertIsNone(client.capture())
        self.assertEqual(
            (await client.send_transcript(TEXT, context)).outcome, Outcome.NOT_ACCEPTING
        )

    # -- Rate limits, back-off and bounded frame uploads ---------------------

    async def test_vision_busy_drops_the_frame_without_backing_off(self) -> None:
        client = await self.ready()
        self.bridge.forced["frames"] = [(429, "vision_busy")]
        busy = await client.send_frame(JPEG, client.capture())
        self.assertEqual(
            (busy.outcome, busy.status, busy.error), (Outcome.BUSY, 429, "vision_busy")
        )
        following = await client.send_frame(JPEG, client.capture())
        self.assertEqual(
            following.outcome,
            Outcome.ACCEPTED,
            "the next sampled frame goes straight out",
        )

    async def test_transient_frame_failures_back_off_exponentially_and_reset_on_success(
        self,
    ) -> None:
        client = await self.ready(
            poll_interval=0.02, max_state_age=10_000.0, max_backoff=3.0
        )
        self.bridge.forced["frames"] = [
            (503, "vision_unavailable"),
            (502, "vision_failed"),
            (504, "vision_timeout"),
        ]

        async def frame() -> Any:
            return await client.send_frame(JPEG, client.capture())

        first = await frame()
        self.assertEqual(
            (first.outcome, first.status, first.error),
            (Outcome.UNAVAILABLE, 503, "vision_unavailable"),
        )
        held = await frame()
        self.assertEqual((held.outcome, held.transmitted), (Outcome.BACKING_OFF, False))
        self.assertEqual(
            len(self.bridge.calls("POST", "/frames")), 1, "no request while backing off"
        )
        self.skew += 1.1  # 1 s back-off elapsed
        self.assertEqual((await frame()).error, "vision_failed")
        self.skew += 1.1  # second failure -> 2 s
        self.assertEqual((await frame()).outcome, Outcome.BACKING_OFF)
        self.skew += 1.0
        self.assertEqual((await frame()).error, "vision_timeout")
        self.skew += 2.9  # third failure -> 4 s, capped at max_backoff = 3 s
        self.assertEqual((await frame()).outcome, Outcome.BACKING_OFF)
        self.skew += 0.2
        self.assertEqual((await frame()).outcome, Outcome.ACCEPTED)
        self.assertEqual(
            (await frame()).outcome, Outcome.ACCEPTED, "success resets the back-off"
        )
        # Transcripts are never held back by frame back-off.
        self.bridge.forced["frames"] = [(503, "vision_unavailable")]
        await frame()
        self.assertEqual(
            (await client.send_transcript(TEXT, client.capture())).outcome,
            Outcome.ACCEPTED,
        )

    async def test_observation_limit_stops_capture_for_that_session(self) -> None:
        client = await self.ready()
        context = client.capture()
        self.bridge.forced["transcripts"] = [(429, "observation_limit_reached")]
        full = await client.send_transcript(TEXT, context)
        self.assertEqual((full.outcome, full.status), (Outcome.LIMIT_REACHED, 429))
        self.assertIsNone(client.capture(), "no new contexts for a full session")
        self.assertEqual(
            (await client.send_transcript(TEXT, context)).outcome, Outcome.LIMIT_REACHED
        )
        self.assertEqual(
            (await client.send_frame(JPEG, context)).outcome, Outcome.LIMIT_REACHED
        )
        self.assertEqual(len(self.bridge.calls("POST", "/transcripts")), 1)
        self.assertEqual(self.bridge.calls("POST", "/frames"), [])

    async def test_at_most_one_frame_upload_is_in_flight(self) -> None:
        client = await self.ready()
        self.bridge.frame_gate = (
            asyncio.Event()
        )  # the bridge holds the first frame "in vision"
        first = asyncio.ensure_future(client.send_frame(JPEG, client.capture()))
        await until(lambda: self.bridge.frames_started == 1)
        for _ in range(5):
            extra = await client.send_frame(JPEG, client.capture())
            self.assertEqual(
                (extra.outcome, extra.error, extra.transmitted),
                (Outcome.BUSY, "frame_in_flight", False),
            )
        burst = await asyncio.gather(
            *(client.send_frame(JPEG, client.capture()) for _ in range(5))
        )
        self.assertEqual({r.outcome for r in burst}, {Outcome.BUSY})
        self.assertEqual(
            self.bridge.frames_started, 1, "extra frames were dropped, not queued"
        )
        # Transcripts are not blocked by a frame upload.
        self.assertEqual(
            (await client.send_transcript(TEXT, client.capture())).outcome,
            Outcome.ACCEPTED,
        )
        self.bridge.frame_gate.set()
        self.assertEqual((await first).outcome, Outcome.ACCEPTED)
        self.assertEqual(
            (await client.send_frame(JPEG, client.capture())).outcome, Outcome.ACCEPTED
        )
        self.assertEqual(self.bridge.frames_started, 2)

    async def test_concurrent_frames_never_overlap(self) -> None:
        client = await self.ready()
        results = await asyncio.gather(
            *(client.send_frame(JPEG, client.capture()) for _ in range(8))
        )
        outcomes = [r.outcome for r in results]
        self.assertEqual(outcomes.count(Outcome.ACCEPTED), 1)
        self.assertEqual(outcomes.count(Outcome.BUSY), 7)
        self.assertEqual(self.bridge.frames_started, 1)

    async def test_a_stalled_frame_upload_times_out_and_frees_the_slot(self) -> None:
        client = await self.ready(frame_timeout=0.2, max_state_age=10_000.0)
        self.bridge.frame_gate = asyncio.Event()
        started = time.monotonic()
        result = await client.send_frame(JPEG, client.capture())
        self.assertEqual(
            (result.outcome, result.error, result.transmitted),
            (Outcome.UNAVAILABLE, "network_error", True),
        )
        self.assertLess(time.monotonic() - started, 2.0, "bounded by the frame timeout")
        self.bridge.frame_gate.set()
        self.bridge.frame_gate = None
        self.skew += 2.0  # past the back-off
        self.assertEqual(
            (await client.send_frame(JPEG, client.capture())).outcome, Outcome.ACCEPTED
        )

    # -- M3: shutdown and cancellation ---------------------------------------

    async def test_close_stops_polling_and_prevents_any_later_send(self) -> None:
        client = await self.ready()
        context = client.capture()
        await client.close()
        self.assertTrue(client.closed)
        self.assertFalse(client.accepting_input)
        self.assertIsNone(client.capture())
        self.assertEqual(owned_tasks(), [])
        self.assertTrue(self.transport_closed(self.transports[-1]))
        seen = len(self.bridge.requests)
        await asyncio.sleep(0.15)
        self.assertEqual(len(self.bridge.requests), seen, "no polling after close")
        for result in (
            await client.send_transcript(TEXT, context),
            await client.send_frame(JPEG, context),
        ):
            self.assertEqual(
                (result.outcome, result.error, result.transmitted),
                (Outcome.CLOSED, "closed_before_send", False),
            )
        self.assertEqual(len(self.bridge.requests), seen)
        self.assertEqual(
            self.bridge.session()["status"], "active", "close never ends the session"
        )

    async def test_sends_not_yet_dispatched_at_shutdown_are_never_transmitted(
        self,
    ) -> None:
        client = await self.ready()
        contexts = [client.capture() for _ in range(3)]
        seen = len(self.bridge.calls("POST", "/transcripts")) + len(
            self.bridge.calls("POST", "/frames")
        )
        # (a) scheduled but not yet started when close() runs
        queued = [
            asyncio.ensure_future(client.send_transcript(TEXT, contexts[0])),
            asyncio.ensure_future(client.send_frame(JPEG, contexts[1])),
        ]
        # (b) started: its inner task exists but has not been handed to the transport yet
        started = asyncio.ensure_future(client.send_transcript(TEXT, contexts[2]))
        await asyncio.sleep(0)
        await client.close()
        for result in await asyncio.gather(*queued, started):
            self.assertEqual(
                (result.outcome, result.error, result.transmitted),
                (Outcome.CLOSED, "closed_before_send", False),
            )
        await asyncio.sleep(0.1)
        after = len(self.bridge.calls("POST", "/transcripts")) + len(
            self.bridge.calls("POST", "/frames")
        )
        self.assertEqual(
            after, seen, "prevented before transmission: the bridge never saw them"
        )
        self.assertEqual(self.bridge.session()["obs"], [])
        self.assertEqual(owned_tasks(), [])

    async def test_close_aborts_an_in_flight_upload_that_the_bridge_has_not_stored(
        self,
    ) -> None:
        client = await self.ready()
        self.bridge.frame_gate = asyncio.Event()  # held before the bridge stores it
        pending = asyncio.ensure_future(client.send_frame(JPEG, client.capture()))
        await until(lambda: self.bridge.frames_started == 1)
        started = time.monotonic()
        await client.close()
        result = await asyncio.wait_for(pending, 1.0)
        self.assertEqual(
            (result.outcome, result.error, result.transmitted),
            (Outcome.CLOSED, "closed_in_flight", True),
        )
        self.assertLess(
            time.monotonic() - started, 1.0, "close does not wait for the bridge"
        )
        self.assertEqual(owned_tasks(), [])
        self.bridge.frame_gate.set()
        await asyncio.sleep(0.15)
        self.assertEqual(
            self.bridge.session()["obs"],
            [],
            "the connection was aborted, so the bridge did not ingest it",
        )

    async def test_close_cannot_undo_an_observation_the_bridge_already_accepted(
        self,
    ) -> None:
        client = await self.ready()
        self.bridge.frame_gate_after = (
            asyncio.Event()
        )  # stored; only the answer is delayed
        pending = asyncio.ensure_future(client.send_frame(JPEG, client.capture()))
        await until(lambda: len(self.bridge.session()["obs"]) == 1)
        await client.close()
        result = await asyncio.wait_for(pending, 1.0)
        # The client reports honestly: closed, but it had been transmitted.
        self.assertEqual(
            (result.outcome, result.error, result.transmitted),
            (Outcome.CLOSED, "closed_in_flight", True),
        )
        self.assertFalse(result.accepted)
        self.assertIsNone(result.observation_id)
        self.bridge.frame_gate_after.set()
        await asyncio.sleep(0.1)
        self.assertEqual(
            len(self.bridge.session()["obs"]),
            1,
            "already accepted by the bridge; cancellation does not remove it",
        )

    async def test_caller_cancellation_propagates_and_releases_the_frame_slot(
        self,
    ) -> None:
        client = await self.ready()
        self.bridge.frame_gate = asyncio.Event()
        pending = asyncio.ensure_future(client.send_frame(JPEG, client.capture()))
        await until(lambda: self.bridge.frames_started == 1)
        pending.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await pending
        self.bridge.frame_gate.set()
        self.bridge.frame_gate = None
        await asyncio.sleep(0.1)
        self.assertEqual(
            self.bridge.session()["obs"], [], "aborted before the bridge stored it"
        )
        self.assertEqual(
            owned_tasks(), ["BridgeClient._poll_loop"], "no send task left behind"
        )
        self.assertEqual(
            (await client.send_frame(JPEG, client.capture())).outcome,
            Outcome.ACCEPTED,
            "the slot was released",
        )
        # Cancelled before the upload task even started:
        early = asyncio.ensure_future(client.send_frame(JPEG, client.capture()))
        early.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await early
        self.assertEqual(
            (await client.send_frame(JPEG, client.capture())).outcome, Outcome.ACCEPTED
        )

    async def test_async_context_manager_closes_the_client(self) -> None:
        async with self.client() as client:
            await client.start(ROOM)
        self.assertTrue(client.closed)
        self.assertEqual(owned_tasks(), [])

    # -- Privacy of logs -----------------------------------------------------

    async def test_logs_contain_no_transcript_text_image_bytes_or_tokens(self) -> None:
        with self.assertLogs("sidekick.bridge", level=logging.DEBUG) as captured:
            client = await self.ready()
            await client.send_transcript(
                TEXT, client.capture(), speaker_ref="verified-speaker-1"
            )
            await client.send_frame(JPEG, client.capture())
            self.bridge.forced["frames"] = [(503, "vision_unavailable")]
            await client.send_frame(JPEG, client.capture())
            self.bridge.forced["transcripts"] = ["drop"]
            await client.send_transcript(TEXT, client.capture())
            self.bridge.discard()
            client._refresh_soon()
            await until(lambda: client.session_id == "session-2")
            await self.consented(client)
            await client.send_transcript(TEXT, client.capture())
            self.bridge.agent_token = "rotated-token-0123456789-abcdefghijklmn"
            await until(lambda: client.auth_failed)
            await client.close()
        text = "\n".join(captured.output)
        for secret in (
            AGENT,
            "Bearer",
            "ZEBRA",
            "left defense",
            "verified-speaker-1",
            "Authorization",
        ):
            self.assertNotIn(secret, text)
        self.assertIn("session-1", text, "metadata such as the session ID is logged")
        self.assertIn("vision_unavailable", text)
        self.assertNotIn(AGENT, repr(client) + repr(client.capture_state))


class StreamTransportTests(_Contract, unittest.IsolatedAsyncioTestCase):
    """Client logic over the test-only stream transport (runs without aiohttp)."""

    def make_transport(self) -> Any:
        return StreamTransport()

    def transport_closed(self, transport: Any) -> bool:
        return transport.closed and transport.active == 0


@unittest.skipUnless(HAVE_AIOHTTP, "aiohttp is not installed in this environment")
class AiohttpTransportTests(_Contract, unittest.IsolatedAsyncioTestCase):
    """The production transport. These are the tests that matter for deployment."""

    def make_transport(self) -> Any:
        return sb._AiohttpTransport()

    def transport_closed(self, transport: Any) -> bool:
        return transport._closed and transport._session is None

    async def test_session_is_configured_without_proxies_redirects_or_cookies(
        self,
    ) -> None:
        client = await self.ready()
        session = self.transports[-1]._session
        self.assertFalse(session.trust_env, "proxies from the environment are ignored")
        self.assertIsInstance(session.cookie_jar, aiohttp.DummyCookieJar)
        self.assertIsNotNone(session.timeout.total)
        await client.close()
        self.assertTrue(session.closed, "the ClientSession is closed deterministically")
        with self.assertRaises(RuntimeError):
            await self.transports[-1].request(
                "GET", self.bridge.url + "/v1/health", {}, None, 1.0
            )

    async def test_default_transport_is_aiohttp(self) -> None:
        client = sb.BridgeClient(self.bridge.url, AGENT)
        self.clients.append(client)
        self.assertIsInstance(client._transport, sb._AiohttpTransport)


class DependencyTests(unittest.TestCase):
    def test_there_is_no_fallback_transport_in_the_module(self) -> None:
        source = _PATH.read_text()
        for forbidden in (
            "urllib.request",
            "run_in_executor",
            "http.client",
            "to_thread",
        ):
            self.assertNotIn(forbidden, source)
        self.assertFalse(hasattr(sb, "_UrllibTransport"))
        self.assertFalse(hasattr(sb, "_default_transport"))

    @unittest.skipIf(HAVE_AIOHTTP, "aiohttp is installed here")
    def test_missing_aiohttp_is_a_clear_dependency_error_not_a_silent_fallback(
        self,
    ) -> None:
        with self.assertRaises(sb.BridgeDependencyError) as raised:
            sb.BridgeClient("http://127.0.0.1:8787", AGENT)
        self.assertIn("aiohttp", str(raised.exception))
        self.assertIsInstance(raised.exception, sb.BridgeConfigError)
        with self.assertRaises(sb.BridgeDependencyError):
            sb.BridgeClient.from_env(
                {
                    "SIDEKICK_BRIDGE_URL": "http://127.0.0.1:8787",
                    "SIDEKICK_AGENT_TOKEN": AGENT,
                }
            )


class HelperTests(unittest.TestCase):
    def test_utc_timestamp_format_and_awareness(self) -> None:
        moment = datetime(
            2026,
            11,
            15,
            15,
            7,
            43,
            897123,
            tzinfo=timezone(timedelta(hours=5, minutes=30)),
        )
        self.assertEqual(sb.utc_timestamp(moment), "2026-11-15T09:37:43.897Z")
        self.assertRegex(
            sb.utc_timestamp(), r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$"
        )
        with self.assertRaises(ValueError):
            sb.utc_timestamp(datetime(2026, 11, 15, 9, 0, 0))

    def test_results_states_and_contexts_are_immutable(self) -> None:
        result = sb.SendResult(Outcome.ACCEPTED, 202, None, "obs-1", True)
        with self.assertRaises(dataclasses.FrozenInstanceError):
            result.status = 500
        with self.assertRaises(dataclasses.FrozenInstanceError):
            sb.CaptureState().generation = 5
        with self.assertRaises(dataclasses.FrozenInstanceError):
            sb.CaptureContext("s", 1, 1, "t").epoch = 2
        self.assertFalse(
            sb.SendResult(Outcome.CLOSED).transmitted, "transmitted defaults to False"
        )


if __name__ == "__main__":
    unittest.main()
