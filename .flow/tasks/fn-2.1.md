# fn-2.1 Add immutable run tables and canonical run writers

## Description

Create immutable `runId` records plus pointer-only active context storage with race-safe single-writer guarantees.

**Size:** M
**Files:**

- `packages/shared/src/db/schema.ts`
- `packages/shared/src/db/types.ts`
- `packages/shared/src/model/feature-flags-definitions.ts`
- `packages/shared/src/types/preview.ts`
- `apps/www/src/server-lib/run-context.ts`
- `apps/www/src/agent/msg/startAgentMessage.ts`
- `apps/www/src/server-actions/retry-thread.ts`
- `apps/www/src/server-lib/scheduled-thread.ts`
- `apps/www/src/server-lib/follow-up-queue.ts`

## Approach

- Add `thread_run` (immutable, keyed by `runId`) and pointer-only `thread_run_context`.
- Key `thread_ui_validation` by `{threadId,threadChatId}` (not `threadId` alone).
- Keep preview/security enums and claim tuple types centralized in `packages/shared/src/types/preview.ts` (single source imported by app/broadcast/daemon contracts).
- Ensure `sandboxPreview` and `daemonRunIdStrict` definitions are explicit in `packages/shared/src/model/feature-flags-definitions.ts` for frozen run snapshots.
- Add indexes/constraints:
  - unique `{threadId,threadChatId,startRequestId}`
  - partial unique active `{threadId,threadChatId}` when `status in ('booting','running','validating')` via raw SQL migration
  - partial unique `{runId,terminalEventId}` when `terminalEventId is not null` for terminal-event dedupe
  - index `thread_run_context(activeRunId)`
  - index `{threadId,threadChatId,createdAt desc}` on `thread_run`
- Implement transaction-safe `createRunContext()`:
  - lock pointer row (`SELECT ... FOR UPDATE`)
  - idempotently reuse existing `runId` for duplicate `startRequestId`
  - mint new `runId` otherwise, insert immutable `thread_run`, and update pointer row
  - pointer update uses compare-and-swap (`where version = expectedVersion`) in the same transaction
  - on optimistic version conflict, retry with bounded exponential backoff + jitter (`25ms * 2^attempt`, max 5 attempts)
- Ensure `lastAcceptedSeq` writes always use DB-level CAS predicate (`lastAcceptedSeq < nextSeq`) to avoid race regressions.
- Implement `bindRunSandbox()` to update pointer fields and immutable run row consistently.
- Persist frozen flags + SHA fields (`runStartSha`,`runEndSha`) on `thread_run`; keep `thread_run_context` as active pointer only.
- Return minted `runId` from `createRunContext()` for downstream daemon propagation.

## Acceptance

- [ ] `runId` is canonical identity with immutable `thread_run` records.
- [ ] Concurrent run starts cannot create two active rows for one `{threadId,threadChatId}`.
- [ ] All run entry paths provide deterministic `startRequestId` source values.
- [ ] `version` conflict handling uses explicit bounded retry/backoff semantics and is tested.
- [ ] Partial unique indexes and CAS update predicates are migration-safe and enforced under concurrent writes.
- [ ] `thread_ui_validation` is keyed by `{threadId,threadChatId}` and migration-safe.
- [ ] `runStartSha` timing is deterministic and test-covered.
- [ ] Shared preview/security enum/types are sourced from `packages/shared/src/types/preview.ts`.
- [ ] Feature flag definitions for `sandboxPreview` and `daemonRunIdStrict` are snapshot-ready and test-covered.

## Test matrix

- Unit: idempotent duplicate `startRequestId` returns same row.
- Unit: concurrent different `startRequestId` yields one active row (partial unique index enforced).
- Integration: raw SQL partial unique migration rejects second active run and duplicate terminal dedupe writes.
- Unit: same `threadId` with different `threadChatId` supports concurrent starts without cross-chat collisions.
- Unit: `lastAcceptedSeq` compare-and-swap rejects stale/out-of-order updates under concurrency.
- Integration: frozen flag snapshot survives later flag changes.
- Integration: immutable `thread_run` history remains intact while pointer row rotates active run.
- Integration: per-chat `thread_ui_validation` rows do not collide across chats on same thread.
- Unit: preview/security enums consumed by run-context contracts are imported from shared preview types (no local enum drift).

## Done summary

Task completed

## Evidence

- Commits:
- Tests:
- PRs:
