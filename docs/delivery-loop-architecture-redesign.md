# Delivery Loop Architecture Redesign

| Field     | Value                               |
| --------- | ----------------------------------- |
| Title     | Delivery Loop Architecture Redesign |
| Authors   | Factory Droid + Tyler Sheffield     |
| Status    | Proposed                            |
| Date      | 2026-03-14                          |
| Reviewers | TBD                                 |

---

## 1. Executive Summary

The current Delivery Loop has strong durability primitives but weak orchestration boundaries. State persistence, signal ingestion, gate execution, publication, retries, and request-time recovery are split across multiple codepaths:

- `apps/www/src/app/api/daemon-event/route.ts`
- `apps/www/src/server-lib/delivery-loop/signal-inbox.ts`
- `apps/www/src/server-lib/checkpoint-thread-internal.ts`
- `apps/www/src/server-lib/delivery-loop/publication.ts`
- `packages/shared/src/model/delivery-loop/*`

This creates three systemic problems:

1. More than one runtime path can advance loop state.
2. Request handlers still contain workflow logic.
3. Reliability and observability exist as local mechanisms, not as one coherent control plane.

This redesign proposes a breaking change: move to a single coordinator-driven Delivery Loop where all ingress paths append normalized signals, one coordinator owns state transitions, and all external side effects flow through explicit durable work queues.

---

## 2. Goals

### 2.1 Primary goals

1. Make workflow orchestration have exactly one owner.
2. Preserve and strengthen durability, idempotency, and replayability.
3. Make stuck loops, partial failures, and regressions obvious to operators.
4. Support richer functionality without adding more hidden coupling.
5. Allow breaking schema and module changes where they materially improve correctness.

### 2.2 Non-goals

1. Preserve all legacy `sdlc-*` naming indefinitely.
2. Minimize schema change count at the expense of architecture quality.
3. Keep request handlers as orchestration surfaces.
4. Keep `checkpoint-thread-internal.ts` as a long-term workflow owner.

### 2.3 Locked architectural decisions

This document assumes the following decisions are final for the target architecture:

1. **Aggregate-row first**

   - the workflow aggregate row is the canonical source of truth for current state
   - append-only workflow events are mandatory audit/history records, not the runtime source of truth

2. **Explicit human wait states**

   - human waits are modeled as explicit workflow variants rather than one generic catch-all wait state

3. **Sequential gates now, future parallelization later**

   - the first implementation executes gates sequentially
   - the type system must support graph/parallel gate expansion later without redesigning the domain core

4. **Dispatch is special in the domain, unified in execution**

   - daemon dispatch keeps first-class domain semantics
   - dispatch still runs through the same durable work-execution framework as other work items

5. **Fast naming cutover**

   - new code uses `delivery_*` naming only
   - compatibility shims are temporary and not part of the end-state architecture

6. **Retain raw payloads for now**

   - raw daemon/GitHub payloads are stored for forensics and migration validation
   - reducer-facing types remain strict closed unions

7. **Operator features are first-class**

   - incidents, DLQs, replay surfaces, and runtime status are part of the initial architecture, not deferred add-ons

8. **Multiple workflow generations per thread**

   - a thread may have multiple workflow generations over time
   - exactly one workflow generation may be active for a thread at once

9. **PR linkage is a projection / side effect**

   - GitHub PR creation/linking is not a core-domain transition primitive
   - the domain models an attached review surface, with GitHub as one adapter implementation

10. **Migration optimizes for clean end-state architecture**
    - transitional convenience should not compromise the final system shape

---

## 3. Current-State Findings

### 3.1 What is already strong

The current system already has valuable primitives worth preserving:

- durable signal inbox
- durable publication outbox
- per-loop lease coordination
- gate result persistence
- dispatch intent lifecycle
- dedupe and idempotency protections
- babysit recheck and parity mechanisms

### 3.2 What is currently weak

The system still has structural weaknesses:

1. **Dual orchestration paths**

   - `signal-inbox.ts` drives phase movement and routing.
   - `checkpoint-thread-internal.ts` also drives gate execution and transitions.

2. **Ingress handlers do too much**

   - `daemon-event/route.ts` does auth, dedupe, dispatch ack handling, run-context mutation, signal processing, and background coordination.

3. **Overloaded state semantics**

   - `loopVersion` is used for more than versioning.
   - `blocked` semantics are implicit and leak automation through effective-phase fallback.

4. **Operational blind spots**
   - no append-only workflow event log
   - no first-class incident or DLQ model
   - no control-plane runtime health model
   - no single forensic timeline per loop

---

## 4. Design Principles

1. **Single writer per loop**

   - One coordinator owns loop transitions.

2. **Append-only ingress**

   - Daemon, GitHub, cron, and human actions append normalized signals rather than directly orchestrating the workflow.

3. **Explicit pending work**

   - Waiting states must be represented directly instead of inferred from side effects.

4. **Outbox-only side effects**

   - GitHub updates, daemon dispatches, and future external effects must go through durable work items.

5. **Observability is a first-class feature**

   - Every meaningful workflow event must be reconstructable.

6. **Shared package is domain and persistence, not orchestration runtime**

   - Runtime integration code belongs in app/server layers.

7. **Illegal states should be unrepresentable**

   - The canonical domain model should prefer discriminated unions over nullable aggregate-wide fields.

8. **Parse unknowns at ingress boundaries**

   - Raw daemon, GitHub, and human payloads may be stored for forensics, but reducer-facing types must be closed unions with validated payloads.

9. **One discriminator convention everywhere**

   - Use `kind` for union discrimination and `snake_case` discriminator values across workflow states, signals, events, work items, incidents, and read models.

10. **Workflow generations are explicit**

    - A thread is durable context.
    - A workflow generation is a bounded event stream and execution attempt attached to that thread.

11. **Review surfaces are projections**
    - PRs, check runs, and comments are attached review surfaces driven by workflow events, not primary workflow-state drivers.

---

## 5. Target Architecture

### 5.1 High-level architecture

```text
External systems
  ├─ Daemon events
  ├─ GitHub webhooks
  ├─ Human interventions
  └─ Cron/timers
          │
          ▼
Normalized signal ingestion
          │
          ▼
Delivery Loop signal inbox
          │
          ▼
Single coordinator tick per loop
  ├─ claim lease
  ├─ drain signals
  ├─ reduce workflow state
  ├─ emit work items
  ├─ append workflow events
  └─ release lease
          │
          ├─ dispatch work queue
          ├─ publication outbox
          ├─ retry queue
          └─ incident/DLQ handling
```

### 5.2 Layering

#### Layer 1: Domain

Location:

- `packages/shared/src/delivery-loop/domain/*`

Responsibilities:

- canonical workflow types
- transition rules
- signal types
- command/work-item types
- invariants
- retry classification enums

Must not depend on:

- Next.js
- GitHub SDK
- sandbox session APIs
- daemon runtime

#### Layer 2: Persistence primitives

Location:

- `packages/shared/src/delivery-loop/store/*`

Responsibilities:

- workflow row CRUD
- signal inbox claim/commit/release
- outbox claim/complete/retry
- lease handling
- event append helpers
- incident and DLQ persistence
- read-model builders

#### Layer 3: Coordinator application layer

Location:

- `apps/www/src/server-lib/delivery-loop/coordinator/*`

Responsibilities:

- acquire loop lease
- load pending signals and workflow state
- reduce state
- choose work items
- enqueue dispatch/publication/retry actions
- persist loop events
- update runtime health projections

#### Layer 4: Adapters

Location:

- `apps/www/src/server-lib/delivery-loop/adapters/*`

Responsibilities:

- daemon event normalization
- GitHub feedback normalization
- gate executor adapters
- publication adapters
- human intervention normalization

#### Layer 5: Workers and entrypoints

Location:

- `apps/www/src/app/api/**`
- `apps/www/src/server-lib/delivery-loop/workers/*`

Responsibilities:

- append signals
- wake coordinator
- execute durable work items

---

## 6. Canonical Workflow Model

### 6.1 Workflow aggregate

````ts
type WorkflowId = string;
type ThreadId = string;
type UserId = string;
type RepoFullName = string;
type DispatchId = string;
type PlanVersion = number;
type HeadSha = string;
type PullRequestNumber = number;
type DeliveryVersion = number;

For the actual implementation, these ids should become branded/nominal types rather than plain aliases. Recommended pattern:

```ts
type Brand<T, TBrand extends string> = T & { readonly __brand: TBrand };

type WorkflowId = Brand<string, "WorkflowId">;
type ThreadId = Brand<string, "ThreadId">;
type UserId = Brand<string, "UserId">;
type DispatchId = Brand<string, "DispatchId">;
type PlanVersion = Brand<number, "PlanVersion">;
type HeadSha = Brand<string, "HeadSha">;
type PullRequestNumber = Brand<number, "PullRequestNumber">;
type SignalId = Brand<string, "SignalId">;
type IncidentId = Brand<string, "IncidentId">;
type CorrelationId = Brand<string, "CorrelationId">;
````

This prevents silent id mix-ups at compile time with zero runtime overhead.

type WorkflowCommon = {
workflowId: WorkflowId;
threadId: ThreadId;
userId: UserId;
repoFullName: RepoFullName;
version: DeliveryVersion;
createdAt: Date;
updatedAt: Date;
lastActivityAt: Date | null;
stuckSince: Date | null;
};

type DeliveryWorkflow =
| PlanningWorkflow
| ImplementingWorkflow
| GatingWorkflow
| AwaitingPrWorkflow
| BabysittingWorkflow
| AwaitingPlanApprovalWorkflow
| AwaitingManualFixWorkflow
| AwaitingOperatorActionWorkflow
| DoneWorkflow
| StoppedWorkflow
| TerminatedWorkflow;

type PlanningWorkflow = WorkflowCommon & {
kind: "planning";
planVersion: PlanVersion | null;
};

type ImplementingWorkflow = WorkflowCommon & {
kind: "implementing";
planVersion: PlanVersion;
dispatch: DeliveryDispatchState;
};

type GatingWorkflow = WorkflowCommon & {
kind: "gating";
headSha: HeadSha;
gate: DeliveryGateState;
};

type AwaitingPrWorkflow = WorkflowCommon & {
kind: "awaiting_pr";
headSha: HeadSha;
};

type BabysittingWorkflow = WorkflowCommon & {
kind: "babysitting";
headSha: HeadSha;
reviewSurface: ReviewSurfaceRef;
nextCheckAt: Date;
};

type AwaitingPlanApprovalWorkflow = WorkflowCommon & {
kind: "awaiting_plan_approval";
planVersion: PlanVersion;
resumableFrom: Extract<ResumableWorkflowState, { kind: "planning" }>;
};

type AwaitingManualFixWorkflow = WorkflowCommon & {
kind: "awaiting_manual_fix";
reason: ManualFixIssue;
resumableFrom: Exclude<ResumableWorkflowState, { kind: "planning" }>;
};

type AwaitingOperatorActionWorkflow = WorkflowCommon & {
kind: "awaiting_operator_action";
incidentId: string;
reason: OperatorActionReason;
resumableFrom: ResumableWorkflowState;
};

type DoneWorkflow = WorkflowCommon & {
kind: "done";
outcome: CompletionOutcome;
completedAt: Date;
};

type StoppedWorkflow = WorkflowCommon & {
kind: "stopped";
reason: StopReason;
};

type TerminatedWorkflow = WorkflowCommon & {
kind: "terminated";
reason: TerminationReason;
};

````

### 6.2 Top-level workflow states

Replace the current state sprawl with fewer top-level states:

- `planning`
- `implementing`
- `gating`
- `awaiting_pr`
- `babysitting`
- `awaiting_plan_approval`
- `awaiting_manual_fix`
- `awaiting_operator_action`
- `done`
- `stopped`
- `terminated`

The workflow aggregate should be a discriminated union, not a flat record with nullable cross-cutting fields. State-specific data must live on the relevant variant so that invalid combinations are impossible to construct.

This proposal intentionally uses explicit human-wait states instead of a single generic `awaiting_human` bucket.

### 6.3 Gating substate

Instead of separate top-level `review_gate`, `ci_gate`, and `ui_gate` states, use one gated phase:

```ts
type GateName = "review" | "ci" | "ui";

type DeliveryGateState = ReviewGateState | CiGateState | UiGateState;

type ReviewGateState = {
  kind: "review";
  status: "waiting" | "passed" | "blocked";
  runId: string | null;
  snapshot: ReviewGateSnapshot;
};

type CiGateState = {
  kind: "ci";
  status: "waiting" | "passed" | "blocked";
  runId: string | null;
  snapshot: CiGateSnapshot;
};

type UiGateState = {
  kind: "ui";
  status: "waiting" | "passed" | "blocked";
  runId: string | null;
  snapshot: UiGateSnapshot;
};

type ReviewGateSnapshot = {
  requiredApprovals: number;
  approvalsReceived: number;
  blockers: readonly ReviewBlocker[];
};

type CiGateSnapshot = {
  checkSuites: readonly CiCheckSuite[];
  failingRequiredChecks: readonly string[];
};

type UiGateSnapshot = {
  artifactUrl: string | null;
  blockers: readonly UiBlocker[];
};
````

This makes gates composable and reduces duplicated transitions.

### 6.4 Pending action model

Replace implicit blocked/resume semantics with explicit waits:

```ts
type DeliveryDispatchState =
  | { kind: "queued"; dispatchId: DispatchId }
  | { kind: "sent"; dispatchId: DispatchId; sentAt: Date; ackDeadlineAt: Date }
  | {
      kind: "acknowledged";
      dispatchId: DispatchId;
      sentAt: Date;
      acknowledgedAt: Date;
    };

type HumanWaitReason =
  | { kind: "approval_required" }
  | { kind: "manual_fix_required"; issue: ManualFixIssue }
  | { kind: "operator_intervention_required"; incidentId: string };

type ResumableWorkflowState =
  | { kind: "planning"; planVersion: PlanVersion | null }
  | { kind: "implementing"; dispatchId: DispatchId }
  | { kind: "gating"; gate: GateName; headSha: HeadSha }
  | { kind: "awaiting_pr"; headSha: HeadSha }
  | { kind: "babysitting"; headSha: HeadSha; reviewSurface: ReviewSurfaceRef };

type DeliveryPendingActionReadModel =
  | { kind: "dispatch_ack"; dispatchId: DispatchId; deadlineAt: Date }
  | { kind: "gate_result"; gate: GateName }
  | { kind: "human_input"; reason: HumanWaitReason }
  | { kind: "review_surface_link" }
  | { kind: "babysit_recheck"; nextCheckAt: Date };
```

`pendingAction` should not be an independent source of truth on the workflow aggregate. It should either be derived from the workflow variant or materialized only as a projection/read-model for status UIs and operator tooling.

### 6.5 Workflow generations and thread relationship

The system models workflow generations explicitly:

- a **thread** is durable user/task context
- a **workflow generation** is one bounded delivery-loop attempt attached to that thread

Rules:

1. a thread may have multiple workflow generations over time
2. at most one workflow generation may be active for a thread at any given time
3. supersession creates a new workflow generation instead of mutating old history into a new attempt
4. event streams are scoped to workflow generations, not to the thread as a whole

---

## 7. Signal Model

### 7.1 External signals

All external stimuli normalize into a typed signal union:

```ts
type DeliverySignal =
  | { source: "daemon"; event: DaemonSignal }
  | { source: "github"; event: GitHubSignal }
  | { source: "human"; event: HumanSignal }
  | { source: "timer"; event: TimerSignal };

type DaemonSignal =
  | { kind: "run_completed"; runId: string; result: DaemonCompletionResult }
  | { kind: "run_failed"; runId: string; failure: DaemonFailure }
  | { kind: "progress_reported"; runId: string; progress: DaemonProgress };

type GitHubSignal =
  | { kind: "ci_changed"; prNumber: PullRequestNumber; result: CiEvaluation }
  | {
      kind: "review_changed";
      prNumber: PullRequestNumber;
      result: ReviewEvaluation;
    };

type HumanSignal =
  | { kind: "resume_requested"; actorUserId: UserId }
  | { kind: "bypass_requested"; actorUserId: UserId; target: BypassTarget };

type TimerSignal =
  | { kind: "dispatch_ack_expired"; dispatchId: DispatchId }
  | { kind: "babysit_due" };
```

Canonical reducer-facing unions should not expose `unknown` payloads or free-form `string` categories. Ingress adapters should parse and validate raw inputs into these closed unions. Raw payloads may still be stored in persistence for debugging, but not inside the domain reducer types.

### 7.2 Canonical workflow events

The coordinator appends immutable workflow events:

```ts
type DeliveryWorkflowEvent =
  | { kind: "workflow_enrolled" }
  | { kind: "plan_approved"; planVersion: PlanVersion }
  | { kind: "dispatch_enqueued"; dispatchId: DispatchId }
  | { kind: "dispatch_sent"; dispatchId: DispatchId; ackDeadlineAt: Date }
  | { kind: "dispatch_acknowledged"; dispatchId: DispatchId }
  | { kind: "implementation_succeeded"; headSha: HeadSha }
  | { kind: "implementation_failed"; failure: DaemonFailure }
  | { kind: "gate_entered"; gate: GateName; headSha: HeadSha }
  | { kind: "gate_evaluated"; evaluation: GateEvaluation }
  | { kind: "review_surface_requested"; headSha: HeadSha }
  | {
      kind: "review_surface_attached";
      surface: ReviewSurfaceRef;
      headSha: HeadSha;
    }
  | { kind: "babysit_scheduled"; nextCheckAt: Date }
  | { kind: "plan_approval_required"; planVersion: PlanVersion }
  | { kind: "manual_fix_required"; reason: ManualFixIssue }
  | {
      kind: "operator_action_required";
      reason: OperatorActionReason;
      incidentId: string;
    }
  | { kind: "publication_delivered"; publication: PublicationTarget }
  | { kind: "workflow_completed"; outcome: CompletionOutcome }
  | { kind: "workflow_stopped"; reason: StopReason }
  | { kind: "workflow_terminated"; reason: TerminationReason }
  | { kind: "incident_opened"; incident: DeliveryIncident }
  | { kind: "incident_resolved"; incidentId: string };
```

Signals are inputs. Workflow events are facts produced by the coordinator.

### 7.3 Closed-set supporting unions

The architecture should standardize supporting closed unions instead of free-form strings:

```ts
type CompletionOutcome =
  | { kind: "completed" }
  | { kind: "merged" }
  | { kind: "closed_without_merge" };

type StopReason =
  | { kind: "user_requested" }
  | { kind: "superseded_by_newer_workflow"; newerWorkflowId: WorkflowId };

type TerminationReason =
  | {
      kind: "invariant_violation";
      code: "missing_head_sha" | "invalid_transition";
    }
  | { kind: "retry_exhausted"; subject: "dispatch" | "publication" | "signal" }
  | { kind: "fatal_external_failure"; system: "daemon" | "github" };

type PublicationTarget =
  | { kind: "status_comment" }
  | { kind: "check_run_summary" }
  | { kind: "operator_annotation" };

type ReviewSurfaceRef =
  | { kind: "github_pr"; prNumber: PullRequestNumber }
  | { kind: "other"; externalId: string };
```

---

## 8. Work Queues and Side Effects

### 8.1 Dispatch work queue

The current dispatch-intent concept should evolve into a first-class durable work queue for agent dispatches.

Dispatch remains a first-class domain concept because daemon lifecycle, ack deadlines, transport mode, and self-dispatch semantics are real workflow concerns. However, dispatch is still executed through the same durable work-execution framework as publication, retry, and babysit work.

The work queue should also be modeled as a discriminated union rather than a generic row shape.

```ts
type DeliveryWorkItem =
  | DispatchWorkItem
  | PublicationWorkItem
  | RetryWorkItem
  | BabysitWorkItem;

type DispatchWorkItem = {
  kind: "dispatch";
  workItemId: string;
  workflowId: WorkflowId;
  dispatchId: DispatchId;
  agent: SelectedAgent;
  transport: TransportMode;
  status: WorkItemStatus;
  scheduledAt: Date;
  attempt: number;
};

type PublicationWorkItem = {
  kind: "publication";
  workItemId: string;
  workflowId: WorkflowId;
  target: PublicationTarget;
  status: WorkItemStatus;
  scheduledAt: Date;
  attempt: number;
};

type RetryWorkItem = {
  kind: "retry";
  workItemId: string;
  workflowId: WorkflowId;
  retry: RetryRequest;
  status: WorkItemStatus;
  scheduledAt: Date;
  attempt: number;
};

type BabysitWorkItem = {
  kind: "babysit";
  workItemId: string;
  workflowId: WorkflowId;
  dueAt: Date;
  status: WorkItemStatus;
  attempt: number;
};

type WorkItemStatus =
  | "pending"
  | "claimed"
  | "completed"
  | "failed"
  | "dead_lettered";
```

Each item should track:

- dispatch id
- workflow id
- attempt count
- selected agent
- transport mode
- status
- ack deadline
- last error classification
- next retry time

### 8.2 Publication outbox

Publication remains durable but becomes purely projection-driven.

It consumes workflow events and updates:

- canonical review-surface status projection
- canonical check run summary
- future operator-facing annotations

The workflow core should depend on an attached review surface abstraction, not directly on GitHub PR mechanics.

### 8.3 Retry queue

All retries should be explicit durable work with a typed reason, not just background best-effort behavior.

```ts
type RetryRequest =
  | { kind: "dispatch_ack_timeout"; dispatchId: DispatchId }
  | { kind: "transient_daemon_failure"; failure: DaemonFailure }
  | { kind: "transient_publication_failure"; target: PublicationTarget }
  | { kind: "transient_github_failure"; operation: GitHubOperation }
  | { kind: "babysit_recheck_due"; dueAt: Date };

type DeliveryStaleOutcome =
  | { kind: "loop_not_found" }
  | { kind: "wrong_state"; expected: string; actual: string }
  | { kind: "version_conflict" }
  | { kind: "head_sha_conflict" }
  | { kind: "invalid_transition" }
  | { kind: "already_terminal" };

type DeliveryReducerResult =
  | {
      kind: "updated";
      workflow: DeliveryWorkflow;
      events: readonly DeliveryWorkflowEvent[];
    }
  | { kind: "noop"; reason: DeliveryStaleOutcome };
```

---

## 9. Observability Architecture

### 9.1 New persisted operational models

Add:

1. `delivery_loop_event`
2. `delivery_loop_incident`
3. `delivery_loop_runtime_status`
4. `delivery_loop_signal_dlq`
5. `delivery_loop_outbox_dlq`

### 9.2 Runtime status projection

`delivery_loop_runtime_status` should expose one row per active loop with:

- workflow state
- gating substate
- pending action
- last signal received time
- last signal processed time
- last dispatch time
- last dispatch ack time
- oldest signal age
- oldest outbox age
- open incident status
- derived health state

Derived health states:

- `healthy`
- `lagging`
- `blocked_expected`
- `stuck`
- `degraded`

Use a discriminated union here too:

```ts
type DeliveryWorkflowHealth =
  | { kind: "healthy" }
  | { kind: "lagging"; oldestSignalAgeSeconds: number }
  | { kind: "blocked_expected"; wait: HumanWaitReason }
  | { kind: "stuck"; stuckSince: Date; reason: StuckReason }
  | { kind: "degraded"; incidentId: string; reason: DegradedReason };
```

### 9.3 Metrics

Required metric families:

- active workflows by state
- phase duration histograms
- dispatch ack latency
- dispatch timeout counts
- signal inbox backlog and age
- outbox backlog and age
- gate pass/block/failure rates
- incident counts
- DLQ counts
- lease contention counts

### 9.4 Structured logs

Every major lifecycle event should log with stable names and correlation fields:

- `workflowId`
- `threadId`
- `runId`
- `signalId`
- `dispatchId`
- `outboxId`
- `headSha`
- `state`
- `pendingAction`

### 9.5 Operational hardening to adopt before or during migration

The redesign should absorb the strongest near-term reliability ideas from the prior planning work.

#### Signal dead-lettering

Signals should support:

- `processingAttemptCount`
- `lastProcessingError`
- `deferredUntil`
- `deadLetteredAt`
- `deadLetterReason`

Failures in signal processing must not be silently swallowed. They should either:

1. retry with bounded backoff, or
2. move to a DLQ with explicit incident visibility.

#### Epoch-fenced lease refresh

Lease refresh must verify the currently held epoch rather than relying only on owner identity. Once a lease is stolen or replaced, the old holder must not be able to refresh or continue.

#### Auto-refreshing heartbeat

Long-running coordination or gate-evaluation work should not rely on ad hoc manual refresh calls. The runtime should use an auto-refreshing heartbeat for:

- workflow lease
- signal claim lease

and expose explicit health/liveness status to the worker.

#### Idempotent gate evaluation

Gate persistence should support an idempotency key so that retried or replayed processing does not create duplicate gate runs.

Recommended key shape:

- `{workflowId}:{headSha}:{signalId}:{gateKind}`

#### Discriminated stale outcomes

Where the current system returns generic stale/no-op results, the new design should return typed outcomes that distinguish:

- loop not found
- wrong state
- version conflict
- head sha conflict
- invalid transition
- already terminal

These reasons should be expressed as closed unions so retry/escalation policy can branch on them deterministically.

---

## 10. Proposed Module Layout

### 10.1 Shared package

```text
packages/shared/src/delivery-loop/
  domain/
    workflow.ts
    transitions.ts
    signals.ts
    events.ts
    work-items.ts
    retry-policy.ts
  store/
    workflow-store.ts
    signal-inbox-store.ts
    work-queue-store.ts
    publication-store.ts
    lease-store.ts
    event-store.ts
    incident-store.ts
    runtime-status-store.ts
```

### 10.2 App runtime

```text
apps/www/src/server-lib/delivery-loop/
  coordinator/
    tick.ts
    reduce-signals.ts
    schedule-work.ts
    append-events.ts
  adapters/
    daemon-ingress.ts
    github-ingress.ts
    human-interventions.ts
    gate-executor.ts
    publication.ts
  workers/
    run-dispatch-work.ts
    run-publication-work.ts
    run-retry-work.ts
    run-babysit-work.ts
```

### 10.3 Files to shrink or retire

- `apps/www/src/app/api/daemon-event/route.ts` → shrink to ingress + wakeup
- `apps/www/src/server-lib/checkpoint-thread-internal.ts` → remove orchestration ownership
- `apps/www/src/server-lib/delivery-loop/signal-inbox.ts` → migrate logic into coordinator/store split
- `packages/shared/src/model/delivery-loop/index.ts` → replace with new canonical exports after migration

---

## 11. Data Model Changes

### 11.1 New tables

#### `delivery_workflow`

Canonical aggregate row.

This row is the authoritative source of truth for current workflow state.

#### `delivery_workflow_event`

Append-only event history.

This table is the immutable audit/history log for workflow behavior.

Suggested columns:

- `id`
- `workflow_id`
- `event_type`
- `state_before`
- `state_after`
- `payload_json`
- `signal_id`
- `dispatch_id`
- `outbox_id`
- `head_sha`
- `occurred_at`

#### `delivery_work_item`

Durable queue for dispatch/retry/babysit tasks.

Suggested columns:

- `id`
- `workflow_id`
- `kind`
- `status`
- `attempt_count`
- `scheduled_at`
- `claimed_at`
- `claim_token`
- `payload_json`
- `last_error_code`
- `last_error_message`

#### `delivery_loop_incident`

Operational incidents for stuck/retry-exhausted/backlog/DLQ conditions.

#### `delivery_loop_runtime_status`

Materialized operational read model.

### 11.2 Evolve or replace current tables

Likely migration targets:

- `sdlcLoop` → `delivery_workflow`
- `delivery_loop_dispatch_intent` → folded into `delivery_work_item` or retained as a dedicated subtype table
- `sdlc_loop_signal_inbox` → retained conceptually but upgraded to normalized signal storage
- `sdlc_loop_outbox` → retain concept but project from workflow events

If a dedicated dispatch table is retained, it must still participate in the unified work-execution model and must not reintroduce a separate orchestration path.

### 11.3 Remove overloaded fields

Do not preserve these semantics in the new model:

- `loopVersion` as general-purpose guardrail counter
- `blockedFromState` as the main resumability carrier
- phase-specific special casing embedded across multiple runtime files

### 11.4 Type-system rules for implementation

When the code implementation starts, follow these rules:

1. reducer-facing types must be discriminated unions with closed sets
2. raw JSON belongs at ingress/storage boundaries, not in domain unions
3. do not use aggregate-wide nullable fields for state-specific data
4. prefer nested unions over string subfields like `category: string` or `gate: string`
5. every union should have one obvious discriminator: `kind`
6. use exhaustive `switch` with `never` assertions in all reducers and interpreters
7. read models may denormalize, but domain state must remain canonical and strict

---

## 12. Runtime Flow Examples

### 12.1 Planning complete

1. Daemon event route normalizes `daemon.completed`.
2. Signal is appended to inbox.
3. Coordinator wakes for workflow.
4. Coordinator drains signal and appends `ImplementationCompleted`-equivalent transition from planning to implementing only after plan acceptance rules pass.
5. Coordinator emits dispatch work item for implementation.
6. Dispatch worker performs daemon dispatch.
7. Ack updates workflow pending action.

### 12.2 CI feedback arrives

1. GitHub webhook route normalizes `github.ci_updated`.
2. Signal is appended to inbox.
3. Coordinator drains signal.
4. Coordinator updates gating state.
5. If passed, moves to next gate or PR/babysit phase.
6. Publication outbox emits updated status projection.

### 12.3 Dispatch ack timeout

1. Timer produces `timer.ack_expired` signal.
2. Coordinator loads active pending action.
3. Retry policy classifies failure.
4. Coordinator appends incident or retry work item.
5. Runtime status reflects degraded or stuck if threshold exceeded.

---

## 13. Migration Plan

This migration plan prioritizes the cleanest end-state architecture over the longest compatibility bridge.

### Phase 0: Stabilize current system

Before structural migration, fix the most dangerous current behaviors:

1. make publication lease refreshable
2. close ack-timeout retry gap
3. harden blocked-state automation behavior
4. reduce request-time orchestration in daemon ingress where possible
5. add signal DLQ and bounded retry/defer behavior
6. add epoch-fenced lease refresh
7. replace ad hoc lease refresh calls with auto-refreshing heartbeat
8. add idempotency keys for gate persistence
9. return discriminated stale/no-op outcomes instead of generic buckets

### Phase 1: Introduce canonical types and event taxonomy

1. add new shared domain types
2. define normalized external signals
3. define workflow event schema
4. define explicit human-wait state variants
5. define workflow-generation identity model

### Phase 2: Add new tables and read models

1. create `delivery_workflow_event`
2. create `delivery_work_item`
3. create `delivery_loop_runtime_status`
4. create incident and DLQ tables
5. add thread → active workflow generation linkage

### Phase 3: Make ingress append-only

1. daemon route appends signals and wakes coordinator
2. GitHub feedback routes append signals and wake coordinator
3. human interventions append signals and wake coordinator
4. retain raw external payloads durably alongside normalized signal records for migration validation and forensics

### Phase 4: Introduce coordinator tick

1. coordinator processes one workflow under lease
2. signal inbox drains through coordinator only
3. state transitions append events and update workflow aggregate
4. treat workflow events as mandatory append-only audit records written alongside canonical state transitions

### Phase 5: Move side effects behind work queues

1. daemon dispatch becomes dispatch work execution
2. publication becomes pure outbox projection
3. retries become explicit scheduled work
4. PR creation/linking becomes review-surface attachment projection work rather than core-domain orchestration

### Phase 6: Decommission old orchestration paths

1. remove phase-transition ownership from `checkpoint-thread-internal.ts`
2. shrink `signal-inbox.ts` to store/runtime utilities or retire it
3. remove compatibility aliases after full cutover
4. complete fast naming cutover from `sdlc-*` to `delivery_*`

### Phase 7: Full cutover and cleanup

1. swap status UI to read from runtime status projection
2. delete obsolete fields and tables
3. remove legacy `sdlc-*` naming from the core path

---

## 14. Detailed Refactor Work Plan

### Workstream A: Domain model

1. Define canonical workflow state types.
2. Define signal/event/work-item unions.
3. Define retry and incident taxonomies.
4. Create transition reducer tests.

### Workstream B: Persistence

1. Add workflow event table.
2. Add work-item table.
3. Add runtime status projection.
4. Add incident + DLQ tables.
5. Add store helpers and claim semantics.
6. Add idempotency-key support for gate persistence.
7. Add epoch-fenced lease refresh and worker heartbeat support.

### Workstream C: Coordinator

1. Build single-workflow tick executor.
2. Move signal reduction rules into coordinator.
3. Move pending-action scheduling into coordinator.
4. Append workflow events for every meaningful state change.

### Workstream D: Ingress adapters

1. daemon ingress → normalize signal only
2. GitHub feedback ingress → normalize signal only
3. human intervention actions → normalize signal only

### Workstream E: Workers

1. dispatch work executor
2. publication work executor
3. retry work executor
4. babysit/recheck work executor

### Workstream F: UI and operator tooling

1. runtime health read API
2. per-loop timeline view
3. backlog dashboards
4. incident inspection and replay controls

---

## 15. Risks and Trade-offs

### 15.1 Costs

- substantial schema migration
- temporary duplication during cutover
- need to preserve behavioral parity while moving logic
- coordinator layer adds a new central abstraction that must be designed carefully

### 15.2 Why this is still worth it

The current complexity is already present; it is just distributed. This redesign concentrates orchestration in one place, which reduces long-term race conditions, improves replayability, and makes the system operable at higher reliability.

---

## 16. Success Criteria

The redesign is successful when:

1. every external event path is append-only
2. exactly one coordinator owns loop transitions
3. every external side effect is represented as durable work
4. a stuck loop can be identified from one runtime status row
5. a full loop timeline can be reconstructed from persisted workflow events
6. `checkpoint-thread-internal.ts` is no longer a workflow orchestrator
7. legacy `sdlc` compatibility exports are out of the hot path

---

## 17. Immediate Recommended Next Step

Implement Phase 0 and Phase 1 first:

1. patch the current highest-risk reliability gaps
2. define the new canonical types and event model
3. lock the workflow-generation, explicit-wait-state, and review-surface abstractions
4. review those types before cutting schema

That yields immediate safety improvements and de-risks the larger migration.
