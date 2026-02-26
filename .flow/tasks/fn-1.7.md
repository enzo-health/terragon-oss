# fn-1.7 Guardrails, idempotency, and audit trail

## Description

Implement safety controls and webhook idempotency guardrails.

Scope:

- Add webhook delivery dedupe store keyed by `X-GitHub-Delivery`.
- Add per-loop `maxIterations`, cooldown, and kill-switch enforcement.
- Add deterministic gate attempt keys and terminal stop reasons.

## Acceptance

- One loop lease domain serializes transitions and outbox execution.
- Supersession-group map is canonical/versioned and validated for all action types.
- Must-stop transitions atomically cancel pending outbox rows.
- Reconciler CAS claim semantics prevent duplicate multi-worker execution.

## Done summary

Implemented guardrails and idempotency safety primitives for the SDLC loop.

- Added deterministic guardrail evaluator with required precedence (`kill_switch` -> terminal -> lease -> cooldown -> max_iterations -> manual_intent_denied).
- Added per-loop lease acquisition/release with expiry-based steal semantics and epoch fencing updates.
- Added atomic stop transition helper that marks loop `stopped` and cancels pending/running outbox rows with `canceled_due_to_stop` reason.
- Added/extended tests for webhook claim idempotency + stale steal, lease serialization/steal behavior, guardrail precedence, and must-stop outbox cancellation.

## Evidence

- Commits:
- Tests: pnpm -C packages/shared test -- src/model/sdlc-loop.test.ts, pnpm tsc-check, pnpm -C apps/www test
- PRs:
