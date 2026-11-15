# Sidekick overlay: companion UI, private voice, session review

> **Status: MOCK PROTOTYPE.** Runs on fictional scripted data. **Not connected to Chert, FaceTime, the backend or a model.**
> It is a **companion browser panel (fallback)**, **not** a native FaceTime overlay.
> Provisional: built before the Chert starter was inspected (see `docs/techstack.md` §8).

Owner: UI / voice / review workstream (D). Branch: `feature/overlay-ui`.

## Run it

Requires Node 18+ (tested on Node 24).

```bash
cd overlay
npm install
npm run dev        # http://localhost:5173
npm test           # unit tests (Vitest)
npm run typecheck  # TypeScript, no emit
npm run build      # typecheck + production build into overlay/dist (git-ignored)
```

### Demo script (about 2 minutes)

1. Tick the consent box, then **Start observing**. The empty state shows ("observing quietly").
2. About 2.5 s later, roles are recorded from the scripted conversation. About 5 s after that, the **Left defense** card appears **silently**.
3. **Explain with voice** speaks privately on this device. Try **Stop voice**.
4. **Pause** stops speech, marks the card "Earlier · not currently verified" and disables Explain. Then **Resume**.
5. Open **Demo controls**, then **Play next scripted observation now**: the **Right wing** card arrives. **History, then Show** brings a card back to the front.
6. **End session**, confirm, **Generate review**. Key moments link to recorded events.
7. **Discard session**, confirm. Everything is cleared and the session can't be resumed.

Demo controls (mock only): skip timers, or tick **Simulate speech synthesis unavailable** to show the text fallback.

## What is implemented, mocked or planned

| Capability | Status |
|---|---|
| Consent screen, active/paused/ended/discarded lifecycle, illegal transitions blocked | Implemented, unit + browser tested |
| One prominent card (active over stale, important over normal, newest first), history, dismiss, empty states | Implemented, tested |
| Evidence (source, observed time, quality in words) and player context | Implemented, tested |
| Explain with voice, Stop voice, preparing/speaking/finished/cancelled/failed, text fallback | Implemented. Logic tested with a fake engine; real Chrome path reaches a defined state |
| Speech stops on dismiss (that card), pause, end, discard, unmount, tab close | Implemented, tested |
| End-of-session review grounded in recorded events | Implemented (**mock rule-based generator**, not AI) |
| Recommendations, observations, events | **Mocked** (`src/data/mock-session.json`) |
| Real data source (Chert / backend) | **Planned**: implement `SidekickDataSource` |
| Native over-game overlay | **Not attempted** (CH-5) |
| Private playback verified isolated from the FaceTime call | **Not yet tested live** (CH-4; see below) |

## Architecture

```text
mock-session.json ─▶ mockDataSource (fake backend: lifecycle rules, scripted feed, event log)
                          │  implements SidekickDataSource  ◀── the ONLY seam to swap for real integration
                          ▼
          useSidekickSession (useReducer)        useVoiceExplanation (useSyncExternalStore)
                  │  session snapshot                   │  voiceController ─▶ speechService ─▶ speechSynthesis
                  └──────────────┬──────────────────────┘
                              App.tsx  (cross-cutting rules: stop voice on dismiss/pause/end/discard; confirmations)
                                 ▼
   ConsentScreen · LiveScreen(StatusBar, RecommendationCard[PlayerContext, EvidenceList, VoiceControls], History)
   EndSessionPanel · SessionReview · DiscardedScreen · ConfirmDialog · MockBanner/MockControls
```

```text
src/
  contracts/sidekick.ts      verbatim copy of docs/engineering.md §3 + §8 (do not edit here)
  contracts/proposed.ts      ⚠️ additions PENDING Sabik's approval
  data/                      SidekickDataSource (interface), mock source, seed + validator, mock review generator
  session/                   sessionMachine (transition table), reducer, selectors, useSidekickSession
  voice/                     speechService (only file using speechSynthesis), voiceController, hook
  components/                presentational components (props in, callbacks out; no data-source imports)
  ui/format.ts               labels and time formatting
  *.test.ts                  Vitest suites, including privacyBoundary.test.ts
```

## Privacy boundary for voice

**What the code guarantees** (enforced by `src/privacyBoundary.test.ts`):

- Sound comes only from `window.speechSynthesis` in `voice/speechService.ts`, which plays through the OS default output and produces no media stream.
- No WebRTC peer connections, `getUserMedia`/`getDisplayMedia`, `MediaStream`, Web Audio graphs, LiveKit/Chert imports, or network calls anywhere in the overlay.
- **Only on-device voices** (`localService === true`). Network voices (which send text to a remote server) are refused, and the UI shows a labeled text fallback.
- Sound starts only from an **Explain with voice** press, scoped to one recommendation ID. Never on card creation. One explanation at a time.

**What code cannot guarantee. Must be tested live (CH-4):**

- [ ] **Acoustic pickup:** on speakers, the FaceTime microphone may hear the explanation. Test with headphones and without; confirm other participants hear nothing.
- [ ] **Screen-share audio:** if this panel runs on the Mac that is screen-sharing in FaceTime, and the share includes app/system audio, TTS might be shared. Test on the target setup.
- [ ] **User-gesture rules:** headless Chrome rejected speech with `not-allowed` for script-generated clicks (the app correctly showed the text fallback). Confirm real clicks speak on the target browser (Chrome, Safari).
- [ ] **On-device voices exist** on the target machine (macOS system voices normally report `localService: true`).
- [ ] **Stop** cancels immediately on the target browser.

## Contract alignment with the session engine (pending migration)

Since this prototype was built, `origin/main` added the approved contracts in **`src/contracts/types.ts`** and the `SidekickEngine`. `overlay/src/contracts/sidekick.ts` is a **superseded** copy of the original `engineering.md` §3, kept only until migration. Differences that affect the UI:

| Overlay prototype today | Approved engine contract |
|---|---|
| Own `SessionSnapshot` aggregate | `OverlayState` (versioned) via `subscribe(sessionId, listener)`; ignore non-increasing `version` |
| Evidence shows observation summaries | `RecommendationView.evidence` has source, kind (condition/context) and time only. **No summaries or transcript text** reach the overlay |
| Stale card stays prominent while paused | `prominent` is an **active** card only; stale cards go to `history` |
| `requestVoiceExplanation` → text | `requestExplanation` → `{ request, context }`; text generation from `ExplanationContext` is a backend step (owner TBD) |
| `reportVoicePlayback(recId, …)` | `reportVoiceStatus(requestId, …)` / `cancelExplanation(requestId, 'user')`; stop playback when `activeVoiceRequest` changes or disappears |
| Mock review over own events | Review from `getTimeline()` (typed payloads) + `getObservation`; respect `timelineTruncated` |

### Original contract proposals (most now covered by the engine)

The overlay originally needed these **additive** changes, isolated in `src/contracts/proposed.ts`. P1, P2, P4 and P5 are covered by the engine contracts. **P3 (explanation text) remains open.**

| # | Proposal | Why the UI needs it |
|---|---|---|
| P1 | Event types `session_paused`, `session_resumed`, `recommendation_stale`, `voice_cancelled`, `voice_failed` | The review must honestly show pauses, stopped/failed voice and cards that went stale |
| P2 | `Recommendation.relatedParticipantIds?: string[]` | Show player context ("Alex · Left defense") via `Session.participants` |
| P3 | `VoiceExplanation { recommendationId, text, refersToEarlierObservation, evidenceObservationIds, generatedAt }` | §9 names `requestVoiceExplanation` but defines no payload |
| P4 | `reportVoicePlayback(id, 'playing' \| 'finished' \| 'cancelled' \| 'failed')` | The browser owns playback; the backend owns the event log. `voiceDeliveryStatus` has no `cancelled` value |
| P5 | Operations `startSession`, `pauseSession`, `resumeSession`, `dismissRecommendation`, `subscribe` (push) | Required by design.md (consent, pause/resume, dismiss, proactive cards) but missing from §9 |

**Open questions:**

1. Who generates `SessionReview`: a model, rules, or both? (The overlay renders any valid `SessionReview`.)
2. Can a dismissed card later be marked `resolved` if an observation supports it? (The mock says no.)
3. Can a session be discarded from `starting` (consent declined), or only after `ended`? (The mock allows only after `ended`.)
4. Should Explain work while `paused`? (The mock and UI say no: pausing stops processing.)
5. Is consent per participant or per session? (The UI asks the requester to confirm everyone agrees.)

## Integrating later

Implement `SidekickDataSource` over the real transport, then replace `createMockDataSource(...)` in `src/App.tsx`. The `MockBanner` and `MockControls` render only when `mode === 'mock'`. No component imports the data source directly.
