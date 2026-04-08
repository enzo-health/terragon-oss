---
name: delivery-loop-runtime-worker
description: Simplify and harden delivery-loop state machine, effect processing, and ingress orchestration with strict behavior preservation.
---

# Delivery Loop Runtime Worker

NOTE: Startup/cleanup is handled by worker-base. This skill defines the work procedure.

## When to Use This Skill

Use for runtime simplification features: reducer/state transitions, effect orchestration, daemon/webhook ingress, retry/lease/dead-letter logic, and canonical transition contracts.

## Required Skills

- `test-driven-development` — required for all runtime changes.
- `systematic-refactoring` — required when collapsing/removing redundant runtime branches.
- `agent-browser` — required when the feature affects user-visible delivery-loop status behavior.

## Work Procedure

1. Read targeted feature + `fulfills` assertions; identify impacted runtime paths.
2. Add/adjust failing characterization tests first for all impacted assertions.
3. Implement minimum runtime change to pass tests while preserving external behavior.
4. Remove or collapse redundant branches only after parity tests prove no regression.
5. Run targeted validators for changed scope:
   - reducer/invariants/reachability/process-effects/worker tests
   - affected route tests (`daemon-event`, `webhooks`, cron)
   - related integration/e2e suites when transition semantics changed
6. For status-projection-impacting changes, perform browser verification with `agent-browser` (fallback only if blocked).
7. Report exact assertions covered, command outcomes, and any discovered runtime risks.

## Example Handoff

```json
{
  "salientSummary": "Simplified v3 transition branches by consolidating legacy-normalized paths and hardened lease-fenced effect emission. Preserved terminal absorption and stale-signal dropping behavior.",
  "whatWasImplemented": "Refactored reducer transition handling and process-effects completion flow to reduce duplicate branches and enforce deterministic failure handling. Added/updated tests for stale event suppression, terminal absorption, and append-failure safety.",
  "whatWasLeftUndone": "",
  "verification": {
    "commandsRun": [
      {
        "command": "pnpm -C apps/www exec vitest run src/server-lib/delivery-loop/v3/reducer.test.ts src/server-lib/delivery-loop/v3/process-effects.test.ts src/server-lib/delivery-loop/v3/durable-delivery.test.ts",
        "exitCode": 0,
        "observation": "Runtime transition/effect suites passed."
      },
      {
        "command": "pnpm -C apps/www exec vitest run src/app/api/daemon-event/route.test.ts src/app/api/webhooks/github/route.test.ts",
        "exitCode": 0,
        "observation": "Ingress contract tests passed."
      }
    ],
    "interactiveChecks": [
      {
        "action": "Open thread delivery-loop status and compare with API status payload",
        "observed": "UI state matched canonical API semantics for active and blocked paths."
      }
    ]
  },
  "tests": {
    "added": [
      {
        "file": "apps/www/src/server-lib/delivery-loop/v3/process-effects.test.ts",
        "cases": [
          {
            "name": "does not leave silently-succeeded state-blocking effect when append fails",
            "verifies": "VAL-PROC-011"
          }
        ]
      }
    ]
  },
  "discoveredIssues": []
}
```

## When to Return to Orchestrator

- The simplification requires changing contract behavior beyond accepted mission scope.
- A change introduces unresolved ambiguity between legacy compatibility and canonical v3 semantics.
- Required tests are flaky due unrelated pre-existing infrastructure failures.
