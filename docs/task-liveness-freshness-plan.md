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
