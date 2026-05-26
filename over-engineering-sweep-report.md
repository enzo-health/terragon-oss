# Over-Engineering & Complexity Sweep Report

## 1. Unnecessary Abstractions / Single-Use Factories

### 1a. `createTerragonTranscriptModelBuilder()` — over-engineered memoization

**File:** `apps/www/src/components/chat/assistant-ui/terragon-transcript-model.ts` (lines 27–53)

A factory function returns a closure that holds `previousInput` / `previousModel` state. The closure pattern adds indirection for memoization that React already provides via `useRef` / `useMemo`. The returned function is invoked exactly once per render cycle in the consuming hook.

**Suggested simplification:**

- Delete `createTerragonTranscriptModelBuilder()`.
- Make `buildTerragonTranscriptModel()` the primary export.
- Let the caller (the `useTerragonTranscriptModel` hook) hold `previousInput` / `previousModel` in a `useRef` and call `buildTerragonTranscriptModel()` directly.

---

### 1b. `LinearClientFactory` — unnecessary injectable factory plumbing

**File:** `apps/www/src/server-lib/linear-agent-activity.ts` (lines 37–40)
**Also pollutes:** `apps/www/src/app/api/webhooks/linear/handlers.ts` (7+ function signatures)

The factory is typed as `(accessToken: string) => LinearClient` and threaded through ~7 function signatures in the webhook handlers as `opts?: { createClient?: LinearClientFactory }`. It exists solely for testability, but tests already mock the `LinearClient` class or could mock the module import. The factory plumbing adds noise to every public API surface.

**Suggested simplification:**

- Remove `LinearClientFactory`, `defaultClientFactory`, and all `createClient` parameters.
- In tests, mock `@linear/sdk` (e.g. `vi.mock("@linear/sdk", () => ({ LinearClient: vi.fn() }))`).
- In `handlers.ts`, inline `new LinearClient({ accessToken })` directly.

---

### 1c. `createHistoryBuilderState()` — single-use object initializer

**File:** `apps/www/src/server-lib/ag-ui-side-effect-messages.ts` (lines 420–432)

Called exactly once inside `getDurableAgUiHistoryItemsFromEvents`. The function does nothing except return a plain object with empty collections.

**Suggested simplification:**

- Inline the object literal at the call site (line 375):
  ```ts
  const state: HistoryBuilderState = {
    items: [],
    itemIds: new Set(),
    /* … */ lastSeqOffset: -1,
  };
  ```
- Delete `createHistoryBuilderState()`.

---

### 1d. `transitionIssueToStarted` duplicates the factory pattern locally

**File:** `apps/www/src/app/api/webhooks/linear/handlers.ts` (lines ~270–320)

The function declares its own `createClient` parameter with an inline arrow factory:

```ts
createClient = (t: string) => new LinearClient({ accessToken: t });
```

This duplicates `defaultClientFactory` from `linear-agent-activity.ts` instead of importing it, creating inconsistency.

**Suggested simplification:**

- Remove the parameter and inline `new LinearClient({ accessToken })` (or import `defaultClientFactory` if the parameter is kept).

---

## 2. Premature / Unnecessary Generic Types

### 2a. `PartRegistryEntry<Part, Props>` — generic interface for a typed record

**File:** `apps/www/src/components/chat/parts/part-registry.ts` (lines 97–133)

Every entry in `PART_REGISTRY` is instantiated with a concrete type. The generics exist only to type the `definePartEntry` helper, which itself could be simplified. `NoInfer<Props>` and the closed-over `render` dispatcher add ~30 lines of type machinery for what is fundamentally `{ component, buildProps, render: (ctx, part) => createElement(component, buildProps(ctx, part)) }`.

**Suggested simplification:**

- Remove the `PartRegistryEntry` interface and `definePartEntry` helper.
- Inline the `render` function at each registry entry (or use a simple untyped helper since TypeScript inference from the object literal already works).
- The exhaustiveness assertions (`_AssertPartRegistryHasNoExtras`) can remain — they’re valuable.

---

### 2b. `getCapability<K extends ToolCapability["kind"]>` — generic for return-type narrowing

**File:** `apps/www/src/components/chat/tools/tool-registry.ts` (lines 140–155)

The generic `K` is used only for return-type narrowing. Every call site knows the `kind` at compile time. A simple non-generic `find` + type assertion would suffice and remove the `Extract` + `c is Extract<…>` cast inside the function.

**Suggested simplification:**

```ts
export function getCapability(
  capabilities: ToolCapability[],
  kind: ToolCapability["kind"],
): ToolCapability {
  const cap = capabilities.find((c) => c.kind === kind);
  if (!cap) throw new Error(`Missing required capability: ${kind}`);
  return cap as Extract<ToolCapability, { kind: typeof kind }>;
}
```

---

## 3. Overly Defensive / Excessive Code

### 3a. `useScrollToBottom.ts` — 11 null checks for RAF IDs in 280 lines

**File:** `apps/www/src/hooks/useScrollToBottom.ts`

The hook contains 11 separate `if (ref.current !== null)` checks for `resizeScrollFrameRef` and `imperativeScrollFrameRef`. `cancelAnimationFrame(0)` is a no-op, so `if (rafId)` is sufficient. The hook itself is ~280 lines for the conceptually simple task of "scroll to bottom on new messages" — it uses 6 `useCallback` hooks, 3 `useEffect`/`useLayoutEffect`, ResizeObserver + MutationObserver fallback, and complex RAF coalescing.

**Suggested simplification:**

- Replace `!== null` checks with truthy checks: `if (resizeScrollFrameRef.current)`.
- Collapse `updateContainer`, `updateIsAtBottom`, `scrollContainerToBottom`, `shouldPreserveInitialPosition`, `forceScrollToBottom`, `maybeScrollToBottom`, `scheduleScrollCheck` into fewer, simpler callbacks. Several are one-liners that don’t need memoization.
- Remove `typeof window === "undefined"` guard on line 89 — this callback runs inside `useLayoutEffect`, where `window` is guaranteed.

---

### 3b. `typeof window === "undefined"` guards in client components (20+ sites)

**Files:** Scattered across `apps/www/src/`

In Next.js App Router, `"use client"` components execute in the browser. `window` and `document` are always defined at runtime for effect callbacks and event handlers. Many guards are in `useEffect` / `useCallback` bodies where the browser environment is guaranteed.

**Notable examples:**

- `apps/www/src/hooks/useScrollToBottom.ts:89` — inside a `useCallback` invoked from `useLayoutEffect`
- `apps/www/src/components/terminal-part-view.tsx:69` — inside `useEffect`
- `apps/www/src/components/chat/terragon-ag-ui-runtime-core.ts:818` — inside `useEffect`
- `apps/www/src/hooks/useBreakpointCross.ts:19` — inside `useEffect`

**Suggested simplification:**

- Remove `typeof window === "undefined"` checks from inside effects and callbacks in client components.
- Keep only the guards that run during module initialization or SSR hydration boundary (e.g. top-level code in a client component).

---

### 3c. `typeof document === "undefined"` in client components

**Files:**

- `apps/www/src/components/system/user-atoms-client.tsx:68`
- `apps/www/src/lib/cookies-client.ts:4`
- `apps/www/src/components/ai-elements/markdown-renderer.tsx:186`
- `apps/www/src/components/chat/hooks.tsx:87`
- `apps/www/src/atoms/user-cookies.ts:89`, `:160`

These are all client-side files. `document` is always defined in the browser.

**Suggested simplification:**

- Remove the guards; they are dead code in browser-only execution paths.

---

### 3d. `typeof ResizeObserver !== "undefined"` — obsolete feature detection

**File:** `apps/www/src/hooks/useScrollToBottom.ts:235`

`ResizeObserver` has been supported in all modern browsers since 2020. The `MutationObserver` fallback below it is dead code for all supported browsers.

**Suggested simplification:**

- Remove the `typeof ResizeObserver !== "undefined"` ternary and the `MutationObserver` fallback.

---

## 4. Feature Flags for Dead / Stalled Features

### 4a. `shutdownMode` — expired shutdown flag

**File:** `packages/shared/src/model/feature-flags-definitions.ts`

Description: _"Used for Terragon shutdown on February 14th, 2026."_  
Today is May 25, 2026. The shutdown date has passed. The flag is only consumed in `apps/www/src/components/system/banner-container.tsx:23` to show a shutdown banner.

**Suggested simplification:**

- Remove the flag definition, the banner-container usage, and the banner UI code if the product is continuing. If a future shutdown is needed, a new flag can be created.

---

### 4b. `autoUpdateDaemon` — permanently disabled

**File:** `packages/shared/src/model/feature-flags-definitions.ts`

Default: `false`. Used in:

- `apps/www/src/agent/sandbox.ts:763`
- `apps/www/src/app/api/run-setup-script/stream/route.ts:129` (hardcoded to `false` regardless of flag)

The route hardcodes `autoUpdateDaemon: false`, so the flag can never enable the feature through that path.

**Suggested simplification:**

- Remove the flag and associated code. If auto-update is desired later, re-implement without a flag.

---

### 4c. `forceDaytonaSandbox` — single-use override

**File:** `packages/shared/src/model/feature-flags-definitions.ts`

Only used in `apps/www/src/agent/sandbox.ts:1083` as a force-override. If Daytona is the intended default provider, this override is unnecessary.

**Suggested simplification:**

- Remove the flag and let the sandbox provider setting control behavior directly.

---

### 4d. `batchGitHubMentions` — stalled feature

**File:** `packages/shared/src/model/feature-flags-definitions.ts`

Only used in `apps/www/src/app/api/webhooks/github/handle-app-mention.ts:336`. Default is `false` and it gates a batching optimization. If the optimization is not planned, the flag and code add dead weight.

**Suggested simplification:**

- Either ship the feature (remove the flag, enable by default) or remove the flag and the gated code.

---

### 4e. `geminiAgent` — potentially abandoned

**File:** `packages/shared/src/model/feature-flags-definitions.ts`

Only used in `apps/www/src/atoms/user.ts:82`. The Gemini agent feature may be abandoned; verify with product before removing.

---

### 4f. `mcpPermissionPrompt` — daemon-side flag with no UI

**File:** `packages/shared/src/model/feature-flags-definitions.ts`

Only consumed in `packages/daemon/src/daemon.ts:3978`. No UI reads this flag. Appears to be an incomplete feature.

**Suggested simplification:**

- Remove if the MCP permission prompt feature is not planned for release.

---

## 5. Unused / Low-Value Configuration

### 5a. `budgetMs = 2000` default parameter

**File:** `apps/www/src/app/api/webhooks/linear/handlers.ts` (~line 192)

`emitErrorActivity` declares `budgetMs = 2000` as a default parameter, but the function is a private helper called only internally. The value is never overridden.

**Suggested simplification:**

- Replace the parameter with a module-level constant: `const ERROR_ACTIVITY_BUDGET_MS = 2000`.

---

## 6. Over-Nested Directory Structures

No major issues found. The deepest paths (`app/(sidebar)/(site-header)/internal/admin/...`) are standard Next.js App Router route-group conventions. The `components/chat/parts/`, `components/chat/tools/`, and `components/chat/assistant-ui/` subdirectories are well-justified by domain cohesion and file count.

---

## 7. Unused Test Utilities

### 7a. `test-helpers/test-global-setup.ts` — pass-through re-export

**File:** `apps/www/src/test-helpers/test-global-setup.ts`

The file simply re-exports `setup` / `teardown` from `@terragon/shared/test-global-setup`. It exists only because `vite.config.ts` points `globalSetup` to this file.

**Suggested simplification:**

- Update `apps/www/vite.config.ts` to point `globalSetup` directly to `@terragon/shared/test-global-setup` (or its resolved path).
- Delete `apps/www/src/test-helpers/test-global-setup.ts`.

---

## 8. Bloated Files (Not Over-Engineering, but Maintenance Risk)

### 8a. `linear-agent-activity.ts` — 392 lines, mixed responsibilities

**File:** `apps/www/src/server-lib/linear-agent-activity.ts`

Mixes type definitions, `emitAgentActivity`, `updateAgentSession`, in-memory throttle state, text-extraction helpers, and the `emitLinearActivitiesForDaemonEvent` orchestrator.

**Suggested simplification:**

- Split into:
  - `linear-agent-activity/types.ts` — all type definitions
  - `linear-agent-activity/emit.ts` — `emitAgentActivity` + `updateAgentSession`
  - `linear-agent-activity/orchestrator.ts` — `emitLinearActivitiesForDaemonEvent` + throttle + extract helpers

---

### 8b. `handlers.ts` — 1198 lines

**File:** `apps/www/src/app/api/webhooks/linear/handlers.ts`

Contains payload type definitions, multiple webhook handlers, `emitErrorActivity`, `transitionIssueToStarted`, and repository suggestion logic.

**Suggested simplification:**

- Split into:
  - `webhooks/linear/types.ts` — payload interfaces
  - `webhooks/linear/handlers/created.ts` — `handleAgentSessionCreated`
  - `webhooks/linear/handlers/prompted.ts` — `handleAgentSessionPrompted`
  - `webhooks/linear/helpers.ts` — `emitErrorActivity`, `transitionIssueToStarted`

---

## Summary Table

| #   | Finding                                                   | File(s)                                                  | Severity |
| --- | --------------------------------------------------------- | -------------------------------------------------------- | -------- |
| 1a  | `createTerragonTranscriptModelBuilder` single-use factory | `terragon-transcript-model.ts`                           | Medium   |
| 1b  | `LinearClientFactory` threaded through 7+ signatures      | `linear-agent-activity.ts`, `handlers.ts`                | Medium   |
| 1c  | `createHistoryBuilderState` single-use initializer        | `ag-ui-side-effect-messages.ts`                          | Low      |
| 1d  | Inline `createClient` duplicates factory                  | `handlers.ts`                                            | Low      |
| 2a  | `PartRegistryEntry<Part, Props>` unnecessary generic      | `part-registry.ts`                                       | Low      |
| 2b  | `getCapability<K>` generic for single-call-site narrowing | `tool-registry.ts`                                       | Low      |
| 3a  | 11 null checks + 280-line scroll hook                     | `useScrollToBottom.ts`                                   | Medium   |
| 3b  | `typeof window === "undefined"` in effects (20+ sites)    | Various client files                                     | Low      |
| 3c  | `typeof document === "undefined"` in client files         | Various client files                                     | Low      |
| 3d  | `typeof ResizeObserver` feature detection                 | `useScrollToBottom.ts`                                   | Low      |
| 4a  | `shutdownMode` expired Feb 2026                           | `feature-flags-definitions.ts`, `banner-container.tsx`   | Medium   |
| 4b  | `autoUpdateDaemon` permanently disabled                   | `feature-flags-definitions.ts`, `sandbox.ts`, `route.ts` | Medium   |
| 4c  | `forceDaytonaSandbox` single-use override                 | `feature-flags-definitions.ts`, `sandbox.ts`             | Low      |
| 4d  | `batchGitHubMentions` stalled feature                     | `feature-flags-definitions.ts`, `handle-app-mention.ts`  | Low      |
| 4e  | `geminiAgent` potentially abandoned                       | `feature-flags-definitions.ts`, `user.ts`                | Low      |
| 4f  | `mcpPermissionPrompt` incomplete daemon feature           | `feature-flags-definitions.ts`, `daemon.ts`              | Low      |
| 5a  | `budgetMs = 2000` unused default parameter                | `handlers.ts`                                            | Low      |
| 7a  | `test-global-setup.ts` pass-through re-export             | `test-helpers/test-global-setup.ts`, `vite.config.ts`    | Low      |
| 8a  | `linear-agent-activity.ts` 392 lines, mixed concerns      | `linear-agent-activity.ts`                               | Low      |
| 8b  | `handlers.ts` 1198 lines                                  | `handlers.ts`                                            | Low      |
