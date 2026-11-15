# Gemini vision: controlled soccer MVP

The adapter is implemented in `src/adapters/model/gemini-vision.mts`. It implements
Sabik's published `VisionPort` without changing the engine, coordinator, Chert
adapter or overlay. Node 24+ is required. No new runtime dependencies.

## What it understands

Use profile `controlled-soccer-v1` explicitly. The image must show a top-down green
soccer field with white pitch markings, a yellow outline around the screen-left
third, blue circular defenders, and red circular opponents. The entire yellow
zone must be visible to assess coverage. A red opponent does not provide coverage.
An ambiguous boundary marker, crop, obstruction, or uncertain team color means
unknown. This profile is not a detector for arbitrary soccer games or F1.

Gemini returns only `scene`, `zoneVisibility`, and `coverage` enums. Local code
validates the combination, creates a bounded summary, and sets the agreed facts:

| Visible situation | Quality | Facts |
|---|---|---|
| Entire zone, no blue defenders | clear | visible=true, uncovered=true |
| Entire zone, blue defender inside | clear | visible=true, uncovered=false |
| Entire zone, uncertain coverage | partial | visible=true; uncovered omitted |
| Obscured/cropped zone | partial or unknown | omitted |
| Unrelated/uncertain scene | unknown | omitted |

Facts are named `leftZoneVisible` and `leftZoneUncovered`. Missing facts are not
false. No player identity, score, motion, outcome, or instruction is extracted
from image text. Enum validation cannot prove the model interpreted pixels
correctly; scene evaluation remains necessary.

## Run the demonstration

From the repo root:

```powershell
npm ci
npm run typecheck
npm run test:all
node examples/vision-demo.mjs
```

This runs four synthetic PNG scenes through the actual adapter, coordinator,
engine, and reasoning module using **injected mock HTTP responses**. It verifies
plumbing, not visual perception. It uses separate sessions for each scene, so it
does not imply automatic resolution of an existing card.

For real Gemini, configure the existing ignored `.env` with `GEMINI_API_KEY` and
an account-supported image/structured-output `GEMINI_MODEL`. Never paste keys into
chat, browser code, or Git. These commands can incur provider usage:

```powershell
# Four actual image analyses; no engine build required for this command.
node --env-file=.env examples/vision-demo.mjs --live --vision-only
# Full pipeline, including real Gemini extraction of Alex's synthetic role.
node --env-file=.env examples/vision-demo.mjs --live --scene uncovered
```

Both commands send generated synthetic images only; the full demo also sends a
synthetic transcript. No screen capture, microphone, Chert call, UI, or speech
playback is started. Output is explicitly labeled. The demo exits nonzero on
provider failure; it never substitutes a mock response. HTTP diagnostics contain
only status codes, and reasoning diagnostics use bounded codes. A 429 means wait
for the account's rate limit to recover; do not repeatedly hammer the endpoint.

`examples/vision-fixtures.mjs` generates the four PNGs in memory with Node zlib;
no downloaded images, personal frames or checked-in binary recordings are needed.

## Handoff to Sabik

```typescript
const vision = createGeminiVision({
  apiKey: process.env.GEMINI_API_KEY!,
  model: process.env.GEMINI_MODEL!,
  profile: VISION_PROFILE,
});
const coordinator = new SidekickCoordinator({
  vision,
  reasoning: (input, signal) => reason(input, reasoningProvider, { signal }),
  conditionFactKeys: [...VISION_FACT_KEYS],
});
```

The adapter accepts PNG/JPEG/WebP bytes, validates MIME signatures and a maximum
5 MiB budget, and snapshots encoded bytes before awaiting network I/O. Frames also
carry an explicit `mediaSource`: `screen_share` is eligible for this soccer prompt;
`camera` returns unknown/unsupported evidence locally and is never sent to Gemini
by this profile. Signature checks are not a full decoder; malformed image data can still be rejected by
Gemini. The coordinator preserves capture-time generation and timestamp and gates
consent/lifecycle before calling it. Do not call vision directly on private frames
without that lifecycle gate.

Default timeout is 15 seconds, including response reading. Concurrent requests
are bounded to one per adapter by default; extra calls reject with `busy` and
are never queued. Capture should sample/drop frames while a request is in flight.
Pause/end/discard cancels the HTTP request and late results are discarded. The
adapter does not retain frames, use a Files API, fetch frame URLs, or log content.
Sending an inline image still sends it to Google's service; local non-retention
does not make a claim about provider data policies.

The engine remains authoritative for evidence freshness. Slow inference does not
change capture time. Configure cadence and stale windows deliberately after real
capture measurements; never make evidence appear fresh by rewriting timestamps.

## Clock-skew handoff

Reasoning accepts optional `maxClockSkewMs`, a safe integer from 0 to 5000, default
0. It tolerates source `observedAt <= now + skew`; engine `receivedAt` remains
`<= now`. It does not extend the existing stale window or change generations.
Sabik can pass the engine's configured skew after updating observation selection
and supersession consistently. His current clock-wait workaround remains intact
in this branch. The shared `ReasoningRequest` port is deliberately unchanged.

## Remaining integration gates

Real Chert frame/transcript ingestion, UI wiring, private local speech, and live
session review still require team integration. (The authenticated bridge now wires
this adapter when `SIDEKICK_VISION=gemini`; see `engineering.md` "Integration
milestone 3". That path is tested with mocked Gemini HTTP only.) This adapter
does not complete those acceptance gates. See `reasoning-verification.md` for
actual tests and live results rather than treating mocks as live proof.
