---
name: delivery-loop-validation-worker
description: Repair and harden delivery-loop validation infrastructure and contract-driven test surfaces with strict TDD.
---

# Delivery Loop Validation Worker

NOTE: Startup/cleanup is handled by worker-base. This skill defines the work procedure.

## When to Use This Skill

Use for features that modify validation entrypoints, CLI delivery-loop harness behavior, contract tests, or QA-facing validation surfaces.

## Required Skills

- `test-driven-development` — required before any implementation changes.
- `agent-browser` — required for browser-visible validation checks when UI assertions are in scope (Playwright fallback only if blocked).

## Work Procedure

1. Read feature requirements and all referenced `fulfills` assertion IDs from `validation-contract.md`.
2. Write or update failing tests first (red) for each targeted assertion.
3. Implement the smallest change needed to make tests pass (green).
4. Refactor for clarity/determinism while keeping tests green.
5. Run validation gates for changed scope:
   - `pnpm delivery-loop:local preflight`
   - targeted `vitest` suites for changed files
   - affected CLI/local-framework command(s)
6. Perform manual/interactive verification for any CLI/API/browser behavior in scope.
7. Capture exact command outcomes, interactive observations, and any unresolved issues in handoff.

## Example Handoff

```json
{
  "salientSummary": "Repaired delivery-loop fast profile to remove stale test paths and added deterministic guardrail tests for e2e argument validation. Verified preflight and fast profile now execute successfully.",
  "whatWasImplemented": "Updated local framework command mappings and added CLI contract tests covering fast/full execution order, required selector guards, and timeout diagnostics emission. Kept behavior of existing successful paths intact while removing stale references.",
  "whatWasLeftUndone": "",
  "verification": {
    "commandsRun": [
      {
        "command": "pnpm delivery-loop:local preflight",
        "exitCode": 0,
        "observation": "Printed required readiness checks."
      },
      {
        "command": "pnpm delivery-loop:local run --profile fast",
        "exitCode": 0,
        "observation": "Executed full fast chain without missing-file failures."
      },
      {
        "command": "pnpm -C apps/www exec vitest run src/server-lib/delivery-loop/**/*.test.ts",
        "exitCode": 0,
        "observation": "All targeted delivery-loop tests passed."
      }
    ],
    "interactiveChecks": [
      {
        "action": "Run e2e in invalid mode without required args",
        "observed": "Command failed with explicit guardrail error as expected."
      }
    ]
  },
  "tests": {
    "added": [
      {
        "file": "scripts/delivery-loop-local-framework.test.ts",
        "cases": [
          {
            "name": "fails when e2e real mode is missing required arguments",
            "verifies": "VAL-CLI-009"
          }
        ]
      }
    ]
  },
  "discoveredIssues": []
}
```

## When to Return to Orchestrator

- A referenced assertion requires infrastructure or credentials not currently available.
- Validation tooling is blocked by environment breakage outside feature scope.
- A contract assertion is ambiguous or conflicts with observed existing behavior.
