# fn-2.4 Implement validation executor, artifact persistence, and shared ready guard

## Description

Build runId-based validation execution with immutable redacted evidence, then enforce one shared guard wrapper across every ready-transition path.

**Size:** M
**Files:**

- `apps/www/src/app/api/internal/preview/validate/[threadId]/[runId]/route.ts`
- `apps/www/src/app/api/internal/preview/maintenance/route.ts`
- `apps/www/src/server-lib/preview-validation.ts`
- `apps/www/src/server-lib/github-pr.ts`
- `apps/www/src/server-lib/checkpoint-thread.ts`
- `apps/www/src/server-actions/mark-pr-ready.ts`
- `apps/www/src/server-actions/pull-request.ts`
- `apps/www/src/app/api/webhooks/github/route.ts`
- `packages/r2/src/index.ts`

## Approach

- Add `preview_validation_attempt` schema updates for artifact hashes/sizes and `matchedUiRulesJson`.
- Add `preview_validation_attempt` schema updates for artifact hashes/sizes, `matchedUiRulesJson`, `diffSourceContextJson`, and explicit 1-based `attemptNumber`.
- Enforce route runtime/auth contracts:
  - Node runtime + force-dynamic
  - maintenance route HMAC auth + production IP allowlist
  - maintenance HMAC keys come from namespace `terragon:v1:internal:hmac:*` with active/previous key rotation
  - route-level feature-flag gating returns `404` when `sandboxPreview` is disabled
- Use namespaced lease key `terragon:v1:preview:validate:lease:{env}:{threadId}:{runId}`.
- Use fixed retry schedule: immediate, +2m, +10m with +/-20% jitter, max 3 attempts.
- Add per-attempt hard timeout (8m) and force-kill semantics for hung validations.
- Gate attempt scheduling on `probeCapabilities().playwright.healthcheck`; mark unsupported when missing.
- Add maintenance backstop for runs stuck without terminal `endSha` to prevent indefinite hanging.
- Persist evidence with constraints:
  - redact secrets from logs via centralized pattern registry with provider extensions
  - gzip logs
  - size caps (10MB logs, 5MB screenshot, 25MB trace, 50MB video)
  - private bucket + signed URLs only
  - SHA-256 + byte-size persisted for integrity
  - immediate post-upload hash/size verification using metadata + second durable GET, plus read-path verification before decision usage
- Define pass criteria as required artifacts (`summary.json`, `trace.zip`, screenshot; video optional only with explicit unsupported reason).
- Persist capability probe snapshot and enforce that optional `videoUnsupportedReason` is only accepted when probe reported `video=false`.
- Mark hard-timeout outcomes with sentinel code/reason (`ETERRAGON_TIMEOUT`, `timeout_killed`) to distinguish from ordinary command failure.
- Centralize `withUiReadyGuard(action)` and apply to every ready-entry path (`openPullRequestForThread`, `markPRReadyForReview`, checkpoint auto-ready, reopen-after-push, webhook auto-ready).
- Guard writes/reads `thread_ui_validation` by `{threadId,threadChatId}` to avoid cross-chat collisions.
- Implement draft conversion idempotency key `{threadId,runId,'convert_to_draft'}` and treat GitHub 422 already-draft as success.
- Require all internal helper paths to call the shared wrapper (no direct PR transition bypasses).
- Maintain an explicit ready-entry callsite list used by tests and static verification so new paths fail closed until wrapped.

## Acceptance

- [ ] Validate/maintenance routes are lease-safe, authenticated, and runtime-correct.
- [ ] Attempt rows are immutable and include artifact integrity metadata.
- [ ] Attempt numbering/metadata are deterministic (`attemptNumber` 1-based, immutable, with fallback context persisted).
- [ ] Redaction registry, artifact size/access constraints, and post-upload/read hash verification are enforced before persistence/decision.
- [ ] Capability probe/video-unsupported consistency and timeout sentinel semantics are deterministic and test-covered.
- [ ] Guard wrapper covers all ready-entry callsites, including webhook/reopen/auto paths.
- [ ] Draft conversion is once-per-runId and retry-safe.
- [ ] Hard-timeout/hung-run kill semantics prevent validator and run-state deadlocks.
- [ ] Ready-state transition bypass tests + static checks cover every known entry point and fail on unwrapped additions.

## Test matrix

- Integration: lease/idempotency across concurrent validator invocations.
- Integration: artifact redaction + size cap rejection + hash persistence + post-upload/read verification.
- Integration: post-upload durable GET integrity check fails attempt on metadata/body mismatch.
- Integration: per-attempt hard timeout triggers kill path and timeout outcome.
- Integration: timeout outcomes persist `ETERRAGON_TIMEOUT` + `timeout_killed`.
- Integration: maintenance backstop finalizes missing-`endSha` stale runs.
- Unit: fallback `diffSourceContextJson` is persisted for SHA mismatch/head-read failure paths.
- Unit: ready-guard bypass coverage stays exhaustive across `openPullRequestForThread`, `markPRReadyForReview`, checkpoint auto-ready, reopen-after-push, and webhook auto-ready.
- Unit: static ready-entrypoint verification fails when new transition path skips `withUiReadyGuard`.
- Integration: conversion idempotency including GitHub 422 behavior.
- Integration: webhook + reopen-after-push + checkpoint auto-ready all invoke shared wrapper.

## Done summary

TBD

## Evidence

- Commits:
- Tests:
- PRs:
