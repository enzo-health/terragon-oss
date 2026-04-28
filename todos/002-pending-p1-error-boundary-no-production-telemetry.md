---
status: pending
priority: p1
issue_id: "002"
tags: [code-review, observability, silent-failure, production-readiness]
dependencies: []
---

# `TerragonThreadErrorBoundary` has no production telemetry

## Problem Statement

The new error boundary class (`terragon-thread.tsx:459-463`) catches every render-time crash in the chat tree but only `console.error`s. The comment says "Production telemetry can hook in here later if needed" — but there's no hookup, and `@sentry/nextjs` is already a dependency in this codebase. In production, console errors are invisible to operators; engineering would only learn about chat crashes via user-filed support tickets.

Identified by silent-failure-hunter (P2, conf 97). Promoted to P1 here because it's a regression in production observability — the previous switch-based code didn't have render-time crash recovery at all, but this commit added the boundary AND silently swallowed the only signal worth having.

## Findings

- **Location:** `apps/www/src/components/chat/assistant-ui/terragon-thread.tsx:450-454`
- **Code:**
  ```ts
  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("TerragonThread crashed:", error, info);
  }
  ```
- **Impact:** Render crashes (SSE parse errors, AG-UI reducer throws, malformed parts, registry-cast failures) are completely unobservable in production. Users see the `<ChatError/>` fallback; operators see nothing in alerting. Incident response starts blind.
- **Existing infrastructure:** Repo uses `@sentry/nextjs`. Sentry's `captureException` accepts both the error and the React `componentStack` from `info`.

## Proposed Solutions

### Option A: Wire Sentry directly (recommended)

```ts
import * as Sentry from "@sentry/nextjs";
// ...
componentDidCatch(error: Error, info: ErrorInfo): void {
  console.error("TerragonThread crashed:", error, info);
  Sentry.captureException(error, {
    contexts: { react: { componentStack: info.componentStack } },
    tags: { source: "TerragonThread" },
  });
}
```

**Pros:** Uses existing infrastructure. Operators get stack traces, user context (if Sentry user is set), and component stack.
**Cons:** Adds an import dependency to `terragon-thread.tsx`.
**Effort:** Small (5 lines).
**Risk:** None — Sentry SDK is already loaded.

### Option B: Generic telemetry hook prop

Pass a `onError?: (e, info) => void` prop and let the consumer wire Sentry. More flexible but defers the wiring.

**Effort:** Medium.
**Risk:** Low.

## Recommended Action

(filled during triage)

## Technical Details

- **Affected files:** `apps/www/src/components/chat/assistant-ui/terragon-thread.tsx`
- **Verify:** check `apps/www/sentry.*.config.*` for the configured DSN and any tag conventions to match.

## Acceptance Criteria

- [ ] Render crash in dev triggers visible Sentry event (or telemetry hook fires)
- [ ] Stack trace + componentStack reach the configured destination
- [ ] No PII leaked in error context
- [ ] `pnpm tsc-check` passes

## Work Log

- 2026-04-27: Filed during code review (commit `1712a19e`).

## Resources

- Affected commit: `1712a19e`
- Sentry React docs: https://docs.sentry.io/platforms/javascript/guides/react/
