# fn-1.8 End-to-end validation and failure-path tests

## Description

Build end-to-end validation matrix for L1 loop reliability.

Scope:

- Happy path: enroll -> implement -> all gates pass -> human-review-ready.
- Failure/retry: AI blocking findings, CI fail then pass, unresolved thread block then resolve.
- Reliability: duplicate webhook redelivery, concurrent coordinator triggers, max-iteration stop.
- Human feedback loop: re-open after review feedback and close again when resolved.

## Acceptance

- Tests cover repeated PR closed/reopened/edited canonical cause uniqueness.
- Tests cover claim outcome state machine and webhook response mapping.
- Tests cover v1 daemon rejection and v2 acceptance for enrolled loops.
- Tests cover parity SLO metric buckets and rollback triggers.

## Done summary

Completed end-to-end validation and failure-path coverage for SDLC L1 loop reliability.

- Added/validated tests for repeated PR lifecycle events (closed/reopened/edited) with canonical cause uniqueness.
- Covered outbox claim/retry/complete state machine and deterministic webhook-delivery claim outcomes.
- Enforced enrolled-loop daemon contract with test coverage for v1 envelope rejection and v2 envelope acceptance.
- Added parity SLO metric bucket + evaluator coverage including rollback triggers for low parity and invariant breach paths.

## Evidence

- Commits:
- Tests: pnpm -C packages/shared test -- src/model/sdlc-loop.test.ts, pnpm -C apps/www test, pnpm tsc-check, pnpm -C apps/www lint
- PRs:
