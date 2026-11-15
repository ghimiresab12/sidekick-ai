# Gemini reasoning component

This component proposes context changes and gaming advice. It never updates session state,
publishes cards, operates Chert, or plays audio. Sabik's engine validates and accepts proposals,
assigns IDs, deduplicates, and controls their lifecycle. Voice remains private/local in the UI.

## Run it in VS Code

Use Node 24 or newer. From the repository root:

```powershell
node --test tests/reasoning/*.test.mjs
node examples/reasoning-demo.mjs
```

If Windows has not refreshed PATH, replace `node` with `& "C:\Program Files\nodejs\node.exe"`.
The demo prints `OFFLINE MOCK / NO GEMINI CALL / NO CHERT`. It uses only synthetic fixtures.
The two original learning JSON files and `evidence.test.mjs` are retained; the real module uses
`normalized-left-defense.json`, matching the published engine observation shape.

Optional development tooling is isolated to avoid changing the session engine's package files:

```powershell
npm --prefix tools/reasoning ci
npm --prefix tools/reasoning run typecheck
npm --prefix tools/reasoning run check:contracts
```

The contract check reads pinned Git objects, extracts the session engine into a fresh OS temporary
directory, typechecks compatibility, builds that copy, and exercises candidate acceptance and
deduplication. It never merges a branch or changes engine files in this checkout. The temporary
directory is printed and retained for debugging. It requires the published engine commit to be
available locally; fetch `origin feature/session-engine` if necessary.

## Learn the flow

1. `contracts.mts`: describes normalized observations and the small read-only session context.
2. `validation.mts`: rejects malformed input and malformed model output before use.
3. `prompt.mts`: sends an allowlisted subset of data and a structured JSON schema to Gemini.
4. `adapters/model/gemini.mts`: calls the documented generateContent REST endpoint with built-in fetch.
5. `reason.mts`: enforces evidence links, freshness, generation, role provenance and the single tactical rule.
6. `adapters/model/mock.mts`: narrow deterministic simulator with the same boundary; no AI claims.

Gemini interprets normalized screen descriptions/facts and conversation and proposes advice. This
module does not fetch `frameRef`, ingest raw pixels, transcribe audio, or claim live visual perception.
Normalized summaries must be supplied upstream. A raw-frame model adapter is a separate integration
step once the screen pathway is verified.

## Contract with Sabik

Verified against `feature/session-engine` commit `1bc0e9f1414fdb18dbcb95f4f41b79d80a0e9a88`.
The structural boundary types intentionally use only fields consumed here; the shared contracts
are not copied into or modified under `src/contracts`. The compatibility check verifies that
engine `SessionSnapshot` and `Observation` objects are assignable and our candidates satisfy
the engine's `RecommendationCandidate`.

```typescript
const result = await reason({
  session: snapshot,
  observations, // ENGINE-INGESTED objects, carrying id/sessionId/source/generation
  now: engineClock.toISOString(),
  staleAfterMs: engineConfig.staleAfterMs
}, provider, { signal });
```

`ConversationInput` and `ScreenInput` are pre-ingestion shapes with no evidence IDs. Ingest them
through the engine first, then pass the resulting observations. Never invent IDs for production.

Returned `contextUpdates` are proposals with exact supporting excerpts:

| Proposal | Engine handoff owned by integrator |
| --- | --- |
| role_assignment | `assignRole` with transcript provenance; do not bypass manual correction precedence |
| group_goal | `setGoal` with transcript provenance |
| activity_identification | `suggestActivity`; users still confirm |
| participant_decision | `recordDecision` with conversation evidence |

Apply context proposals first when desired, re-read the snapshot, and rerun reasoning if the
context revision changes. Do not relabel old candidates with a new revision. Context and
recommendations returned in one batch were computed against the ORIGINAL snapshot.

Pass approved candidates to `proposeRecommendation`. Before acceptance, re-read lifecycle,
context revision, capture generation and the actual clock. Abort in-flight reasoning on Pause/End.
The engine remains the final authority, including rejecting results that went stale during a call.

Each candidate has `conditionObservationIds` and separate `contextObservationIds`. Only screen
condition evidence drives freshness in this narrow gaming rule. Old context can explain a role,
but cannot refresh old gameplay. All cited conditions must be current-generation, recent, clear,
and include the latest provided screen timestamp. A later unknown frame suppresses earlier advice.
The caller must include the latest relevant screen; this module cannot detect omitted observations.

Freshness uses caller-supplied `staleAfterMs`. The demo's 10 seconds is a fixture setting, not a
team-wide production choice. Future timestamps are conservatively rejected (no skew tolerance).
Partial/unknown scene evidence is withheld rather than producing confident suggestions.

`facts.leftZoneVisible` and `facts.leftZoneUncovered` are optional demo rule keys within Sabik's
generic `ScreenFacts`, not Chert fields. The deterministic mock requires them; Gemini can interpret
summaries without them. Explicit contradictory facts always suppress the candidate.

## Real Gemini smoke test (optional and billable)

Use a server-only `.env` (already ignored) with `GEMINI_API_KEY` and `GEMINI_MODEL`. The model must
be available in your account and support generateContent structured JSON output. No model/version
is silently chosen. `.env.example` contains names only. Never put keys in the frontend or Git.

```powershell
node --env-file=.env examples/reasoning-demo.mjs --live
```

This sends only the synthetic fixture to Gemini. A successful call checks transport and output
validation; it does not verify live Chert, raw image interpretation, overlay, or private speech.
No automatic retry or mock fallback is used on provider errors. Production code logs no prompts,
responses or credentials. Errors return bounded codes rather than raw provider messages.

Reference: [Google generateContent REST](https://aistudio.google.com/api-reference/generate-content/generate-content).

## Limits and verification honesty

Evidence-ID existence and exact supporting quotes are checked in code. Role/goal/decision proposals
also require narrow affirmative wording; unsupported paraphrases are withheld rather than guessed.
The final card title and advice are rendered locally from the accepted left-defense rule and known
participant names, so arbitrary model prose cannot add scores or outcomes to a card. These checks
still do not prove that Gemini's scene interpretation logically follows from the quoted evidence;
human evaluation with real Gemini remains necessary. This is not a general hallucination detector.
Mock regex extraction is deliberately limited and is never used as an undisclosed fallback.

No persistent storage, session mutation, UI, voice delivery, Chert SDK calls, or raw media retention
is added. Input/output sizes and timeouts are bounded. Cancellation is propagated and late results
must still pass the engine's current-state checks. No commits or pushes are performed by these tools.

## Live Gemini schema compatibility verification

A synthetic live smoke test with gemini-3.5-flash-lite returned HTTP 400 with the original constrained
response schema. Minimal generation and a simple JSON schema succeeded. Removing maxItems and
additionalProperties from the provider schema made the full request succeed. This identifies a
compatibility problem in this request, not a claim that these keywords are universally unsupported.
The local validator still enforces array limits, allowed fields, evidence scope and freshness.
The prompt now explicitly requires exact quotes for every cited context AND condition observation.

The final end-to-end live smoke test returned ok=true and one validated left-defense candidate citing
screen-1 and conversation-1, with no withheld candidates. The input was synthetic; no private call
content was sent. This verifies this model/request combination once, not general model accuracy,
latency guarantees or Chert integration. New checks pass: 82 offline tests and strict TypeScript.
