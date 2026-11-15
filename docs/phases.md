# Sidekick AI — Phases and Build Order

**Purpose:** Shared fixed roadmap for four developers and their AI coding assistants. This describes intended work; **no unchecked step is claimed implemented**. Track active owners/tasks in GitHub Issues or a team board instead of rewriting the roadmap after every commit.

**Priority:** Prove real Chert group FaceTime + screen and conversation context **first**; then implement quiet recommendation, selected private local voice explanation, and event review. The overlay and review are part of the agreed MVP but may be simplified visually. Do not build unrelated systems to fill time.

## Phase 0 — Shared contracts and Chert proof (critical path)

- [ ] Agree that `docs/requirements.md` defines product scope, `docs/engineering.md` defines internal contracts, `docs/techstack.md` defines dependencies, `docs/design.md` defines UI, and this file defines order.
- [ ] Inspect Chert's official starter: <https://app.trychert.com/skills.md>. Record actual language, project layout, authentication and SDK methods. Do not invent methods.
- [ ] Establish a **real group FaceTime call** with the agent.
- [ ] Prove **incoming FaceTime screen-share observations** reach the agent as frames/supported media, as separately confirmed possible by the team.
- [ ] Prove speech/transcript access; determine whether participant identity is included.
- [ ] Prove a user gesture can trigger and cancel **private local speech** while the FaceTime call stays active, without injecting speech into shared call audio.
- [ ] On target gaming computer, determine feasible overlay approach; test drawing one static text card over a game or document honest fallback.
- [ ] Record confirmed integration and gaps in `engineering.md`; finalize language/AI model in `techstack.md` only after evidence.
- [ ] Agree normalized `Session`, `Observation`, `Recommendation`, `SessionEvent` contracts and one concrete gaming demo scene.

**Exit gate:** Real FaceTime works, screen + conversation inputs are understood, voice-output trigger and overlay path are characterized. All four members have stable interfaces. If a critical Chert path fails, do not build a pretend native demo: disclose and choose a genuine fallback while continuing to investigate.

## Phase 1 — Context and observation (in parallel after contracts)

- [ ] Implement Chert adapter with only **verified** API interfaces.
- [ ] Implement consent, `starting/active/paused/ended` session lifecycle, and activity suggestion + user confirmation.
- [ ] Normalize speech events and store explicit player roles/goal; allow corrections and unknown speaker ID.
- [ ] Normalize sampled screen observations with timestamps and ephemeral evidence references.
- [ ] Use one model adapter to create structured scene descriptions, then deterministic tactical rules to evaluate **one** testable issue (left defensive coverage).
- [ ] Add pure tests for role correction, wrong-session isolation, stopped sessions and out-of-order frames.

**Exit gate:** A real spoken role persists in session state and a real shared screen produces one reliable structured tactical observation.

## Phase 2 — Quiet, proactive recommendation path

- [ ] Convert tactical state change into a short, actionable text recommendation with evidence links.
- [ ] Add deduplication and staleness checks so repeated frames do not spam the interface.
- [ ] Implement minimal visible **text overlay** on the actual target computer; static local UI acceptable before live wiring.
- [ ] Send recommendations to overlay; keep **all automatic speech disabled**.
- [ ] Add card dismissal and a minimal history if time permits; store creation in session events.

**Exit gate:** Without being asked a second question, a relevant visual change produces **one** accurate text-only recommendation. No unsolicited voice occurs.

## Phase 3 — Selected recommendation voice

- [ ] Attach **Explain with voice** to an individual card's stable recommendation ID.
- [ ] Fetch that card's original evidence, roles and goals; handle stale cards honestly.
- [ ] Generate one concise deeper explanation: observation → significance → action.
- [ ] Return explanation text to requesting participant’s companion UI and play with **private local TTS**; record local playback state.
- [ ] Return to Quiet Mode after speech; avoid overlapping requests and support cancellation when possible.
- [ ] If voice route unavailable, show detailed text as **explicit fallback** and record that the P0 voice requirement is incomplete.

**Exit gate:** Clicking a selected card privately plays the explanation on the requesting participant’s device, without publishing audio to the FaceTime call; no auto-coaching.

## Phase 4 — Event timeline and end review

- [ ] Maintain minimal timestamped events as observations/advice/voice requests occur; do not store raw media by default.
- [ ] Implement **End Session** that stops processing before review.
- [ ] Add **Generate Review** and **Discard**; structured summary includes key moments, observed strengths/weaknesses, advice and next actions.
- [ ] Check summaries do not invent player scores, match results or unobserved resolutions; represent unknowns.
- [ ] Render concise review UI with evidence-linked timeline; avoid a full analytics dashboard.

**Exit gate:** Ended session yields a repeatable truthful report entirely grounded in events; session can be discarded.

## Phase 5 — Integration, robustness, and judge demo

- [ ] Test entire path **Start/consent → spoken assignment → screen event → overlay text → chosen voice → End → Review** at least twice.
- [ ] Test no-screen, bad audio, wrong role, delayed frame, missing speaker label, failed AI, voice unavailable, stop/pause, and no-events review.
- [ ] Verify no secrets, private recordings, or raw identifiable call contents committed to repository.
- [ ] Use controlled soccer simulation if needed; show that **input really comes from live screen sharing**, not a generated test fixture, during judged demo.
- [ ] Prepare a three-minute explanation; distinguish actual live features from simulator/mocks/fallback. Add truthful screenshots and backup recording.
- [ ] Verify event dashboard/submission instructions and submit ahead of Devpost cutoff.

**Exit gate:** Stable live FaceTime demonstration, supported factual claims, runnable setup instructions, and complete judging assets.

## Team ownership (suggested, adjustable)

| Developer | Primary module | Handoff / acceptance |
|---|---|---|
| A | Chert call/audio/video adapter | Live FaceTime and screen/audio event shapes |
| B | Session coordinator + memory | Validated role/goal/event objects available to reasoning |
| C | Visual model + tactical rules + dedup | Grounded observation yields exactly one advice event |
| D | Overlay + voice selection UI + review + demo | Working chosen-card interaction and event review |

**One integrator** coordinates merges and tests the full path. Share interface examples early. Keep `main` demo-stable and use short-lived feature branches; exact branch policy is a team preference, not a product requirement.

## Scope cuts when blocked

1. Cut rich styling, animations, historical analytics, advanced state visualization.
2. Cut iMessage, generic “Engineer Mode,” travel/social MVP, multiple games, long-term memory.
3. Cut full dashboard, browser extension **unless necessary for actual media capture**, Postgres, Docker Compose, elaborate deployment and CI.
4. Keep context + real observed video → **quiet text card** as the core novelty. Pursue selected voice and review via their smallest working interfaces; if a P0 integration is unsupported, label it honestly rather than claiming full completion.

## Schedule warning

The team-supplied HackUTA slides describe a Saturday 12 PM–midnight hacking window, Devpost due **Saturday 11:59 PM**, and Sunday judging with **3 minutes + 2 minutes Q&A**. This is not a newly verified live schedule; check organizer announcements immediately. Use time remaining for the critical path, not a rigid six-hour timeline from Dami's separate PITWALL proposal.

## Outstanding proof register

- [ ] CH-1 — real Chert group call
- [ ] CH-2 — screen-share frames available in agent
- [ ] CH-3 — continuous transcript/audio, speaker attribution behavior
- [ ] CH-4 — click-triggered private local voice, isolated from shared FaceTime
- [ ] CH-5 — actual overlay on target device
- [ ] CH-6 — stop processing and generate review from events

## Decision update — revised product path (2026-11-15)

The requirements update adds camera-context coaching and an opt-in Chert realtime voice conversation, with quiet text coaching as the default. It supersedes the older private-only voice target as the primary voice interaction. Do not skip the live integration proof or implement guessed Chert methods.

**Phase 0 — product and interface reset: complete on this branch** (requirements, engineering boundary, overlay interaction rules and roadmap; commit `b37fabe`).

**Phase 1 — media-source contract: complete on this branch.** Internal frames now carry an explicit `camera` or `screen_share` source through bridge validation, vision interpretation, engine observations, reasoning input and recommendation evidence. The soccer profile remains screen-share-only; camera frames are not sent to Gemini and cannot be used as soccer condition evidence. Focused tests cover these boundaries. No Chert method or event field was assumed.

**Next phase after review: verified Chert wiring.** Inspect starter examples and live session payloads; implement camera frames, shared-screen frames, text/audio input and agent audio output only where actually exposed. Latest `chert doctor --json` check (2026-11-15) reports the assigned line and worker available, resolving the earlier unacknowledged/offline warning. The agent check was skipped, media readiness remains unverified, and `OPENAI_API_KEY` is missing; verify those before attempting a live agent call.

**Then:** add general screen/camera model instructions and text Q&A; implement the opt-in voice control against verified Chert realtime audio; test lifecycle stop/interruption; preserve session review. The existing private card explanation can remain separate if desired. Each phase is reviewed before moving to the next.

Record observed evidence, tested platform, owner, and status in issues or `engineering.md`. Product decisions are settled; **interface support is not**.

## Decision update — private explanation (confirmed 2026-11-14)

- **Who hears it:** Only the participant who clicked **Explain with voice** on a selected recommendation.
- **Where it plays:** Locally on that participant’s companion device, preferably through headphones. No TTS audio may be published into the FaceTime/LiveKit room or shared Chert call. If speakers are used, acoustic microphone pickup can still leak audio; test and warn.
- **How it works:** The backend returns grounded explanation **text** tied to the selected recommendation ID and event evidence; the local UI handles TTS playback, stop/cancel, and an on-screen text fallback. Browser `speechSynthesis` is a candidate, not a finalized tested dependency.
- **Unchanged:** Continuous group-aware input during an explicitly consented active session; proactive quiet overlay advice; gaming-first hackathon MVP; mandatory event-based end-of-session review.
- **Dami/PITWALL reconciliation:** Adopt the private companion audio concept and modular Chert + Gemini + session-coordinator architecture, but **do not** expand MVP scope to iMessage, an always-on general assistant, a browser extension, or five separate modes.

## Reasoning feature verification scope

The Gemini reasoning feature is developed independently with synthetic normalized observations and
mock provider responses. Its offline tests and temporary session-engine compatibility check do not
complete the live Phase 0 gates. See docs/reasoning.md and docs/reasoning-verification.md for commands
and recorded verification; do not treat mock output as live Gemini or Chert proof.

## Integration milestone 1 status (2026-11-14)

- [x] Coordinator connects the engine and the reasoning module **in-process, with mocks only** (`npm run test:all`).
- [x] Authenticated localhost HTTP bridge, implemented and tested locally with mocks (milestone 2, 2026-11-15). Not yet exercised by the real Python agent.
- [ ] Python agent: listen-only mode, transcripts, screen-share frame sampling. Damius must check the APIs against the LiveKit docs and a real Chert call.
- [x] Vision adapter (Prabin), using the existing `VisionPort`; controlled synthetic images tested with real Gemini. Real Chert frames still unverified. See `vision.md`.
- [x] Optional `maxClockSkewMs` implemented in reasoning (0–5000 ms, default 0); coordinator adoption still pending with Sabik.
- **Blocker:** a real Chert call must confirm whether the connection greeting is mandatory and whether screen share reaches the agent (the CH-2 proof).

- [x] Gemini vision wired into the HTTP bridge behind `SIDEKICK_VISION=gemini` (milestone 3, 2026-11-15). Tested with mocked Gemini HTTP only; no live call, Chert frames or Python agent yet.
- [x] Overlay ↔ bridge browser API: pairing, session-scoped cookies, live state stream, participants, activity confirmation, dismiss, explanations, voice ownership, timeline, same-origin UI serving (milestone 4, 2026-11-15). Mock-tested; the overlay's HTTP backend (Tunji) is now done and is the overlay default (see engineering.md "Overlay adoption status"), also mock-tested only. Review fixes M1–M5 applied (idle refresh on heartbeats, operator-only resume, participant limit and duplicate names, `GET /v1/ui/session` reload recovery, browser privacy projection).
- [x] Overlay HTTP backend: pairing bootstrap, cookie recovery, SSE state, participants, Confirm gaming, operator-only consent/resume, dismiss, private explanations, voice reports, review from the browser timeline (2026-11-15). Tested against the real bridge runtime with mock reasoning, mocked Gemini vision HTTP and synthetic input in headless Chrome; not with Chert, the Python agent or live Gemini. Overlay CI job added (`.github/workflows/overlay.yml`).
