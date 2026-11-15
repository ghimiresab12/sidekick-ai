# Sidekick AI

**HackUTA 2026 · Chert — Best Use of FaceTime · Team of 4**  
**Status:** Product decisions agreed; Chert runtime integration and implementation choices pending verification.

> **Sidekick is a context-aware AI teammate for group FaceTime calls.** During an explicitly started, consented session it observes shared-screen activity and conversation context, proactively offers **quiet text advice in an overlay**, privately plays a **selected recommendation’s detailed voice explanation only to the person who presses its button**, and produces an **evidence-based end-of-session review**.

## Product in one sentence

**Observe → Understand → Remember → Recommend quietly → Explain on demand → Review afterward.**

Sidekick is not merely a screen describer, a chatbot waiting for questions, a generic travel planner, or a copy of a game-master template. It relates the group's **previously stated goals and roles** to **new visual observations**, notices changes that matter, and helps without interrupting gameplay.

## Settled experience

1. Participants explicitly start a session and consent to continuous conversation/screen processing while it is active; there is a visible active-state and a **Stop** control.
2. Sidekick receives available FaceTime audio/transcripts and the participant's shared-screen content, and maintains temporary group context. The team has **confirmed the possibility of incoming FaceTime screen sharing with Chert**; its actual API/frame interface still requires a live test.
3. It proposes an activity based on screen and conversation, then **asks for confirmation or correction** (gaming in the hackathon demo).
4. It generates short, proactive **text-only recommendation cards** in an **overlay**. It never speaks merely because it detected an issue; suppress repeated or stale advice.
5. Selecting **Explain with voice** on a specific card plays a detailed explanation **locally on the requester’s device only** (headphones recommended), then returns to quiet output. Never inject this audio into the group FaceTime call.
6. **End session → Review** creates a debrief from recorded events: key moments, strengths, weaknesses, decisions, recommendations, and next actions. Do not invent telemetry or outcomes.

**Continuous input does not mean full-frame-rate AI inference.** Sample or throttle observations as required for performance. Quiet mode controls **output**, not audio capture; participants must be told that the session continuously processes audio.

## Hackathon MVP: gaming

**Demonstration story:** Two or more people and Sidekick join a group FaceTime call. A participant says, “Alex is responsible for left defense.” The group shows a soccer game or controlled field simulation through FaceTime screen sharing. When the visible defender leaves the left zone, Sidekick remembers the assignment and displays: **“Left defense appears exposed. Have Alex drop back or arrange cover.”** A player selects the card and presses **Explain with voice**. Sidekick privately explains the issue on the requesting player’s device; the audio is not injected into the group call. At session end the debrief reflects the actual detected event and recommendation.

Use a **controlled, clearly labeled soccer-field simulation or single well-chosen game scene** if commercial-game tracking is too unreliable. A simulation may simplify the visual scene, but **do not simulate the Chert FaceTime connection or pass prerecorded outputs off as live**.

### Acceptance gate

A real FaceTime session conveys a spoken assignment and actual shared visual context; one recommendation uses **both**; the text card is visible; selected-card private voice explanation plays locally for its requester; session end produces an evidence-backed debrief. The live/fallback boundary must be disclosed clearly.

## Longer-term applications (not hackathon scope)

- **Trip planning:** Remember participants' budgets/interests, interpret shared destinations, flag incompatibilities.
- **Social interaction:** Suggest common-interest topics and activities, respecting user preferences and context.
- **Collaborative work:** Keep track of agreed tasks and screen-visible obstacles.

All of these use the **same session/context/recommendation engine**, not separate independent agents. **Gaming is the only required MVP use case.**

## Project structure

```text
sidekick-ai/
├── README.md                 # Product, demo, setup (this document)
├── CLAUDE.md                 # Short AI-assistant instructions / doc router
├── docs/
│   ├── requirements.md       # Settled product requirements and testable acceptance
│   ├── techstack.md          # Confirmed vs provisional tech decisions
│   ├── engineering.md        # Architecture, contracts, privacy, integration seams
│   ├── phases.md             # Fixed implementation order and exit gates
│   └── design.md             # Overlay, voice action and debrief UI behavior
├── src/                      # Session engine (mock inputs only — see below)
│   ├── contracts/            # Shared types + input validation (no Chert types)
│   ├── sessions/             # In-memory event timeline
│   ├── recommendations/      # Dedup / cooldown / staleness rules
│   ├── engine.ts             # SidekickEngine
│   └── mock/                 # Clearly labeled mock demo scenario
├── tests/                    # node:test unit tests for the engine
└── agent/                    # Imported LiveKit Agent Builder Python starter
    ├── Dockerfile
    ├── pyproject.toml
    └── src/agent.py
```

Chert adapter, model adapter, overlay and review generator are **not implemented yet**. The proposed layout for them in `docs/engineering.md` §2 is not code.

The code in `agent/` is a generic LiveKit starter. It does not establish that Chert integration or the product flows in the requirements are implemented. Do not scaffold a fictional API; verify Chert interfaces against the official starter and a live session.

## Session engine (implemented, mock-only)

`SidekickEngine` holds session memory in memory only:
- participants, roles and corrections;
- goals and decisions;
- conversation and screen observations;
- recommendation dedup, cooldown and staleness;
- voice-request tracking;
- the timestamped event timeline for the review.

It has **no** Chert, Gemini, UI or speech-playback code. All inputs in tests and the demo are **mock data**. Contracts and integration points: [`docs/engineering.md`](./docs/engineering.md) §3.

Requires Node.js 24 or newer (`.nvmrc`).

```bash
npm install          # dev dependencies only (typescript, @types/node)
npm run typecheck    # tsc --noEmit
npm test             # compile + node:test suite
npm run demo         # prints the MOCK scenario's timeline (not a live integration)
npm run test:all     # engine + coordinator integration tests, then the reasoning tests
```

**Coordinator (mock-only).** `SidekickCoordinator` (`src/coordinator/`) connects capture input, the engine and Prabin's reasoning module (`src/reasoning/`). Its in-process tests use only mocks.

Two Gemini pieces are easy to confuse:

| Piece | Status | What it does |
|---|---|---|
| **Gemini reasoning adapter** (`src/adapters/model/gemini.mts`, Prabin) | **Implemented.** Tested against simulated HTTP responses only; no live call yet. | Sends *text* to Gemini (screen summaries, structured facts, transcripts) and returns proposed context updates and recommendation candidates. It never receives images. |
| **Gemini raw-frame vision adapter** | **Missing.** Not implemented by anyone yet. | Would turn a shared-screen **image** into a screen summary plus structured facts. The coordinator only defines the proposed `VisionPort` interface; tests use a mock that decodes a JSON "image".

No HTTP bridge, Python agent integration, live Gemini call or UI exists yet. See `docs/engineering.md` "Integration milestone 1".

## Start here (team and coding assistants)

1. Read [`CLAUDE.md`](./CLAUDE.md), then [`docs/requirements.md`](./docs/requirements.md).
2. Follow [`docs/phases.md`](./docs/phases.md) to work on the **earliest unblocked milestone**.
3. Use [`docs/engineering.md`](./docs/engineering.md) for internal contracts and [`docs/techstack.md`](./docs/techstack.md) before adding a dependency.
4. For the overlay and debrief only, consult [`docs/design.md`](./docs/design.md).
5. Start Chert integration from the sponsor-provided instructions: <https://app.trychert.com/skills.md>. Treat actual starter code and observed behavior—not invented endpoint names—as authoritative for external API details.
6. Put credentials in local ignored environment files, provide an `.env.example` after names are verified, and **never commit real secrets or conversation recordings**.

## Four-person coordination

| Owner | Primary workstream | First proof |
| --- | --- | --- |
| A — Chert integration | Group FaceTime, audio/screen ingestion and call lifecycle | Actual call receives and exposes screen + speech context |
| B — Context/session | Participant roles, activity, event models, session lifecycle | Spoken role persists into later observation |
| C — Reasoning | Vision interpretation, tactical rule, recommendation generation/dedup | Screen change yields one grounded card |
| D — UI/review/integration | Overlay, selected voice-button action, review, demo testing | Private playback and end-of-session debrief work end-to-end |

Agree on the internal event contracts **before parallel work**; designate one integrator. Use short feature branches and frequent merges to a stable shared branch; avoid modifying each other's modules without coordination.

## Scope and authenticity

**Must protect:** Chert FaceTime authenticity, meaningful shared-screen understanding, remembered context, quiet recommendations, private selected voice explanation, and review. **Cut first:** iMessage, browser extension (unless needed as a verified fallback), full dashboard, persistent DB, Docker, advanced CI/CD, additional games/modes, invented statistics.

For a missed/unsupported Chert capability, report the limitation and demonstrate a clearly labeled fallback; never call a browser panel a native FaceTime overlay or claim that an unsupported voice path works.

## Competition references

- Chert track: <https://www.trychert.com/uta>
- Chert integration setup: <https://app.trychert.com/skills.md>
- Team-supplied HackUTA 2026 presentation (general criteria: robustness, creativity, Odyssey theme; published schedule requires verification)

**Do not trust dates in this README without checking the event dashboard.** The team presentation lists Devpost submission at **Saturday 11:59 PM**, a roughly 12-hour hacking period, and a **3-minute presentation + 2-minute Q&A** format. Build a repeatable, truthful three-minute demonstration; submit before the published cutoff.

## Decision update — private explanation (confirmed 2026-11-14)

- **Who hears it:** Only the participant who clicked **Explain with voice** on a selected recommendation.
- **Where it plays:** Locally on that participant’s companion device, preferably through headphones. No TTS audio may be published into the FaceTime/LiveKit room or shared Chert call. If speakers are used, acoustic microphone pickup can still leak audio; test and warn.
- **How it works:** The backend returns grounded explanation **text** tied to the selected recommendation ID and event evidence; the local UI handles TTS playback, stop/cancel, and an on-screen text fallback. Browser `speechSynthesis` is a candidate, not a finalized tested dependency.
- **Unchanged:** Continuous group-aware input during an explicitly consented active session; proactive quiet overlay advice; gaming-first hackathon MVP; mandatory event-based end-of-session review.
- **Dami/PITWALL reconciliation:** Adopt the private companion audio concept and modular Chert + Gemini + session-coordinator architecture, but **do not** expand MVP scope to iMessage, an always-on general assistant, a browser extension, or five separate modes.

## Gemini reasoning feature

For the independent mock reasoning demo, tests, Gemini configuration and session-engine handoff,
see [docs/reasoning.md](docs/reasoning.md). From the repository root with Node 24+:

```powershell
node --test tests/reasoning/*.test.mjs
node examples/reasoning-demo.mjs
```

The default demo is offline and explicitly mocked. No live Chert integration is claimed.

This section covers the **reasoning** adapter, which works on text. It does **not** cover the raw-frame **vision** adapter, which is still missing. Screen summaries must already exist before reasoning can use them; see the table in "Session engine" above.

## Run the LiveKit agent export

The exported Python agent lives in `agent/`. It is a LiveKit starter and does not yet implement Sidekick's Chert, recommendation, overlay, private voice explanation, or event-review integrations. Keep those capabilities labeled as planned until they are implemented and verified against the real interfaces.

### Local setup (macOS, Windows, and Linux)

1. Install Python 3.13 and the `uv` package manager. The project pins Python to 3.13 in `agent/.python-version`.
2. Clone the repository and enter the agent directory:

   ```sh
   git clone https://github.com/ghimiresab12/sidekick-ai.git
   cd sidekick-ai/agent
   ```

3. Copy `.env.example` to `.env.local` (`cp .env.example .env.local` in macOS/Linux or `Copy-Item .env.example .env.local` in PowerShell). Set `LIVEKIT_URL`, `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET` using your own LiveKit project credentials. Keep credentials in LiveKit Cloud Secrets for deployed agents; never paste them into chat or commit local env files. The repository ignores `.env.local`.
4. Install the dependencies and local audio model files:

   ```sh
   uv sync
   uv run python src/agent.py download-files
   ```

5. Run the development agent:

   ```sh
   uv run python src/agent.py dev
   ```

The LiveKit export contains no `uv.lock`; `uv sync` resolves the version ranges in `pyproject.toml`. Check in the generated `uv.lock` after dependency resolution when the team is ready to standardize exact package versions.

### Build and run the shared Docker environment

Run these commands from `agent/` after creating `.env.local`:

```sh
docker build -t sidekick-ai-agent .
docker run --rm --env-file .env.local sidekick-ai-agent
```

Docker uses the same Python 3.13 runtime and installs dependencies with `uv`. The container starts the LiveKit agent in `start` mode. CI runs Python checks on macOS, Windows, and Linux, and builds the image on Linux; CI does not deploy.
