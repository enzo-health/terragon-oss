# fn-1.3 Carmack Review gate agent and blocking findings

## Description

Implement Carmack Review AI gate as second strict review pass after Deep Review passes.

Scope:

- Add Carmack review execution mode/prompt contract using same findings schema.
- Persist results and findings keyed by head SHA.
- Ensure ordered gate behavior and deterministic decision recording.

## Acceptance

- Carmack Review runs only when Deep Review is passed for current head SHA.
- Blocking Carmack findings re-open fix loop.
- Findings lifecycle supports clear resolution tracking across iterations.
- Gate decisions are replay-safe under duplicate triggers.

## Done summary

Implemented Carmack Review gate foundation for SDLC loops.

- Added Carmack review gate runner (`apps/www/src/server-lib/sdlc-loop/carmack-review-gate.ts`) with schema-constrained JSON output contract.
- Added DB tables and types for Carmack runs/findings keyed by `(loopId, headSha)` with stable finding identity lifecycle.
- Added model functions to gate Carmack on Deep Review pass, persist deterministic run/finding state, resolve findings, and compute follow-up requirements.
- Added tests validating pass-ordering, replay-safe persistence, and blocking-finding lifecycle behavior.

## Evidence

- Commits:
- Tests: pnpm -C packages/shared test -- src/model/sdlc-loop.test.ts, pnpm -C apps/www test -- src/agent/thread-resource.test.ts src/server-lib/e2e.test.ts, pnpm tsc-check
- PRs:
