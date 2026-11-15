# Sidekick AI — Overlay and Review UX Specification

**Status:** Agreed user experience; implementation route pending Chert/desktop-platform verification.  
**Scope:** Minimal overlay for gaming, private local click-to-explain voice, and session debrief. No full dashboard, no separate iMessage UI or login for MVP.

## 1. Design principles

- **Gameplay first:** Short and unobtrusive advice; never cover essential game information.
- **Quiet by default:** Sidekick can continuously process consented input and show cards, but **never speaks automatically**.
- **Grounded and transparent:** Each recommendation is tied to observed context; show when it was observed and when it is uncertain/stale.
- **One clear action:** Click **Explain with voice** on an individual card to hear details **privately on the requester’s device**, not through FaceTime. No voice wake-word or accidental auto-speech required.
- **User control:** Monitoring status, Pause/Resume, Stop, Dismiss, End + Review, Discard.
- **Accessible:** Readable text, clear focus and keyboard buttons, no color-only meanings; avoid tiny targets.

## 2. Screen inventory

1. **Session setup/consent:** Explains that active sessions continuously process group audio and screen share, despite quiet voice output. Start is explicit; show whether screen is being shared.
2. **Minimal gaming overlay:** Status chip, newest relevant recommendation, **Explain with voice** and Dismiss; optional recommendation history.
3. **Voice explanation state:** Selected card shows Pending / Speaking / Finished / Failed. Always return to quiet recommendations after one response. Playback is private/local, never a shared FaceTime stream.
4. **Session review:** Summary, key moments with timestamps and evidence labels, strengths/improvements, next steps, and Discard.
5. **Error/empty:** No screen shared, no useful observation, microphone inaccessible, disconnected call, model unavailable, voice delivery failed, no events to review.

## 3. Overlay wireframe (illustrative)

```text
┌───────────────────────────────────────────────────────────┐
│ SIDEKICK  ● Observing     Quiet · Gaming confirmed    ⏸ ⏹ │
├───────────────────────────────────────────────────────────┤
│ ! Left defense appears exposed                           │
│ Alex advanced and the left zone looks uncovered.         │
│ Consider dropping back or asking for backup coverage.    │
│ Evidence: screen + assigned role · observed 12:45         │
│                                                           │
│ [🔊 Explain with voice] [Dismiss] [History]               │
└───────────────────────────────────────────────────────────┘
```

The window should be compact, movable if feasible, and must not hide the game action area. For windowed games, an always-on-top transparent desktop surface **might** work, but overlay specifics are **unverified**. A companion browser panel is a **fallback**, not equivalent to an actual over-game overlay; label it accordingly. Do not claim Chert itself overlays text on the user's game without proof.

## 4. Card behavior

| Property | Rule |
|---|---|
| Display | One prominent active suggestion; optional collapsed history |
| Text | Short title + 1–2 sentence observed situation + 1 clear suggested action |
| Evidence | Source and observation time (or “time unknown”), not invented confidence percentages |
| New issue | Replace or stack only if meaningfully different and relevant |
| Same repeated issue | Debounce; don't show duplicate cards every sampled frame |
| Resolved | Mark only if a subsequent observation supports resolution |
| Stale | Mark older advice as earlier/not currently verified; don't pretend it's still happening |
| Dismiss | Hides from prominent view but preserves an event for review while session is active |
| Explanation | Button is scoped to `recommendationId`, never the entire list |
| Voice | **No sound at card creation**; sound begins only with user button press |

Avoid “danger” or high-certainty colors for weak evidence. Use helpful but concise language (“left defense **appears** open”) instead of overstating screen recognition.

## 5. Voice-button states

```text
Idle on selected card
   → Click Explain with voice
   → Preparing
   → Speaking locally (only on requester’s device)
   → Finished → Quiet

On failure: Preparing → Unable to speak → Show detailed text fallback
On stale advice: Explain this earlier observation, not a current alert
```

- While speaking, show which card is being explained. Disable duplicate requests.
- Provide **Stop speaking** when the chosen local synthesis mechanism supports cancellation; test on target device.
- Speech should be conversational and short enough for live gameplay, but more informative than the text card: **what happened, why it matters, what to do**.
- The user should not need to repeat the context. Preserve evidence IDs and role assignments.
- Recommend headphones and test that microphone pickup does not make a local explanation audible to the group.
- Return to Quiet Mode after each spoken explanation; do not silently enable a continuous voice-coach mode.

## 6. Activity identification

Sidekick may suggest “Looks like a soccer game — use Gaming Mode?” based on screen and audio; wait for confirmation. Allow correction. If uncertain, show an unconfirmed activity indicator and request a selection rather than inventing a game or silently switching modes.

## 7. Session controls and consent

- **Start:** Describe continuous audio + screen analysis and prompt for opt-in. Show participant-visible status when active.
- **Pause:** Stop new processing; keep existing cards visible but mark stale as appropriate.
- **Resume:** Restore processing only as permitted. Do not silently reactivate after ended/discarded state.
- **End Session:** Stop observation first, then show **Generate Review** or **Discard**.
- **Discard:** Delete session state and event history in memory for demo; explain that the review will be unavailable afterward.
- **Screen off:** Never imply screen is being analyzed when no usable input is available.

## 8. Review page / panel

```text
SESSION REVIEW                           [Discard session]
Gaming session · Ended

Summary
- Sidekick observed at least one left-side defensive coverage gap.

Key moments
12:45  Left defense appeared uncovered [screen observation + role]
12:46  Advice displayed: drop back or arrange cover
12:48  Detailed explanation requested [user action]

What went well
- [Only include when an event actually supports a positive observation.]

Opportunities
- Consider assigning backup coverage during forward runs.

Suggested next steps
- Agree on who covers left defense during attacking transitions.

Limitations
- Sampled screenshots; no confirmed scoreline or full-match tracking.
```

This is an illustrative layout, **not sample telemetry from a real match**. Every moment should link back to an event reference (internal event IDs are fine); unknown resolution remains unknown. If there are too few events, say **“Not enough observations for a performance assessment”** rather than inventing strengths or trends.

## 9. Minimal style guidance

- Prioritize contrast, readability and transparency; background should not obscure underlying game controls.
- Use a neutral surface with restrained accent colors for actionable advice and status.
- Readable typography: roughly 14–16 px body text on desktop, larger for key actions; use system fonts to avoid extra downloads.
- Stable card height and consistent spacing; avoid flashy transitions, blocking dialogs or game-disrupting animations.
- Make active capture state unmistakable with both text and an indicator; don't rely on a green dot alone.
- Support keyboard focus order, Escape for dismiss where appropriate, and clear disabled/loading states.

## 10. UX tests / definition of done

- [ ] Session start requires active consent and displays audio/video monitoring status.
- [ ] A new grounded recommendation is readable over the active game or is explicitly labeled a companion fallback.
- [ ] Recommendation appears **without unsolicited speech**.
- [ ] Button privately speaks the **selected** recommendation only on the requester’s device, then returns to quiet output.
- [ ] Duplicate frames do not flood the overlay.
- [ ] Pausing and ending stop new processing and reflect correct status.
- [ ] Review contains actual events and honest “unknown” statements; discard clears ephemeral data.
- [ ] Game remains usable while overlay visible; buttons work via keyboard and mouse.

## 11. Out of scope

No full multi-page analytics dashboard, charts with imaginary performance scores, video highlight editing, social feed, saved account history, theme customization, automatic speech warnings, or cross-game controls in the hackathon MVP.

## Decision update — private explanation (confirmed 2026-11-14)

- **Who hears it:** Only the participant who clicked **Explain with voice** on a selected recommendation.
- **Where it plays:** Locally on that participant’s companion device, preferably through headphones. No TTS audio may be published into the FaceTime/LiveKit room or shared Chert call. If speakers are used, acoustic microphone pickup can still leak audio; test and warn.
- **How it works:** The backend returns grounded explanation **text** tied to the selected recommendation ID and event evidence; the local UI handles TTS playback, stop/cancel, and an on-screen text fallback. Browser `speechSynthesis` is a candidate, not a finalized tested dependency.
- **Unchanged:** Continuous group-aware input during an explicitly consented active session; proactive quiet overlay advice; gaming-first hackathon MVP; mandatory event-based end-of-session review.
- **Dami/PITWALL reconciliation:** Adopt the private companion audio concept and modular Chert + Gemini + session-coordinator architecture, but **do not** expand MVP scope to iMessage, an always-on general assistant, a browser extension, or five separate modes.

## Decision update — text coaching and live voice switch (2026-11-15)

- Default live state remains quiet text coaching in the companion panel, with a clear source label for camera versus shared screen when known.
- Add a distinct, explicit **Live voice** control. Before activation, tell users that the Chert agent's spoken replies may be audible to everyone on the FaceTime call. Show a persistent active indicator and an immediate **Turn voice off** action.
- The live-voice control represents a Chert realtime conversation only. Do not reuse the local “Explain with voice” button or browser speech synthesis to simulate it.
- If Chert realtime audio is not verified or unavailable, disable the control and state that live voice is unavailable; text chat and text coaching remain available.
- Camera and screen observation status must be independently visible when the adapter can distinguish them. Stop/pause ends both input paths.
