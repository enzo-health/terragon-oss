# fn-1.4 CI and unresolved PR thread gates

## Description

Implement CI and unresolved review-thread gates for current PR head SHA.

Scope:

- Trigger evaluation on `check_run.completed`/`check_suite.completed` for both pass/fail changes.
- Add configurable CI required-check policy (allowlist/branch-protection-derived).
- Add unresolved review-thread evaluator using GraphQL `isResolved`.
- Add webhook-first + polling fallback for review-thread resolution state changes.

## Acceptance

- CI policy/check evaluation is pinned to installation-app actor type.
- Capability-state transitions are deterministic and persisted.
- Required-check normalization persists provenance and versioned mapping tables.
- Lifecycle-global events bypass SHA staleness where required.

## Done summary

Completed CI/review-thread gate reliability for enrolled SDLC loops and fixed the remaining cross-suite test flake.

- CI gate evaluations persist deterministic capability states and required-check provenance on check_run/check_suite events.
- Review-thread gate evaluations support webhook-first updates with polling fallback.
- Fixed flaky FK failures by scoping `handle-app-mention` test cleanup to the owning user instead of deleting all SDLC loops globally.
- Full apps/www test suite, repo typecheck, and app lint now pass.

## Evidence

- Commits:
- Tests: pnpm -C apps/www test, pnpm tsc-check, pnpm -C apps/www lint
- PRs:
