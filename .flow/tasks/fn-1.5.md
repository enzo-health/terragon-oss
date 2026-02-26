# fn-1.5 Video artifact pipeline via agent-browser

## Description

Implement video artifact runner and storage contract.

Scope:

- Define deterministic runtime contract (browser availability, codec/container, timeout, max size).
- Execute capture via agent-browser-driven runner.
- Persist typed failure classes (`infra|script|auth|quota`) for retry policy.
- Store artifacts privately and expose reviewer-safe links.

## Acceptance

- Runtime contract is explicit and validated before execution.
- Capture outcomes are classified into typed failure classes.
- Artifact URLs are private/auth-gated or short-lived signed.
- `video_degraded_ready` and `done` gating behavior is deterministic and test-covered.

## Done summary

Implemented the video artifact pipeline contract and persistence behavior for enrolled SDLC loops.

- Added explicit/validated runtime contract for agent-browser capture execution (runner/browser/container/codec/timeout/max size).
- Capture results persist artifact metadata on success and typed failure classes (`infra|script|auth|quota`) on failure.
- Reviewer-safe artifact links are generated via short-lived signed private R2 URLs in publication flow.
- Deterministic gate-state behavior is test-covered: failed capture moves to `video_degraded_ready`, successful capture moves to `human_review_ready`, and terminal `done` remains stable.

## Evidence

- Commits:
- Tests: pnpm -C packages/shared test -- src/model/sdlc-loop.test.ts, pnpm -C apps/www test, pnpm tsc-check, pnpm -C apps/www lint
- PRs:
