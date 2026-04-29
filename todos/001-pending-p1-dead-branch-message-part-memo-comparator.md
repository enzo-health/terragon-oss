---
status: pending
priority: p1
issue_id: "001"
tags: [code-review, quality, correctness, react-memoization]
dependencies: []
---

# Dead branch in `areMessagePartPropsEqual`

## Problem Statement

`message-part.tsx:185-186` ends the comparator with:

```ts
const toolName = prevToolPart.name;
return toolName === "ExitPlanMode" ? true : true;
```

Both arms of the ternary return `true`. The `toolName` extraction is dead. This is unambiguously a bug — almost certainly a refactor artifact where per-tool memo logic was removed but the conditional skeleton was left behind. Identified independently by 3 reviewers (Kieran TS conf 95, Type-Design conf 95, Performance conf 95).

## Findings

- **Location:** `apps/www/src/components/chat/message-part.tsx:185-186`
- **Evidence:** Verbatim code shown above. TypeScript can't catch this because both arms are syntactically valid `boolean`.
- **Impact:** No runtime behavior change today, but it's a footgun. The next contributor will assume the conditional is doing work and may mistakenly modify it. More importantly, if there was originally per-tool memo logic for `ExitPlanMode`, that logic is silently absent — `ExitPlanMode` tool state changes won't trigger re-renders when they should.

## Proposed Solutions

### Option A: Collapse to `return true`

**Pros:** Simplest fix; preserves observed behavior.
**Cons:** Loses the (apparently lost) intent.
**Effort:** Small (1 line).
**Risk:** None — same behavior.

```ts
return true;
```

### Option B: Restore per-tool intent (if known)

If the original intent was something like comparing `onOpenArtifact` for `ExitPlanMode`, restore it explicitly:

```ts
return toolName === "ExitPlanMode"
  ? prevProps.toolProps.onOpenArtifact === nextProps.toolProps.onOpenArtifact
  : true;
```

**Pros:** Restores lost behavior.
**Cons:** Requires knowing the original intent (git blame on the previous commit may help).
**Effort:** Small (3 lines).
**Risk:** Low — but verify against the original code if recoverable.

## Recommended Action

(filled during triage)

## Technical Details

- **Affected files:** `apps/www/src/components/chat/message-part.tsx`
- **Tests:** No existing test catches this. Consider adding a memo-rerender test asserting `ExitPlanMode` tool state changes do/don't trigger re-renders per the chosen behavior.

## Acceptance Criteria

- [ ] Dead `true : true` ternary removed
- [ ] If Option B chosen, intent verified against git history or product behavior
- [ ] `pnpm tsc-check` still passes
- [ ] No new lint warnings

## Work Log

- 2026-04-27: Filed during code review (commit `398cfa85`).

## Resources

- Review commit: `398cfa85`
- Three independent reviewer findings converged on this.
