# fn-1.2 Deep Review gate agent and blocking findings

## Description

Implement Deep Review AI gate with strict schema-driven outcomes.

Scope:

- Add deep-review execution mode/prompt contract.
- Require structured output including `gatePassed` and `blockingFindings[]` with stable fields.
- Persist findings keyed by loop iteration and head SHA.
- Coordinator blocks progression when unresolved blocking findings exist.

## Acceptance

- Deep Review output is schema-validated; invalid output yields deterministic gate error state.
- Blocking findings are persisted with stable identifiers.
- Unresolved blocking findings force follow-up re-entry.
- Re-run on same head SHA is replay-safe and idempotent.

## Done summary

Implemented fn-1.2 deep-review gate foundations:

- Added deep-review prompt contract/execution helper for AI gate mode.
- Added schema + model persistence for deep-review runs/findings with stable finding IDs.
- Enforced deterministic invalid-output state and replay-safe same-head upsert semantics.
- Added unresolved blocking finding queries and resolution helpers for follow-up re-entry gating.

## Evidence

- Commits:
- Tests: pnpm -C packages/shared test -- src/model/sdlc-loop.test.ts (pass), pnpm -C packages/shared exec vitest src/model/sdlc-loop.test.ts --run (pass), pnpm -C apps/www test (fails: 19 pre-existing e2e/thread-resource failures)
- PRs:
