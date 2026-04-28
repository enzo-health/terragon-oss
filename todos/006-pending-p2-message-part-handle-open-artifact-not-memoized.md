---
status: pending
priority: p2
issue_id: "006"
tags: [code-review, performance, react-memoization]
dependencies: []
---

# `MessagePart.handleOpenArtifact` not memoized (inconsistent with sibling)

## Problem Statement

`message-part.tsx:51-54` builds `handleOpenArtifact` as a fresh closure on every render. Its sibling `handleOpenPlanArtifact` (lines 87-92) IS correctly `useMemo`-wrapped — this is an inconsistency suggesting an oversight, not a deliberate choice.

The fresh closure is then placed into `ctx` and passed to renderers. Children that depend on `onOpenInArtifactWorkspace` reference identity (`ImagePart`, `PdfPart`, `RichTextPart`, etc.) re-render even when nothing changed.

Identified by performance-oracle (P2, conf 85).

## Findings

- **Location:** `apps/www/src/components/chat/message-part.tsx:51-54`
- **Code:**
  ```ts
  const handleOpenArtifact =
    artifactDescriptor && onOpenArtifact
      ? () => onOpenArtifact(artifactDescriptor.id)
      : undefined;
  ```
- **Sibling (correct):** Lines 87-92 `useMemo`-wrap `handleOpenPlanArtifact` with `[planArtifactDescriptor, onOpenArtifact]` deps.
- **Impact:** Streaming token deltas on the latest message create new `handleOpenArtifact` references; child renderers re-render unnecessarily.

## Proposed Solutions

### Option A: Mirror the sibling pattern

```ts
const handleOpenArtifact = useMemo(() => {
  if (!artifactDescriptor || !onOpenArtifact) return undefined;
  return () => onOpenArtifact(artifactDescriptor.id);
}, [artifactDescriptor, onOpenArtifact]);
```

**Pros:** Consistent with `handleOpenPlanArtifact`. Stable identity when inputs unchanged.
**Cons:** None.
**Effort:** Small (5 lines).
**Risk:** None.

## Recommended Action

(filled during triage)

## Technical Details

- **Affected files:** `apps/www/src/components/chat/message-part.tsx`
- **Test:** `memo-rerenders.test.tsx` should already cover this path; verify the test catches the regression by reverting + running.

## Acceptance Criteria

- [ ] `handleOpenArtifact` wrapped in `useMemo` with `[artifactDescriptor, onOpenArtifact]` deps
- [ ] `memo-rerenders.test.tsx` passes
- [ ] No new tsc errors

## Work Log

- 2026-04-27: Filed during code review (commit `19a96d55`).

## Resources

- Affected commit: `19a96d55`
- Sibling pattern: `handleOpenPlanArtifact` in same file lines 87-92
