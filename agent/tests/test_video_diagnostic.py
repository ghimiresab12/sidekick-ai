"""Offline tests for the metadata-only video-track diagnostic. Fake SDK objects only."""

from __future__ import annotations

import asyncio
import importlib.util
import json
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

_SRC = Path(__file__).parents[1] / "src"
for _name in ("sidekick_bridge", "video_diagnostic"):
    if _name not in sys.modules:
        _spec = importlib.util.spec_from_file_location(_name, _SRC / f"{_name}.py")
        assert _spec and _spec.loader
        _module = importlib.util.module_from_spec(_spec)
        sys.modules[_name] = _module
        _spec.loader.exec_module(_module)

import video_diagnostic  # noqa: E402
from sidekick_bridge import CaptureState  # noqa: E402
from video_diagnostic import (  # noqa: E402
    VideoTrackDiagnostic,
    video_diagnostic_enabled,
)

AUDIO, VIDEO = 1, 2
CAMERA, MICROPHONE, SCREEN = 1, 2, 3


class FakeBridge:
    """Only the read-only surface the diagnostic may use; anything else raises."""

    def __init__(self) -> None:
        self.auth_failed = False
        self.accepting_input = False
        self.capture_state = CaptureState(
            session_id="session-a", status="starting", generation=1
        )

    def consent(self, active: bool = True) -> None:
        self.accepting_input = active
        self.capture_state = CaptureState(
            session_id="session-a",
            status="active" if active else "paused",
            accepting_input=active,
            generation=1,
            consent_given=True,
        )


class FakePublication:
    def __init__(self, sid, name, kind, source, width=0, height=0, room=None):
        self.sid, self.name, self.kind, self.source = sid, name, kind, source
        self.width, self.height = width, height
        self.mime_type = "video/h264" if kind == VIDEO else "audio/opus"
        self.simulcasted = False
        self.muted = False
        self.subscribed = False
        self.requests: list[bool] = []
        self._room = room

    def set_subscribed(self, subscribed: bool) -> None:
        self.requests.append(subscribed)
        self.subscribed = subscribed


class PoisonTrack:
    """A track object on which any attribute access fails the test."""

    def __getattr__(self, name):
        raise AssertionError(f"diagnostic touched track.{name}")


class FakeRoom:
    def __init__(self) -> None:
        self.remote_participants: dict[str, SimpleNamespace] = {}
        self.handlers: dict[str, list] = {}

    def on(self, event, callback):
        self.handlers.setdefault(event, []).append(callback)

    def off(self, event, callback):
        self.handlers[event].remove(callback)

    def emit(self, event, *args):
        for callback in list(self.handlers.get(event, [])):
            callback(*args)

    def add(self, identity, *publications, kind=6):
        participant = SimpleNamespace(
            identity=identity,
            kind=kind,
            name="Private Display Name",
            attributes={"phone": "+1 817 555 0100"},
            track_publications={p.sid: p for p in publications},
        )
        self.remote_participants[identity] = participant
        return participant


def camera(sid="TR_cam", **kw):
    return FakePublication(sid, "facetime-remote-video", VIDEO, CAMERA, **kw)


def microphone(sid="TR_mic"):
    return FakePublication(sid, "facetime-remote-audio", AUDIO, MICROPHONE)


class VideoDiagnosticTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.bridge = FakeBridge()
        self.room = FakeRoom()
        self.records: list[dict] = []
        self.diagnostic = VideoTrackDiagnostic(
            self.bridge, self.room, poll_interval=0.01, emit=self.records.append
        )
        self.addAsyncCleanup(self.diagnostic.close)

    def events(self, name):
        return [r for r in self.records if r["event"] == name]

    async def tick(self):
        await asyncio.sleep(0.05)

    def test_flag_is_off_unless_explicitly_enabled(self):
        self.assertFalse(video_diagnostic_enabled({}))
        for value in ("", "0", "false", "off", "no", "placeholder"):
            self.assertFalse(
                video_diagnostic_enabled({video_diagnostic.ENV_FLAG: value})
            )
        for value in ("1", "true", "ON", " yes "):
            self.assertTrue(
                video_diagnostic_enabled({video_diagnostic.ENV_FLAG: value})
            )

    async def test_reports_existing_publication_metadata_without_subscribing(self):
        video = camera(width=1280, height=720)
        audio = microphone()
        self.room.add("bridge-001", video, audio)
        self.diagnostic.start()
        await self.tick()
        existing = self.events("existing_publication")
        self.assertEqual(len(existing), 2)
        record = next(r for r in existing if r["kind"] == "video")
        # Publisher-chosen text is withheld before consent; structure is reported.
        self.assertNotIn("participant", record)
        self.assertNotIn("track_name", record)
        self.assertEqual(record["track_name_class"], "chert_remote_video")
        self.assertEqual(len(record["participant_ref"]), 10)
        self.assertEqual(record["participant_kind"], "bridge")
        self.assertEqual(record["track_sid"], "TR_cam")
        self.assertEqual(record["source"], "camera")
        self.assertEqual((record["width"], record["height"]), (1280, 720))
        self.assertFalse(record["subscribed"])
        self.assertFalse(record["consent"])
        # No consent: nothing was subscribed, and audio is never managed here.
        self.assertEqual(video.requests, [])
        self.assertEqual(audio.requests, [])

    async def test_unannounced_dimensions_are_reported_as_null(self):
        self.room.add("bridge-001", camera())
        self.diagnostic.start()
        record = self.events("existing_publication")[0]
        self.assertIsNone(record["width"])
        self.assertIsNone(record["height"])

    async def test_subscribes_to_video_only_after_consent_and_drops_on_pause(self):
        video, audio = camera(), microphone()
        self.room.add("bridge-001", video, audio)
        self.diagnostic.start()
        await self.tick()
        self.assertEqual(video.requests, [])

        self.bridge.consent(True)
        await self.tick()
        self.assertEqual(video.requests, [True])
        self.assertEqual(audio.requests, [])
        self.assertEqual(self.events("consent_gate")[-1]["consent"], True)

        self.bridge.consent(False)
        await self.tick()
        self.assertEqual(video.requests, [True, False])
        self.assertEqual(
            self.events("unsubscribe_requested")[-1]["reason"], "consent_inactive"
        )
        self.assertEqual(audio.requests, [])

    async def test_stale_or_failed_bridge_state_closes_the_gate(self):
        video = camera()
        self.room.add("bridge-001", video)
        self.bridge.consent(True)
        self.diagnostic.start()
        self.assertEqual(video.requests, [True])
        # BridgeClient.accepting_input turns False when its polled state is stale.
        self.bridge.accepting_input = False
        await self.tick()
        self.assertEqual(video.requests, [True, False])

        self.bridge.consent(True)
        await self.tick()
        self.assertEqual(video.requests, [True, False, True])
        self.bridge.auth_failed = True
        await self.tick()
        self.assertEqual(video.requests, [True, False, True, False])

    async def test_publication_events_and_screen_share_source(self):
        participant = self.room.add("bridge-001")
        self.diagnostic.start()
        screen = FakePublication("TR_scr", "screen", VIDEO, SCREEN, 1920, 1080)
        participant.track_publications[screen.sid] = screen
        self.room.emit("track_published", screen, participant)
        published = self.events("track_published")[0]
        self.assertEqual(published["source"], "screen_share")
        self.assertEqual((published["width"], published["height"]), (1920, 1080))
        self.assertEqual(screen.requests, [])  # published before consent

        self.bridge.consent(True)
        later = camera("TR_late")
        participant.track_publications[later.sid] = later
        self.room.emit("track_published", later, participant)
        self.assertEqual(later.requests, [True])
        self.assertEqual(screen.requests, [True])

        track = PoisonTrack()
        self.room.emit("track_subscribed", track, screen, participant)
        self.room.emit("track_muted", participant, screen)
        self.room.emit("track_unmuted", participant, screen)
        self.room.emit("track_unsubscribed", track, screen, participant)
        self.room.emit("track_unpublished", screen, participant)
        self.room.emit(
            "track_subscription_failed", participant, "TR_scr", "secret detail"
        )
        for name in (
            "track_subscribed",
            "track_muted",
            "track_unmuted",
            "track_unsubscribed",
            "track_unpublished",
            "track_subscription_failed",
        ):
            self.assertEqual(len(self.events(name)), 1, name)
        self.assertNotIn("secret detail", json.dumps(self.records))

    async def test_video_subscribed_without_consent_is_dropped_immediately(self):
        video = camera()
        participant = self.room.add("bridge-001", video)
        self.diagnostic.start()
        video.subscribed = True  # e.g. another component or an SDK default
        self.room.emit("track_subscribed", PoisonTrack(), video, participant)
        self.assertEqual(video.requests, [False])
        self.assertEqual(
            self.events("unsubscribe_requested")[0]["reason"],
            "subscribed_without_consent",
        )

    async def test_sensitive_text_never_appears_in_any_consent_state(self):
        secrets = (
            "+1 (817) 555-0100",
            "sam@example.com",
            "jordan-smith",
            "Jordan iPhone camera",
            "video for jane.doe@example.com",
            "Private Display Name",
            "secret sdk detail",
        )
        first = FakePublication("TR_cam", secrets[3], VIDEO, CAMERA)
        second = FakePublication("TR_two", secrets[4], VIDEO, SCREEN)
        odd = FakePublication("jordan-smith-sid", "", VIDEO, CAMERA)
        odd.mime_type = "video/h264; owner=jordan-smith"
        caller = self.room.add(secrets[0], first, kind=3)
        other = self.room.add("caller:" + secrets[1], second, kind=0)
        named = self.room.add(secrets[2], odd, kind=0)

        def exercise():
            for participant, publication in (
                (caller, first),
                (other, second),
                (named, odd),
            ):
                self.room.emit("track_published", publication, participant)
                self.room.emit(
                    "track_subscribed", PoisonTrack(), publication, participant
                )
                self.room.emit("track_muted", participant, publication)
                self.room.emit("track_unmuted", participant, publication)
                self.room.emit(
                    "track_unsubscribed", PoisonTrack(), publication, participant
                )
                self.room.emit(
                    "track_subscription_failed", participant, secrets[2], secrets[6]
                )
                self.room.emit("track_unpublished", publication, participant)

        self.diagnostic.start()  # before consent
        exercise()
        self.bridge.consent(True)  # consent active
        await self.tick()
        exercise()
        self.bridge.consent(False)  # consent ended
        exercise()
        await self.tick()
        await self.diagnostic.close()

        dumped = json.dumps(self.records).lower()
        fragments = ("817", "555", "0100", "jane", "sam@", "example.com")
        fragments += ("jordan", "iphone", "private", "secret", "caller:")
        for fragment in fragments:
            self.assertNotIn(fragment, dumped, fragment)
        allowed = {
            "event", "participant_ref", "participant_kind", "track_sid",
            "track_name_class", "kind", "source", "width", "height", "mime_type",
            "simulcasted", "muted", "subscribed", "consent", "reason", "error",
        }  # fmt: skip
        for record in self.records:
            self.assertLessEqual(set(record), allowed, record)
        reports = [r for r in self.records if "track_name_class" in r]
        self.assertEqual({r["track_name_class"] for r in reports}, {"other", "empty"})
        # Values that are not server-shaped are dropped, not sanitized.
        odd_reports = [r for r in reports if r["track_name_class"] == "empty"]
        self.assertTrue(odd_reports)
        for record in odd_reports:
            self.assertIsNone(record["track_sid"])
            self.assertIsNone(record["mime_type"])
        self.assertTrue(all(len(r["participant_ref"]) == 10 for r in reports))
        self.assertEqual(len({r["participant_ref"] for r in reports}), 3)
        self.assertEqual({r["participant_kind"] for r in reports}, {"sip", "standard"})

    async def test_log_line_carries_only_the_sanitized_record(self):
        diagnostic = VideoTrackDiagnostic(self.bridge, self.room, poll_interval=0.01)
        self.addAsyncCleanup(diagnostic.close)
        self.room.add("jordan-smith", FakePublication("TR_a", "Jordan cam", VIDEO, 1))
        self.bridge.consent(True)
        with self.assertLogs("sidekick.video_diagnostic", level="INFO") as captured:
            diagnostic.start()
        output = "\n".join(captured.output)
        self.assertIn("video_track_diagnostic {", output)
        self.assertNotIn("jordan", output.lower())

    async def test_participant_reference_is_salted_per_instance(self):
        other_records: list[dict] = []
        other = VideoTrackDiagnostic(
            self.bridge, self.room, poll_interval=0.01, emit=other_records.append
        )
        self.addAsyncCleanup(other.close)
        self.room.add("+18175550100", camera())
        self.diagnostic.start()
        other.start()
        first = self.events("existing_publication")[0]["participant_ref"]
        second = next(r for r in other_records if r["event"] == "existing_publication")[
            "participant_ref"
        ]
        self.assertNotEqual(first, second)
        unsalted = __import__("hashlib").sha256(b"+18175550100").hexdigest()[:10]
        self.assertNotIn(unsalted, (first, second))

    async def test_resume_resubscribes_and_watcher_failure_fails_closed(self):
        video = camera()
        self.room.add("bridge-001", video)
        self.bridge.consent(True)
        self.diagnostic.start()
        self.bridge.consent(False)
        await self.tick()
        self.bridge.consent(True)
        await self.tick()
        self.assertEqual(video.requests, [True, False, True])

        def boom():
            raise RuntimeError("unexpected")

        self.diagnostic._reconcile = boom
        await self.tick()
        self.assertEqual(video.requests, [True, False, True, False])
        self.assertEqual(
            self.events("unsubscribe_requested")[-1]["reason"], "watcher_failed"
        )

    async def test_close_detaches_unsubscribes_and_goes_quiet(self):
        video = camera()
        participant = self.room.add("bridge-001", video)
        self.bridge.consent(True)
        self.diagnostic.start()
        self.assertEqual(video.requests, [True])
        await self.diagnostic.close()
        await self.diagnostic.close()
        self.assertEqual(video.requests, [True, False])
        self.assertTrue(all(not h for h in self.room.handlers.values()))
        count = len(self.records)
        self.room.emit("track_published", camera("TR_new"), participant)
        await self.tick()
        self.assertEqual(len(self.records), count)
        self.assertEqual(video.requests, [True, False])

    async def test_handler_and_sdk_errors_never_escape(self):
        class Broken(FakePublication):
            def set_subscribed(self, subscribed):
                raise RuntimeError("ffi unavailable: token=abc")

        video = Broken("TR_cam", "v", VIDEO, CAMERA)
        participant = self.room.add("bridge-001", video)
        self.bridge.consent(True)
        self.diagnostic.start()
        failed = self.events("subscribe_request_failed")[0]
        self.assertEqual(failed["error"], "RuntimeError")
        self.assertNotIn("token", json.dumps(self.records))
        self.room.emit("track_published", object(), None)  # malformed SDK payload
        self.room.emit("track_muted", participant)  # wrong arity

    def test_module_has_no_frame_or_network_surface(self):
        source = (_SRC / "video_diagnostic.py").read_text(encoding="utf-8")
        code = "\n".join(
            line for line in source.split('"""')[2].splitlines() if "#" not in line
        )
        for forbidden in (
            "VideoStream",
            "VideoFrame",
            "send_frame",
            "send_transcript",
            ".capture(",
            "aiohttp",
            "import livekit",
            "from livekit",
            "open(",
        ):
            self.assertNotIn(forbidden, code, forbidden)

    def test_sdk_audio_only_connect_contract(self):
        """The SDK behavior the entrypoint hook relies on (livekit-agents 1.8.x)."""
        try:
            import inspect

            from livekit import rtc
            from livekit.agents import AutoSubscribe, JobContext
            from livekit.agents import job as sdk_job
        except ImportError:
            self.skipTest("livekit SDK not installed")
        parameters = inspect.signature(JobContext.connect).parameters
        # Without the hook the SDK subscribes to every track, video included.
        self.assertIs(parameters["auto_subscribe"].default, AutoSubscribe.SUBSCRIBE_ALL)
        helper = getattr(sdk_job, "_apply_auto_subscribe_opts", None)
        if helper is None:
            self.skipTest("private SDK helper moved; re-verify audio-only behavior")
        handlers = {}
        audio = FakePublication("TR_a", "a", rtc.TrackKind.KIND_AUDIO, MICROPHONE)
        video = camera()
        room = SimpleNamespace(
            remote_participants={
                "p": SimpleNamespace(track_publications={"a": audio, "v": video})
            },
            on=lambda event: lambda callback: handlers.setdefault(event, callback),
        )
        helper(room, AutoSubscribe.AUDIO_ONLY)
        late_audio = FakePublication("TR_b", "b", rtc.TrackKind.KIND_AUDIO, MICROPHONE)
        late_video = camera("TR_late")
        handlers["track_published"](late_audio, None)
        handlers["track_published"](late_video, None)
        # Audio keeps being subscribed for STT; video is left for the consent gate.
        self.assertEqual((audio.requests, late_audio.requests), ([True], [True]))
        self.assertEqual((video.requests, late_video.requests), ([], []))

    def test_enum_tables_match_the_installed_sdk(self):
        try:
            from livekit import rtc
        except ImportError:
            self.skipTest("livekit SDK not installed")
        self.assertEqual(rtc.TrackKind.KIND_VIDEO, video_diagnostic.KIND_VIDEO)
        for table, enum, prefix in (
            (video_diagnostic._KINDS, rtc.TrackKind, "KIND_"),
            (video_diagnostic._SOURCES, rtc.TrackSource, "SOURCE_"),
            (
                video_diagnostic._PARTICIPANT_KINDS,
                rtc.ParticipantKind,
                "PARTICIPANT_KIND_",
            ),
        ):
            expected = {
                value: name.removeprefix(prefix)
                .lower()
                .replace("screenshare", "screen_share")
                for name, value in enum.items()
            }
            self.assertEqual(table, expected)


if __name__ == "__main__":
    unittest.main()
