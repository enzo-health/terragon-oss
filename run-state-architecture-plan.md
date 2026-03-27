# Plan: Run-State Architecture for Resilient Agent + Sub-Agent Execution

**Generated**: 2026-03-26
**Estimated Complexity**: High

## Overview

Replace transcript-driven retry behavior with an explicit run-state execution model that enforces hard turn-size budgets, deterministic compaction, isolated sub-agent child runs, and typed terminal errors. The target outcome is to eliminate unrecoverable retry amplification loops (like repeated `turn/start` payload overflows), reduce `agent-generic-error` ambiguity, and make failures actionable at the first occurrence.

## Prerequisites

- Production telemetry access for validation (DB + daemon logs + sandbox logs).
- Existing Delivery Loop v3 retry plumbing available in `apps/www/src/server-lib/delivery-loop/*`.
- Codex app-server transport enabled paths (`codex-app-server`) in daemon and web app.
- Feature flag for staged rollout of new run-state behavior.

## Sprint 1: Failure Taxonomy + Run Diagnostics Foundation

**Goal**: Stop treating root-cause failures as generic; persist structured diagnostics per run/turn.
**Demo/Validation**:

- A failed run surfaces structured `failureClass`, `failureSignature`, and provider details.
- `agent-generic-error` appears only as compatibility fallback, not primary diagnosis.

### Task S1-T1: Expand typed failure classes for Codex transport

- **Location**: `apps/www/src/agent/daemon.ts`, `packages/shared/src/delivery-loop/domain/failure-signature.ts`, `packages/shared/src/db/types.ts`
- **Description**: Add explicit categories for `turn_input_too_large`, `app_server_exit_mid_turn`, `ws_connect_timeout`, `config_invalid_provider`, and `subagent_child_failure`.
- **Dependencies**: []
- **Acceptance Criteria**:
  - Known signatures map to deterministic categories instead of broad generic buckets.
  - Existing categories remain backward-compatible for analytics.
- **Validation**:
  - `pnpm -C packages/shared test -- failure-signature`
  - `pnpm -C apps/www test -- agent/daemon`
- **Status**: completed
- **Work Log**:
  - Added explicit Codex transport failure categories in shared domain/types:
    `turn_input_too_large`, `app_server_exit_mid_turn`, `ws_connect_timeout`,
    `config_invalid_provider`, `subagent_child_failure`.
  - Updated daemon-side classifier and delivery-loop adapter classifier to map
    concrete error signatures into these typed categories.
  - Extended failure signature classification/tests to recognize and policy-map
    the new transport categories.
  - Files touched:
    - `apps/www/src/agent/daemon.ts`
    - `apps/www/src/server-lib/delivery-loop/adapters/shared.ts`
    - `packages/shared/src/db/types.ts`
    - `packages/shared/src/delivery-loop/domain/failure.ts`
    - `packages/shared/src/delivery-loop/domain/failure-signature.ts`
    - `packages/shared/src/delivery-loop/domain/failure-signature.test.ts`

### Task S1-T2: Persist structured run/turn failure metadata

- **Location**: `packages/shared/src/db/schema.ts`, `packages/shared/src/db/types.ts`, `apps/www/src/server-lib/handle-daemon-event.ts`
- **Description**: Add normalized run failure fields (category, raw source, retryable, signature hash, terminal reason) to thread chat/run context writes.
- **Dependencies**: [S1-T1]
- **Acceptance Criteria**:
  - Failures are queryable without parsing freeform `error_info`.
  - Existing UI behavior remains functional.
- **Validation**:
  - Migration + model tests in `packages/shared/src/model/*.test.ts`
  - `pnpm tsc-check`
- **Status**: completed
- **Work Log**:
  - Added normalized failure metadata columns to `agent_run_context`:
    `failure_category`, `failure_source`, `failure_retryable`,
    `failure_signature_hash`, `failure_terminal_reason`.
  - Wired `handle-daemon-event` to compute failure metadata from terminal
    outcomes and persist it on the associated `runId` row.
  - Kept thread-chat compatibility by continuing to use existing
    `error_message` + `error_message_info` as user-facing terminal error fields.
  - Added e2e coverage for run-context metadata persistence on error flow.
  - Files touched:
    - `packages/shared/src/db/schema.ts`
    - `packages/shared/src/db/types.ts`
    - `apps/www/src/server-lib/handle-daemon-event.ts`
    - `apps/www/src/server-lib/e2e.test.ts`

### Task S1-T3: Capture app-server exit diagnostics at source

- **Location**: `packages/daemon/src/codex-app-server.ts`, `packages/daemon/src/daemon.ts`
- **Description**: Attach exit code, signal, last stderr excerpt, and request method context to emitted failures.
- **Dependencies**: [S1-T1]
- **Acceptance Criteria**:
  - `codex app-server exited unexpectedly during turn` includes structured cause context.
  - Crash-loop detection can key on signature, not just message substring.
- **Validation**:
  - `pnpm -C packages/daemon test -- codex-app-server daemon`
- **Status**: completed
- **Work Log**:
  - Added app-server diagnostics surface on manager:
    `lastExitCode`, `lastExitSignal`, `lastExitSource`, `lastStderrLine`,
    `lastRequestMethod`.
  - Captured diagnostics during stderr, request dispatch, and process close/exit.
  - Enriched emitted daemon turn-failure messages with diagnostics context so
    `agent-generic-error` records include actionable source details.
  - Files touched:
    - `packages/daemon/src/codex-app-server.ts`
    - `packages/daemon/src/daemon.ts`

## Sprint 2: Turn Budgeting + Deterministic Compaction

**Goal**: Prevent oversized `turn/start` requests before they are sent.
**Demo/Validation**:

- Any prompt above budget is compacted before dispatch.
- No retries send payloads above configured threshold.

### Task S2-T1: Introduce prompt payload budget preflight

- **Location**: `apps/www/src/agent/msg/startAgentMessage.ts`, `packages/daemon/src/codex.ts`
- **Description**: Compute serialized turn payload size before dispatch; reject/compact if above budget (e.g. soft: 900KB, hard: 1MB).
- **Dependencies**: [S1-T2]
- **Acceptance Criteria**:
  - Oversized payloads never reach `manager.send({ method: "turn/start" })`.
  - Budget decision is logged with exact measured size.
- **Validation**:
  - New tests in `packages/daemon/src/codex.test.ts` and `apps/www/src/agent/thread-resource.test.ts`
- **Status**: completed
- **Work Log**:
  - Added hard/soft turn payload budget constants and request-size estimator in daemon codex transport module.
  - Added daemon-side preflight guard immediately before `turn/start`; now logs measured payload size and rejects oversized requests with explicit max-length diagnostics.
  - Added app-side codex preflight sizing before dispatch in `startAgentMessage`; above soft threshold triggers forced compaction summary injection and session reset, above hard threshold throws `prompt-too-long` pre-dispatch.
  - Added targeted unit coverage for request-size estimation behavior.
  - Files touched:
    - `packages/daemon/src/codex.ts`
    - `packages/daemon/src/codex.test.ts`
    - `packages/daemon/src/daemon.ts`
    - `apps/www/src/agent/msg/startAgentMessage.ts`

### Task S2-T2: Build deterministic compaction pipeline for retry context

- **Location**: `apps/www/src/server-lib/handle-daemon-event.ts`, `apps/www/src/server-lib/thread-context.ts`, `apps/www/src/server-lib/checkpoint-thread-internal.ts`
- **Description**: Replace additive retry text growth with bounded compaction policy (drop redundant system/retry chatter, summarize tool/log blobs, preserve decisions + TODO state).
- **Dependencies**: [S2-T1]
- **Acceptance Criteria**:
  - Retry context size decreases monotonically after compaction path executes.
  - System keeps enough state for continuity without replaying full transcript.
- **Validation**:
  - `pnpm -C apps/www test -- handle-daemon-event checkpoint-thread-internal`

### Task S2-T3: Add pointer-based artifact references for large tool/log outputs

- **Location**: `apps/www/src/agent/msg/startAgentMessage.ts`, `apps/www/src/server-lib/handle-daemon-event.ts`, `packages/shared/src/db/schema.ts`
- **Description**: Store large payloads as artifact references and include compact pointers in prompt context.
- **Dependencies**: [S2-T2]
- **Acceptance Criteria**:
  - Prompt context carries IDs/summaries instead of full large blobs.
  - Artifact retrieval remains available for UI/debugging.
- **Validation**:
  - Targeted DB/model tests + prompt formatting tests.

## Sprint 3: Run Orchestrator State Machine + Retry Controller

**Goal**: Make retries stateful, bounded, and idempotent.
**Demo/Validation**:

- Repeated same-signature error without state change no longer loops.
- Retries require mutation (`compacted`, `restarted`, or `scope-reduced`) before re-dispatch.

### Task S3-T1: Define explicit run-state machine and transitions

- **Location**: `apps/www/src/server-lib/delivery-loop/v3/process-effects.ts`, `apps/www/src/server-lib/handle-daemon-event.ts`
- **Description**: Introduce run states (`building_turn`, `running`, `compacting`, `retrying`, `terminal_failed`, `succeeded`) and transition guards.
- **Dependencies**: [S2-T2]
- **Acceptance Criteria**:
  - Every retry attempt records transition reason and previous state.
  - Illegal transitions are rejected and logged.
- **Validation**:
  - Add state transition tests under `apps/www/src/server-lib/delivery-loop/v3/*.test.ts`

### Task S3-T2: Make retry policy signature-aware and state-change-aware

- **Location**: `apps/www/src/server-lib/delivery-loop/retry-policy.ts`, `apps/www/src/server-lib/handle-daemon-event.ts`
- **Description**: Extend retry policy to block identical retry when signature and context digest are unchanged.
- **Dependencies**: [S3-T1]
- **Acceptance Criteria**:
  - Same oversized-input failure cannot retry unchanged.
  - Retry budget is tracked per `(threadChatId, signature, contextDigest)`.
- **Validation**:
  - `pnpm -C apps/www test -- delivery-loop/retry-policy handle-daemon-event`

### Task S3-T3: Replace unconditional queued "Continue" with intented retry actions

- **Location**: `apps/www/src/server-lib/handle-daemon-event.ts`, `apps/www/src/server-lib/delivery-loop/v3/process-effects.ts`
- **Description**: Queue specific recovery intents (`retry_after_compact`, `retry_after_restart`, `needs_human_intervention`) instead of raw `Continue`.
- **Dependencies**: [S3-T2]
- **Acceptance Criteria**:
  - Retry action is explicit in persisted message/event metadata.
  - No blind `Continue` loops on terminal non-retryable failures.
- **Validation**:
  - `pnpm -C apps/www test -- handle-daemon-event delivery-loop/v3/process-effects`

## Sprint 4: Sub-Agent Isolation Model

**Goal**: Stop parent-run context explosion from sub-agent transcripts.
**Demo/Validation**:

- Parent run receives child result envelopes only.
- Sub-agent failures are scoped and diagnosable without inflating parent turn payload.

### Task S4-T1: Define child-run envelope contract

- **Location**: `packages/daemon/src/codex-app-server.ts`, `packages/shared/src/db/types.ts`, `packages/shared/src/db/schema.ts`
- **Description**: Add typed child-run envelope (`childRunId`, `objective`, `resultSummary`, `artifactRefs`, `status`, `failureClass`).
- **Dependencies**: [S1-T2]
- **Acceptance Criteria**:
  - Parent context stores envelope, not full child transcript.
  - Child envelope supports success and failure variants.
- **Validation**:
  - `pnpm -C packages/daemon test -- codex-app-server`

### Task S4-T2: Persist child-run records and link to parent thread chat

- **Location**: `packages/shared/src/model/agent-run-context.ts`, `apps/www/src/app/api/daemon-event/route.ts`
- **Description**: Store child run entries with parent linkage and artifact pointers.
- **Dependencies**: [S4-T1]
- **Acceptance Criteria**:
  - Trace view can show parent/child lineage for each run.
  - Failures in child runs do not collapse into parent generic error.
- **Validation**:
  - API route and model tests for lineage + retrieval.

### Task S4-T3: Update prompt builder to include child summaries only

- **Location**: `apps/www/src/agent/msg/startAgentMessage.ts`, `apps/www/src/lib/thread-to-msg-formatter.ts`
- **Description**: Inject compact child-run summary blocks; omit verbose child events by default.
- **Dependencies**: [S4-T2, S2-T3]
- **Acceptance Criteria**:
  - Parent turn payload growth remains bounded despite sub-agent activity.
  - Optional deep drill-down available via artifact refs.
- **Validation**:
  - Prompt formatter tests + payload budget tests.

## Sprint 5: Rollout, Backfill, and Operational Guardrails

**Goal**: Ship safely with measurable regression protection.
**Demo/Validation**:

- Canary traffic shows reduced `agent-generic-error` and zero repeated payload-overflow loops.
- On-call can triage top failures from structured dimensions.

### Task S5-T1: Add feature flags and staged rollout controls

- **Location**: `packages/shared/src/model/feature-flags-definitions.ts`, `apps/www/src/agent/msg/startAgentMessage.ts`, `apps/www/src/server-lib/handle-daemon-event.ts`
- **Description**: Gate run-state orchestration, size preflight, and sub-agent envelope features for canary rollout.
- **Dependencies**: [S3-T3, S4-T3]
- **Acceptance Criteria**:
  - Flags can enable/disable each major behavior independently.
  - Rollback path is configuration-only.
- **Validation**:
  - Feature-flag unit tests + smoke test in staging.

### Task S5-T2: Add observability dashboards and SLO alerts

- **Location**: `apps/www/src/server-lib/handle-daemon-event.ts`, metrics/log pipeline configs
- **Description**: Emit metrics for `turn_payload_bytes`, `compaction_invocations`, `retry_blocked_same_signature`, `child_run_failure_rate`, `app_server_exit_rate`.
- **Dependencies**: [S1-T3, S3-T2, S4-T2]
- **Acceptance Criteria**:
  - Dashboards expose failure funnel by category and state transition.
  - Alerts trigger before loops exhaust retry budgets widely.
- **Validation**:
  - Staging replay of known failing sessions confirms metrics.

### Task S5-T3: Backfill analyzer for historical generic errors

- **Location**: `scripts/` (new analysis script), `packages/shared/src/model/threads.ts`
- **Description**: Reclassify recent `agent-generic-error` rows into new typed buckets for baseline comparisons.
- **Dependencies**: [S1-T1, S1-T2]
- **Acceptance Criteria**:
  - 30/90-day baseline available by new failure taxonomy.
  - Report highlights migration impact and unresolved unknowns.
- **Validation**:
  - Dry run + production-safe read-only execution.

## Testing Strategy

- Unit tests for taxonomy mapping, preflight budget checks, and retry gating.
- Integration tests for end-to-end failure paths:
  - app-server crash mid-turn
  - payload > 1MB
  - repeated identical failure without state change
  - sub-agent child failure propagation
- Replay tests using sanitized real event sequences from today’s run to verify no retry amplification.
- Staging canary with feature flags and side-by-side legacy vs run-state metrics.

## Potential Risks & Gotchas

- Prompt budget measured by character count may diverge from true serialized RPC size if not normalized consistently.
- Over-aggressive compaction can drop critical implementation context and degrade success rate.
- Child-run envelope design can under-specify enough detail for debugging if artifact references are brittle.
- Mixed-mode rollout (legacy + run-state) can produce inconsistent retry behavior unless routing is explicit.
- Existing UI surfaces may still assume `agent-generic-error`; update paths must remain backward-compatible during migration.

## Rollback Plan

- Keep legacy retry/continue behavior behind inverse feature flag while run-state ships in canary.
- If regression is detected:
  - Disable run-state transitions and envelope mode via flags.
  - Revert to legacy prompt building and retry flow without schema rollback.
  - Preserve new diagnostics writes (read-only impact) to retain incident insight.

## Locked Decisions

- **Budget thresholds**: Keep `900KB soft / 1MB hard` for Codex turn payloads.
- **Compaction trigger**: Trigger on preflight budget breach and on known size-related failure signatures.
- **Retry rule (size-related failures)**: Compaction is required before any retry.
- **Retry cap**: Keep max attempts at 3 and require context/state digest change between attempts.
- **Child envelope depth**: Use the recommended path: summary + artifact refs by default; full child transcript retrieval remains opt-in.
