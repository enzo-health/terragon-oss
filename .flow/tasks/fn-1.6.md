# fn-1.6 GitHub publication surfaces (PR comment + check summary)

## Description

Implement GitHub publishing with stable identities and idempotent updates.

Scope:

- Persist one canonical SDLC status comment id per loop and update in place.
- Update check summary output with compact gate state + artifact links.
- Add retry/recovery behavior for partial API failures.

## Acceptance

- Canonical PR status comment is updated in place via persisted id.
- Missing/deleted canonical comment is rediscovered/recreated once with audit record.
- Publisher writes structured attempt records and retry/backoff state.
- Publication side effects execute via outbox idempotency keys.

## Done summary

Implemented GitHub publication surfaces with stable identities, idempotent updates, and retry-safe execution.

- Canonical PR status comment is persisted per loop and updated in place when present.
- Missing/deleted canonical comments are detected (404), reference is cleared, and comment is recreated once with refreshed persisted ids.
- Canonical check summary updates include compact gate summary plus short-lived signed video artifact links.
- Publication side effects execute through outbox claim/complete semantics with structured attempt records, retry classification/backoff, and supersession-aware idempotency keys.

## Evidence

- Commits:
- Tests: pnpm -C packages/shared test -- src/model/sdlc-loop.test.ts, pnpm -C apps/www test, pnpm tsc-check, pnpm -C apps/www lint
- PRs:
