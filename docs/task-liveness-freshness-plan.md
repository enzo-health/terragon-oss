# Task Liveness Freshness Plan

## Problem

The task page currently derives "is the agent working?" from multiple sources
that do not share a single freshness contract:

- `thread_chat.status`
- `delivery_workflow_head_v3.state`
- AG-UI SSE replay/live-tail state
- TanStack Query cache + TanStack DB seeded collections
- broadcast-driven task-list state

When one channel advances and another does not, the UI can show:

- `Planning`
- `10%`
- `Assistant is working`
- an empty transcript

even though the run is dead, disconnected, or already terminal elsewhere.

## What We Found

### 1. SSE terminal truth is not durable

The AG-UI route treats a run as complete only when replayed events include
`RUN_FINISHED` or `RUN_ERROR`, but those terminal markers are currently
ephemeral-only. Reconnect can therefore replay a dead run with no terminal
marker and keep live-tailing forever.

Key files:

- `apps/www/src/app/api/ag-ui/[threadId]/route.ts`
- `apps/www/src/server-lib/ag-ui-publisher.ts`
- `packages/shared/src/model/agent-event-log.ts`

### 2. Canonical run persistence and legacy status persistence can diverge

`agent_event_log`, `thread_chat.status`, `agent_run_context.status`, and
delivery-loop head updates do not commit as one fenced terminal transition.
Canonical-only daemon payloads can advance replay state without advancing the
status fields the UI also reads.

Key files:

- `apps/www/src/app/api/daemon-event/route.ts`
- `apps/www/src/server-lib/handle-daemon-event.ts`
- `apps/www/src/agent/update-status.ts`

### 3. Delivery-loop state can override fresher terminal chat state

`getDeliveryLoopAwareThreadStatus()` coerces terminal chat states back to
`working` whenever delivery-loop state is still "active". That means a stale
workflow head can make a fresh terminal chat look live.

Key files:

- `apps/www/src/lib/delivery-loop-status.ts`
- `apps/www/src/components/chat/chat-ui.tsx`
- `apps/www/src/components/chat/chat-messages.tsx`

### 4. The task page and the task list do not refresh from the same signals

The sidebar is still broadcast-patch driven, while the open task page mostly
depends on AG-UI invalidation (`thread.status_changed`, `RUN_FINISHED`,
`RUN_ERROR`). Missing one AG-UI event can strand the open page on stale state
while the list moves on.

Key files:

- `apps/www/src/hooks/use-ag-ui-query-invalidator.ts`
- `apps/www/src/components/thread-list/main.tsx`
- `apps/www/src/queries/thread-patch-cache.ts`

### 5. Collection-first reads are not backed by live collection patching

`ChatUI` prefers TanStack DB collections over query results, but current app
usage is mostly query seeding. The collection patch helpers exist, but are not
the active freshness path for the task page.

Key files:

- `apps/www/src/components/chat/chat-ui.tsx`
- `apps/www/src/collections/thread-shell-collection.ts`
- `apps/www/src/collections/thread-chat-collection.ts`

## Decision

We should make task liveliness derive from one durable source of truth and then
fan out from there. The cleanest contract is:

1. Persist run lifecycle transitions durably.
2. Compute liveliness from durable run/workflow state first.
3. Treat SSE and broadcast as delivery channels, not truth.
4. Never let stale workflow hints override fresher terminal chat/run state.

## Proposed Fix

### Phase 1: Make terminal run lifecycle durable

Goal: reconnecting clients must be able to determine that a run is terminal
without having observed a live ephemeral event.

Changes:

- Persist terminal AG-UI events into `agent_event_log`.
- Or, if we keep terminal markers ephemeral on the wire, synthesize terminality
  in `/api/ag-ui/[threadId]` from `agent_run_context.status` and
  `delivery_workflow_head_v3` when replay lacks a terminal marker.
- Stop treating "run with only `RUN_STARTED`" as indefinitely live unless a
  durable liveness field still says it is live.

Acceptance:

- Refreshing a completed/failed/stopped task never leaves SSE in endless
  live-tail for an already-dead run.
- Reconnect after a missed terminal event still lands in a terminal UI state.

### Phase 2: Fence terminal persistence across all status surfaces

Goal: `agent_event_log`, `thread_chat.status`, `agent_run_context.status`, and
delivery-loop head cannot disagree about terminality for the same run.

Changes:

- In `daemon-event` handling, derive terminality from the same canonical/envelope
  payload that persists AG-UI events.
- Make terminal transition fail-closed when one of the terminal writes fails.
- Ensure canonical-only terminal payloads also advance `thread_chat` and
  `agent_run_context`.
- Treat CAS failures on terminal transitions as correctness bugs, not soft
  no-ops.

Acceptance:

- No path exists where terminal content lands but `thread_chat.status` stays
  `working`.
- No path exists where `agent_run_context.status` is terminal while the active
  workflow head remains falsely active.

### Phase 3: Add a liveness contract to the UI

Goal: the page should only say "working" when the underlying run/workflow is
fresh enough to justify it.

Changes:

- Add a derived `isLive` / `livenessState` field to the task status payload.
- Base it on durable fields like:
  - latest run terminality
  - active run id
  - lease expiry
  - last activity timestamp
  - task chat updated timestamp
- Use that field in the footer instead of "active delivery state OR working
  status".
- Stop `getDeliveryLoopAwareThreadStatus()` from coercing terminal chat states
  back to `working` unless the run is provably still live.

Acceptance:

- A stale `planning` workflow head cannot override a fresher terminal chat/run.
- The footer degrades to neutral or stale messaging when freshness is unknown.

### Phase 4: Unify refresh signals

Goal: the open task page and the sidebar should converge from the same truth.

Changes:

- Add a first-class invalidation signal for workflow-head changes, not just
  `thread.status_changed`.
- Refetch delivery-loop status when `delivery_workflow_head_v3.updatedAt` or
  blocked reason changes.
- Add a small fallback poll for status-critical data while a task is believed
  live, so one missed SSE event cannot wedge the page indefinitely.

Acceptance:

- Sidebar and open page converge after missed AG-UI invalidation events.
- Delivery stepper does not remain on `Planning`/`Implementing` for minutes
  after the underlying workflow moved.

### Phase 5: Simplify the read path

Goal: stop having "collection truth" and "query truth" compete in the task page
unless both are actually live.

Changes:

- Either wire collection patching back into the task detail page for shell/chat,
  or stop preferring collection over query for status-critical fields.
- Keep transcript hydration separate from liveness/status hydration if needed.

Acceptance:

- Blank transcript plus stale active footer is no longer possible from seeded
  collection drift alone.

## Recommended Order

1. Phase 1
2. Phase 2
3. Phase 3
4. Phase 4
5. Phase 5

This order fixes the truth model before changing UX behavior.

## Short-Term Safety Checks

Before or alongside implementation, add tests for:

- reconnect after missing terminal SSE event
- run with only `RUN_STARTED`
- canonical-only terminal daemon payload
- terminal chat status plus stale active workflow head
- missed `thread.status_changed` invalidation
- task page and sidebar diverging after one channel updates

## Practical UX Rule

Until the full fix lands, the page should prefer being conservative:

- If liveliness is uncertain, show `Waiting for updates` or similar
- Do not show `Assistant is working` unless we have fresh evidence
- Do not show `Planning` as an activity claim when it is only a stale workflow
  snapshot

## Closing The Feedback Loop

We should make this bug class testable against the actual app, not just unit and
route harnesses.

### Goal

Be able to:

1. run a real task in the local app
2. observe every liveness surface in one place
3. reproduce stale-state failures on demand
4. capture the failing run as a deterministic replay artifact
5. turn that capture into a permanent regression test

### Existing Building Blocks

The repo already has useful pieces:

- daemon-event capture via `apps/www/test/integration/recorder.ts`
- real route replay via `apps/www/test/integration/replayer.ts`
- AG-UI event replay via `apps/www/test/integration/ag-ui-replayer.ts`

What is missing is one joined live-browser loop over the actual app plus a
single debug truth surface.

### Phase 6: Add A Task Liveness Debug Surface

Goal: for any thread, expose the state we need to explain why the UI says a
task is live or not.

Add a debug endpoint or debug-only server action that returns:

- latest `thread_chat.status` and `thread_chat.updatedAt`
- latest `agent_run_context.status`
- workflow-head state, `activeRunId`, `leaseExpiresAt`, `lastActivityAt`
- latest replay-selected run id
- whether AG-UI replay sees a terminal marker
- enough timestamps to compare freshness between these surfaces

Acceptance:

- when the UI looks wrong, we can inspect one payload and immediately see which
  source is stale

### Phase 7: Create One Golden Local Task Scenario

Goal: one command should create a reproducible real task path in the local app.

Add a helper that:

- seeds a test user
- creates a test thread + thread chat
- launches a real run through the normal app path
- prefers a deterministic local provider when possible

Acceptance:

- we can start a known task scenario locally without manual setup drift

### Phase 8: Add Real Browser E2E For Liveness

Goal: assert the actual page, not just reducers and routes.

Add browser automation that:

- signs in as the seeded test user
- opens the real task page
- waits for run start
- forces one failure mode at a stream boundary
- asserts the page does not remain stuck on stale `Assistant is working` /
  `Planning`

Target cases:

- terminal backend state after missed terminal SSE event
- stale active workflow head with terminal chat
- missing AG-UI invalidation while sidebar state advances

Acceptance:

- at least one browser test proves the page degrades correctly when freshness is
  uncertain

### Phase 9: Auto-Capture Failed Live Runs

Goal: every real failure should become a replayable artifact.

When a live E2E fails, capture:

- daemon-event JSONL
- AG-UI event stream snapshot
- liveness debug payload
- browser screenshot/video

Then feed the captured run back through the existing replay harnesses.

Acceptance:

- a real-world stale-state failure can be converted into a deterministic test
  fixture with low manual effort

### Phase 10: Add A Cross-Surface Liveness Invariant

Goal: make divergence measurable.

While a browser test believes a task is live, poll the liveness debug surface
and assert:

- UI state matches durable backend liveness within a short grace window
- terminal backend state cannot coexist with prolonged `Assistant is working`
- stale workflow state cannot override fresher terminal chat/run state

Acceptance:

- this entire class of bugs fails as an invariant, not only as scattered UI
  expectations

## Updated Recommended Order

1. Phase 1
2. Phase 2
3. Phase 3
4. Phase 4
5. Phase 5
6. Phase 6
7. Phase 7
8. Phase 8
9. Phase 9
10. Phase 10

## Subagent-Driven Execution

We should execute this plan with fresh sub agents per task, not as one large
implementation pass. The work is mostly separable by truth boundary:

- AG-UI replay / SSE truth
- daemon-event terminal persistence
- delivery-loop freshness + UI derivation
- detail-page refresh mechanics
- actual-app E2E / capture loop

Each task should follow the same gate:

1. implementer sub agent
2. spec-compliance review
3. code-quality review
4. only then mark complete

## Execution Tasks

### Task 1: Durable terminal AG-UI lifecycle

Scope:

- `apps/www/src/app/api/ag-ui/[threadId]/route.ts`
- `apps/www/src/server-lib/ag-ui-publisher.ts`
- `packages/shared/src/model/agent-event-log.ts`
- related tests

Deliver:

- reconnect-safe terminal replay behavior
- no endless live-tail for already-terminal runs
- tests for missed terminal SSE event and `RUN_STARTED`-only runs

Why first:

- this removes the largest false-liveness class at the source

### Task 2: Fence terminal persistence across all run surfaces

Scope:

- `apps/www/src/app/api/daemon-event/route.ts`
- `apps/www/src/server-lib/handle-daemon-event.ts`
- `apps/www/src/agent/update-status.ts`
- `packages/shared/src/model/threads.ts`
- related tests

Deliver:

- canonical terminal payloads advance `thread_chat`, `agent_run_context`, and
  delivery-loop head consistently
- terminal transition is fail-closed instead of best-effort split-brain
- tests for canonical-only terminal payloads and CAS/transition races

Dependency:

- should build directly on Task 1

### Task 3: Add a real liveness contract to the UI

Scope:

- `apps/www/src/lib/delivery-loop-status.ts`
- `apps/www/src/components/chat/chat-ui.tsx`
- `apps/www/src/components/chat/chat-messages.tsx`
- `apps/www/src/components/chat/assistant-ui/terragon-thread.tsx`
- related tests

Deliver:

- `Assistant is working` only shows with fresh evidence
- stale workflow state cannot override fresher terminal chat/run state
- fallback copy for uncertain liveness

Dependency:

- should build on Tasks 1 and 2

### Task 4: Unify task-page freshness and refresh signals

Scope:

- `apps/www/src/hooks/use-ag-ui-query-invalidator.ts`
- `apps/www/src/queries/delivery-loop-status-queries.ts`
- `apps/www/src/collections/thread-shell-collection.ts`
- `apps/www/src/collections/thread-chat-collection.ts`
- task-list/detail-page refresh seams

Deliver:

- workflow-head changes invalidate the open task page
- status-critical fields do not depend on dead collection patch paths
- sidebar and open task converge after missed stream events

Dependency:

- can begin after Task 3 is clear

### Task 5: Add task-liveness debug surface

Scope:

- debug-only route or server action
- enough backend selectors to expose joined liveness state

Deliver:

- one payload that explains why the UI thinks a task is live
- timestamps and run ids across all truth surfaces

Dependency:

- should follow Tasks 1 and 2 so it reflects the intended truth model

### Task 6: Build golden local scenario + real browser E2E

Scope:

- seeded test scenario
- browser automation against the actual app
- failed-run auto-capture into replay artifacts

Deliver:

- reproducible real-app liveness scenario
- at least one E2E for terminal-backend / stale-UI divergence
- fixture capture path back into replay tests

Dependency:

- strongest after Task 5, because the debug surface makes failures diagnosable

## Recommended Implementation Order

1. Task 1
2. Task 2
3. Task 3
4. Task 4
5. Task 5
6. Task 6

## Per-Task Review Standard

Every task should pass these two review gates before moving on:

### Spec Compliance Review

Reviewer checks:

- all promised behavior landed
- no requested behavior was skipped
- no unrelated feature creep was added
- the tests match the failure modes named in this plan

### Code Quality Review

Reviewer checks:

- truth boundaries are clearer, not more coupled
- no new split-brain status paths were introduced
- freshness rules are explicit and readable
- test coverage is strong enough to prevent regressions

## Notes For Dispatching Sub Agents

When we start implementation, each implementer sub agent should get:

- the exact task text from this section
- the files in scope
- the dependency/task ordering constraint
- the specific failure modes it must cover with tests
- instruction to avoid widening scope outside its task boundary

The controller should not hand sub agents the whole project problem statement
again once a task is dispatched. Give them only the slice they need.
