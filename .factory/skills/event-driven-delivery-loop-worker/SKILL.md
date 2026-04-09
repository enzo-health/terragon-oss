---
name: event-driven-delivery-loop-worker
description: Worker for event-driven delivery-loop updates mission. Handles broadcast schema changes, daemon event wiring, UI query refactoring, and E2E validation.
---

# Event-Driven Delivery-Loop Worker

## When to Use This Skill

Features that:

- Extend broadcast types in packages/types
- Wire daemon events to broadcast delivery-loop refetch
- Refactor React Query from adaptive polling to heartbeat + event-driven
- Add realtime hooks for broadcast invalidation
- Validate with agent-browser E2E flows

## Required Skills

- `agent-browser` for E2E validation of broadcast → UI latency

## Work Procedure

### Phase 1: Schema/Broadcast Changes (if applicable)

1. Update `packages/types/src/broadcast.ts` to add "delivery-loop" refetch target
2. Run `pnpm -C packages/types tsc-check` to verify types compile
3. Update `apps/www/src/queries/thread-patch-cache.ts` to handle delivery-loop refetch
4. Run `pnpm -C apps/www exec vitest run thread-patch-cache.test.ts`

### Phase 2: Daemon Integration (if applicable)

1. Modify `apps/www/src/app/api/daemon-event/route.ts` to broadcast on terminal events
2. Modify `apps/www/src/server-lib/handle-daemon-event.ts` if needed
3. Update `apps/www/src/server-lib/delivery-loop/v3/process-effects.ts` to broadcast on state transitions
4. Run `pnpm -C apps/www exec vitest run daemon-event/route.test.ts process-effects.test.ts`

### Phase 3: UI Query Refactoring (if applicable)

1. Modify `apps/www/src/queries/delivery-loop-status-queries.ts`:
   - Replace adaptive refetchInterval with constant 300_000ms (5 min)
   - Keep staleTime for deduplication
2. Create `apps/www/src/hooks/useDeliveryLoopStatusRealtime.ts`:
   - Subscribe to broadcast with useRealtimeThread
   - On refetch: ["delivery-loop"], call queryClient.invalidateQueries()
3. Run typecheck and tests

### Phase 4: E2E Validation (if applicable)

1. Start dev services: `pnpm dev`
2. Use `agent-browser` to:
   - Navigate to thread with active delivery loop
   - Trigger daemon event (via API call or sandbox)
   - Verify UI updates within 1 second of event
   - Check Network tab for refetch timing
3. Simulate WebSocket drop and verify heartbeat recovery

### Phase 5: Verification

1. Run `pnpm tsc-check` — must pass
2. Run `pnpm turbo lint` — must pass
3. Run affected tests — must pass
4. For E2E features: agent-browser validation showing < 1s latency

## Example Handoff

```json
{
  "timestamp": "2026-04-09T12:00:00Z",
  "workerSessionId": "...",
  "featureId": "m3-add-realtime-invalidation-hook",
  "milestone": "ui-refactoring",
  "commitId": "abc123",
  "successState": "success",
  "returnToOrchestrator": false,
  "handoff": {
    "salientSummary": "Created useDeliveryLoopStatusRealtime hook that subscribes to broadcast events and invalidates delivery-loop query. Hook handles refetch: ['delivery-loop'] patches and cleans up on unmount.",
    "whatWasImplemented": "1. Created useDeliveryLoopStatusRealtime.ts hook\n2. Uses useRealtimeThread to subscribe to user channel\n3. On refetch: ['delivery-loop'] patch, calls queryClient.invalidateQueries()\n4. Proper cleanup on unmount\n5. Added tests for hook behavior",
    "whatWasLeftUndone": "",
    "verification": {
      "commandsRun": [
        {
          "command": "pnpm tsc-check",
          "exitCode": 0,
          "observation": "All packages passed type checking"
        },
        {
          "command": "pnpm -C apps/www exec vitest run useDeliveryLoopStatusRealtime.test.ts",
          "exitCode": 0,
          "observation": "Hook tests passed - subscription, invalidation, cleanup"
        }
      ]
    },
    "tests": {
      "added": [
        {
          "file": "apps/www/src/hooks/useDeliveryLoopStatusRealtime.test.ts",
          "cases": [
            {
              "name": "subscribes to broadcast on mount",
              "verifies": "subscription"
            },
            {
              "name": "invalidates query on delivery-loop refetch",
              "verifies": "VAL-UI-001"
            },
            {
              "name": "cleans up subscription on unmount",
              "verifies": "cleanup"
            }
          ]
        }
      ]
    }
  }
}
```

## When to Return to Orchestrator

- Schema changes fail TypeScript compilation
- Broadcast wiring conflicts with existing daemon flow
- UI query refactoring causes test failures
- E2E latency exceeds 1 second target (architectural concern)
- WebSocket reconnection issues require broader investigation
