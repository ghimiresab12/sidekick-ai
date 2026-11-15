# Sidekick AI — Product Requirements

**Status:** Product behavior agreed; external delivery mechanisms not yet verified.  
**Track:** HackUTA 2026 / Chert — Best Use of FaceTime.  
**Scope:** One high-quality gaming MVP for four developers; future use cases share the same agent core.

## 1. Product goal

Sidekick observes an active, consented **group FaceTime** session through conversation and shared-screen context. It remembers the group's objective and roles, proactively displays **concise, contextual text recommendations in an overlay**, privately plays **a detailed spoken explanation of a selected recommendation only to the requesting user**, and creates an **evidence-grounded event review** after the session.

### Non-goals

Not a generic chat assistant; not separate gaming/travel/social agents; not an autonomous player or game controller; not emotional-state inference; not 100% accurate real-time tracking of arbitrary commercial games.

## 2. Fixed product decisions

| ID | Decision | Requirements implication |
|---|---|---|
| D01 | Group FaceTime via Chert | Demonstrate real Chert call and screen context |
| D02 | Incoming screen share supported per team confirmation | Implement against actual verified starter API, not imagined methods |
| D03 | Continuous **audio input processing** during explicitly started, consented session | Preserve relevant group conversation context; indicate recording/processing state |
| D04 | Continuous **screen observation** during active session | May use sampled frames; stop immediately on Stop |
| D05 | Quiet Mode always default | No unsolicited speech; proactive **text** suggestions only |
| D06 | Recommendation surface is an **overlay** | Exact overlay platform is an implementation dependency |
| D07 | Voice button operates on a **selected suggestion** | Explain that suggestion with **private local playback for the requester only**, using stored observations/context; never broadcast into FaceTime |
| D08 | After one voice explanation, return to quiet output | Keep receiving context and producing text advice |
| D09 | Session review includes actual events | Key moments, strengths, weaknesses, decisions, next actions; no invented stats |
| D10 | Automatically infer activity, request participant confirmation | Never silently apply wrong gaming/travel profile |
| D11 | Hackathon MVP is gaming | Other activities documented but not implemented as separate MVP modules |

## 3. Functional requirements and acceptance criteria

### P0 — Minimum viable user journey

- **FR-01 Start/Stop and informed consent:** Participants can see when audio and screen observation are active. Starting requires explicit opt-in; stopping ends new processing and allows review/discard. *Accept:* a user can explain and control whether Sidekick is observing.
- **FR-02 Real group FaceTime:** Agent joins and participates through Chert. *Accept:* a live call is shown and an input reaches the agent.
- **FR-03 Spoken role/context retention:** Sidekick records an explicitly stated participant role and goal (e.g., “Alex protects left defense”), and permits corrections. *Accept:* role survives until a later visual event without restating it.
- **FR-04 Shared-screen interpretation:** Analyze screen-share observations from a real active call. *Accept:* a known visual change produces a matching structured observation. Sampled frames are acceptable.
- **FR-05 Proactive quiet advice:** Correlate context with observation to create one useful short text recommendation, displayed in the selected overlay. *Accept:* the relevant visual change triggers advice without a second user question; no automatic voice.
- **FR-06 Explanation on selection:** Every actionable recommendation has a stable ID and an **Explain with voice** action. *Accept:* pressing the chosen card plays one longer, relevant spoken explanation **on the requester’s local device only**, then returns to Quiet Mode; FaceTime receives no new audio track.
- **FR-07 Session event log:** Track important observations, advice, user-requested voice actions, decisions and explicitly observed resolutions. *Accept:* timeline contains real associated timestamps and sources.
- **FR-08 End review:** After stopping observations, user may generate a report. *Accept:* the report contains a summary, notable moments, strengths, weaknesses, and next-step suggestions drawn exclusively from stored evidence; uncertain/unobserved outcomes labeled as such.
- **FR-09 Graceful errors:** Display understandable states when video is not shared, transcript is unavailable, model fails, or voice delivery fails. *Accept:* avoid fake “live” claims or invented observations.

### P1 — Reliability improvements after core path works

- **FR-10 Activity detection:** Detect probable game from observed context and ask the group to confirm. Manual override must be possible.
- **FR-11 Recommendation hygiene:** Severity/relevance thresholds, duplicate suppression, cooldowns, stale-card handling and dismiss.
- **FR-12 Cancel voice:** Stop in-progress local playback; test speech-synthesis cancellation and user controls.
- **FR-13 Detect resolution:** Mark an issue resolved only if a subsequent observation supports that fact.

### P2 — Stretch / future

Travel budget/planning, social prompts, other games, searchable saved history, rich video highlights, persistent storage, automated scheduling, sophisticated player tracking, iMessage as a second channel.

## 4. Required gaming demo story

1. FaceTime group joins with Sidekick; participant opts into observation and shares screen.
2. Participants say who is defending the left zone. Sidekick remembers it.
3. User confirms gaming context (or Sidekick suggests and they confirm it).
4. Shared simulation or single real game scene visibly shows left zone becoming uncovered.
5. Sidekick displays **one** targeted text recommendation in the overlay without talking.
6. User selects that recommendation and presses **Explain with voice**.
7. The requester’s device privately speaks a more detailed explanation and returns to quiet mode; it does not enter shared FaceTime audio.
8. User ends session, opens review, sees relevant recorded event and recommendation.

**Simulation policy:** An intentionally simplified soccer field is acceptable as **input to real live screen analysis**; it must be identified as a simulated game scene. A prerecorded AI response or mock Chert session cannot be described as a successful live integration.

## 5. Quality, safety and trust

- **Audio processing is continuous while active**, even though speech output is not; all participants should know that.
- Provide obvious active/paused/stopped state, consent and an immediate Stop control. Allow discarding the session after the debrief or without generating one.
- Keep raw frames/audio out of persistent storage by default. Store minimal structured session events in memory for the demo; do not include identifiable personal content unnecessarily.
- No hallucinated scores, game telemetry, participant identity, outcomes, or measurable accuracy. Use language such as “appears” when uncertain.
- If screen share is unavailable or ambiguous, don't present stale advice as current. On voice request, check whether the recommendation is still current or explain that it refers to an earlier moment.
- Deduplicate same event across samples; time-stamp advice; prevent overlapping spoken explanations.
- Never allow AI output to operate a game, send messages on behalf of players, or take external action without explicit authorization.

## 6. Definition of done

The team can demonstrate the **complete live, consented Chert FaceTime path** from spoken role assignment and shared visual evidence to a **quiet proactive text card**, an **on-click private local spoken explanation of that exact card**, and an **evidence-based debrief**. Each integration is accurately identified as live, mocked, or fallback. All P0 requirements have a recorded test; P1/P2 never delay the full path.

## 7. Requirements boundaries / evidence

- **Confirmed by team:** incoming FaceTime screen sharing is possible.
- **Not yet verified in starter code:** actual media/transcript schemas; speaker identification; local private voice playback and isolation from the call; overlay delivery mechanism; latency and throughput.
- Source of truth for open integration work: [`engineering.md`](engineering.md) and [`phases.md`](phases.md).

## Decision update — private explanation (confirmed 2026-11-14)

- **Who hears it:** Only the participant who clicked **Explain with voice** on a selected recommendation.
- **Where it plays:** Locally on that participant’s companion device, preferably through headphones. No TTS audio may be published into the FaceTime/LiveKit room or shared Chert call. If speakers are used, acoustic microphone pickup can still leak audio; test and warn.
- **How it works:** The backend returns grounded explanation **text** tied to the selected recommendation ID and event evidence; the local UI handles TTS playback, stop/cancel, and an on-screen text fallback. Browser `speechSynthesis` is a candidate, not a finalized tested dependency.
- **Unchanged:** Continuous group-aware input during an explicitly consented active session; proactive quiet overlay advice; gaming-first hackathon MVP; mandatory event-based end-of-session review.
- **Dami/PITWALL reconciliation:** Adopt the private companion audio concept and modular Chert + Gemini + session-coordinator architecture, but **do not** expand MVP scope to iMessage, an always-on general assistant, a browser extension, or five separate modes.
