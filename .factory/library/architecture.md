# Architecture

How the delivery loop works today and what must remain true after simplification.

## System Model

The delivery loop is a workflow orchestrator with one canonical runtime head (`delivery_workflow_head_v3`) and durable ledgers for events/effects/outbox work.  
User-visible behavior is driven by transitions of that canonical head and surfaced through API/CLI/UI projections.

## Core Components

- **Ingress**
  - Daemon ingress: `/api/daemon-event`
  - GitHub ingress: `/api/webhooks/github`
  - Human interventions: server actions / outbox path
- **Kernel + Reducer**
  - `v3/reducer.ts` decides state transitions and effects
  - `v3/kernel.ts` appends events and advances head with CAS/idempotency
- **Effect Execution**
  - `v3/process-effects.ts` executes queued effects and maps effect outcomes back to loop events
- **Durable Delivery**
  - `v3/relay.ts` publishes outbox signals
  - `v3/worker.ts` consumes signals and advances workflow
- **Recovery**
  - Cron endpoints run watchdog/reconciliation passes for missed or stale progress
- **Read Models**
  - `get-delivery-loop-status` and UI mapping functions project canonical state to user-visible status

## Primary Code and Test Roots

- Runtime/state machine code:
  - `apps/www/src/server-lib/delivery-loop/v3/`
  - `apps/www/src/app/api/daemon-event/`
  - `apps/www/src/app/api/webhooks/github/`
  - `apps/www/src/app/api/internal/cron/`
- CLI/local validation flow:
  - `scripts/delivery-loop-local-framework.ts`
  - `apps/www/src/server-lib/delivery-loop/LOCAL_TESTING.md`
- UI/status projection:
  - `apps/www/src/lib/delivery-loop-status.ts`
  - `apps/www/src/server-actions/get-delivery-loop-status.ts`
  - `apps/www/src/components/patterns/delivery-loop-top-progress-stepper.tsx`
- Main test roots:
  - `apps/www/src/server-lib/delivery-loop/v3/*.test.ts`
  - `apps/www/src/app/api/**/route.test.ts`
  - `apps/www/src/server-lib/e2e.test.ts`
  - `apps/www/src/lib/delivery-loop-status.test.ts`
  - `apps/www/src/server-actions/get-delivery-loop-status.test.ts`
  - `packages/shared/src/delivery-loop/**/*.test.ts`

## Primary Data Flows

1. **Task bootstrap** -> canonical `bootstrap` event -> planning/dispatch effects
2. **Dispatch effect** -> launch run + durable intent updates -> `dispatch_queued`/`dispatch_accepted`
3. **Daemon terminal events** -> canonical `run_completed`/`run_failed` bridge
4. **Gate events (review/ci/pr)** -> transition through gating states
5. **Publication effects** -> status/check/pr-link projections
6. **Watchdog ticks** -> recover stalled workflows/effects without duplicate logical progress

## Architectural Invariants

- Canonical head is source of truth; projections may lag but must converge.
- Terminal states are absorbing.
- Stale/out-of-order signals do not mutate canonical state.
- Effect execution is idempotent and lease-guarded.
- Retry and dead-letter behavior is deterministic by configured attempt budgets.
- Legacy compatibility paths cannot override canonical v3 semantics.
- User-visible status must stay consistent with canonical state semantics.

### Canonical State/Event Contract (must preserve)

- Canonical states (v3): `planning`, `implementing`, `gating_review`, `gating_ci`, `awaiting_pr_creation`, `awaiting_pr_lifecycle`, `awaiting_manual_fix`, `awaiting_operator_action`, `done`, `stopped`, `terminated`.
- Canonical terminal semantics: once terminal (`done|stopped|terminated`), no later ingress mutates state.
- Canonical event compatibility: legacy aliases are normalized; normalized semantics must match canonical behavior.

### External Contract Freeze (must-not-change behaviors)

- CLI contracts:
  - `delivery-loop:local preflight/run/snapshot/e2e` command semantics and guardrails.
- API contracts:
  - daemon-event auth/idempotency/conflict response semantics.
  - webhook auth/idempotency semantics.
  - cron endpoint auth and response semantics.
- UI contracts:
  - state->status mapping for active, blocked, and terminal phases.
  - PR-link visibility and status refresh semantics.

## Legacy Compatibility Scope

Compatibility paths still in scope and must only be removed with characterization coverage:

- legacy event aliases (`dispatch_sent`, `dispatch_acked`, old acceptance state normalization)
- legacy timeout compatibility paths referenced by `ack_timeout_check`

### Recently Removed (2025-04-08)

The following legacy surfaces have been removed as part of milestone `legacy-dead-flaky-removal`:

- **Legacy signal envelope handling** (`parseLegacySignalEnvelopeToLoopEvent` in worker.ts): The v2-to-v3 signal envelope format `{ source, event: { kind } }` is no longer supported. Invalid formats are now rejected at the worker boundary and dead-lettered. The worker exclusively uses the canonical `parseLoopEvent` from contracts.ts.

Any other legacy/dead branch is a removal candidate once assertions that depend on it are preserved.

## Simplification Direction (Mission Guardrails)

- Reduce transition/effect surface area without changing externally visible delivery-loop behavior.
- Collapse redundant legacy branches only when covered by characterization tests.
- Remove dead/flaky code that is not part of required contract behavior.
- Prefer explicit contracts (typed event/effect assertions + invariant tests) over implicit coupling.

## Required Validation Gates for This Mission

Workers should treat these as baseline quality gates before handoff:

- `pnpm delivery-loop:local preflight`
- `pnpm -C packages/shared exec vitest run src/delivery-loop/domain/failure-signature.test.ts src/delivery-loop/store/dispatch-intent-store.test.ts`
- `pnpm -C apps/www exec vitest run src/server-lib/delivery-loop/v3/reducer.test.ts src/server-lib/delivery-loop/v3/process-effects.test.ts src/app/api/daemon-event/route.test.ts`
- Critical-flow e2e/behavior checks tied to `validation-contract.md` assertions for each changed feature
