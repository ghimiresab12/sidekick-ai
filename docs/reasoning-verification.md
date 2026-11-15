# Reasoning feature verification

Branch: feature/gemini-reasoning. Tests run on installed Node v26.13.1.
Published session-engine compatibility target: 1bc0e9f1414fdb18dbcb95f4f41b79d80a0e9a88.

| Check | Result |
| --- | --- |
| Offline Node tests | 80 passed, 0 failed, 0 skipped |
| Strict TypeScript check | Passed |
| Structural compatibility with published engine contracts | Passed |
| Published engine context-update acceptance | Passed in temporary copy |
| Published engine candidate acceptance / deduplication | Created then merged as expected |
| Published engine stale-context rejection | Passed after manual role correction |
| Paused-session reasoning | Blocked before inference |
| End-to-end synthetic mock demo | Passed; explicitly labeled offline mock |
| Live mode without credentials | Clear failure; no silent mock fallback or network call |
| Git diff whitespace check | Passed (only normal Windows line-ending notices) |
| Secret/config ignore rules | .env and .env.local ignored; node_modules ignored |
| Commit / push | Not performed during implementation verification; subsequently authorized by the user |

Coverage includes malformed data, invalid/future timestamps, wrong-session IDs, duplicate IDs,
missing evidence, fabricated quotes, separate condition/context lists, stale condition evidence
with fresh context, capture generations, current context revision, newer contradictory/unknown
screens, uncertain evidence, consent and lifecycle gating, explicit context extraction, unknown
speakers, manual role corrections, deterministic bounded card wording, provider failure, timeout,
cancellation, request shape, HTTP errors/rate limits, truncated/blocked responses, invalid JSON,
oversized responses, omitted raw media refs and sanitized error reporting.

## Not verified live

No Gemini credentials or model were configured, so no real Gemini request was made. Gemini request
format and response/error handling were tested with injected HTTP responses. Run the opt-in live
smoke command in reasoning.md once a server-only key and account-supported model are configured.
Real model accuracy, latency, account permissions and model schema support remain unverified.

No Chert call, screen ingestion, raw image interpretation, frontend overlay or local voice playback
was tested. Normalized screen summaries/facts are inputs to this component. Those integrations
remain owned by their respective teammates. Mock tests cannot establish factual model accuracy.

## Files and ownership

New implementation: src/reasoning/*.mts and src/adapters/model/{gemini,mock}.mts.
Tests/fixtures: tests/reasoning. Demo: examples/reasoning-demo.mjs.
Isolated development tooling and pinned lockfile: tools/reasoning.
Docs: README.md, docs/engineering.md, docs/techstack.md, docs/phases.md, docs/reasoning.md.
Credentials template: .env.example (empty values only).
No session-engine, shared-contract, Chert-adapter or frontend source was modified.

Use the commands in reasoning.md to reproduce checks. This is a scoped verification record,
not a claim that every possible input or the complete Sidekick application has been tested.

## Follow-up: real Gemini smoke test

On codex/gemini-schema-compatibility, gemini-3.5-flash-lite successfully completed the full synthetic
reasoning demo after simplifying the provider response schema. Result: ok=true, one accepted
recommendation candidate, both condition/context evidence lists populated, no withheld candidates.
82 offline tests and strict TypeScript checks pass. The original 80-test results and no-credentials
statements above describe the earlier implementation verification. Chert and raw media remain untested.
Credentials stayed in ignored .env and were not printed, staged or committed.

## Gemini vision and clock-skew follow-up (2026-11-15 UTC)

Branch: `codex/gemini-vision`, based on merged main `037229c`.

| Check | Observed result |
|---|---|
| Complete engine/coordinator/reasoning/vision suite | 353 passed, 0 failed, 0 skipped on Node v26.13.1 |
| Root TypeScript and reasoning compatibility checks | Both passed |
| Real Gemini vision, generated uncovered PNG | clear; visible=true, uncovered=true; 1485 ms |
| Real Gemini vision, generated covered PNG | clear; visible=true, uncovered=false; 1320 ms |
| Real Gemini vision, generated obscured PNG | partial; condition facts omitted; 2318 ms |
| Real Gemini vision, generated unrelated PNG | unknown; condition facts omitted; 2002 ms |
| First real full uncovered pipeline | Role extracted from synthetic transcript; one engine-approved card with separate screen/context IDs; 5030 ms |
| Later real full uncovered pipeline | Same supported outcome, 4097 ms |
| Full covered and obscured pipelines | No recommendations; no provider failures in these two runs |
| Repeated live requests | Some reasoning `provider_error` and one `vision_failed`; no mock fallback or fabricated card. Earlier failures lacked status diagnostics, so their cause is not established. |
| Automated lifecycle tests | Pause/end/discard abort the vision request and prevent late ingestion |
| Automated duplicate test | Three frames yield one recommendation-created event and no voice requests |
| Automated latency test | Capture time stays unchanged; a 16-second-old result produces no fresh card |
| Clock skew | 0/1000/5000 ms exact boundaries and +1 ms rejection; invalid configuration rejected; old evidence remains stale |
| Credential handling | Existing ignored `.env` loaded by Node; no keys printed or copied into this worktree |
| Git diff whitespace | Passed |

The model was the account-configured `gemini-3.5-flash-lite`. Measurements are
individual smoke observations, not latency guarantees or an accuracy benchmark.
PNG fixture generation was visually inspected. The four image-only calls passed;
the subsequent multi-scene full run was **not entirely successful** because of
intermittent provider failures. Content-free HTTP/finish-reason diagnostics were
added afterward; a later uncovered pipeline succeeded. Do not erase the failures
or label the integration production-ready from these few scenes.

No real Chert, FaceTime, microphone, captured user screen, frontend or private
speech path was exercised here. Shared ports, session engine, coordinator behavior,
Chert adapter and overlay source remain unchanged. Sabik still owns adoption of
clock skew in coordinator selection and supersession. The adapter implements a
controlled soccer scene profile; arbitrary commercial games remain unverified.

Reproduce with `npm run typecheck`, `npm run test:all`, and the commands in
[vision.md](vision.md). The new CI workflow runs offline checks only; live provider
tests require an explicitly configured ignored environment file.
