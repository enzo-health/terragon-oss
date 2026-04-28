---
status: pending
priority: p2
issue_id: "009"
tags: [code-review, react-query, correctness]
dependencies: []
---

# `<ThreadProvider/>` uses sentinel string `"missing-thread-chat-id"`

## Problem Statement

`thread-provider.tsx:91-100` passes `threadChatId: "missing-thread-chat-id"` to `threadChatQueryOptions` when `threadChatId` is undefined, then disables the query via `enabled: false`. This is a sentinel-string code smell. The React Query `queryKey` derived from this options object will be cached against `"missing-thread-chat-id"` and could collide with a real thread chat that someday has that id.

Identified by Kieran TS (P2, conf 85).

## Findings

- **Location:** `apps/www/src/components/chat/thread-provider.tsx:91-100`
- **Risk vectors:**
  - Cache collision: hypothetical real id `"missing-thread-chat-id"` (extremely unlikely but theoretically possible)
  - Cache pollution: every disabled query uses the same fake key, inflating React Query's internal cache lookups
  - Future contributors copy the pattern (cargo-cult sentinel)

## Proposed Solutions

### Option A: Use React Query 5's `skipToken` (recommended)

```ts
import { skipToken } from "@tanstack/react-query";

useQuery({
  ...threadChatQueryOptions(
    threadChatId ? { threadId, threadChatId } : skipToken,
  ),
});
```

`skipToken` cleanly opts out of the query without a sentinel — the query is genuinely not registered.

**Pros:** Idiomatic React Query 5. No sentinel. No cache pollution.
**Cons:** Requires `threadChatQueryOptions` to accept `skipToken` (may need a small typing tweak).
**Effort:** Small.
**Risk:** None.

### Option B: Conditional `useQuery` call

Guard the entire `useQuery` call behind the `threadChatId` check using a custom hook that returns `{ data: undefined, isLoading: false }` when no id is present.

**Pros:** Explicit control flow.
**Cons:** Hooks can't be conditional in React; would need an inner helper component or always-call-with-skip pattern.
**Effort:** Medium.
**Risk:** Low.

## Recommended Action

(filled during triage — Option A preferred)

## Technical Details

- **Affected files:** `apps/www/src/components/chat/thread-provider.tsx`, possibly `apps/www/src/queries/thread-chat-query-options.ts` (or wherever `threadChatQueryOptions` lives)

## Acceptance Criteria

- [ ] No string sentinel like `"missing-thread-chat-id"` in the codebase
- [ ] Disabled queries don't pollute the React Query cache
- [ ] `pnpm tsc-check` passes

## Work Log

- 2026-04-27: Filed during code review (commit `d7aa2d41`).

## Resources

- Affected commit: `d7aa2d41`
- React Query skipToken: https://tanstack.com/query/latest/docs/framework/react/guides/disabling-queries#typesafe-disabling-of-queries-using-skiptoken
