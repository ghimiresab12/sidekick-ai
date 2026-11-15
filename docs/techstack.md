# Sidekick AI — Technology Stack and Open Decisions

**Status:** Provisional implementation stack; do not present untested technologies as confirmed integrations.  
**Rule:** Prefer the working Chert starter's language and APIs. The team agreed on product behavior, not every technical component.

## 1. Confirmed product/platform choices

| Area | Decision | Status |
|---|---|---|
| Sponsor / agent channel | **Chert-powered group FaceTime** | Chosen; run live test |
| Screen input | Participant FaceTime screen share | Team confirmed capability; event/frame API unverified |
| Conversation input | Continuous speech processing during active, consented session | Product confirmed; transcript/event availability unverified |
| Recommendation output | Quiet proactive text in an overlay | Product confirmed; implementation mechanism open |
| Voice output | Click selected card → private speech locally on requester’s device | Product confirmed; local TTS permissions, cancellation, and isolation require testing |
| Review | In-memory events → event-based debrief | Product confirmed; model adapter details TBD |
| Demo domain | Gaming | Confirmed |

## 2. Recommended implementation selections (provisional)

| Layer | Candidate | Why | Commit when... |
|---|---|---|---|
| Main language | **TypeScript + Node.js**, if compatible with Chert starter | Shared schemas/types across agent, logic and UI | Starter inspected |
| Chert integration | Official Chert agent runtime/SDK | FaceTime lifecycle and incoming media | Actual examples run |
| Multimodal model | **Gemini** behind a model-neutral adapter | Screen+conversation reasoning; Dami's candidate | Credentials, latency and image input tested |
| Session state | In-memory Map keyed by session ID | Minimal setup, enough for a live demo | **Implemented** (`SidekickEngine`, mock inputs only) |
| Validation | Hand-written guards in `src/contracts/validate.ts` for now; Zod or the starter's schema library later if needed | Validate context/events/AI output | Avoid duplicate dependency; revisit once starter is inspected |
| Text UI | Minimal local overlay / companion panel | Fast advice display and button interaction | Desktop platform and overlay feasibility tested |
| UI tools | Existing starter web stack; simple HTML/React as needed | Minimal dependencies | Chert/output constraints known |
| Tests | `node:test` (built in) on `tsc`-compiled output; adopt the starter's runner if it has one | Test rule engine, dedup and debrief; no test dependency | **In use** for the session engine (`npm test`) |
| Hosting | Local running server/tunnel or host only as required by Chert | Keep real call integration reliable | Callback connectivity verified |
| Logging | Minimal structured debug/event logs | See pipeline without retaining raw media | Privacy requirements met |

**AI coding assistants (Claude Code, Codex, Cursor) are development tools, not the in-app inference provider.** Gemini is a **proposed** runtime choice, not proof of integration.

### 2.1 Node.js and TypeScript toolchain (session engine, 2026-11-14)

| Item | Choice | Notes |
|---|---|---|
| Node.js | **24 LTS** as the team standard (`.nvmrc`). Supported floor is **22** (`"engines": { "node": ">=22" }`) | Tests verified on Node 22.23, 24.22 and 26.13. A future Docker image should use a `node:24` base, which no file pins yet. |
| TypeScript | `typescript@7.0.2` (dev dependency, exact pin) | `strict`, `NodeNext` modules, ES2022 target. Compiled with `tsc` to `dist/`, so we don't rely on any Node version's built-in type stripping. |
| Node types | `@types/node@24.19.2` (dev dependency, exact pin) | Matches the Node 24 standard. |
| Runtime dependencies | **None** | The engine uses only `node:crypto` (`randomUUID`) and built-in `structuredClone`. |
| Scripts | `npm run typecheck`, `npm test` (build + `node --test`), `npm run demo` (mock scenario) | `dist/` is git-ignored. |

If the Chert starter turns out to use a different runtime, keep `src/contracts/` as the schema reference and call the engine across a local process boundary rather than rewriting it.

## 3. Architecture boundary

```text
Active group FaceTime call + user-approved screen share
                        |
                 Official Chert adapter
                 /                 \
       speech/transcript       sampled screen frames
                 \                 /
                 Session Coordinator
            participant roles, goals, modes
                        |
          AI vision/context + deterministic rules
                        |
            Recommendation/event manager
                      /   |   \
               text overlay |  session debrief
                       selected-card button
                             |
                 Private local speech adapter
```

All provider-specific code stays behind adapters. Chert events become project-owned normalized observation objects; no business logic should depend on unverified SDK payloads.

## 4. Explicitly deferred decisions

- **Frame format, cadence and processing:** actual Chert stream API, acceptable sampling rate, compression and measured latency.
- **Speaker diarization:** whether Chert exposes speaker IDs; explicit verbal identification if not.
- **Overlay implementation:** true desktop always-on-top overlay vs browser companion window; video-card output is **not** assumed equivalent to an over-game overlay.
- **Private voice playback:** local TTS implementation (browser speech synthesis is simplest), user-gesture/autoplay policy, cancellation, and verification that audio is neither sent to a shared call track nor acoustically picked up by a microphone. No Chert in-call speech API needed for MVP.
- **Network setup:** local versus hosted process, Chert callback URL, any tunneling and firewall requirements.
- **Model choice:** Gemini model/version, multimodal request limits, performance and API billing.

Record experiments and verification in `engineering.md`; do not assert undocumented API routes.

## 5. Do not add for MVP without a demonstrated need

Postgres, MongoDB, Firebase, Prisma, Docker Compose, complex CI/CD, Chrome extension, full Next.js dashboard, custom computer vision model training, multiple provider SDKs, cloud account workflows, iMessage integration or a second activity mode.

A permissioned Chrome extension remains **a contingency only** if the verified Chert screen-share pathway cannot deliver usable input. If considered, it requires an explicit screen/tab picker, capture indicator, Stop and a session pairing mechanism; it is not a native FaceTime screen-share implementation.

## 6. Secrets and environment

- Store model/Chert credentials only in server/agent environment; never in browser JavaScript or client-shipped config.
- Commit `.env.example` with **verified variable names** only after reading real starter documentation.
- Do not commit `.env`, tokens, raw frames, transcripts or private user session data.
- Document the command that actually launches the Chert agent **after** successfully running it; avoid fictitious commands in the README.

## 7. Source references

- Sponsor: <https://www.trychert.com/uta>
- Starter instructions: <https://app.trychert.com/skills.md>
- Dami's *PITWALL AI — Technical Architecture & Hackathon Execution Plan*: useful session coordinator, modular ownership and go/no-go testing; **its extension, iMessage, Next.js dashboard, persistence and DevOps layers are not Sidekick MVP commitments.**

## Decision update — private explanation (confirmed 2026-11-14)

- **Who hears it:** Only the participant who clicked **Explain with voice** on a selected recommendation.
- **Where it plays:** Locally on that participant’s companion device, preferably through headphones. No TTS audio may be published into the FaceTime/LiveKit room or shared Chert call. If speakers are used, acoustic microphone pickup can still leak audio; test and warn.
- **How it works:** The backend returns grounded explanation **text** tied to the selected recommendation ID and event evidence; the local UI handles TTS playback, stop/cancel, and an on-screen text fallback. Browser `speechSynthesis` is a candidate, not a finalized tested dependency.
- **Unchanged:** Continuous group-aware input during an explicitly consented active session; proactive quiet overlay advice; gaming-first hackathon MVP; mandatory event-based end-of-session review.
- **Dami/PITWALL reconciliation:** Adopt the private companion audio concept and modular Chert + Gemini + session-coordinator architecture, but **do not** expand MVP scope to iMessage, an always-on general assistant, a browser extension, or five separate modes.
