---
status: pending
priority: p2
issue_id: "008"
tags: [code-review, architecture, simplicity, refactor]
dependencies: []
---

# `<ChatUILayout/>` 49-prop bag — premature decomposition

## Problem Statement

`<ChatUILayout/>` was extracted from `chat-ui.tsx` to enforce a "pure presentation" boundary, but its `ChatUILayoutProps` type now has 49 fields including 5 refs, 4 setters, 4 callbacks. The single consumer (`<ChatUIContent/>`) destructures and passes all 49 across the boundary. The "pure presentation" comment is aspirational — the layout still defines a `useCallback(handleCancel, …)` internally.

Three reviewers converged: code-simplicity-reviewer (P1, conf 92, "premature decomposition"), architecture-strategist (P2, conf 84, "inappropriate intimacy via prop drilling"), DHH ("revert / fold back").

This is the **highest-disagreement finding** — type-design and Kieran said little about it; Phase-7 was approved by other passes. Triage should weigh whether to fold back vs. group props.

## Findings

- **Location:** `apps/www/src/components/chat/chat-ui-layout.tsx:263-311` (props type), `chat-ui.tsx:316-360` (callsite spread)
- **Symptom:** Adding any state to `<ChatUIContent/>` requires touching `ChatUILayoutProps`, the destructure block, and the JSX-spread call. Phase 1+2 (event-flow refactor) will keep widening this seam.

## Proposed Solutions

### Option A: Fold `<ChatUILayout/>` back into `<ChatUIContent/>` (DHH's recommendation)

Move the JSX from `chat-ui-layout.tsx` directly into `<ChatUIContent/>`'s render. Keep `<ThreadProvider/>` and the extracted hooks (`use-chat-effects`, `use-thread-mutations`, `use-chat-view-snapshot`).

**Pros:** Eliminates a 311-LOC pass-through layer. Data flow becomes 1:1 traceable. No prop bag.
**Cons:** `<ChatUIContent/>` grows back toward ~700 LOC. Loses the "pure presentation" narrative.
**Effort:** Medium.
**Risk:** Medium — non-trivial diff; tests must still pass.

### Option B: Group props by concern

Group the 49 props into 5-7 grouped objects:

- `scrollState: { transcriptRef, scrollAreaRef, messagesEndRef, hasInitialized, isAtBottom, scrollToTop, forceScrollToBottom }`
- `panelState: { activeArtifactId, setActiveArtifactId, showTerminal, setShowTerminal, shouldRenderSecondaryPanel }`
- `dialogData: { redoDialogData, forkDialogData }`
- `optimisticHandlers: { onOptimisticUserSubmit, onOptimisticQueuedMessagesUpdate, onOptimisticPermissionModeUpdate }`
- `errorState: { error, setError, isRetrying, handleRetry }`
- `coreData: { agent, chatAgent, threadChat, thread, threadWithViewModelStatus, messages, queuedMessages, ... }`

Memoize the groupings in `<ChatUIContent/>`. Reduces the prop bag, makes the seam explicit.

**Pros:** Keeps the architectural split. Reduces churn on future state additions.
**Cons:** Adds memoization boilerplate. Doesn't eliminate the layer.
**Effort:** Medium.
**Risk:** Low.

### Option C: Accept the current split

Document the rationale; let Phase 1+2 push concerns out of `<ChatUIContent/>` into more focused hooks, naturally shrinking the prop bag.

**Pros:** Zero immediate work.
**Cons:** Reviewers consistently flagged this; deferring without addressing is debt.
**Effort:** None.
**Risk:** Medium — debt compounds.

## Recommended Action

(filled during triage — likely B or C; A has the highest disruption)

## Technical Details

- **Affected files:** `apps/www/src/components/chat/chat-ui-layout.tsx`, `apps/www/src/components/chat/chat-ui.tsx`
- **Tests:** integration test `chat-ui-streaming-budget.test.tsx` must still pass.

## Acceptance Criteria

- [ ] Choose Option A, B, or C explicitly during triage
- [ ] If A or B: prop count visible in the layout signature decreases meaningfully
- [ ] No behavior change; all existing tests pass
- [ ] `pnpm tsc-check` passes

## Work Log

- 2026-04-27: Filed during code review (commit `d7aa2d41`).

## Resources

- Affected commit: `d7aa2d41`
- Related: DHH review (full revert recommendation), simplicity review (P1), architecture review (P2)
