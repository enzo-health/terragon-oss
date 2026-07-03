# Plan 006: Stop selecting the full JSONB transcript on every chat-page load

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat e1cb4079..HEAD -- packages/shared/src/model/thread-page.ts`
> On any change, compare the "Current state" excerpt against the live code
> before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `e1cb4079`, 2026-07-01

## Why this matters

`getThreadPageFullChatSelect()` pulls the entire legacy `messages` JSONB column — the full transcript, which is megabytes on long threads — out of Postgres on every chat-page load and every `createThread`. The value is then immediately destructured out and thrown away; the rendered transcript comes from a separate canonical-events replay, not from this column. So the largest payload in the read path is fetched over the wire from the database and discarded. Dropping the column from the select removes that transfer with zero behavior change.

## Current state

The select includes `messages` (`packages/shared/src/model/thread-page.ts:155-178`):

```ts
function getThreadPageFullChatSelect() {
  return {
    id: schema.threadChat.id,
    // ... other columns ...
    messages: schema.threadChat.messages, // <- the whole DBMessage[] JSONB
    queuedMessages: schema.threadChat.queuedMessages,
    // ... other columns ...
    messageSeq: schema.threadChat.messageSeq,
  };
}
```

It is used in exactly one query (`thread-page.ts:412-431`), whose result is destructured to **discard** `messages` (`thread-page.ts:438`):

```ts
const threadChat = threadChatResult[0];
if (!threadChat) return undefined;
const { messages: _dbMessagesRaw, ...threadChatWithoutMessages } = threadChat;
// _dbMessagesRaw is never referenced again
```

The rendered transcript is built downstream from canonical events (`thread-page.ts:445-455`, `getThreadReplayEntriesFromCanonicalEvents`), and the returned object spreads `threadChatWithoutMessages` (already without `messages`) plus `projectedMessages`. The return type `ThreadPageChat` does not include `messages`.

Confirmed scope: `grep -rn "getThreadPageFullChatSelect" packages/shared apps/www` returns only the definition (`:155`) and the single call site (`:414`). `grep -rn "_dbMessagesRaw" ...` returns only `:438`.

## Commands you will need

| Purpose   | Command                                              | Expected on success                                                   |
| --------- | ---------------------------------------------------- | --------------------------------------------------------------------- |
| Typecheck | `pnpm tsc-check`                                     | exit 0, no errors                                                     |
| Test      | `pnpm -C packages/shared test src/model/thread-page` | all pass (or whole `packages/shared` suite if no path filter matches) |

## Scope

**In scope**:

- `packages/shared/src/model/thread-page.ts`

**Out of scope**:

- The `schema.threadChat.messages` column itself — do NOT drop it from the DB schema; other code and migrations may still read/write it. This plan only stops _selecting_ it here.
- `getThreadReplayEntriesFromCanonicalEvents` and the projection logic — unchanged.
- Any other select in the file (e.g. summary selects) — only the full-chat select.
- `queuedMessages` — keep it; it is a different, small column that IS used.

## Git workflow

- Branch: `advisor/006-drop-discarded-transcript-select`
- Commit message: `perf(thread-page): stop fetching the discarded messages JSONB on chat load`
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Remove `messages` from the select

Delete the `messages: schema.threadChat.messages,` line from `getThreadPageFullChatSelect()`. Keep every other column (including `queuedMessages` and `messageSeq`).

**Verify**: `pnpm tsc-check` — this will fail on the now-invalid destructure at `:438` (there is no longer a `messages` key), which Step 2 fixes.

### Step 2: Remove the now-dead destructure

At `thread-page.ts:438`, the `messages` key no longer exists on `threadChat`. Replace:

```ts
const { messages: _dbMessagesRaw, ...threadChatWithoutMessages } = threadChat;
```

with a direct alias (the result no longer carries `messages`):

```ts
const threadChatWithoutMessages = threadChat;
```

Leave the rest of the function (`...threadChatWithoutMessages` spread in the return) unchanged.

**Verify**: `pnpm tsc-check` → exit 0, and `grep -n "_dbMessagesRaw" packages/shared/src/model/thread-page.ts` → no matches.

### Step 3: Run the thread-page tests

**Verify**: `pnpm -C packages/shared test src/model/thread-page` → all pass. If that path filter matches no test file, run `pnpm -C packages/shared test` and confirm no new failures versus baseline.

## Test plan

This is a pure removal of a discarded value, so no new behavioral test is strictly required — the existing thread-page tests must still pass unchanged. If a test currently asserts on the shape of the query result and referenced `messages`, update it to match the new shape (it should not — `messages` was always discarded before return).

Optionally add one assertion in the existing thread-page test that a returned `ThreadPageChat` has no `messages` property, to lock the intent.

Verification: `pnpm -C packages/shared test src/model/thread-page` (or full `packages/shared` suite) → all pass.

## Done criteria

- [ ] `pnpm tsc-check` exits 0
- [ ] `grep -n "messages: schema.threadChat.messages" packages/shared/src/model/thread-page.ts` returns no matches
- [ ] `grep -n "_dbMessagesRaw" packages/shared/src/model/thread-page.ts` returns no matches
- [ ] `packages/shared` thread-page tests pass with no new failures
- [ ] `git status` shows only `thread-page.ts` modified
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report if:

- `getThreadPageFullChatSelect` has more than the one call site shown (re-run the grep) — a second consumer might actually read `messages`, in which case removing it is not safe here.
- Any code between the query and the return reads `threadChat.messages` / `_dbMessagesRaw` beyond the discard (re-grep before deleting).
- Removing the column changes the `ThreadPageChat` return type in a way `tsc-check` flags at a call site outside this file — report; do not chase type changes across the app in this plan.

## Maintenance notes

- This is the first step of a larger cleanup: the same function makes 4 sequential round-trips (access check → this select → `hasCanonicalReplayProjection` → replay entries). Folding the projection-gate boolean into the replay query to cut a round-trip is a reasonable follow-up, deliberately deferred here to keep this change a zero-risk column removal.
- A reviewer should confirm no serialization/broadcast path elsewhere depended on `getThreadPageChat` returning `messages` (it never did — the value was destructured away — but worth a glance).
- If the legacy `messages` column is eventually dropped from the schema, this select will already be clean.
