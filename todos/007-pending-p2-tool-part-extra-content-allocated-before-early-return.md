---
status: pending
priority: p2
issue_id: "007"
tags: [code-review, performance, react-rendering]
dependencies: []
---

# `<ToolPart/>` `extraContent` JSX built before early-return

## Problem Statement

`tool-part.tsx:296-316` constructs `extraContent` (a JSX fragment with conditional `<Badge/>`, `<ProgressChunks/>`, working span) on every render — even when the component short-circuits at line 324 with `return renderedTool`. The JSX construction creates React element objects with prop bags regardless of whether they're rendered.

Identified by performance-oracle (P2, conf 90).

## Findings

- **Location:** `apps/www/src/components/chat/tool-part.tsx:296-316` (allocation), `:324` (early-return)
- **Allocation includes:**
  - `<Badge/>` element with prop bag (when `mcpServer` truthy)
  - `<ProgressChunks chunks={progressChunks}/>` element (when `progressChunks?.length`)
  - working-state span
- **Impact:** At 50+ tool parts in a long thread, this is ~50 wasted element allocations per re-render of the latest message. Multiply by streaming-token-delta frequency.

## Proposed Solutions

### Option A: Move `extraContent` past the early-return

```ts
const renderedTool = TOOL_DISPATCH[...] ?? renderUnknownTool;
if (!hasExtras) return renderedTool;  // guard with explicit boolean
const extraContent = <>...</>;  // only built when needed
return (<>{renderedTool}{extraContent}</>);
```

**Pros:** Minimal change; preserves all existing behavior.
**Cons:** Need to compute the `hasExtras` boolean correctly.
**Effort:** Small.
**Risk:** Low.

### Option B: Inline conditionals in the return JSX

Skip building `extraContent` as a variable — inline each condition in the final JSX. React will short-circuit `false && <Badge/>` evaluations.

**Pros:** No precomputed boolean needed.
**Cons:** Slightly less readable.
**Effort:** Small.
**Risk:** Low.

## Recommended Action

(filled during triage)

## Technical Details

- **Affected files:** `apps/www/src/components/chat/tool-part.tsx`

## Acceptance Criteria

- [ ] `extraContent` is not allocated when not rendered
- [ ] `pnpm tsc-check` passes
- [ ] Visual smoke test confirms badge/progress/working span still render correctly

## Work Log

- 2026-04-27: Filed during code review (commit `c2dbe2cb`).

## Resources

- Affected commit: `c2dbe2cb`
