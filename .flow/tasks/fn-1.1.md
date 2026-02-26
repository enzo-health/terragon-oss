# fn-1.1 SDLC coordinator + persisted loop state machine

## Description

Create loop schema and coordinator core contracts.

Scope:

- Enrollment record + identity constraints for active loops.
- FSM definitions, CAS transitions, `currentHeadSha`, and PR terminal states.
- Lease lock with `leaseEpoch` fencing.
- Signal inbox model and dedupe key contract.
- Outbox table contract for atomic side-effect intent recording.

## Acceptance

- Cause identity matrix includes per-delivery uniqueness for non-daemon triggers.
- Delivery claim state outcomes and HTTP responses are deterministic.
- Enrolled-loop daemon events require v2 envelope support.
- Post-enrollment sibling thread creation follows deterministic default exclusion.

## Done summary

Implemented fn-1.1 coordinator foundations: deterministic GitHub delivery claim/complete semantics, canonical cause identity scaffolding, transactional inbox/outbox/lease schema, enrolled-loop webhook routing behavior, and enrolled-loop daemon v2 envelope enforcement. Added targeted tests for webhook delivery idempotency, daemon v2 gating, and sibling thread suppression; all relevant tests, tsc-check, and lint passed.

## Evidence

- Commits:
- Tests:
- PRs:
