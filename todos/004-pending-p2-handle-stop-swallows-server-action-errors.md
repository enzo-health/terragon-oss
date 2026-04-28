---
status: pending
priority: p2
issue_id: "004"
tags: [code-review, silent-failure, user-facing]
dependencies: []
---

# `handleStop` in `<ChatPromptBox/>` swallows `stopThread` errors

## Problem Statement

`chat-prompt-box.tsx:122-125` calls `stopThread` server action without checking `result.success` or wrapping in try/catch. Compare to sibling handlers (`handleSubmit`, `updateQueuedMessages`) which both check `result.success` and call `setError`. `handleStop` is inconsistent — failures are silent.

Identified by silent-failure-hunter (P2, conf 88).

## Findings

- **Location:** `apps/www/src/components/chat/chat-prompt-box.tsx:122-125`
- **Code:**
  ```ts
  const handleStop = useCallback(async () => {
    await stopThread({ threadId, threadChatId });
    await refetch();
  }, [threadId, threadChatId, refetch]);
  ```
- **Impact:** User clicks Stop; server-side stop fails (auth expiry, network error, race); UI gives no indication of failure. Agent keeps running. User clicks Stop again — same silent failure. No recourse without DevTools.

## Proposed Solutions

### Option A: Check `result.success` (matches sibling pattern)

```ts
const handleStop = useCallback(async () => {
  const result = await stopThread({ threadId, threadChatId });
  if (!result.success) {
    setError(result.errorMessage ?? "Failed to stop");
    return;
  }
  await refetch();
}, [threadId, threadChatId, refetch, setError]);
```

**Pros:** Consistent with `handleSubmit` and `updateQueuedMessages`.
**Cons:** Requires `setError` to be passed through props (verify it's already available).
**Effort:** Small.
**Risk:** None.

## Recommended Action

(filled during triage)

## Technical Details

- **Affected files:** `apps/www/src/components/chat/chat-prompt-box.tsx`
- **Pattern reference:** `handleSubmit` in same file shows the established error-handling pattern.

## Acceptance Criteria

- [ ] `handleStop` checks `result.success` and surfaces failures via `setError`
- [ ] User sees an error message when Stop fails
- [ ] `pnpm tsc-check` passes

## Work Log

- 2026-04-27: Filed during code review (commit `d7aa2d41`).

## Resources

- Affected commit: `d7aa2d41`
