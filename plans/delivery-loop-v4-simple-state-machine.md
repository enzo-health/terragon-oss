# Delivery Loop v4: Direct Async State Machine

## Problem Statement

The current v3 architecture has 3 layers of indirection between state transitions:

```
event → reducer → effect ledger row → cron claims lease → effect handler → event
```

Each hop adds 1-60s latency (cron interval) and failure modes (lease expiry, phantom runIds, stale version checks). A 4-transition path (implementing → gating_review → gating_ci → awaiting_pr) accumulates 4-8 minutes of idle cron waiting.

The inline drain we added (`setImmediate`) helps but is a band-aid — it still goes through the effect ledger, lease claiming, and mark-succeeded ceremony for what should be a direct function call.

## Design Principle

**The call stack IS the execution engine.** State transitions execute their side effects inline. The database is for durability, not orchestration.

## Architecture

### Core: `advanceWorkflow()`

Single entry point. Receives an event, reduces it, executes the resulting action, and recurses if the action produces a follow-up event.

```typescript
async function advanceWorkflow(
  db: DB,
  workflowId: string,
  event: WorkflowEvent,
  source: EventSource,
): Promise<AdvanceResult> {
  // 1. Atomic: read head + append journal + update head + record action
  const { head, action, idempotent } = await db.transaction(async (tx) => {
    const head = await getHead(tx, workflowId);
    if (!head) return { head: null, action: null, idempotent: false };

    const journalInserted = await appendJournal(tx, workflowId, event, source);
    if (!journalInserted) return { head, action: null, idempotent: true };

    const reduced = reduce(head, event);
    await updateHead(tx, reduced.head, head.version);

    // Record pending action for crash recovery
    if (reduced.action) {
      await setPendingAction(tx, workflowId, reduced.action);
    }

    return { head: reduced.head, action: reduced.action, idempotent: false };
  });

  if (!head || idempotent) return { advanced: false };

  // 2. Execute action outside transaction (may be slow/external)
  if (action) {
    const result = await executeAction(db, workflowId, action);
    await clearPendingAction(db, workflowId);

    // 3. Action produced a follow-up event — recurse
    if (result.event) {
      return advanceWorkflow(db, workflowId, result.event, "system");
    }
  }

  return { advanced: true, state: head.state };
}
```

### Reducer: Pure, returns Action instead of Effects

```typescript
type ReduceResult = {
  head: WorkflowHead;
  action: WorkflowAction | null;  // At most ONE action per transition
};

type WorkflowAction =
  | { kind: "dispatch"; phase: "implementing" | "gate_review" | "gate_ci"; executionClass: string }
  | { kind: "create_plan_artifact" }
  | { kind: "ensure_pr" }
  | { kind: "publish_status" }
  | { kind: "schedule_ack_timeout"; runId: string; delayMs: number };
```

Key difference from v3: **one action per transition, not an array of effects.** If a transition needs both a dispatch AND a status publish, the dispatch action's completion event triggers the status publish. Sequential, not parallel.

### Action Executor: Returns follow-up event

```typescript
async function executeAction(
  db: DB,
  workflowId: string,
  action: WorkflowAction,
): Promise<{ event: WorkflowEvent | null }> {
  switch (action.kind) {
    case "dispatch": {
      const { runId, ackDeadlineAt } = await createDispatchAndTrigger(db, workflowId, action);
      return {
        event: { type: "dispatch_sent", runId, ackDeadlineAt },
      };
    }
    case "create_plan_artifact": {
      const result = await extractAndCreatePlan(db, workflowId);
      if (result.ok) {
        return {
          event: result.approvalPolicy === "auto"
            ? { type: "plan_completed" }
            : null,  // Human approval — no follow-up
        };
      }
      return { event: { type: "plan_failed", reason: result.reason } };
    }
    case "ensure_pr": {
      const result = await openOrLinkPR(db, workflowId);
      if (result.linked) return { event: { type: "pr_linked", prNumber: result.prNumber } };
      return { event: { type: "gate_review_failed", reason: result.reason } };
    }
    case "publish_status": {
      await publishGitHubStatus(db, workflowId);
      return { event: null };  // Terminal action, no follow-up
    }
    case "schedule_ack_timeout": {
      // Only remaining use of timer — schedule a delayed event
      await scheduleDelayedEvent(db, workflowId, {
        event: { type: "dispatch_ack_timeout", runId: action.runId },
        fireAt: new Date(Date.now() + action.delayMs),
      });
      return { event: null };
    }
  }
}
```

### Crash Recovery: Reconciliation pass

Instead of a cron that claims and processes effects, a lightweight reconciliation pass runs periodically:

```typescript
async function reconcileStaleWorkflows(db: DB): Promise<number> {
  // Find workflows with pending actions older than 5 minutes
  const stale = await db.query.workflowHead.findMany({
    where: and(
      isNotNull(schema.workflowHead.pendingAction),
      lt(schema.workflowHead.pendingActionAt, subMinutes(new Date(), 5)),
    ),
    limit: 10,
  });

  let recovered = 0;
  for (const head of stale) {
    // Re-execute the pending action
    const action = JSON.parse(head.pendingAction);
    const result = await executeAction(db, head.workflowId, action);
    await clearPendingAction(db, head.workflowId);
    if (result.event) {
      await advanceWorkflow(db, head.workflowId, result.event, "recovery");
    }
    recovered++;
  }
  return recovered;
}
```

This replaces the entire effect ledger + lease claiming + cron drain machinery.

## State Machine (unchanged)

Same 10 states, same transitions. Only the execution model changes.

```
planning → implementing → gating_review → gating_ci → awaiting_pr → done
                ↑                                          |
                └──────── retry (agent/infra) ─────────────┘

Terminal: done, stopped, terminated
Blocked: awaiting_manual_fix, awaiting_operator_action
```

## What Gets Deleted

| Current v3 | v4 Replacement |
|---|---|
| `delivery_effect_ledger_v3` table | `pending_action` column on head row |
| `delivery_timer_ledger_v3` table | `delayed_events` table (simpler) |
| `process-effects.ts` (~900 lines) | `execute-action.ts` (~200 lines) |
| `drainDueEffects()` + cron route | `reconcileStaleWorkflows()` (50 lines) |
| `claimNextEffect` / lease machinery | Gone — single-writer per workflow |
| `markEffectSucceeded/Failed` | `clearPendingAction()` |
| `executeStateBlockingEffect` wrapper | Direct try/catch in `executeAction` |
| `effectResultToEvent` mapping | Action executor returns event directly |
| `EffectResult` / `EffectPayload` types | `WorkflowAction` type |

**Net deletion: ~800 lines of effect ledger machinery replaced by ~250 lines of direct execution.**

## DB Schema Changes

### Add to `delivery_workflow_head_v3`:
```sql
ALTER TABLE delivery_workflow_head_v3
  ADD COLUMN pending_action JSONB,
  ADD COLUMN pending_action_at TIMESTAMPTZ;
```

### New table (replaces timer ledger):
```sql
CREATE TABLE delivery_delayed_event (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id UUID NOT NULL REFERENCES delivery_workflow(id),
  event_json JSONB NOT NULL,
  fire_at TIMESTAMPTZ NOT NULL,
  fired BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_delayed_event_fire ON delivery_delayed_event (fire_at) WHERE NOT fired;
```

### Drop after migration:
- `delivery_effect_ledger_v3`
- `delivery_timer_ledger_v3`

## Migration Path

### Phase 1: Add pending_action column + delayed_event table
- Non-breaking schema additions
- Deploy without behavior change

### Phase 2: Implement `advanceWorkflow()` + `executeAction()`
- New code path alongside existing effect ledger
- Feature flag: `useDirectStateMachine`
- When enabled, `appendEventAndAdvance()` calls `advanceWorkflow()` directly instead of inserting effects

### Phase 3: Validate in production
- Run both paths simultaneously, compare outcomes
- Monitor: action execution time, crash recovery rate, state transition latency

### Phase 4: Remove effect ledger
- Delete `process-effects.ts`, effect types, cron drain route
- Drop `delivery_effect_ledger_v3` and `delivery_timer_ledger_v3` tables
- Remove feature flag

## Latency Comparison

| Transition | v3 (cron) | v3 + inline drain | v4 (direct) |
|---|---|---|---|
| bootstrap → dispatch_sent | 1-60s | ~200ms | ~50ms |
| run_completed → gating dispatch | 1-60s | ~200ms | ~50ms |
| gate_passed → next gate dispatch | 1-60s | ~200ms | ~50ms |
| Full path (4 transitions) | 4-240s | ~800ms | ~200ms |

## Risks

1. **Long-running actions block the call stack** — dispatch actions that boot sandboxes can take 30s+. Mitigated: the dispatch action creates the intent and triggers the queue, then returns. The actual sandbox boot is async.

2. **Recursive advanceWorkflow could stack overflow** — unlikely with 10 states max depth, but add a max recursion guard (e.g., 20 hops).

3. **Crash during action execution** — the pending_action column ensures we can retry. The 5-minute staleness check prevents infinite retry loops.

4. **Concurrent signals** — two daemon events arriving simultaneously for the same workflow. Mitigated: `updateHead` uses optimistic concurrency (version check). The loser retries or is idempotent.

## Open Questions

1. Should `publish_status` be fire-and-forget (no follow-up event) or should it produce `status_published`? Currently leaning toward no event — it's a side effect, not a state transition.

2. Should the ack timeout be a delayed event or a separate timer mechanism? Delayed events table is simpler but adds a table. Alternative: just check `head.updatedAt` staleness in the reconciliation pass.

3. Should the reconciliation cron run every 30s or every 5min? More frequent = faster crash recovery but more DB queries. The direct execution path handles 99% of cases — reconciliation is truly exceptional.
