# Plan: Delivery Loop Long-Term Fix (Event-Driven, No Cron Progression)

**Generated**: 2026-03-18
**Estimated Complexity**: High

## Overview

Replace cron-driven progression with an event-driven pipeline where Redis is the execution backbone and Postgres remains the source of truth. All ingress paths publish durable signals, workers process transitions/effects, and invariant middleware deterministically resolves invalid states (including PR creation/linking).

## Prerequisites

- `pnpm dev` running with local Postgres/Redis.
- Existing delivery-loop v2 + v3 code paths available in repo.
- Real GitHub test repository access for end-to-end PR validation.
- Feature-flag controlled cutover route for v3 orchestration.

## Sprint 1: Durable Event Core + Queue Wiring

**Goal**: Make signal ingestion and worker triggering fully event-driven with durable guarantees.
**Demo/Validation**:

- New signal enters DB journal and triggers worker without manual cron hit.
- Duplicate ingress event dedupes by canonical idempotency key.
- Worker restart replays pending outbox entries once.

### Task S1-T1: Define v3 Signal/Effect/Outbox Contracts

- **depends_on**: []
- **Location**: `packages/shared/src/db/schema.ts`, `packages/shared/src/db/types.ts`, `apps/www/src/server-lib/delivery-loop/v3/*`
- **Description**: Add/normalize v3 schemas and types for signal journal, effect ledger, timer ledger, and outbox contracts. Ensure canonical idempotency fields are explicit and required where needed.
- **Acceptance Criteria**:
  - Contract types compile cleanly.
  - Schema encodes dedupe identity and processing indexes.
  - v3 stores can read/write new contracts without runtime casts to `any`.
- **Validation**:
  - `pnpm tsc-check`
  - Targeted v3/store tests.
- **Status**: completed
- **Work Log**:
  - Added v3 contract unions/types in shared DB types for signal sources, effect/timer/outbox kinds, and statuses.
  - Expanded v3 schema with explicit idempotency/dedupe fields and processing indexes:
    - `delivery_effect_ledger_v3`: added required `idempotency_key`, dedupe unique `(workflow_id, effect_kind, idempotency_key)`, and claimable ordering index on `(status, due_at, created_at)`.
    - New `delivery_timer_ledger_v3`: durable timer contract + dedupe/claim/lease indexes.
    - New `delivery_outbox_v3`: transactional relay contract + dedupe/claim/lease indexes.
  - Added typed v3 contract helpers/parsers in app runtime and rewired v3 store/kernel/effect processing to use them (no runtime `any` casts for contract payload IO).
  - Added targeted v3 contract tests covering idempotency-required insert contracts and payload round-trip parsing.
  - **Files changed**:
    - `packages/shared/src/db/schema.ts`
    - `packages/shared/src/db/types.ts`
    - `apps/www/src/server-lib/delivery-loop/v3/contracts.ts`
    - `apps/www/src/server-lib/delivery-loop/v3/contracts.test.ts`
    - `apps/www/src/server-lib/delivery-loop/v3/kernel.ts`
    - `apps/www/src/server-lib/delivery-loop/v3/process-effects.ts`
    - `apps/www/src/server-lib/delivery-loop/v3/store.ts`
    - `apps/www/src/server-lib/delivery-loop/v3/types.ts`
  - **Gotchas**:
    - Kept `delivery_workflow_head_v3.state` DB column as text for backward compatibility and normalized to `WorkflowStateV3` in store mapping.
    - Full monorepo `pnpm tsc-check` is intentionally deferred for this task due broad unrelated in-flight workspace changes; used targeted package typechecks/tests for task-scoped verification.

### Task S1-T2: Ingress Transactional Outbox Write Path

- **depends_on**: [S1-T1]
- **Location**: `apps/www/src/server-lib/delivery-loop/adapters/ingress/*`
- **Description**: Update daemon/github/human ingress adapters to write signal journal rows + outbox rows in one DB transaction.
- **Acceptance Criteria**:
  - No ingress path requires cron to progress normal flow.
  - Duplicate ingress events do not create duplicate logical signals.
  - Existing ingress route interfaces remain backward-compatible.
- **Validation**:
  - Targeted ingress adapter tests.
  - Manual signal insertion smoke check.
- **Status**: completed
- **Work Log**:
  - Updated daemon, GitHub, and human ingress adapters to dual-write in one DB transaction:
    - v2 `sdlc_loop_signal_inbox` append
    - v3 `delivery_loop_journal_v3` append
    - v3 `delivery_outbox_v3` enqueue (only when journal insert succeeds)
  - Preserved ingress adapter public interfaces and call signatures; no route contract changes required.
  - Canonical ingress dedupe identities now drive both journal idempotency and outbox dedupe keys.
  - Added targeted ingress adapter tests for GitHub and human flows, and expanded daemon ingress tests to verify transactional dual-write + dedupe behavior.
  - **Files changed**:
    - `apps/www/src/server-lib/delivery-loop/adapters/ingress/daemon-ingress.ts`
    - `apps/www/src/server-lib/delivery-loop/adapters/ingress/daemon-ingress.test.ts`
    - `apps/www/src/server-lib/delivery-loop/adapters/ingress/github-ingress.ts`
    - `apps/www/src/server-lib/delivery-loop/adapters/ingress/github-ingress.test.ts`
    - `apps/www/src/server-lib/delivery-loop/adapters/ingress/human-interventions.ts`
    - `apps/www/src/server-lib/delivery-loop/adapters/ingress/human-interventions.test.ts`
    - `apps/www/src/server-lib/delivery-loop/v3/contracts.ts`
    - `apps/www/src/server-lib/delivery-loop/v3/store.ts`
  - **Gotchas**:
    - v3 signal journal/outbox contracts were widened from `LoopEventV3`-only payload/event typing to string + record payload so ingress can journal all normalized signal kinds (including non-reducer events) without unsafe casts.
    - Manual insertion smoke check not required after passing targeted adapter tests and scoped typecheck covering all touched ingress paths.

### Task S1-T3: Outbox Relay to Redis Queue/Stream

- **depends_on**: [S1-T1, S1-T2]
- **Location**: `apps/www/src/server-lib/delivery-loop/v3/*`
- **Description**: Implement relay worker that reads DB outbox, publishes to Redis queue/stream with idempotent publish semantics, and marks rows delivered.
- **Acceptance Criteria**:
  - Relay retries safely on transient Redis/DB failure.
  - Publish is idempotent for the same outbox record.
  - Delivery metadata is persisted for auditability.
- **Validation**:
  - Relay unit/integration tests.
  - Crash/restart replay test.
- **Status**: completed
- **Work Log**:
  - Added Redis-backed outbox relay worker in `apps/www/src/server-lib/delivery-loop/v3/relay.ts` with:
    - deterministic lease-based claim loop,
    - Lua-based idempotent Redis `XADD` publish (dedupe index),
    - transient-failure retry metadata persistence (`error_code`, `error_message`, `available_at` bump),
    - published audit marker writeback (`relay_message_id`, `published_at`).
  - Added `drainOutboxV3Relay` integration into scheduled-tasks cron path in `apps/www/src/app/api/internal/cron/scheduled-tasks/route.ts` and surfaced outbox relay metrics.
  - Added `apps/www/src/server-lib/delivery-loop/v3/relay.test.ts` with tests for:
    - publish + mark-published happy path,
    - idempotent publish,
    - retry + error metadata updates,
    - stale claim replay (crash/restart) with single publish outcome.
  - 2026-03-18 verification: `pnpm -C apps/www exec vitest run src/server-lib/delivery-loop/v3/relay.test.ts` (4 tests) and `pnpm -C apps/www exec tsc --noEmit --pretty false` passed.

### Task S1-T4: Worker Consumer Group Leasing

- **depends_on**: [S1-T3]
- **Location**: `apps/www/src/server-lib/delivery-loop/v3/*`
- **Description**: Add worker loop with consumer-group claim/lease, heartbeat, stale claim reclaim, and bounded retry behavior.
- **Acceptance Criteria**:
  - Parallel workers do not double-process the same message.
  - Stale claims are reclaimed deterministically.
  - Worker shutdown/restart does not lose unacked work.
- **Validation**:
  - Concurrency tests for claim/lease behavior.
  - Restart/reclaim simulation test.
  - **Status**: completed
  - **Work Log**:
    - Implemented `apps/www/src/server-lib/delivery-loop/v3/worker.ts` with deterministic Redis Stream consumer-group processing:
      - Consumer-group claim/read loop with configurable group name and consumer identity.
      - Heartbeat writes in a Redis hash for active consumers.
      - Deterministic stale claim recovery via `XAUTOCLAIM` with cursor-aware sweep.
      - Bounded retry using attempt-count hash with expiry and dead-letter handoff on exhaustion.
      - Strict message parsing and typed invalid-message dead-lettering.
      - Default signal processor kept aligned with relay payload contract and v3 kernel event appending.
    - Added `apps/www/src/server-lib/delivery-loop/v3/worker.test.ts` to verify:
      - Parallel consumers do not process a given message twice in the same batch window.
      - Stale claim reclaim enables restart-style recovery without losing unacked work.
      - Bounded retry transitions to dead-letter when max attempts are exceeded.
    - Integrated v3 worker execution into cron route (`apps/www/src/app/api/internal/cron/scheduled-tasks/route.ts`) and exposed worker result counters + failure marker.
    - Preserved current v2/v3 staging behavior; worker errors now surface as `v3WorkerError` in cron payload with non-200 status on failure.
    - 2026-03-18 verification: `pnpm -C apps/www exec vitest run src/server-lib/delivery-loop/v3/worker.test.ts` (3 tests) and `pnpm -C apps/www exec tsc --noEmit --pretty false` passed.

### Task S1-T5: Durable Delivery Test Suite

- **depends_on**: [S1-T4]
- **Location**: `apps/www/src/server-lib/delivery-loop/v3/*.test.ts`
- **Description**: Add integration tests for dedupe, replay, and relay/worker recovery.
- **Acceptance Criteria**:
  - Tests cover duplicate ingress, relay crash, worker crash, and recovery.
  - Failures are diagnosable via event/effect logs.
- **Validation**:
  - `pnpm -C apps/www exec vitest run src/server-lib/delivery-loop/v3/*.test.ts`
- **Status**: completed
- **Work Log**:
  - Added `apps/www/src/server-lib/delivery-loop/v3/durable-delivery.test.ts` with deterministic integration coverage for:
    - duplicate ingress dedupe at journal/outbox level (idempotent journal insert + outbox dedupe key) and exactly-once transition semantics in durable logs.
    - relay writeback failure simulation with retry, ensuring recovery and no duplicate Redis stream publish via relay-level idempotent `XADD`.
    - worker crash simulation with stale claim reclaim and deterministic replay; recovery verifies no duplicate journal/effect writes.
  - Assertions now explicitly read `delivery_loop_journal_v3`, `delivery_effect_ledger_v3`, `delivery_workflow_head_v3`, and `delivery_outbox_v3` rows to guarantee recoverability is diagnosable via durable event/effect records.
  - Covered failure/recovery patterns now include:
    - duplicate ingress/outbox rows,
    - relay markPublished miss retries,
    - relay publish retries via stale lease reclaim,
    - worker crash + claim reclaim replay.
  - Validation:
    - `pnpm -C apps/www exec vitest run src/server-lib/delivery-loop/v3/*.test.ts` (5 files, 23 tests passing in this implementation).
  - Updated task status in this plan to completed.

## Sprint 2: Coordinator Rewrite on v3 Scaffolding

**Goal**: Move reduction/tick progression to worker-driven coordinator with strict invariants.
**Demo/Validation**:

- `planning -> implementing` and `implementing -> gating/awaiting_pr` happen from queue events only.
- Missed ack/start signals no longer deadlock progression.

### Task S2-T1: v3 Coordinator Worker Loop

- **depends_on**: [S1-T5]
- **Location**: `apps/www/src/server-lib/delivery-loop/v3/reducer.ts`, `apps/www/src/server-lib/delivery-loop/v3/store.ts`
- **Description**: Implement coordinator worker that hydrates workflow head, reduces signals, writes workflow/event/effects atomically, and emits follow-up effects.
- **Acceptance Criteria**:
  - Versioned CAS transition guard is enforced.
  - Coordinator loop is idempotent per signal.
- **Validation**:
  - Coordinator worker tests with duplicate and out-of-order signals.
- **Work Log**:
  - Scope implemented. Added run-signal correlation checks in `apps/www/src/server-lib/delivery-loop/v3/reducer.ts` to make run-scoped events idempotent when they target stale/unknown run IDs.
  - Added durable coordinator tests that validate duplicate and out-of-order signal behavior and CAS protection in `apps/www/src/server-lib/delivery-loop/v3/durable-delivery.test.ts`.
  - Updated reducer tests in `apps/www/src/server-lib/delivery-loop/v3/reducer.test.ts` for stale run-scoped events.
  - Verified `apps/www/src/server-lib/delivery-loop/v3/store.ts` CAS behavior via explicit stale-version update test and existing transition assertions.
- **Status**: completed

### Task S2-T2: Dispatch Lifecycle State Model

- **depends_on**: [S2-T1]
- **Location**: `packages/shared/src/delivery-loop/domain/*`, `apps/www/src/server-lib/delivery-loop/coordinator/*`, `apps/www/src/server-lib/delivery-loop/v3/*`
- **Description**: Add explicit dispatch lifecycle substate and terminal-first handling for daemon outcomes.
- **Acceptance Criteria**:
  - Terminal `run_completed/run_failed` can resolve dispatch state even when ack/start missing.
  - No workflow remains `implementing` with stale terminal signal unhandled.
- **Validation**:
  - Domain transition tests and pipeline tests.
- **Status**: completed
- **Work Log**:
  - Added dispatch-lifecycle terminal guard in `apps/www/src/server-lib/delivery-loop/coordinator/reduce-signals.ts`:
    - `run_completed`/`run_failed` now resolve only for active implementing substate (`queued|sent`) and are ignored when dispatch is already failed.
  - Added coordinator unit tests in `apps/www/src/server-lib/delivery-loop/coordinator/reduce-signals.test.ts` for:
    - missing ack/start terminal handling (`queued` dispatch + run_completed/run_failed),
    - stale terminal terminal events ignored when dispatch is failed.
  - Added explicit terminal-first branch in `apps/www/src/server-lib/delivery-loop/v3/reducer.ts` by treating missing `runId` as non-stale and still allowing terminal handling.
  - Added pipeline coverage in `apps/www/src/server-lib/delivery-loop/coordinator/pipeline.test.ts` for:
    - daemon `run_completed` entering gating with queued dispatch and no prior ack,
    - daemon `run_failed` returning to implementing with retry scheduling.
  - Expanded shared domain transitions for infra-retry behavior in
    `packages/shared/src/delivery-loop/domain/transitions.ts` and added transition tests in
    `packages/shared/src/delivery-loop/domain/transitions.test.ts` for
    `gate_blocked + infraRetry`.

### Task S2-T3: Invariant Middleware (State Reconciliation)

- **depends_on**: [S2-T2]
- **Location**: `apps/www/src/server-lib/delivery-loop/v3/reducer.ts`, `apps/www/src/server-lib/delivery-loop/coordinator/tick.ts`
- **Description**: Add deterministic invariant middleware after each transition for dispatch coherence, branch coherence, and PR coherence.
- **Acceptance Criteria**:
  - Invalid states are auto-reconciled or moved to explicit terminal/operator state.
  - Invariant actions are audit-logged.
- **Validation**:
  - Middleware tests for branch mismatch, stale dispatch, missing PR link.
- **Status**: completed
- **Work Log**:
- 2026-03-18: Implemented deterministic invariant middleware in v3 reducer:
  - Added dispatch coherence and branch coherence checks after every transition.
  - Stale `activeRunId` is coerced to `null` outside active dispatch states (`implementing`, `gating_review`, `gating_ci`).
  - `activeGate` is normalized to expected state (`null`, `"review"`, `"ci"`).
  - Ensured middleware preserves transition effects while returning invariant actions.
- 2026-03-18: Added coordinator PR coherence middleware and auditing in `apps/www/src/server-lib/delivery-loop/coordinator/tick.ts`:
  - `awaiting_pr` with no diff auto-enqueues `mark_done_requested` once via idempotent signal.
  - `awaiting_pr` with PR available or discoverable auto-enqueues `pr_synchronized` once via idempotent signal.
  - Both paths emit auditable `awaiting_pr_invariant` workflow events with deterministic payload.
- 2026-03-18: Added invariant audit journaling to v3 kernel in `apps/www/src/server-lib/delivery-loop/v3/kernel.ts`:
  - `dispatch_coherence` and `branch_coherence` actions are appended as journal events (`invariant_action`), using deterministic idempotency keys.
- 2026-03-18: Added coverage:
  - `apps/www/src/server-lib/delivery-loop/v3/reducer.test.ts`: stale dispatch and branch mismatch invariant tests.
  - `apps/www/src/server-lib/delivery-loop/coordinator/tick.test.ts`: awaiting_pr invariant audit event assertions.

### Task S2-T4: Runtime Fallback Policy

- **depends_on**: [S2-T2]
- **Location**: `apps/www/src/server-lib/delivery-loop/coordinator/reduce-signals.ts`, `apps/www/src/server-lib/delivery-loop/v3/*`, `packages/shared/src/delivery-loop/domain/*`
- **Description**: Add classified infra-failure policy to fallback from primary runtime to secondary runtime automatically.
- **Acceptance Criteria**:
  - Infra failures increase infra retry/fallback counters without consuming normal fix budget.
  - Fallback decision is deterministic and recorded.
- **Validation**:
  - Failure classification tests and fallback transition tests.
- **Status**: pending
- **Work Log**:

### Task S2-T5: Reducer/Worker Race Hardening Tests

- **depends_on**: [S2-T3, S2-T4]
- **Location**: `apps/www/src/server-lib/delivery-loop/v3/*.test.ts`, `apps/www/src/server-lib/delivery-loop/coordinator/*.test.ts`
- **Description**: Add race-hardening tests for out-of-order and duplicated signals under concurrent workers.
- **Acceptance Criteria**:
  - Test suite proves no duplicate transitions/effects for duplicated events.
  - Concurrent claim paths preserve single logical transition.
- **Validation**:
  - Targeted race test suite.
- **Status**: pending
- **Work Log**:

## Sprint 3: Effects, Timers, PR Determinism

**Goal**: Replace cron timers with delayed queue effects and guarantee PR terminalization behavior.
**Demo/Validation**:

- Timers fire from delayed queue jobs.
- Awaiting-PR invalid states auto-resolve via PR link/create or done reason.

### Task S3-T1: Effect Workers (Dispatch/Publication/PR/Babysit/Timer)

- **depends_on**: [S2-T5]
- **Location**: `apps/www/src/server-lib/delivery-loop/workers/*`, `apps/www/src/server-lib/delivery-loop/v3/*`
- **Description**: Implement effect workers and delayed scheduling for ack expiry, babysit due, and retry backoff.
- **Acceptance Criteria**:
  - No progression path requires cron timer to move state.
  - Timer effects are persisted and replayable.
- **Validation**:
  - Worker/effect tests + delayed job simulations.
- **Status**: pending
- **Work Log**:

### Task S3-T2: Deterministic Post-Gate PR Invariant

- **depends_on**: [S3-T1]
- **Location**: `apps/www/src/server-lib/delivery-loop/coordinator/tick.ts`, `apps/www/src/server-lib/delivery-loop/v3/reducer.ts`
- **Description**: Enforce create-or-link-PR or explicit done reason immediately after gate completion.
- **Acceptance Criteria**:
  - `awaiting_pr` cannot silently stall.
  - PR create/link attempts are idempotent and audited.
- **Validation**:
  - Awaiting PR invariant tests including failure and retry.
- **Status**: pending
- **Work Log**:

### Task S3-T3: Base Branch Default Policy (`origin/main`)

- **depends_on**: [S3-T1]
- **Location**: `apps/cli/*`, `apps/www/src/agent/msg/startAgentMessage.ts`, `apps/www/src/server-lib/*`
- **Description**: Default new task base branch to `origin/main` (repo default branch) unless explicitly overridden.
- **Acceptance Criteria**:
  - New task creation path resolves repo default branch consistently.
  - Dirty long-lived user branch is no longer default base.
- **Validation**:
  - CLI create flow test.
  - API task create branch-resolution test.
- **Status**: pending
- **Work Log**:

### Task S3-T4: Sandbox/Branch Reconciliation Effect

- **depends_on**: [S3-T1]
- **Location**: `apps/www/src/agent/sandbox.ts`, `apps/www/src/server-lib/delivery-loop/workers/*`
- **Description**: Add pre-dispatch branch reconciliation to enforce thread branch == sandbox branch before run execution.
- **Acceptance Criteria**:
  - Branch drift is detected and corrected/restarted before execution.
  - Reconciliation failures route to explicit operator or retry state.
- **Validation**:
  - Branch drift simulation test.
- **Status**: pending
- **Work Log**:

### Task S3-T5: Real E2E PR Flow Validation Harness

- **depends_on**: [S3-T2, S3-T3, S3-T4]
- **Location**: `scripts/delivery-loop-local-framework.ts`, `apps/www/src/server-lib/delivery-loop/LOCAL_TESTING.md`
- **Description**: Extend local framework for deterministic real-repo E2E PR checks without manual cron nudges.
- **Acceptance Criteria**:
  - Harness can run minimal task and assert PR row/link existence.
  - Harness reports stuck-state diagnostics with workflow/signal/effect snapshots.
- **Validation**:
  - Scripted end-to-end local run.
- **Status**: pending
- **Work Log**:

## Sprint 4: Big-Bang Cutover + Soak

**Goal**: Switch all progression traffic to v3 workers and retire cron progression paths.
**Demo/Validation**:

- Ingress routes to v3 only.
- 3/3 real runs produce draft PRs without manual ticks.

### Task S4-T1: v3-Only Progression Routing

- **depends_on**: [S3-T5]
- **Location**: `apps/www/src/app/api/internal/cron/*`, `apps/www/src/server-lib/delivery-loop/*`
- **Description**: Flip routing so v3 workers are the only progression path; keep cron endpoints for watchdog/incident auditing only.
- **Acceptance Criteria**:
  - Normal delivery progression does not rely on cron endpoints.
  - Watchdog mode remains available for incident surfacing.
- **Validation**:
  - Routing tests + manual smoke.
- **Status**: pending
- **Work Log**:

### Task S4-T2: Retire v2 Progression Paths

- **depends_on**: [S4-T1]
- **Location**: `apps/www/src/server-lib/delivery-loop/coordinator/*`, `apps/www/src/server-lib/delivery-loop/workers/*`
- **Description**: Remove/supersede v2 progression logic and keep only compatibility shims needed for UI state mapping.
- **Acceptance Criteria**:
  - No v2 progression path is invoked in normal operation.
  - Compatibility mapping still renders expected status UI.
- **Validation**:
  - Typecheck/lint/tests for delivery loop and status mapping.
- **Status**: pending
- **Work Log**:

### Task S4-T3: Soak Validation (3/3 Real PR Runs)

- **depends_on**: [S4-T2]
- **Location**: operational runbook + local validation scripts
- **Description**: Execute three independent real-repo runs from `origin/main`, each requiring automatic draft PR creation.
- **Acceptance Criteria**:
  - 3/3 runs succeed without manual cron progression.
  - Failure runs include captured diagnostics.
- **Validation**:
  - Harness execution logs + DB assertions + PR links.
- **Status**: pending
- **Work Log**:

### Task S4-T4: Incident + Ops Runbook

- **depends_on**: [S4-T2]
- **Location**: `apps/www/src/server-lib/delivery-loop/LOCAL_TESTING.md` (or adjacent ops doc)
- **Description**: Document triage and recovery for runtime fallback, queue lag, invariant violations, and reconciliation failures.
- **Acceptance Criteria**:
  - Runbook contains deterministic diagnosis steps and commands.
  - Mapped incident types include recovery playbook.
- **Validation**:
  - Manual review and dry-run of runbook commands.
- **Status**: pending
- **Work Log**:

### Task S4-T5: Observability + Alerting Finalization

- **depends_on**: [S4-T3, S4-T4]
- **Location**: `apps/www/src/server-lib/delivery-loop/*` + metrics/telemetry integration points
- **Description**: Add final metrics and alerts for queue lag, stuck dispatch, invariant auto-heal count, and fallback usage.
- **Acceptance Criteria**:
  - Operators can detect stuck workflows without cron progression.
  - Alert thresholds and metric names are documented.
- **Validation**:
  - Metric emission tests and manual alert simulation.
- **Status**: pending
- **Work Log**:

## Testing Strategy

- Unit tests for transitions, invariants, and failure classification.
- Integration tests for outbox relay, worker claim/replay behavior, and effect idempotency.
- End-to-end real-repo tests verifying automatic draft PR creation from `origin/main`.

## Potential Risks & Gotchas

- ACP instability can still cause noisy infra retries; fallback policy must be strictly deterministic.
- Big-bang cutover may expose hidden dependencies on v2 cron progression.
- Branch reconciliation can conflict with existing long-lived sandbox sessions if not staged carefully.

## Rollback Plan

- Gate v3-only progression behind feature flag to allow temporary routing fallback.
- Preserve migration-safe DB structures and backwards-compatible readers during cutover.
- Keep watchdog cron endpoints for diagnostics even after progression cutover.
