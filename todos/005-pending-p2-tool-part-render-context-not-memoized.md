---
status: pending
priority: p2
issue_id: "005"
tags: [code-review, performance, react-memoization]
dependencies: []
---

# `<ToolPart/>` `renderCtx` and `renderChildToolPart` allocated per-render

## Problem Statement

`tool-part.tsx:221-251` constructs `renderCtx` (including the inline `renderChildToolPart` closure) on every render. For `Task` tools that recursively render children via `ctx.renderChildToolPart`, every parent render re-creates the child renderer closure, defeating React's element identity optimization in the recursive path.

Identified by performance-oracle (P1, conf 85), architecture-strategist (P3, conf 90).

## Findings

- **Location:** `apps/www/src/components/chat/tool-part.tsx:221-251`
- **Pattern:** `renderCtx` is built unconditionally on each render. The `renderChildToolPart` arrow function inside captures parent props and is recreated each call.
- **Impact:** Token streaming on a message containing a `Task` tool produces extra renders per delta on each child tool. With 50+ tool parts in a long thread × every streaming delta, this adds measurable cost. The `areToolPartPropsEqual` memo bound the worst case but the closure allocation per render is wasted work either way.

## Proposed Solutions

### Option A: `useMemo` the context, `useCallback` the recursive renderer

```ts
const renderChildToolPart = useCallback(
  (childPart) => <ToolPart toolPart={childPart} ... />,
  [/* same deps as areToolPartPropsEqual checks */]
);
const renderCtx = useMemo<ToolRenderContext>(
  () => ({ ... renderChildToolPart, /* other ctx fields */ }),
  [renderChildToolPart, /* other deps */]
);
```

**Pros:** Stable identity for both ctx and recursive renderer.
**Cons:** Need to enumerate deps carefully; missing one re-introduces the bug.
**Effort:** Small.
**Risk:** Low if deps are matched against `areToolPartPropsEqual`.

### Option B: Extract recursive case to a child component

Move the recursive case into a separate `<ToolPartChild/>` component that takes `toolPart` + ctx (provided via React context). Eliminates the renderer-closure-as-prop pattern.

**Pros:** Cleaner architectural separation. No closure to memoize.
**Cons:** Larger refactor; introduces a context provider.
**Effort:** Medium.
**Risk:** Low.

## Recommended Action

(filled during triage)

## Technical Details

- **Affected files:** `apps/www/src/components/chat/tool-part.tsx`
- **Test impact:** `memo-rerenders.test.tsx` is the load-bearing regression gate. Add a test asserting that streaming deltas on a Task tool's parent message don't cascade re-renders to its children.

## Acceptance Criteria

- [ ] `renderCtx` has stable identity across renders when input deps are unchanged
- [ ] `renderChildToolPart` has stable identity
- [ ] `memo-rerenders.test.tsx` adds a regression test for nested Task tools
- [ ] Manual streaming smoke test shows no visible regression

## Work Log

- 2026-04-27: Filed during code review (commit `c2dbe2cb`).

## Resources

- Affected commit: `c2dbe2cb`
