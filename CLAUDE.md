# Sidekick AI — Instructions for AI Coding Assistants

**Project:** Four-developer HackUTA 2026 Chert FaceTime entry.  
**Product:** Proactive **quiet text recommendations** grounded in group conversation plus shared screen; **private local voice explanation only to the user pressing a selected recommendation's button**; **event-based review** at session end. Gaming is the hackathon MVP; broader group activities are future applications.

**This file routes you to the specifications; it is not a replacement for them.** Use these rules in Claude Code, Codex, Cursor or any other assistant. If your tool ignores `CLAUDE.md`, paste this content into its project instructions.

## Reading order

1. [`docs/phases.md`](docs/phases.md) — build order; choose the earliest unblocked small task.
2. [`docs/requirements.md`](docs/requirements.md) — product intent, must-have acceptance, scope.
3. [`docs/engineering.md`](docs/engineering.md) — implementation architecture, contracts, event handling. **Wins on internal technical contracts.**
4. [`docs/techstack.md`](docs/techstack.md) — dependencies, settled versus deferred choices.
5. [`docs/design.md`](docs/design.md) — overlay/review UI rules; read for UI tasks.
6. [`README.md`](README.md) — introduction, demo narrative, onboarding.

## Settled product decisions — do not silently change

- FaceTime through Chert, group context, screen observations, continuous consented audio processing during an active session.
- Proactive recommendations are **text in a visible overlay**, not auto-spoken warnings. No constant verbal interruption.
- **Explain with voice** acts on the **selected** recommendation and its stored evidence; it plays **locally and privately on the requester’s device** (headphones recommended), never through shared FaceTime audio. After one explanation, return to quiet text.
- Activity is **detected/suggested automatically and confirmed by the users**; gaming is the only required hackathon mode.
- Session review uses **stored events**, not hallucinated scores, claims, or retrospective telemetry.
- Continuous observation is active-session-only. Stop/pause and visible status are essential. No indefinite private recordings.

## External integration caution

- The team reports incoming FaceTime screen sharing is supported by Chert. **The exact API/event/frame interface is unverified until tested in live starter code.** Do not contradict the team confirmation or invent SDK methods.
- Audio transcripts/speaker identity, overlay display, external button-triggered in-call voice, cancellation and latency likewise require proof.
- **Never invent Chert endpoints, event field names, voice controls, or undocumented streaming capabilities.** Implement thin adapters after inspecting <https://app.trychert.com/skills.md> and actual starter examples.
- If an interface is unavailable: note it in `docs/engineering.md`, apply the documented go/no-go rule, and disclose fallback mode visibly.

## Development rules

1. Favor **one working FaceTime → screen + context → text advice → selected voice → review** path over breadth.
2. Keep Chert I/O separate from context state, vision reasoning, tactical rules, recommendation logic, and UI.
3. Define or update shared data contracts **before** multiple developers implement them; use structured, validated objects.
4. A recommendation needs observed evidence, source timestamps, status (`active`, `resolved`, `dismissed`, `stale`), and de-duplication. Do not assert identities or game outcomes the frames cannot establish.
5. The voice button must use a recommendation ID and retrieve its existing context. Do not make it a generic prompt without grounding.
6. One source of truth for participant roles/assignments; participants can correct them. If speaker identity is uncertain, ask for identification.
7. Don't store raw audio/video by default. Keep keys server-side; never commit `.env`, tokens, transcripts, or personal call data.
8. Prefer simple rules, sampled frames, and one chosen multimodal reasoning model. Avoid extra databases/frameworks/extensions until a need is demonstrated.
9. Add a focused test or repeatable manual verification for each changed integration contract; maintain a working smoke path.
10. Distinguish **implemented**, **tested live**, **mocked**, and **planned**. Never claim a mock overlay is a native FaceTime overlay.

## Document change rules

- Scope/behavior change → `docs/requirements.md` **first**.
- Architecture, event schema, API/adapter, privacy decision → `docs/engineering.md` **first**.
- New dependency or selected language/provider → `docs/techstack.md`.
- Changed milestones/order or known blocker → `docs/phases.md`.
- Overlay/review interaction change → `docs/design.md`.
- Update demo/setup in README only when true.

**Before reporting complete:** state exactly what changed; what was tested on real Chert versus mocked; remaining blockers; affected docs updated. Never say integration works without actual evidence.

## Practical first assignment

Get a real Chert FaceTime session running and log **the actual shape** of incoming screen observations and transcript events; confirm the agent can speak in the same call. Record these findings in `docs/engineering.md` without recording private raw media in source control.

## Decision update — private explanation (confirmed 2026-11-14)

- **Who hears it:** Only the participant who clicked **Explain with voice** on a selected recommendation.
- **Where it plays:** Locally on that participant’s companion device, preferably through headphones. No TTS audio may be published into the FaceTime/LiveKit room or shared Chert call. If speakers are used, acoustic microphone pickup can still leak audio; test and warn.
- **How it works:** The backend returns grounded explanation **text** tied to the selected recommendation ID and event evidence; the local UI handles TTS playback, stop/cancel, and an on-screen text fallback. Browser `speechSynthesis` is a candidate, not a finalized tested dependency.
- **Unchanged:** Continuous group-aware input during an explicitly consented active session; proactive quiet overlay advice; gaming-first hackathon MVP; mandatory event-based end-of-session review.
- **Dami/PITWALL reconciliation:** Adopt the private companion audio concept and modular Chert + Gemini + session-coordinator architecture, but **do not** expand MVP scope to iMessage, an always-on general assistant, a browser extension, or five separate modes.
