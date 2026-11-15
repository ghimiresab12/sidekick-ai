# Overlay live backend: assessment and open contract questions

**Status (2026-11-15):** assessment only. The overlay's live backend API is **pending agreement with the
backend developer**. This document defines no routes, HTTP methods, payloads, event names, authentication
mechanism or error format. Nothing here is implemented.

Owner: UI / voice / review workstream (D). Based on `main` at `6f73218` (after PR #10).

## 1. Where things stand

- The overlay consumes the shared contracts (`src/contracts/types.ts`) through a type-only re-export in
  `overlay/src/contracts/shared.ts`.
- Its only backend is the **in-process mock** (`overlay/src/backend/inProcessBackend.ts`). It runs the real
  `SidekickEngine`, `SidekickCoordinator` and `reason()` with the deterministic mock provider inside the
  page, fed by a two-step synthetic demo feed. This stays, for tests and demos.
- The HTTP bridge on `main` (`src/bridge/`, `docs/engineering.md` "Integration milestone 2") is
  **agent- and control-facing only**:
  - it binds to `127.0.0.1` and refuses any request with an `Origin` header, so a browser cannot call it;
  - the control token is for a "trusted operator / future UI backend (**never browser code**)";
  - it has no operations for the overlay's state stream, dismiss, explanations, voice status, timeline or
    review.
- `docs/engineering.md` §9 lists the operations a companion overlay might need. They are explicitly
  "examples, not implemented endpoints".

So a live overlay needs an overlay-facing API that does not exist yet, served by something that can hold
server-side credentials.

## 2. The existing interface and its limits

The UI talks only to `SidekickBackend` (`overlay/src/backend/SidekickBackend.ts`):
`connect`, `startSession`, `pauseSession`, `resumeSession`, `endSession`, `discardSession`, `dismiss`,
`requestExplanation`, `reportVoiceStatus`, `cancelExplanation`, `getTimeline`, plus an optional
`simulation` control used only by the mock.

What already fits a remote backend:

- state arrives as versioned `OverlayState` snapshots; the reducer drops any snapshot whose `version` does
  not increase;
- `ConnectionStatus` covers connecting, connected, reconnecting and unavailable, and the UI disables
  actions and voice while disconnected;
- voice is tracked by engine request ID, and local playback stops whenever `activeVoiceRequest` disappears.

What it lacks for live use:

| Area | Limitation |
|---|---|
| A. Session state | No way to attach to an existing session (the Python agent creates sessions) or to say which participant this device belongs to. |
| B. Recommendations | Fits as is. `dismiss` maps to the engine. |
| C. Private explanations | `ExplanationScript` is an overlay-only type (`contracts/pending.ts`); the text is generated in the browser by a template. |
| D. Voice requests | No requester identity is sent, although the engine accepts `requesterParticipantId`. |
| E. Session review | Built in the browser from the timeline (`review/buildReview.ts`); there is no `generateReview` on the interface and no shared `SessionReview` type. |
| Errors | `BackendErrorCode` covers engine errors plus `unavailable`, `invalid_response`, `reasoning_failed`; there is no agreed mapping from a remote error format. |

## 3. Separation of concerns

Things that must come from the backend in live mode but are computed in the browser today:

1. Review generation (`review/buildReview.ts`).
2. Explanation text (`backend/explanationText.ts`).
3. Session setup: participants and activity confirmation (inside the mock).
4. Backend choice: `App.tsx` always creates the in-process backend, so mock and backend code always ship
   in the bundle.

The client-side lifecycle table (`session/`) is fine as long as it only disables buttons; the backend stays
authoritative.

Fix: keep 1–3 inside the mock implementation only, and make the backend selectable (mock or live).

UI-only concerns that stay local: speech playback and voice selection, confirmations, history "Show",
connection banners, error display.

## 4. Proposed mock / live architecture

```text
                    ┌─ inProcessBackend (mock: engine + coordinator + mock reasoning,
UI ─▶ SidekickBackend ┤    synthetic feed, client-side review and explanation text)
                    └─ live backend adapter (not written; shape depends on the agreed API)
```

- One interface; the UI cannot tell which implementation is active.
- Selection by build or start-up configuration, so the live build need not ship mock code.
- The mock keeps every existing test.

## 5. API information needed (per capability)

Everything below is a **question for the backend developer**, not a proposal of routes or payloads.
"Verified" means it exists on `main` today.

| Capability | Verified on main | Information needed |
|---|---|---|
| Reaching the backend from a browser | Bridge refuses browser requests; control token is never in browser code | Which server the overlay talks to, how it is authenticated, and how it is scoped to one session and one participant. |
| Attach to a session | Sessions are created by the agent via the bridge | How the overlay learns the session ID and its own participant ID. |
| Live session state | `engine.subscribe` emits versioned `OverlayState` | Transport (stream vs polling), reconnect behaviour, whether a full snapshot is sent on (re)connect. |
| Lifecycle (consent, pause, resume, end, discard) | Bridge control operations exist | Whether the overlay may trigger them, and through what. |
| Dismiss | `engine.dismiss` | Request/response shape and errors. |
| Private explanation | `engine.requestExplanation` returns `ExplanationContext` (contains transcript text) | Where text is generated; the shared type for the result; guarantee that text goes only to the requester, never on a shared stream. |
| Voice status / cancel | `engine.reportVoiceStatus`, `engine.cancelExplanation` | Request/response shape; how requester identity is checked. |
| Timeline | `engine.getTimeline` | Whether the browser may receive it at all (summaries include screen descriptions). |
| Review | No review service; `SessionReview` is a proposal in engineering.md §8 | Who generates it (rules, model, both) and the shared type. |
| Errors | Bridge uses its own error codes and status table | Error format for overlay operations and how it maps to `EngineError`. |

Shared-type gaps (additive; owner: contracts):

1. A type for backend-generated explanation text (the overlay uses `ExplanationScript` provisionally).
2. The `SessionReview` type from engineering.md §8.

Other open questions:

- The engine's voice lock (`voiceBusy`, `activeVoiceRequest`) is session-wide: one participant's
  explanation blocks everyone else's. Intended?
- Is consent per participant or per session?

## 6. Risks

- Explanation text or transcript content leaking onto a shared state channel.
- Control credentials ending up in browser code.
- Timeline or review exposing screen-description text to every participant.
- Drift between the mock's behaviour and the live backend's (for example, review or explanation wording).
- Reconnect and out-of-order delivery are unit-tested only; the mock cannot disconnect.
- Private playback isolation still needs live CH-4 testing.

## 7. Files likely to change (once the contract is agreed)

- `overlay/src/backend/SidekickBackend.ts` (attach, participant, review, error mapping)
- a new live adapter under `overlay/src/backend/`
- `overlay/src/backend/inProcessBackend.ts` (absorb review and explanation text as mock-only)
- `overlay/src/App.tsx` (backend selection)
- `overlay/src/session/useSidekickSession.ts` (review via the backend)
- `overlay/src/contracts/pending.ts` (removed once the shared types exist)
- `overlay/src/privacyBoundary.test.ts` (allow network calls only in the live adapter)
- `overlay/README.md`, `docs/techstack.md` §8

No coordinator, engine, bridge or shared-contract change is made from the overlay workstream.

## 8. Implementation sequence (after agreement)

1. Agree the overlay-facing API and the two shared types with the backend developer.
2. Add the shared types (contracts owner).
3. Extend `SidekickBackend` for attach, participant identity and review.
4. Move review and explanation-text generation behind the mock implementation.
5. Add backend selection; keep mock as the test default.
6. Write the live adapter against the agreed contract, with contract tests.
7. Narrow the privacy-boundary test to permit network calls only in the live adapter.
8. End-to-end test against a running backend, then live CH-4 voice tests.

## 9. Inconsistencies found and corrected

- `overlay/README.md` listed proposed routes for a bridge "not on main"; the bridge is on main and those
  routes were never agreed. Replaced with a capability list marked pending.
- `docs/techstack.md` §8 pointed to those routes. Corrected.
- The root `README.md` said the overlay runs on mock data and is not connected to the engine. It runs the
  real engine and coordinator in-page with synthetic input. Corrected.
