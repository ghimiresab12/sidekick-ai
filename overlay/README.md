# Sidekick overlay: companion UI, private voice, session review

> **Status: connected to the real backend code, with synthetic input.** The overlay consumes the shared
> contracts (`src/contracts/types.ts`) and, by default, runs the **real** session engine,
> `SidekickCoordinator` and reasoning module inside the page, fed by a two-step synthetic demo feed.
> Reasoning uses the **deterministic mock provider, not Gemini**. No Chert, FaceTime, microphone, camera or
> screen share is involved. It is a **companion browser panel**, not a native FaceTime overlay.

Owner: UI / voice / review workstream (D). Branch: `feature/overlay-backend-integration`.

## Run it

Requires Node 24 (root `.nvmrc`). The overlay imports the shared backend modules from `../src`, so both
package sets must be installed:

```bash
npm ci                    # repository root (types for the shared modules)
cd overlay && npm ci
npm run dev               # http://localhost:5173
npm test                  # Vitest, including end-to-end tests through the real coordinator
npm run typecheck         # fails if src/contracts/types.ts drifts from what the overlay uses
npm run build             # typecheck + production build into overlay/dist (git-ignored)
```

### Demo script (about 2 minutes)

1. Tick the consent box, then **Start observing**.
2. Open **Demo controls** and **Send next synthetic observation**: "Alex is responsible for left defense."
   Reasoning records the role. No card yet: advice needs screen evidence.
3. Send the second observation (a structured frame: left zone uncovered). The coordinator runs reasoning,
   the engine validates the candidate, and **Left defense appears exposed** appears **silently**, with
   Alex's role and the evidence provenance.
4. **Explain with voice** speaks a grounded explanation on this device only. Try **Stop voice**.
5. **Pause**: speech stops, the engine marks the card stale and moves it to History. The main slot says
   "Paused" instead of showing earlier advice as current. **History → Show** brings it back, labelled earlier.
6. **Resume**: the card stays earlier until new evidence arrives (engine rule).
7. **End session**, confirm, **Generate review**. The timeline is the engine's own event log.
8. **Discard session**, confirm. The engine deletes the session.

Tick **Simulate speech synthesis unavailable** to see the text fallback.

## What is real, synthetic or missing

| Capability | Status |
|---|---|
| Session lifecycle (start, pause, resume, end, discard) | **Real engine + coordinator** rules; UI disables what the engine would reject |
| Recommendations, staleness, dedupe, evidence, player context | **Real engine** `OverlayState`, versioned |
| Reasoning | **Real `reason()`** with the deterministic **mock provider**. Gemini is server-only |
| Late reasoning after pause/end | **Real coordinator** discards it (tested) |
| Voice requests (pending, playing, finished, failed, cancelled) | **Real engine** voice lifecycle, by request id |
| Explanation text | Backend-side template from `ExplanationContext` (`backend/explanationText.ts`), not a model |
| Local speech | Browser `speechSynthesis`, on-device voices only |
| Session review | Rule-based summary of the **real engine timeline**. No backend review service exists yet |
| Input | **Synthetic**: two scripted observations (`backend/inProcessBackend.ts`) |
| Overlay-facing backend API | **Not defined yet, pending agreement with the backend developer.** The bridge on main serves the agent and control side only. See "Live backend requirements" |
| Chert / FaceTime input | **Not connected** |
| Private playback verified isolated from the call | **Not yet tested live** (CH-4) |

## Architecture

```text
synthetic feed ─▶ SidekickCoordinator ─▶ reason() + mock provider
                       │  (abort on pause/end, revalidate, select observations)
                       ▼
                 SidekickEngine  ── subscribe ─▶ OverlayState (versioned)
                       ▲                               │
   inProcessBackend implements SidekickBackend  ◀──────┘   ◀── the ONLY seam the UI uses
                       │
   useSidekickSession (reducer: version dedupe, connection, pending)   useVoiceExplanation
                       └──────────────────────┬──────────────────────────────┘
                                        App.tsx (voice stop rules, confirmations)
                                              ▼
   ConsentScreen · LiveScreen(StatusBar, RecommendationCard[PlayerContext, EvidenceList, VoiceControls], History)
   EndSessionPanel · SessionReview · StateScreens (connecting, unavailable, reconnecting, discarded)
```

```text
src/
  contracts/shared.ts      type-only re-export of src/contracts/types.ts (no duplicates)
  contracts/pending.ts     types with NO shared equivalent yet (GAP 1, GAP 2)
  backend/                 SidekickBackend port, inProcessBackend, explanationText, browserCrypto shim
  session/                 lifecycle table, reducer (version dedupe, connection), selectors, hook
  voice/                   speechService (only speechSynthesis user), voiceController (request ids), hook
  review/buildReview.ts    review from SessionEvent[] + final OverlayState
  components/              presentational components (props in, callbacks out)
```

`src/engine.ts` imports `randomUUID` from `node:crypto`; `vite.config.ts` and `tsconfig.json` map that one
import to `backend/browserCrypto.ts` (Web Crypto). No backend file is modified.

## Contract mapping (provisional → shared)

| Overlay before | Now |
|---|---|
| `contracts/sidekick.ts` (copy of old engineering.md §3) | **Deleted.** `contracts/shared.ts` re-exports `src/contracts/types.ts` |
| `Session` + `RecommendationWithContext[]` + `Observation[]` snapshot | `OverlayState` (`prominent`, `history`, `voiceBusy`, `activeVoiceRequest`, `version`) |
| UI ranking of cards | Engine's `prominent` (active only) and `history` order. The UI only adds "Show" for open cards |
| Evidence with observation summary and quality | `RecommendationView.evidence`: source, kind (condition/context), time. No text, by design |
| `relatedParticipantIds` resolved via `Session.participants` | `RecommendationView.relatedParticipants` (roles at creation) + `contextChangedSinceCreation` |
| `TimelineEvent` + proposed event types | `SessionEvent` (typed payloads). `voice_finished.outcome` gives finished / stopped / failed |
| `requestVoiceExplanation(recId)` → text | `requestExplanation` → `ExplanationScript { request: VoiceRequest, text, … }` |
| `reportVoicePlayback(recId, …)` | `reportVoiceStatus(requestId, …)` and `cancelExplanation(requestId)` |
| `canExplain` computed in UI | `RecommendationView.canExplain` from the engine |
| Hand-written mock backend + seed + validator | **Deleted.** Replaced by the real engine + coordinator in-process |

## Contract gaps (need the contracts owner's decision)

None of these change an existing shared type. Each is additive.

1. **Explanation text.** engineering.md §3.2 says the backend generates text from `ExplanationContext`, but
   `types.ts` has no type for the result. The overlay uses `ExplanationScript { request: VoiceRequest; text;
   refersToEarlierObservation }` in `contracts/pending.ts`. Proposal: add it to `types.ts`. The overlay must
   not receive `ExplanationContext` itself, because it contains raw transcript text.
2. **Session review.** `SessionReview` exists only as a proposal in engineering.md §8, and no review service
   exists. The overlay builds it client-side from the engine timeline (`review/buildReview.ts`). Proposal:
   add the §8 type to `types.ts`, then decide whether a backend `generateReview` replaces the client builder.
3. **Participants for consent.** `OverlayState` has no participant list, so the consent screen no longer
   names participants. Not needed for the MVP; noted in case design.md wants names there.
4. **Activity confirmation.** The overlay has no "confirm activity" control yet. The in-process setup
   confirms `gaming`, and `OverlayState.suggestedActivity` is shown when present.

## Live backend requirements (contract pending)

**The overlay-facing API is not defined yet.** It is pending agreement with the backend developer, and no
live adapter will be written until it is agreed. This section lists capabilities only, with no routes,
methods, payloads, event names, authentication or error formats.

The HTTP bridge on main (`docs/engineering.md` "Integration milestone 2") is agent- and control-facing: it
refuses browser requests, and its control token must never be in browser code. A live overlay therefore needs
an overlay-facing API that can:

- attach the overlay to an existing session as a specific participant;
- deliver versioned `OverlayState` (shared type, unchanged) and recover after a disconnect;
- run lifecycle actions the overlay is allowed to trigger;
- dismiss a recommendation;
- return explanation text **only to the requester**, never on a shared channel;
- accept voice status and cancellation by request ID;
- provide the session review (and, if agreed, the timeline).

The UI already handles `reconnecting` / `unavailable`, drops snapshots whose `version` does not increase,
disables actions while disconnected and never shows the last state as live. The in-process mock stays for
tests and demos.

Findings, open questions and the implementation sequence are in
[`docs/overlay-live-backend.md`](../docs/overlay-live-backend.md).

## Privacy boundary for voice

**What the code guarantees** (enforced by `src/privacyBoundary.test.ts`, which now also scans every bundled
backend module):

- Sound comes only from `window.speechSynthesis` in `voice/speechService.ts`. No media stream is created.
- No WebRTC, `getUserMedia`/`getDisplayMedia`, `MediaStream`, Web Audio, LiveKit/Chert imports or network
  calls, in the overlay or in the backend modules it bundles. The Gemini adapter and `process.env` are never
  imported.
- Only on-device voices (`localService === true`); otherwise a labelled text fallback.
- Sound starts only from **Explain with voice**, scoped to one recommendation and one engine voice request.
- Speech stops on Stop, dismiss of that card, pause, end, discard, connection loss, unmount, tab close, and
  whenever the engine drops `activeVoiceRequest`.

**Must be tested live (CH-4):**

- [ ] Acoustic pickup: with speakers, the FaceTime microphone may hear the explanation. Test with and without headphones.
- [ ] Screen-share audio: if this panel runs on the Mac sharing its screen with app audio, TTS could be shared.
- [ ] User-gesture rules: confirm real clicks speak on Chrome and Safari (headless script clicks get `not-allowed`).
- [ ] On-device voices exist on the target machine.
- [ ] Stop cancels immediately on the target browser.

## Open questions

1. Who generates `SessionReview` long term: rules (today), a model, or both?
2. Should the overlay get a "confirm activity" control, using `OverlayState.suggestedActivity`?
3. Is consent per participant or per session? (The UI asks the requester to confirm.)
