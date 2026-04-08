---
name: delivery-loop-cleanup-worker
description: Remove legacy, dead, and flaky delivery-loop code safely using characterization tests and contract checks.
---

# Delivery Loop Cleanup Worker

NOTE: Startup/cleanup is handled by worker-base. This skill defines the work procedure.

## When to Use This Skill

Use for aggressive cleanup features that remove dead code, legacy compatibility branches, brittle tests, and redundant abstractions in delivery-loop surfaces.

## Required Skills

- `test-driven-development` — required for characterization coverage before deletions.
- `code-cleanup` — required for finding stale/dead candidates.
- `testing-anti-patterns` — required when deflaking tests.

## Work Procedure

1. Enumerate cleanup candidates in feature scope and classify confidence (`high/medium/low`) before deletion.
2. Add failing characterization/parity tests for any externally observable behavior affected by removals.
3. Remove only high-confidence dead/legacy/flaky surfaces first; keep change sets small.
4. Re-run targeted suites after each cleanup cluster; revert/remove cleanup chunks that break behavior parity.
5. Run mission-level validators for changed areas (unit/integration/e2e as applicable).
6. Record deleted surfaces explicitly in handoff and note why each was safe to remove.

## Example Handoff

```json
{
  "salientSummary": "Removed obsolete legacy event alias handling and deleted stale retry helper branches no longer reachable from canonical v3 flow. Replaced flaky timing assertions with deterministic condition-based checks.",
  "whatWasImplemented": "Deleted high-confidence dead compatibility branches and updated tests to validate canonical event parity directly. Refactored flaky timeout-based tests into deterministic assertions around state and idempotency keys.",
  "whatWasLeftUndone": "",
  "verification": {
    "commandsRun": [
      {
        "command": "pnpm -C apps/www exec vitest run src/server-lib/delivery-loop/v3/reducer.test.ts src/server-lib/delivery-loop/v3/reachability.test.ts",
        "exitCode": 0,
        "observation": "Canonical transition parity remained green after cleanup."
      },
      {
        "command": "pnpm -C apps/www exec vitest run src/server-lib/delivery-loop/v3/worker.test.ts src/server-lib/delivery-loop/v3/relay.test.ts",
        "exitCode": 0,
        "observation": "Durable processing and relay idempotency behavior remained intact."
      }
    ],
    "interactiveChecks": [
      {
        "action": "Inspect delivery-loop progression in browser after cleanup",
        "observed": "No regression in user-visible phase progression or terminal rendering."
      }
    ]
  },
  "tests": {
    "added": [
      {
        "file": "apps/www/src/server-lib/delivery-loop/v3/reachability.test.ts",
        "cases": [
          {
            "name": "canonical event parity remains exhaustive after legacy branch removal",
            "verifies": "VAL-CROSS-010"
          }
        ]
      }
    ]
  },
  "discoveredIssues": []
}
```

## When to Return to Orchestrator

- A candidate deletion is medium/low confidence and cannot be proven dead with available evidence.
- Removing a legacy path would violate an active validation-contract assertion.
- Flakiness root cause appears to be external infrastructure rather than test design/code.
