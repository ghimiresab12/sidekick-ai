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
| Node.js | **24 LTS** as the team standard (`.nvmrc`) and the **supported floor** (`"engines": { "node": ">=24" }`, raised from 22 on 2026-11-14) | Reasoning `.mts` modules run via Node's built-in type stripping and are loaded at runtime by the integration tests; `docs/reasoning.md` already required Node 24. A future Docker image should use a `node:24` base. |
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

## 8. Overlay companion UI (`overlay/`)

**Status (2026-11-15):** the overlay consumes the shared contracts in `src/contracts/types.ts` (type-only re-export in `overlay/src/contracts/shared.ts`). **By default it is a client of the Node bridge's browser API** (milestone 4): it is served by the bridge at `/ui/`, pairs with a one-time code and receives `OverlayState` over same-origin SSE; the bridge owns all session state. `vite --mode simulation` instead runs the real `SidekickEngine`, `SidekickCoordinator` and `reason()` with the **deterministic mock provider** inside the page, fed by a synthetic feed (development only; excluded from the default build). Verified against the bridge with mocks only; not connected to Chert, FaceTime, LiveKit, live Gemini or live screen frames. It remains a standalone Vite app with its own `package.json`; the root `tsconfig.json`, `npm test` and CI do not include `overlay/`.

**Toolchain notes:** the overlay type-checks the shared modules with its own TypeScript 5.9.3 (root uses 7.0.2; both compile the shared code today). `allowImportingTsExtensions` (with `noEmit`) lets it import the reasoning `.mts` modules. `src/engine.ts` imports `randomUUID` from `node:crypto`; the overlay maps that single import to Web Crypto (`overlay/src/backend/browserCrypto.ts`) through a Vite alias and a matching `paths` entry. No backend file is modified.

| Package (exact pin) | Scope | Why |
|---|---|---|
| `react`, `react-dom` 18.3.1 | runtime | Component UI; "simple HTML/React as needed" (§2) |
| `vite` 6.4.5, `@vitejs/plugin-react` 5.2.0 | dev | Dev server and static build. Patched 6.4 line chosen; `npm audit` reports 0 vulnerabilities |
| `typescript` 5.9.3, `@types/react` 18.3.31, `@types/react-dom` 18.3.7 | dev | Type-checking for the overlay and the shared contracts it imports |
| `vitest` 4.1.12 | dev | Unit and end-to-end tests (real coordinator), voice logic, privacy boundary |

- **No new dependencies** in this integration. No UI kit, state library, router or network client: the HTTP backend uses the browser's own `fetch` and `EventSource`.
- **Private voice:** browser `speechSynthesis`, **on-device voices only** (`localService === true`); otherwise a labeled text fallback. The overlay and every backend module it bundles contain no WebRTC, media-capture, LiveKit/Chert or Gemini code, and only `overlay/src/backend/httpBackend.ts` may use the network (same-origin bridge only); the rest has no network code (enforced by `overlay/src/privacyBoundary.test.ts`).
- **Still requires live testing (CH-4):** acoustic pickup through speakers, OS-level screen-share audio capture, and user-gesture rules on the target device.
- **Integration seam:** `overlay/src/backend/SidekickBackend.ts`, implemented by `httpBackend.ts` (default, the bridge's browser API in `docs/engineering.md` "Integration milestone 4") and `inProcessBackend.ts` (simulation). `overlay/scripts/bridge-demo.mjs` runs the real bridge with mocked inputs for local end-to-end testing; it uses no extra dependency.

## Decision update — private explanation (confirmed 2026-11-14)

- **Who hears it:** Only the participant who clicked **Explain with voice** on a selected recommendation.
- **Where it plays:** Locally on that participant’s companion device, preferably through headphones. No TTS audio may be published into the FaceTime/LiveKit room or shared Chert call. If speakers are used, acoustic microphone pickup can still leak audio; test and warn.
- **How it works:** The backend returns grounded explanation **text** tied to the selected recommendation ID and event evidence; the local UI handles TTS playback, stop/cancel, and an on-screen text fallback. Browser `speechSynthesis` is a candidate, not a finalized tested dependency.
- **Unchanged:** Continuous group-aware input during an explicitly consented active session; proactive quiet overlay advice; gaming-first hackathon MVP; mandatory event-based end-of-session review.
- **Dami/PITWALL reconciliation:** Adopt the private companion audio concept and modular Chert + Gemini + session-coordinator architecture, but **do not** expand MVP scope to iMessage, an always-on general assistant, a browser extension, or five separate modes.

## Gemini reasoning implementation

The reasoning component uses TypeScript .mts modules with Node 24+ native type stripping and built-in
fetch/node:test. Gemini generateContent REST is isolated behind a provider interface; no runtime SDK
or validation dependency is added. GEMINI_API_KEY is server-only; GEMINI_MODEL must be explicitly set
to a structured-output-capable model in the caller's account. No model version is assumed verified.
Development-only TypeScript 7.0.2 and @types/node 24.19.2 match the published session-engine toolchain
and are isolated in tools/reasoning. These choices apply to this component, not the Chert runtime.

### Imported LiveKit Agent Builder export

The repository contains the exported Python LiveKit agent in `agent/`. Its declared shared runtime is Python 3.13 with `uv`; the existing LiveKit dependencies and source entrypoint are preserved. This is an imported starter, **not evidence that Chert FaceTime, screen-share, transcript, overlay, recommendation, private voice, or review integration works**. Keep the current Chert verification gates unchanged. The export did not include `uv.lock`, so package ranges are not yet pinned to exact versions; generate and commit the lockfile after resolving dependencies in an environment with package-index access.

### Verified Gemini smoke model

The configured gemini-3.5-flash-lite model successfully handled one synthetic normalized-observation
reasoning request using generateContent structured JSON. Model selection remains an explicit server
environment setting, not a hardcoded default. This test does not establish production quality or quotas.

### Integration milestone 1 tooling (2026-11-14)

- `npm run typecheck` now runs two checks: `tsc -p tsconfig.json --noEmit` (engine, coordinator, tests) and `tsc -p tsconfig.reasoning-compat.json`. The second type-checks Prabin's `.mts` reasoning modules together with `tests/integration/reasoning-wiring.mts`, without emitting or modifying them.
- `npm run test:all` runs the compiled engine and integration suite (`npm test`) and then the reasoning suite (`npm run test:reasoning`).
- No new dependencies.

### Gemini vision implementation

`src/adapters/model/gemini-vision.mts` uses built-in Node fetch and inline image
bytes with Gemini generateContent REST. The selected model remains explicit in
the server environment. No image-processing SDK, runtime dependency, Files API,
database, or Chert method is added. Synthetic PNG fixtures use Node zlib.
The `Reasoning and vision` workflow runs Node 24 typechecks, engine/coordinator/
reasoning tests and the offline vision demo without credentials or live API calls.
See [vision.md](vision.md) for the controlled-scene profile and limitations.

### HTTP bridge (milestone 2, 2026-11-15)

- Built only on Node built-ins (`node:http`, `node:crypto`) and the global `fetch` in tests. **No new dependencies.**
- `npm run bridge` builds the project and starts `dist/src/bridge/main.js`, loading `.env` if present (`--env-file-if-exists`). Requires Node 24.
- New server-only environment variables (names in `.env.example`): `SIDEKICK_AGENT_TOKEN`, `SIDEKICK_CONTROL_TOKEN`, `SIDEKICK_BRIDGE_PORT` and `SIDEKICK_REASONING`. None of them may appear in browser or overlay code.
- `tsconfig.reasoning-compat.json` now also type-checks `src/bridge/reasoning-wiring.mts` against Prabin's modules.

### Vision bridge wiring (milestone 3, 2026-11-15)

- `SIDEKICK_VISION` (`none` default, or `gemini`) connects Prabin's existing `src/adapters/model/gemini-vision.mts` to the bridge. It reuses `GEMINI_API_KEY` and `GEMINI_MODEL`, the same model as reasoning.
- **No new dependencies.** `tsconfig.reasoning-compat.json` already type-checks `src/bridge/*.mts`, including the new `vision-wiring.mts`, against the adapter.

### Overlay ↔ bridge API (milestone 4, 2026-11-15)

- Still Node built-ins only: `node:http`, `node:crypto`, `node:fs`, and SSE written by hand. **No new dependencies.**
- New optional server-only variables: `SIDEKICK_UI_DIR` and `SIDEKICK_UI_DEV_ORIGIN`.
- New script: `npm run pair -- --room <room> [--participant <name>]` prints a one-time pairing URL. The control token is never printed.
- Deployment stays **localhost only**.
