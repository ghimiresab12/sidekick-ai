# Sidekick overlay: companion UI, private voice, session review

> **Status: a client of the local Sidekick bridge, tested with mocks only.** By default the overlay is served
> by the Node bridge at `/ui/`, pairs with a one-time code and shows the bridge's live session state. The
> bridge owns the engine, coordinator and all session state; the overlay keeps none of its own. It has been
> tested end to end against the real bridge runtime with **mock reasoning, mocked Gemini vision HTTP and
> synthetic agent input**, not with Chert, the Python agent or live Gemini. It is a **companion browser
> panel**, not a native FaceTime overlay.

Owner: UI / voice / review workstream (D). Contract: `docs/engineering.md` "Integration milestone 4"
(browser API, pairing, live state stream) and "Overlay adoption status".

## Run it

Requires Node 24 (root `.nvmrc`). The overlay imports shared types and modules from `../src`, so both package
sets must be installed:

```bash
npm ci                                  # repository root
npm ci --prefix overlay
npm --prefix overlay test               # Vitest: HTTP adapter, simulation end to end, voice, privacy boundary
npm --prefix overlay run typecheck      # fails if src/contracts/types.ts drifts from what the overlay uses
npm --prefix overlay run build          # typecheck + production build into overlay/dist (git-ignored)
```

### With the bridge (default)

**Local demo, no credentials needed.** `scripts/bridge-demo.mjs` starts the real bridge (root `dist/`) serving
`overlay/dist`, and plays the operator and the agent with random per-run tokens (never printed). Reasoning is
the deterministic mock provider; Gemini vision runs with its HTTP mocked; inputs are synthetic.

```bash
npm run build && npm --prefix overlay run build
node overlay/scripts/bridge-demo.mjs          # prints a one-time pairing URL; type commands below
```

1. Open the printed `http://127.0.0.1:8787/ui/#pair=…` URL within 2 minutes. The code is removed from the
   address bar; a reload recovers the session from the HttpOnly cookie.
2. The overlay shows **Waiting for the operator** (no consent button). Add a participant if you like.
3. Type `consent` (the operator attests that everyone agreed). The overlay switches to **Observing**. Consent
   does not confirm the activity: **Confirm gaming** stays on screen until you press it (or type `gaming`).
   It can also be confirmed before consent; no advice appears until it is.
4. Type `role`, then `frame`. **Left defense appears exposed** appears silently with Alex's role and evidence.
5. **Explain with voice** speaks the bridge's explanation on this device only. Try **Stop voice**.
6. **Pause** in the overlay: speech stops and the card becomes earlier advice. There is no Resume button;
   type `resume` (operator). Type `frame` again for fresh evidence.
7. Type `drop` to cut every connection: the overlay shows **Reconnecting**, disables actions, and recovers.
   If an explanation was playing, it stops, the bridge records it as failed, and a new explanation works as
   soon as the overlay is reconnected.
8. **End session**, **Generate review**, then **Discard session**. Afterwards the overlay asks for a new pairing
   link.

**With a real bridge:** `npm run bridge` (needs `SIDEKICK_AGENT_TOKEN` and `SIDEKICK_CONTROL_TOKEN`, see
`.env.example`), then `npm run pair -- --room <room> [--participant <name>]`. Restart the bridge after every
overlay build (it snapshots `overlay/dist` at startup). For the Vite dev server, start the bridge with
`SIDEKICK_UI_DEV_ORIGIN=http://localhost:5173`, run `npm --prefix overlay run dev`, and open
`http://localhost:5173/ui/#pair=<code>`; `/v1` is proxied to the bridge.

### Offline simulation (development only)

```bash
npm --prefix overlay run dev:simulation       # http://localhost:5173/ui/
```

Runs the **real** engine, coordinator and reasoning (mock provider) **inside the page**, fed by a two-step
synthetic feed (Demo controls → **Send next synthetic observation**). It uses the same browser projection,
explanation text and recommendation-resolution rule (`controlledSoccerResolution`) as the bridge runtime. It is selected only by `--mode simulation`; the default build does not
contain it. Tick **Simulate speech synthesis unavailable** to see the text fallback.

## What is real, mocked or missing

| Capability | Status |
|---|---|
| Session state | **Bridge-owned**, streamed as projected `OverlayState` over same-origin SSE; versions that don't increase are dropped |
| Pairing and auth | One-time code → HttpOnly cookie for one session; `401` → "ask the operator for a new pairing link". No token in the browser |
| Consent | **Operator-only** (all participants agreed). The overlay waits and offers no consent button |
| Lifecycle | Pause, End, Discard from the overlay. **Resume is operator-only** |
| Participants and activity | Register names (normalized by the bridge), **Confirm gaming** |
| Recommendations, staleness, evidence, player context | **Real engine** via the bridge; safe role labels only |
| Explanation text | **Server-side** (`src/explanations/explanation-text.ts`), returned only to the requesting device |
| Voice requests | Engine lifecycle by request id; owned by this device; refused reports stop speech |
| Local speech | Browser `speechSynthesis`, on-device voices only |
| Session review | Rule-based summary of the **browser timeline** (no goal or decision wording). No backend review service exists |
| Reconnection | Browser retry, then cookie check and backoff; actions disabled while disconnected |
| Inputs in testing | **Synthetic** (demo harness). Python agent and Chert **not connected** |
| Private playback isolated from the call | **Not yet tested live** (CH-4) |
| Overlay CI | `.github/workflows/overlay.yml`: typecheck, tests, production build |

## Architecture

```text
   Chert / agent (not connected)   operator (control token)        demo harness (scripts/bridge-demo.mjs)
                 └──────────────────────┬──────────────────────────────────┘
                                        ▼
              Node bridge ── SidekickCoordinator ── SidekickEngine ── reason() + provider
              (owns all session state; browser projection; serves overlay/dist at /ui/)
                                        │  /v1/ui/pair · /v1/ui/session · SSE stream · JSON routes (cookie)
                                        ▼
   httpBackend implements SidekickBackend   ◀── the ONLY seam the UI uses (inProcessBackend in simulation mode)
                                        │
   useSidekickSession (reducer: version dedupe, connection, discard)   useVoiceExplanation
                                        ▼
                         App.tsx (voice stop rules, confirmations)
                                        ▼
   ConsentScreen(SessionSetup) · LiveScreen(StatusBar, RecommendationCard, History)
   EndSessionPanel · SessionReview · StateScreens (connecting, unavailable, reconnecting, discarded)
```

```text
src/
  contracts/shared.ts      type-only re-export of src/contracts/types.ts (no duplicates)
  contracts/pending.ts     SessionReview only (engineering.md §8 proposal; no shared type yet)
  backend/                 SidekickBackend port, httpBackend (default), inProcessBackend (simulation), browserCrypto
  session/                 lifecycle table, reducer (version dedupe, connection), selectors, hook
  voice/                   speechService (only speechSynthesis user), voiceController (request ids), hook
  review/buildReview.ts    review from BrowserSessionTimeline + final OverlayState
  components/              presentational components (props in, callbacks out)
scripts/bridge-demo.mjs    local bridge + operator/agent harness with mocked inputs
```

The simulation bundles `src/engine.ts`, which imports `randomUUID` from `node:crypto`; `vite.config.ts` and
`tsconfig.json` map that one import to `backend/browserCrypto.ts` (Web Crypto).

## Shared contracts used

`OverlayState`, `RecommendationView`, `VoiceRequest`, `ExplanationScript`, `BrowserSessionTimeline` /
`BrowserSessionEvent`, `StaleReason`, `EngineError`, all from `src/contracts/types.ts`. The overlay never
receives `ExplanationContext` (it contains transcript text). The only overlay-defined data type left is
`SessionReview`, because the engineering.md §8 type is still a proposal.

## Privacy boundary

**What the code guarantees** (enforced by `src/privacyBoundary.test.ts`):

- Sound comes only from `window.speechSynthesis` in `voice/speechService.ts`. No media stream is created.
- No WebRTC, `getUserMedia`/`getDisplayMedia`, `MediaStream`, Web Audio or LiveKit/Chert imports anywhere,
  including the shared modules the simulation bundles. The Gemini adapter and `process.env` are never imported.
- Network access only in `backend/httpBackend.ts`: same-origin paths, no absolute URLs, no `Authorization`
  header. The default build does not contain the in-process engine.
- Only on-device voices (`localService === true`); otherwise a labelled text fallback.
- Sound starts only from **Explain with voice**, scoped to one recommendation and one engine voice request.
- Speech stops on Stop, dismiss of that card, pause, end, discard, connection loss, unmount, tab close,
  whenever the engine drops or replaces `activeVoiceRequest`, and when the bridge refuses a playback report.
- If the connection drops mid-explanation, speech stops and the request is reported `failed`, retried and
  re-sent after reconnect if needed, so the bridge never keeps it live (which would block explanations with `voice_busy`).
  Reconnecting never restarts speech.

**Must be tested live (CH-4):**

- [ ] Acoustic pickup: with speakers, the FaceTime microphone may hear the explanation. Test with and without headphones.
- [ ] Screen-share audio: if this panel runs on the Mac sharing its screen with app audio, TTS could be shared.
- [ ] User-gesture rules: confirm real clicks speak on Chrome and Safari (headless script clicks get `not-allowed`).
- [ ] On-device voices exist on the target machine.
- [ ] Stop cancels immediately on the target browser.

## Open questions

1. Who generates `SessionReview` long term: rules in the browser (today), a backend service, or a model?
2. The engine allows one live explanation per session, so one participant's explanation blocks the others
   (`409 voice_busy`). Intended for multi-device use?
3. Per-participant consent is out of scope for the MVP (operator attests for the group).
