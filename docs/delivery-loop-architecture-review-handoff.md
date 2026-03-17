# Delivery Loop Architecture Review Handoff

| Field       | Value                                                |
| ----------- | ---------------------------------------------------- |
| Title       | Delivery Loop Architecture Review Handoff            |
| Audience    | Staff engineer unfamiliar with the Terragon codebase |
| Status      | Review packet                                        |
| Date        | 2026-03-14                                           |
| Primary doc | `docs/delivery-loop-architecture-redesign.md`        |

---

## 1. Purpose of this document

This document is a handoff packet for a staff engineer who has not worked in the Terragon codebase before. It provides:

1. enough codebase context to understand the current delivery-loop system
2. the architectural problems motivating the redesign
3. the proposed target architecture
4. the decisions already made
5. the areas where a critical architecture review is most valuable

This is not the canonical architecture spec. The canonical proposal is:

- `docs/delivery-loop-architecture-redesign.md`

This handoff exists so a reviewer can form an opinion without first reverse-engineering the repo.

---

## 2. What Terragon is

Terragon is an AI-powered coding assistant platform. Users create tasks/threads connected to repositories and remote sandboxes. Agent runs operate inside those sandboxes, edit code, run checks, and can create or update PRs.

This repository is a monorepo with several apps and packages. The delivery loop primarily lives in the web app and shared model packages.

### Relevant top-level areas

- `apps/www`
  - main Next.js application
  - API routes, server actions, orchestration logic, chat/task runtime
- `packages/shared`
  - database schema, model code, core persistence helpers
- `packages/daemon`
  - the daemon process that runs in sandboxes and communicates with the web app
- `packages/sandbox`
  - sandbox control and daemon communication helpers

---

## 3. What the delivery loop is

The delivery loop is Terragon’s autonomous software delivery workflow. Conceptually, it takes a thread through these phases:

1. planning
2. implementing
3. review / quality gating
4. CI / UI validation
5. PR or review-surface babysitting
6. done / stopped / terminated

It is the system that turns agent progress and external feedback into workflow movement.

### The current system already has some strong primitives

- durable signal inbox
- durable outbox/publication queue
- per-loop leases
- dispatch intent tracking
- gate persistence
- webhook dedupe/idempotency
- babysit recheck mechanisms

The redesign does not reject those ideas. It tries to give them a cleaner owner model.

---

## 4. Current codebase map

If you are new to the repo, start here.

### Current orchestration hotspots

- `apps/www/src/app/api/daemon-event/route.ts`

  - ingress for daemon messages/events
  - currently does much more than pure ingress

- `apps/www/src/server-lib/delivery-loop/signal-inbox.ts`

  - processes loop signals and can drive workflow progression

- `apps/www/src/server-lib/checkpoint-thread-internal.ts`

  - another major orchestration path; also advances workflow/gates

- `apps/www/src/server-lib/delivery-loop/publication.ts`
  - durable publication/status projection behavior

### Current shared model / persistence layer

- `packages/shared/src/model/delivery-loop/*`
  - state machine
  - guarded state persistence
  - lease
  - outbox
  - dispatch intent
  - gate persistence
  - related helpers

### Current status / operator surface

- `apps/www/src/server-actions/get-delivery-loop-status.ts`
  - user-facing status projection and background triggering behavior

### Existing background / retry surfaces

- `apps/www/src/server-lib/delivery-loop/retry-jobs.ts`
- `apps/www/src/server-lib/delivery-loop/ack-lifecycle.ts`
- `apps/www/src/server-lib/delivery-loop/ack-timeout.ts`
- `apps/www/src/server-lib/delivery-loop/babysit-recheck.ts`

---

## 5. Current architectural problems

The redesign is motivated by structural problems, not just isolated bugs.

### 5.1 Dual orchestration paths

Today more than one runtime path can advance loop state:

- `signal-inbox.ts`
- `checkpoint-thread-internal.ts`

This creates drift risk, duplicated invariants, and hidden coupling.

### 5.2 Request handlers still act like orchestrators

The daemon event route does too much:

- auth
- dedupe
- dispatch ack handling
- run-context mutation
- signal processing kickoff
- coordination side effects

The redesign wants routes to append signals and wake workers, not own workflow logic.

### 5.3 Mutable row state is overloaded

In the current system, concepts like `loopVersion` and blocked-state semantics carry too many responsibilities.

Examples:

- versioning and staleness
- guardrails / iteration counting
- resumability semantics
- runtime routing behavior

### 5.4 Operational visibility is weaker than the reliability substrate

The current code has durable mechanics, but not a strong operator model:

- no canonical append-only workflow event log
- no first-class runtime status projection for active loops
- no true DLQ/incident story as a primary design element
- no single per-loop timeline for forensics

### 5.5 Naming and migration debt

The codebase still carries a significant amount of `sdlc-*` / `delivery-loop-*` coexistence. The redesign intentionally chooses a fast naming cutover to reduce long-term confusion.

---

## 6. Decisions already made

The following choices are already locked for the target architecture.

### 6.1 Source of truth

- aggregate-row first
- `delivery_workflow` is authoritative for current state
- append-only workflow events are mandatory audit/history records

### 6.2 Human waits

Use explicit wait states rather than one generic catch-all:

- `awaiting_plan_approval`
- `awaiting_manual_fix`
- `awaiting_operator_action`

### 6.3 Gate model

- sequential execution in the first implementation
- type system should support future graph/parallel execution

### 6.4 Dispatch model

- dispatch remains a special domain concept
- but it executes through the same durable work-execution framework as other work items

### 6.5 Naming

- fast cutover to `delivery_*`
- no long-lived compatibility vocabulary in the end-state

### 6.6 Raw payload retention

- keep raw daemon/GitHub payloads for now
- but only at ingress/storage boundaries, not in reducer-facing domain unions

### 6.7 Operator model

- incidents, DLQs, replay surfaces, and runtime health are first-class

### 6.8 Workflow identity

- multiple workflow generations may exist for a thread over time
- exactly one workflow generation may be active at a time

### 6.9 PR relationship

- GitHub PR creation/linking is not a core-domain transition primitive
- the core domain models an attached review surface
- GitHub is one adapter/projection implementation of that abstraction

### 6.10 Migration objective

- optimize for the cleanest end-state architecture
- do not let migration scaffolding distort the final shape

---

## 7. Proposed target architecture

At a high level:

1. all external inputs normalize into typed signals
2. signals land in a durable inbox
3. one coordinator tick owns state transitions for one workflow generation at a time
4. the coordinator appends immutable workflow events
5. projections/read models are built from canonical workflow state plus operational tables and audit history
6. side effects run through durable work items

### 7.1 High-level flow

```text
External systems
  ├─ daemon
  ├─ GitHub
  ├─ human actions
  └─ timers/cron
        │
        ▼
  typed signal normalization
        │
        ▼
  durable signal inbox
        │
        ▼
  single coordinator tick
    ├─ reduce state
    ├─ append workflow events
    ├─ update projections
    └─ emit work items
        │
        ├─ dispatch work
        ├─ publication work
        ├─ retry work
        └─ babysit work
```

### 7.2 Architectural layers

#### Shared domain layer

Proposed path:

- `packages/shared/src/delivery-loop/domain/*`

Responsibilities:

- workflow types
- transition events
- signal types
- domain events
- work-item types
- retry/incident enums

#### Shared store layer

Proposed path:

- `packages/shared/src/delivery-loop/store/*`

Responsibilities:

- event append/query
- signal inbox claim/commit/release
- work-item persistence/claiming
- leases
- incident persistence
- runtime-status projections

#### App coordinator layer

Proposed path:

- `apps/www/src/server-lib/delivery-loop/coordinator/*`

Responsibilities:

- one owner for loop transitions
- choose work items
- append events
- update projections

#### Adapter layer

Proposed path:

- `apps/www/src/server-lib/delivery-loop/adapters/*`

Responsibilities:

- daemon ingress normalization
- GitHub normalization
- human-action normalization
- gate executor bridges
- publication bridges

#### Worker layer

Proposed path:

- `apps/www/src/server-lib/delivery-loop/workers/*`

Responsibilities:

- execute dispatch work
- execute publication work
- execute retry work
- execute babysit work

---

## 8. Type-system direction

The redesign is intentionally type-heavy. The goal is to make illegal workflow states difficult or impossible to represent.

### 8.1 Workflow as discriminated union

The core workflow should be a discriminated union, not a flat row-shaped object with many nullable fields.

Representative states:

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

State-specific fields should live on the relevant variants.

### 8.2 Branded IDs

The reviewed architecture recommends branded/nominal types for:

- `WorkflowId`
- `ThreadId`
- `DispatchId`
- `SignalId`
- `PlanVersion`
- `HeadSha`
- `PullRequestNumber`
- `IncidentId`
- `CorrelationId`

This is one of the strongest ideas from the comparison review and should likely be preserved in implementation.

### 8.3 Closed unions only at the reducer boundary

Reducer-facing types should:

- use `kind` as the discriminator
- use `snake_case` discriminator values
- avoid `unknown` and free-form string categories
- parse raw external payloads before they reach domain logic

### 8.4 Derived pending action model

`pendingAction` should not be an independent source of truth on the aggregate. It should be derived from workflow state or materialized only in projections/read models.

### 8.5 Review surface abstraction

The architecture uses `ReviewSurfaceRef` rather than hard-coding GitHub PR as the primary domain object.

That allows the workflow to wait for and attach to a review surface without baking GitHub into the core state machine.

---

## 9. Operational hardening to preserve

The latest comparison against Claude’s plan found several near-term hardening ideas that should be retained.

### 9.1 Signal DLQ

Signals should support:

- retry/defer count
- last processing error
- dead-letter timestamps/reason

Signal processing failures should never be silently swallowed.

### 9.2 Epoch-fenced lease refresh

Lease refresh must verify epoch, not just owner identity.

### 9.3 Auto-refreshing heartbeat

Long-running coordination should not rely on scattered manual refresh calls.

### 9.4 Idempotent gate persistence

Gate persistence should support an idempotency key so replayed/retried processing does not duplicate gate runs.

### 9.5 Discriminated stale outcomes

Stale/no-op conditions should become typed unions rather than one generic stale bucket.

---

## 10. Proposed data model

### 10.1 New core tables

#### `delivery_workflow_event`

Append-only workflow event history.

This is the immutable audit/history log.

#### `delivery_workflow`

Canonical row for current aggregate state.

This is the authoritative runtime source of truth.

#### `delivery_work_item`

Durable work queue for:

- dispatch
- publication
- retry
- babysit

#### `delivery_loop_runtime_status`

Materialized operational read model for active workflows.

#### `delivery_loop_incident`

Operational incident table.

#### `delivery_loop_signal_dlq`

Dead-lettered signals.

#### `delivery_loop_outbox_dlq`

Dead-lettered work/projection outputs.

### 10.2 Existing tables likely to evolve or be replaced

- `sdlcLoop`
- `delivery_loop_dispatch_intent`
- `sdlc_loop_signal_inbox`
- `sdlc_loop_outbox`

The review request should pay attention to whether these should be evolved in place or replaced more aggressively.

---

## 11. Proposed migration plan

This migration intentionally optimizes for the best end-state design.

### Phase 0

Stabilize the current system:

1. publication lease refreshability
2. ack-timeout retry gap
3. blocked-state automation hardening
4. reduced request-time orchestration
5. signal DLQ / bounded retries
6. epoch-fenced lease refresh
7. auto-refreshing heartbeat
8. gate idempotency keys
9. discriminated stale outcomes

### Phase 1

Introduce canonical domain types and event taxonomy:

1. workflow types
2. typed signals
3. workflow event schema
4. explicit human wait variants
5. workflow-generation identity model

### Phase 2

Add core persistence and read-model tables:

1. `delivery_workflow_event`
2. `delivery_work_item`
3. `delivery_loop_runtime_status`
4. incident and DLQ tables
5. thread → active workflow generation linkage

### Phase 3

Make ingress append-only:

1. daemon route appends signals
2. GitHub routes append signals
3. human interventions append signals
4. raw payloads retained for forensics and migration validation

### Phase 4

Introduce the coordinator:

1. one workflow generation processed under lease
2. signal inbox drains only via coordinator
3. state transitions append events and update projections
4. aggregate rows treated as projections

### Phase 5

Move side effects behind work execution:

1. dispatch work execution
2. publication projection work
3. retry work
4. review-surface attachment work

### Phase 6

Decommission old orchestration paths:

1. remove orchestration ownership from `checkpoint-thread-internal.ts`
2. retire or heavily shrink `signal-inbox.ts`
3. remove compatibility aliases
4. complete fast naming cutover

### Phase 7

Final cleanup:

1. status UI reads from runtime-status projection
2. obsolete fields/tables removed
3. legacy `sdlc-*` terminology gone from the core path

---

## 12. What the reviewer should focus on

The reviewer does not need to re-litigate every choice. The most valuable review areas are:

### 12.1 Event-sourced boundary correctness

- Is event-log-as-canonical the right choice here?
- Are the proposed projections sufficient?
- Are there missing replay or projection hazards?

### 12.2 Domain boundary cleanliness

- Is the review-surface abstraction correct?
- Is PR linkage sufficiently decoupled from the core domain?
- Are any GitHub-specific concepts still leaking into the core?

### 12.3 Coordinator ownership

- Does the coordinator have the right responsibilities?
- Is any orchestration still leaking into ingress or persistence helpers?

### 12.4 Type-system rigor

- Are the unions sufficiently discriminated?
- Are there still invalid aggregate shapes that remain representable?
- Should more branded types be used?

### 12.5 Migration realism

- Is the migration plan still feasible despite optimizing for clean end-state?
- Are there places where temporary scaffolding is still necessary?

### 12.6 Operational model

- Are incidents/DLQs/runtime status sufficiently first-class?
- Is the operator surface strong enough for a rollout of this size?

---

## 13. Open tensions worth explicit scrutiny

These are not unresolved product questions, but they are valid review pressure points:

1. should `awaiting_pr` remain a top-level state, or should review-surface attachment be modeled differently?
2. should dispatch live in the unified `delivery_work_item` table, or in a dedicated table that still conforms to the same execution model?
3. how much dual-write or parity scaffolding is acceptable during migration without polluting the target architecture?
4. should gate graph parallelization have any representation in v1 types beyond the `gating` abstraction?
5. what is the cleanest strategy for preserving current operator/user status semantics during the migration?

---

## 14. Quick file map for reviewer reading

If the reviewer wants to inspect code after reading this packet, start with these files:

- `docs/delivery-loop-architecture-redesign.md`
- `apps/www/src/app/api/daemon-event/route.ts`
- `apps/www/src/server-lib/delivery-loop/signal-inbox.ts`
- `apps/www/src/server-lib/checkpoint-thread-internal.ts`
- `apps/www/src/server-lib/delivery-loop/publication.ts`
- `apps/www/src/server-lib/delivery-loop/ack-lifecycle.ts`
- `apps/www/src/server-lib/delivery-loop/ack-timeout.ts`
- `apps/www/src/server-lib/delivery-loop/retry-jobs.ts`
- `apps/www/src/server-lib/delivery-loop/babysit-recheck.ts`
- `packages/shared/src/model/delivery-loop/state-machine.ts`
- `packages/shared/src/model/delivery-loop/guarded-state.ts`
- `packages/shared/src/model/delivery-loop/lease.ts`
- `packages/shared/src/model/delivery-loop/outbox.ts`
- `packages/shared/src/model/delivery-loop/dispatch-intent.ts`
- `packages/shared/src/model/delivery-loop/review-gate-persistence.ts`
- `packages/shared/src/model/delivery-loop/ci-gate-persistence.ts`
- `packages/shared/src/model/delivery-loop/review-thread-gate-persistence.ts`
- `packages/shared/src/model/signal-inbox-core.ts`

---

## 15. Bottom line

The proposed architecture is trying to turn the delivery loop into a proper workflow engine with:

- one owner for transitions
- append-only ingress
- event-log-as-canonical
- durable work execution
- explicit wait states
- projection-based review surfaces
- first-class operator tooling

The key review question is not whether the current system can be patched further. It is whether this target architecture is the right long-term owner model for a system that already behaves like a workflow engine.
