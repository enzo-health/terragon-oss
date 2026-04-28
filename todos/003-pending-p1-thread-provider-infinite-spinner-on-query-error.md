---
status: pending
priority: p1
issue_id: "003"
tags: [code-review, silent-failure, user-facing, react-query]
dependencies: []
---

# `<ThreadProvider/>` shows infinite spinner on query error

## Problem Statement

`thread-provider.tsx` destructures `isLoading` from the React Query results but never destructures `isError` or `error`. When the shell or threadChat fetch fails (network error, 404, auth expiry), `isLoading` becomes `false` but `shell`/`threadChat` stay `null`, so the gate condition `!shell || !threadChat` keeps rendering `<LeafLoading/>` indefinitely.

User experience: spinner spins forever, no error state, no retry button, no signal to open a support ticket. This is an **active regression** vs. the previous inline approach in `chat-ui.tsx` which did surface errors.

Identified by silent-failure-hunter (P2, conf 92). Promoted to P1 because it's user-facing and trivially reproducible (kill the network briefly during page load).

## Findings

- **Location:** `apps/www/src/components/chat/thread-provider.tsx:80-122`
- **Pattern:**
  ```ts
  const { data: shellFromQuery, isLoading: isShellFetching } = useQuery({
    ...threadShellQueryOptions(threadId),
  });
  // ... isError NOT destructured
  if (isShellLoading || isThreadChatLoading || !shell || !threadChat || ...) {
    return <LeafLoading message="Loading task…" />;
  }
  ```
- **Impact:** Any transient server error or auth expiry during page load → infinite spinner. No way to recover except hard refresh.

## Proposed Solutions

### Option A: Surface query errors via `<ChatError/>`

```ts
const {
  data: shellFromQuery,
  isLoading: isShellFetching,
  isError: isShellError,
  error: shellError,
} = useQuery(...);
// ... same for threadChat

if (isShellError || isThreadChatError) {
  return (
    <ChatError
      status="error"
      errorType="unknown-error"
      errorInfo={shellError?.message ?? threadChatError?.message ?? "Failed to load thread"}
      handleRetry={() => { /* React Query refetch */ }}
      isReadOnly={false}
    />
  );
}
```

**Pros:** Reuses existing error UI; user gets a retry button.
**Cons:** Need to wire React Query's refetch into a handleRetry.
**Effort:** Medium.
**Risk:** Low.

### Option B: Throw to the error boundary

Re-throw the React Query error so `<TerragonThreadErrorBoundary/>` catches it and renders the same `<ChatError/>` it shows for render crashes.

**Pros:** Centralizes error handling.
**Cons:** The boundary is currently mounted INSIDE `<ThreadProvider/>`'s gated children — won't catch errors raised before the gate opens. Would need to move the boundary above the provider.
**Effort:** Medium.
**Risk:** Medium — moves error-boundary placement.

## Recommended Action

(filled during triage)

## Technical Details

- **Affected files:** `apps/www/src/components/chat/thread-provider.tsx`
- **Reproduction:** Set network throttling to "Offline" in DevTools, navigate to `/task/<id>`. Should show error state, not spinner.
- **Related:** `chat-ui.tsx` previously rendered an inline error block — the prior behavior should be preserved.

## Acceptance Criteria

- [ ] Query error shows `<ChatError/>` (or equivalent), not `<LeafLoading/>`
- [ ] Retry mechanism re-fetches the failed queries
- [ ] No PII leaked in error message
- [ ] Manual smoke test: offline → navigate → error UI; back online → retry → loads

## Work Log

- 2026-04-27: Filed during code review (commit `d7aa2d41`).

## Resources

- Affected commit: `d7aa2d41`
