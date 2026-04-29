---
title: "refactor: Adopt assistant-ui ActionBar, harden the runtime, document constraints"
type: refactor
status: draft
date: 2026-04-27
deepened: 2026-04-27
reviewed: 2026-04-27
companion: docs/plans/2026-04-27-001-refactor-ag-ui-native-runtime-plan.md
---

# refactor: Adopt assistant-ui ActionBar, harden the runtime, document constraints

> **Honest framing (post plan_review).** The earlier title called this
> "convergence." The actual scope is: adopt one substantive primitive
> (ActionBar), pilot a tool-registry migration with a hard kill-switch,
> harden the runtime hook, and document the constraints that prevent
> further library adoption (Reload, markdown). If the Phase B pilot reveals
> the library can't accommodate terragon lifecycle without sibling-state
> reads in more than two tools, Phase B is cancelled.

## Enhancement Summary

**Deepened on:** 2026-04-27
**Reviewed on:** 2026-04-27 (DHH, Kieran TS, simplicity re-pass)
**Sections enhanced:** Title (renamed for honesty), Overview, Phase A (Kieran specifics), Phase B0.5 (NEW: tool registry types), Phase B (kill switch + intermediate gate), Phase C (closure caveat), Phase D (inverted, one-liner), Phase F (cut), Justified divergences, Open Questions, Acceptance Gates, Operational Notes, Risks
**Research applied:**
- assistant-ui ActionBar / MessagePrimitive API extracted from local tarball
- `@assistant-ui/react-markdown` capabilities vs. current `streamdown` setup
- code-simplicity-reviewer pass (verdict: CONCERNS → addressed)
- DHH plan_review (taste critique on framing → title renamed, "convergence" rescoped)
- Kieran TypeScript plan_review (verdict: CONCERNS — Phase B blocker → Phase B0.5 added)

### Key Improvements

1. **Phase D inverted** — Research found we're on `streamdown` (not a hand-rolled
   renderer), and it has `parseIncompleteMarkdown` for graceful streaming that
   `@assistant-ui/react-markdown` lacks. Migrating would *regress* streaming UX.
   New Phase D: codify "keep streamdown, document why."
2. **Phase C corrected** — `ActionBar.Reload` calls `runtime.reload()`, which
   doesn't fit our DB-source-of-truth model. Use custom button inside
   `ActionBarPrimitive.Root` for retry/redo, not the Reload primitive.
   `MessagePrimitive.If` is deprecated; use `AuiIf` with custom predicates.
   Library hover is managed by `useAuiState`, replacing our manual `useState`.
3. **Phase F cut** — Removed ESLint custom rules and `pnpm chat:audit` script
   per simplicity review (phantom ceremony solving non-existent regressions).
   Phase F now: just AGENTS.md update.
4. **Phase E removed** — Was a placeholder for follow-up work, not a real phase.
5. **terragon-thread.tsx recategorized** — Moved from "justified divergence" to
   "transitional" since plan 001 Unit 5 is meant to thin it.
6. **Precondition surfaced** — `@assistant-ui/react` is in package.json but not
   under `node_modules/`. First implementer task: `pnpm install`.
7. **Pilot-before-cascade gate added to Phase B** — One end-to-end tool
   migration with progress-chunk handling resolved before touching the rest.
8. **Bundle size as value gate** — Replaces "net negative LOC" as the
   verifiable simplification metric.

### New Considerations Discovered

- **Markdown copy semantics**: `ActionBar.Copy` joins text-type parts only
  (no markdown emit). Our current `getTextContent` builds markdown image
  syntax — preserve via `useActionBarCopy` hook with custom `copyToClipboard`.
- **No built-in aria-labels** in primitives — caller supplies them, same as
  today. No accessibility regression risk.
- **Branch navigation primitives exist** (`BranchPickerPrimitive`) but are
  inert without per-message branch storage. Don't pursue in this plan.
- **`useSmoothText` requires the assistant-ui runtime**, which our chat
  doesn't fully use. Don't pursue token-by-token reveal animation here.

## Overview

Plan 001 makes AG-UI events the source of truth for the runtime transcript.
This plan (002) is its companion: it focuses on the **rendering layer** — adopting
assistant-ui primitives wherever the library already provides what we hand-roll
today, deleting the parallel constructs, and codifying architecture invariants
that prevent regression.

These plans compose cleanly. Plan 001 owns the event/data flow; this plan owns
the React component/primitive surface and the guardrails. They can run in
parallel up to the point where this plan's Phase 4 (reducer collapse) requires
plan 001's Unit 5 (assistant-ui as rendered transcript owner).

## Problem Frame

We have three categories of "custom" code in the chat layer today:

1. **Replaceable** — code with a direct library equivalent (~700 LOC across
   tool dispatch, toolbar, markdown rendering, message rendering).
2. **Justified divergence** — code with no library equivalent that we will
   keep forever (TipTap promptbox, DB persistence layer, lifecycle queue,
   server-action-driven follow-ups).
3. **Transitional** — code that exists because we haven't migrated yet
   (custom tool switch in `tool-part.tsx`, custom toolbar in
   `chat-message-toolbar.tsx`, custom markdown in `text-part.tsx`).

The previous plan (001) targets category 3 from the data side. This plan targets
category 3 from the rendering side, and codifies the boundary between
categories 2 and 3 so future contributors know when custom is allowed.

## Requirements Trace

- R1. Tool call rendering must go through `makeAssistantToolUI` registration
  with **typed `Args` and `Result` generics derived from a central
  `tool-registry.ts`**. No string-keyed switch on tool name. No `<any, any>`.
- R2. Message-level actions (copy, retry trigger, fork dialog launcher) must
  compose via assistant-ui `ActionBarPrimitive` composition, not a
  hand-rolled toolbar.
- R3. The streamdown markdown renderer stays. `@assistant-ui/react-markdown`
  is documented in AGENTS.md as not the migration target due to missing
  `parseIncompleteMarkdown` and `useSmoothText` runtime requirement.
- R4. The `@assistant-ui/react` and `@assistant-ui/react-ag-ui` versions are
  pinned to exact (no caret), since `react-ag-ui` is `0.0.x` with documented
  protocol churn.
- R5. The runtime hook is memoized with explicit dependencies and is
  surrounded by an error boundary (class component or `react-error-boundary`,
  caller's choice; specified at implementation time).
- R6. AGENTS.md contains an "AG-UI Architecture Invariants" section that
  states the rules and identifies justified divergences.
- R7. The TipTap promptbox stays as-is. ComposerPrimitive is documented as
  not the migration target.
- R8. After migration, the chat directory has bundle-size delta ≤0 KB
  (regression-free) AND `chat-message-toolbar.tsx` reduced from ~241 LOC
  to ≤50 LOC or deleted.

## Success Criteria

- `tool-part.tsx` no longer contains a switch on `toolPart.name` — each tool
  registers via `makeAssistantToolUI<Args, Result>`.
- `chat-message-toolbar.tsx` either reduces to ~30 LOC of composition or is
  deleted in favor of inline `ActionBar` primitives in the message components.
- `text-part.tsx` either delegates to `@assistant-ui/react-markdown` or
  documents in code why it cannot.
- `package.json` pins `@assistant-ui/react@<exact>` and
  `@assistant-ui/react-ag-ui@<exact>` (no `^`).
- `useTerragonRuntime` props are memoized; an error boundary wraps
  `<TerragonThread />`.
- `AGENTS.md` contains the architecture invariants block.
- An ESLint config or repo-level lint script fails on the forbidden patterns.
- `cloc apps/www/src/components/chat` shows net negative LOC after Phase 1-3.

## Scope Boundaries

**In scope:**
- Tool UI registration migration
- Message toolbar primitive adoption
- Markdown rendering migration
- Runtime hardening (memo, error boundary)
- Version pinning
- AGENTS.md invariants
- ESLint guardrails

**Out of scope:**
- AG-UI event mapping changes (plan 001 owns this)
- DB schema changes / `thread_chat.messages` deletion (plan 001)
- Native reasoning event migration (plan 001 Unit 4)
- ActivityMessage migration for rich parts (plan 001 Unit 4)
- TipTap promptbox migration (justified divergence; out forever)
- Branching / edit / regenerate UX (defer; needs runtime→server-action bridge)
- Path A full event-sourcing (defer indefinitely)

## Context & Research

### Library state (researched 2026-04-27)

- `@assistant-ui/react@^0.12.24` — installed; latest `0.12.26`. Patch bump safe.
  v0.14 will move primitives from `components` prop to children render
  functions; plan for that before next major.
- `@assistant-ui/react-ag-ui@0.0.26` — installed; latest `0.0.27`. **Three
  backward-compatibility middlewares (`BackwardCompatibility_0_0_{39,45,47}`)
  auto-installed by the SDK confirm protocol churn.** Pin exact, watch
  releases manually.
- `@ag-ui/client@0.0.52` — direct dependency; `AbstractAgent.messages` is
  SDK-maintained via `defaultApplyEvents`. Subscriber callbacks receive
  `textMessageBuffer`, `toolCallBuffer` pre-accumulated.
- `@assistant-ui/react-markdown` — official package; renders streaming
  partial-syntax markdown without flicker.

### Files in scope

- `apps/www/src/components/chat/tools/tool-part.tsx` — custom switch (~150 LOC)
- `apps/www/src/components/chat/tools/*.tsx` — individual tool components
  (BashTool, ReadTool, WriteTool, TodoWriteTool, etc.) — keep as renderers
- `apps/www/src/components/chat/chat-message-toolbar.tsx` — custom toolbar (~200 LOC)
- `apps/www/src/components/chat/text-part.tsx` — custom markdown
- `apps/www/src/components/chat/assistant-runtime.ts` — runtime hook
- `apps/www/src/components/chat/assistant-ui/terragon-thread.tsx` — wraps provider
- `apps/www/package.json` — version pinning
- `AGENTS.md` — architecture invariants
- ESLint config (root or app-level)

### Justified divergences (do NOT migrate)

| Surface | Library equivalent | Why we keep custom |
|---|---|---|
| `promptbox/use-promptbox.tsx` (~913 LOC) | `ComposerPrimitive` | TipTap with slash commands, mentions, drafts, transcription, multi-message queue. ComposerPrimitive is plain text only. Architectural divergence forever. |
| `streamdown` markdown renderer (~491 LOC) | `@assistant-ui/react-markdown` | streamdown's `parseIncompleteMarkdown` has no equivalent — migration would regress streaming UX. Also requires assistant-ui runtime adoption for `useSmoothText`. Reconsider only when full runtime adopted. |
| Lifecycle messages (auto-compact / oauth-retry) | `MESSAGES_SNAPSHOT` synthesis | Server-side recovery flows need durable persistence + queued Continue. Stays in `daemon-event/route.ts` recovery paths. |
| Server-action `followUp` / `queueFollowUp` | `runtime.append` / `ActionBar.Reload` | DB-source-of-truth model; runtime stays read-side. May change if plan 001 lands fully. |

**Transitional (NOT justified — slated for migration):**

| Surface | Migration vehicle | Status |
|---|---|---|
| `terragon-thread.tsx` (~400 LOC) | Plan 001 Unit 5 ("assistant-ui as rendered transcript owner") | After plan 001 Unit 5, this should be reviewed and thinned. Listing as transitional, not justified, so it doesn't get grandfathered. |
| `chat-message-toolbar.tsx` (~241 LOC) | This plan, Phase C | Under active migration. |
| `tool-part.tsx` switch (~150 LOC) | This plan, Phase B | Under active migration. |

## Phased Delivery

### Phase A — Hardening (1 day, no dependencies)

Independent of plan 001. Ship in any order.

- A1. Memoize `useTerragonRuntime` props in `terragon-thread.tsx:162`.
  Explicit deps: `[agent, threadId, showThinking, onCancel]` (verify against
  actual hook signature). Memoize via `useMemo` returning a config object;
  do NOT memoize `onCancel` separately — wrap it in `useCallback` with the
  same deps as the values it closes over.
- A2. Wrap `<TerragonThread />` in an error boundary. Implementer chooses
  between a class component (existing pattern) or `react-error-boundary`
  (new dep). Either way, fallback reuses the existing `ChatError` UI.
- A3. **Order:** install first, then pin. Run `pnpm install` to resolve
  current `@assistant-ui/react` and `@assistant-ui/react-ag-ui` versions
  against the existing peer-dep graph. Then update `package.json` to pin
  whatever resolved (or to a verified-compatible newer patch). Pinning to
  "latest" without observing what resolves risks selecting a version that
  pre-dates the current `@ag-ui/client@0.0.52` peer.

**Acceptance:**
- No `^` in `@assistant-ui/react` or `@assistant-ui/react-ag-ui` versions.
- Runtime hook has `useMemo`-stable inputs with named dep array.
- Manual error injection in dev shows the boundary catches and offers retry.
- `node_modules/@assistant-ui/react` exists.
- `pnpm tsc-check` passes.

### Phase B0.5 — Tool registry types (1 day; **blocks Phase B**)

**Goal:** Resolve the type-safety gap that Kieran's review surfaced.
`DBToolCall.args` and `.result` are `unknown` (JSONB). Without typed
generics, `makeAssistantToolUI<Args, Result>` becomes `<any, any>` and
the migration is type laundering, not type safety.

- **B0.5.1.** Create `apps/www/src/components/chat/tools/tool-registry.ts`
  with a single typed map keyed by tool name:

  ```ts
  // Sketch — exact shape decided during implementation.
  export type ToolRegistry = {
    Bash: { args: BashArgs; result: BashResult };
    Read: { args: ReadArgs; result: ReadResult };
    // ... one entry per tool
  };

  export type ToolName = keyof ToolRegistry;
  export type ToolArgs<T extends ToolName> = ToolRegistry[T]["args"];
  export type ToolResult<T extends ToolName> = ToolRegistry[T]["result"];
  ```

- **B0.5.2.** Source the per-tool `Args`/`Result` shapes from one of:
  - the daemon's existing tool-call type definitions (preferred if they exist),
  - existing zod schemas via `z.infer` (if zod is already used for tools), or
  - hand-authored types co-located with each tool component.
  Pick one approach; do not mix.
- **B0.5.3.** Verify the registry's `keyof` set matches the runtime tool
  names emitted by the daemon (write a small test asserting equality
  against a known-tools fixture).

**Acceptance:**
- `tool-registry.ts` exists and exports `ToolRegistry`, `ToolName`,
  `ToolArgs`, `ToolResult`.
- Every tool the daemon emits has a registry entry (verified by test).
- `pnpm tsc-check` passes with no new `any` types introduced.
- No `<any, any>` invocations of `makeAssistantToolUI` anywhere.

**Decision gate to Phase B:** if B0.5 reveals that args/result types are
genuinely unrecoverable (e.g. tools accept arbitrary JSON with no schema),
**stop and reconsider**. In that case, accepting `<unknown, unknown>` and
runtime-validating with zod inside each component is a defensible
fallback — but record the decision explicitly here.

### Phase B — Tool UI registry (2-3 days)

**Goal:** Replace `tool-part.tsx`'s switch with `makeAssistantToolUI`
registrations.

**Dependencies:** Phase B0.5 must be complete (typed `ToolRegistry`).

- **B0. Precondition.** Phase A's `pnpm install` step has run.
- **B1. Pilot end-to-end.** Pick the simplest tool with progress chunks
  (e.g. `BashTool`). Wrap in
  `makeAssistantToolUI<ToolArgs<"Bash">, ToolResult<"Bash">>({ toolName: "Bash", render: BashTool })`.
  Mount as a child of `AssistantRuntimeProvider` in `terragon-thread.tsx`.
  The pilot **must** demonstrate progressChunks rendering before B3.
- **B2. Hard kill-switch (DHH's gate).** If the pilot or the next tool
  reveals that `progressChunks`/`mcpMetadata`/`toolStatus` cannot be
  expressed via the library's `status` union AND requires reading sibling
  state via `useAuiState` to render anything interesting:
  - **If 1-2 tools need sibling state:** acceptable. Document the access
    pattern in `tool-registry.ts` and proceed.
  - **If 3+ tools need it:** **STOP**. The library shape doesn't fit our
    data model. Cancel Phase B; the switch in `tool-part.tsx` is more
    honest than `<any, any>`-style registrations with sibling-state reads
    masquerading as library adoption.
- **B3. Cascade** to remaining tools (Read, Write, Edit, MultiEdit, Glob,
  Grep, LS, Task, NotebookEdit, NotebookRead, TodoWrite, WebFetch, WebSearch,
  ExitPlanMode, etc.). Update `tool-registry.ts` for each.
- **B4. Intermediate gate.** Before deleting the switch, write a test
  asserting that `Object.keys(ToolRegistry)` (the typed registry) equals
  the set of cases handled by the current `tool-part.tsx` switch. This
  catches silent drops during the cascade.
- **B5. Delete or shrink the switch** in `tool-part.tsx`. If the file is
  imported elsewhere, leave a barrel re-export of the remaining
  (non-tool-dispatch) parts to avoid breaking import sites in one PR.
  Follow up with a separate cleanup PR.

**Acceptance:**
- `rg "switch \\(toolPart\\.name\\)" apps/www/src` returns empty.
- Each tool has exactly one `makeAssistantToolUI` call typed via
  `ToolArgs<"X">` / `ToolResult<"X">` (no `<any, any>`, no `<unknown, unknown>`
  unless explicitly accepted in B0.5's decision).
- `tool-part.tsx` either deleted or <30 LOC.
- Intermediate gate test (B4) passes: registry keys === switch case set.
- Pilot tool's progressChunks render visibly during streaming (manual smoke
  test in dev).
- `pnpm tsc-check` passes.

**Patterns to follow:**
- Library docs: `https://www.assistant-ui.com/docs/guides/tool-ui`
- Status mapping: `DBToolCall.status` ("started"/"in_progress"/"completed")
  → library's `running`/`complete`/`incomplete`.
- terragon-extended fields read via `useAuiState`, not by mutating the
  status enum.

**Risk:** Library status enum may not model `progressChunks`. Mitigation
above (B2). If pilot reveals deeper incompatibility (e.g. tool components
can't read sibling context), cancel B and write a follow-up plan.

### Phase C — Toolbar / ActionBar (1 day; revised from 0.5 day)

**Goal:** Replace `chat-message-toolbar.tsx`'s hand-rolled hover/show logic
with assistant-ui `ActionBarPrimitive` primitives. Note: research surfaced
that `ActionBar.Reload` is incompatible with our DB-source model — we use
custom buttons inside `Root`, not the Reload primitive.

- **C1. Compose with `ActionBarPrimitive.Root`** with
  `autohide="not-last"` and `hideWhenRunning` props (built-in floating /
  hover-to-show; replaces our `opacity-0 group-hover:opacity-100`).
- **C2. Use `ActionBarPrimitive.Copy`** for plain-text copy. For our
  markdown-aware copy (which today builds image syntax via `getTextContent`
  in `chat-message-toolbar.tsx:36-51`), use `useActionBarCopy` from
  `@assistant-ui/core/react` with a custom `copyToClipboard` callback.
  **Closure caveat:** wrap the callback in `useCallback` with explicit
  `[parts]` (or whatever it closes over) deps — a free function will
  capture stale parts during streaming and copy outdated content. Read
  copy state via `useAuiState((s) => s.message.isCopied)` for icon swap.
  Verify `AuiIf` and `useAuiState` are exported from `@assistant-ui/react`
  before kickoff (B1 verification step).
- **C3. Visibility predicates use `AuiIf`, NOT `MessagePrimitive.If`.**
  `MessagePrimitive.If` is deprecated in v0.12. Use:

  ```tsx
  <AuiIf condition={(s) => s.message.role === "assistant"}>
    {/* assistant-only items */}
  </AuiIf>
  ```

- **C4. Custom items (redo, fork dialog launcher, share)** render as plain
  `<button>` children inside `ActionBarPrimitive.Root`. They inherit the
  Root's autohide gating automatically.
- **C5. DO NOT use `ActionBarPrimitive.Reload`.** It calls
  `runtime.reload(messageId)`, which our DB-source-of-truth model can't
  satisfy. Render a custom button that opens the existing `RedoTaskDialog`.
  Disable via `useAuiState((s) => s.thread.isRunning)`.
- **C6. Delete or shrink** `chat-message-toolbar.tsx`. Target ≤50 LOC
  (revised from ≤30 — custom Copy callback + AuiIf + custom buttons need
  some glue).

**Acceptance:**
- No custom `useState` for hover/copied state inside the toolbar — library
  primitives own it.
- No `MessagePrimitive.If` usage; all conditionals use `AuiIf`.
- File LOC drops from ~241 (current) to ≤50, or file deleted entirely.
- aria-labels are preserved (library doesn't supply them).

**Patterns:** ActionBarPrimitive composition example A documented at
`.claude/skills/primitives/references/action-bar.md:156-217` (full
assistant-message bar with autohide + AuiIf + icon swap).

### Phase D — Markdown (INVERTED: codify "keep streamdown") (0.5 day)

**Goal (revised after research):** Document why `@assistant-ui/react-markdown`
is not the migration target. We're already on `streamdown` (via
`apps/www/src/components/ai-elements/markdown-renderer.tsx`, ~491 LOC),
which has features the assistant-ui markdown package lacks.

**Research finding:** `@assistant-ui/react-markdown` is a thin primitive over
`react-markdown`. It does NOT include `parseIncompleteMarkdown` (graceful
streaming of unclosed fences/bold/links). It does NOT bundle Shiki/KaTeX/
GFM — all are bring-your-own. `useSmoothText` requires the full assistant-ui
runtime, which our chat doesn't use end-to-end.

**Hard blockers to migration (documented for future contributors):**

1. **`parseIncompleteMarkdown` has no equivalent.** Switching would visibly
   regress streaming output — users would see literal `**` and unclosed
   ``` ` ``` until tokens land.
2. **`useSmoothText` requires the full `@assistant-ui/react` runtime**,
   which our chat doesn't use; we drive parts directly from `DBMessage`.
   Adopting the runtime is a separate, much larger migration.

**Action:**
- D1. Add a single one-line comment to the top of
  `apps/www/src/components/chat/text-part.tsx`:

  ```tsx
  // streamdown handles partial-token streaming; @assistant-ui/react-markdown does not. See docs/plans/2026-04-27-002-*.md
  ```

  Optionally add the same one-liner to
  `apps/www/src/components/ai-elements/markdown-renderer.tsx` if it would
  help future readers — but `ai-elements/` is outside `chat/` scope, so
  this is optional, not required.
- D2. Add an entry to "Justified divergences" table (above) for the
  markdown renderer.

**Acceptance:**
- `text-part.tsx` opens with the documented one-line comment.
- AGENTS.md (Phase F) mentions "markdown rendering uses streamdown, not
  @assistant-ui/react-markdown" in the invariants list.

**Reconsider when:** the chat fully adopts the assistant-ui runtime
(plan 001 Unit 5 is a partial step; full adoption would be plan 003 or later).
At that point, `MarkdownTextPrimitive` + custom remark plugins for
incomplete-markdown stabilization may net out positive.

### Phase E — REMOVED

Phase E was a placeholder for "reducer collapse" follow-up work. Per
simplicity review: a placeholder is not a phase. If material remains after
plan 001 Unit 5 lands, it gets its own plan 003.

### Phase F — AGENTS.md update (0.5 day; trimmed from 1 day)

**Goal:** Document the architecture so future contributors know the rules.
This is a documentation update, not an enforcement layer. Per simplicity
review, ESLint custom rules and `cloc`-based audit scripts are phantom
ceremony — the migrations themselves are one-time, and TypeScript already
warns on deprecated v0.12 hooks.

- **F1. Add to `AGENTS.md`:**

  ```
  ## Chat Layer Architecture Invariants

  - AG-UI is the protocol. assistant-ui is the rendering layer. Both are
    first-class. Direct imports from @ag-ui/client are allowed.
  - Tool UIs are registered via `makeAssistantToolUI`. Do not add tool
    switches keyed on tool name.
  - Message-level actions use assistant-ui ActionBarPrimitive composition.
    Use AuiIf for conditional rendering, not deprecated MessagePrimitive.If.
  - ActionBar.Reload is NOT used (incompatible with DB-source model);
    redo/retry uses a custom button calling our existing server actions.
  - Reasoning events are REASONING_*, never THINKING_*. (See plan 001.)
  - Rich custom parts use ActivityMessage with a typed activityType.
    CUSTOM events are reserved for ephemeral one-shot signals. (See plan 001.)
  - @ag-ui/client and @assistant-ui/react-ag-ui are pinned to exact
    versions because both are 0.0.x.
  - The TipTap promptbox stays custom. ComposerPrimitive is not the
    migration target.
  - The streamdown markdown renderer stays custom. @assistant-ui/react-markdown
    lacks parseIncompleteMarkdown and would regress streaming UX.
  - DB writes happen ONLY in apps/www/src/app/api/daemon-event/route.ts.
    The runtime's history.append is a no-op by contract.
  ```

**Acceptance:**
- AGENTS.md contains the invariants section.
- A grep for `switch (toolPart.name)` in `apps/www/src` returns empty
  (one-time PR check, not CI gate).

## System-Wide Impact

- **Component graph:** `tool-part.tsx`, `chat-message-toolbar.tsx`,
  `text-part.tsx`, `terragon-thread.tsx`, `assistant-runtime.ts`, all
  individual tool components.
- **Build:** package version pin changes only. No new dependencies (Phase D
  inverted; streamdown stays).
- **Tests:** `memo-rerenders.test.tsx` is the load-bearing test that
  toolbar/tool migrations must not regress. Add new tests proving registered
  tools render via `makeAssistantToolUI`.
- **Bundle size:** Should net-decrease as we delete custom code; verify
  `pnpm build` size delta in PR.
- **Behavior:** No user-visible behavior changes are intended. Any visible
  delta is a bug.

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| `makeAssistantToolUI` status union doesn't model `progressChunks` | Render terragon-specific lifecycle inside the tool component via `useAuiState` selectors; don't extend the library enum. Pilot tool (B1) gates the cascade. |
| Library `ActionBarPrimitive.Reload` is incompatible with DB-source model | Use a custom button inside `Root` calling `RedoTaskDialog`; do not register Reload (documented in Phase C5). |
| Pinning to exact versions blocks security patches | Maintainer reads `@ag-ui/client` releases on each minor bump (3 backcompat shims in 13 versions confirms the cadence). No automated reminder; this is a manual ops task. |
| Plan 001 races/conflicts with plan 002 changes | A/B/C/F ship independent of plan 001. D is documentation-only. terragon-thread thinning waits for plan 001 Unit 5 (handled in plan 001, not here). |
| Markdown migration regresses streaming UX | Inverted in deepening: streamdown stays. Phase D documents the decision so future contributors don't re-litigate. |
| `makeAssistantToolUI` becomes type-laundering (`<any, any>`) | Phase B0.5 (NEW) defines `tool-registry.ts` as the single typed source of truth. Phase B blocks until B0.5 lands. |
| Phase B cascade smuggles complexity into per-tool sibling-state reads | Hard kill switch at B2: ≤2 tools may need `useAuiState` lifecycle reads; if 3+, cancel Phase B. |
| `tool-part.tsx` deletion breaks import sites | B5 leaves a barrel re-export for non-dispatch parts. Cleanup follow-up PR resolves remaining imports. |
| `copyToClipboard` callback captures stale parts during streaming | C2 specifies `useCallback` with `[parts]` deps; verify in pilot. |

## Known Gaps (Not Addressed by This Plan)

This plan does NOT remove all legacy chat-layer code. Specific items
deferred to follow-up plan 003 (`docs/plans/2026-04-27-003-*.md`):

- **`message-part.tsx`'s `switch (extendedPart.type)`** — same anti-pattern
  as `tool-part.tsx`'s switch (which Phase B removes), but for non-tool
  parts. Independent work; could ship in parallel.
- **`ag-ui-messages-reducer.ts` (26.3 KB) collapse** — depends on plan 001
  Unit 5 making the assistant-ui runtime the rendered transcript owner.
- **`thread-view-model/` directory (6 files, ~1700+ LOC) reduction** —
  same dependency.
- **`assistant-ui/` bridge directory cleanup** (assistant-message,
  user-message, system-message, thread-context, plan-occurrences,
  ctx-stability) — same dependency.
- **`chat-ui.tsx` (34.6 KB) extraction** of React Query plumbing into a
  dedicated `ThreadProvider` — independent, low priority.

The honest framing: plans 001 + 002 together solve the **transport** and
**toolbar/tool-dispatch** layers. Plan 003 solves the **part-dispatch**,
**reducer**, and **bridge** layers. After 001 + 002 + 003 land, the
architecture invariants in AGENTS.md are fully realized.

## Documentation / Operational Notes

- Update `AGENTS.md` per Phase F1. AGENTS.md is the only architecture
  documentation surface; do NOT create `docs/architecture/chat-layer.md`
  (per DHH review: two documents will diverge).
- Add a Renovate or Dependabot config entry for `@assistant-ui/react`,
  `@assistant-ui/react-ag-ui`, and `@ag-ui/client` that opens PRs but
  does NOT auto-merge. Pre-1.0 churn surfaces as a review item, not a
  silent dependency drift.

## Acceptance Gates (rollup)

A PR can claim "this plan is done" when ALL hold:

- [ ] Phase A: `useTerragonRuntime` props are memoized with explicit deps;
      error boundary tested with deliberate throw; both packages pinned
      exact-version after `pnpm install` resolved them
- [ ] Phase B0.5: `tool-registry.ts` exists with typed `ToolRegistry`;
      `Object.keys(ToolRegistry)` test passes against runtime tool name set
- [ ] Phase B: `rg "switch \(toolPart\.name\)" apps/www/src` returns empty
- [ ] Phase B: every tool component is wrapped by exactly one
      `makeAssistantToolUI<ToolArgs<T>, ToolResult<T>>` call
      (no `<any, any>` or `<unknown, unknown>` unless explicitly accepted in B0.5)
- [ ] Phase B: pilot tool's `progressChunks` render visibly during a manual
      streaming test
- [ ] Phase B kill-switch was respected: ≤2 tools required `useAuiState`
      sibling-state reads, OR Phase B was cancelled
- [ ] Phase C: `chat-message-toolbar.tsx` ≤50 LOC or deleted
- [ ] Phase C: no `MessagePrimitive.If` usage (use `AuiIf`)
- [ ] Phase C: redo/retry uses a custom button (NOT `ActionBarPrimitive.Reload`)
- [ ] Phase D: `text-part.tsx` opens with the one-line documented-gap comment
- [ ] Phase F: `AGENTS.md` contains "Chat Layer Architecture Invariants"
- [ ] **`pnpm tsc-check` passes** (no new `any`, no new untyped selectors)
- [ ] **Bundle size:** `apps/www` `.next` total bundle size delta is ≤0 KB
      relative to baseline measured at PR-open time. Baseline command:
      `pnpm -C apps/www build && du -sb .next | awk '{print $1}'`.
      If positive, the PR description must justify the added bytes
      (e.g. "library replaces N KB of custom code; net is +X KB but
      removes a class of bugs.")
- [ ] All existing chat tests pass; new tests cover the pilot registered tool
      and the registry-equality assertion (B4)
- [ ] No user-visible behavior change (verified by manual smoke test:
      streaming text, tool calls with progress, copy, redo, fork dialog)

## Open Questions

### Resolved during deepening (2026-04-27)

- **Q1 (resolved)** Does `makeAssistantToolUI` accept render-order hints?
  Library docs don't expose priority/order; registrations match by
  `toolName`. Single-registration-per-tool is the intended pattern. Not a
  blocker.
- **Q2 (resolved)** Custom predicates on conditional rendering: use `AuiIf`
  with `condition: (state) => boolean` reading from `useAuiState`.
  `MessagePrimitive.If` is deprecated in v0.12. Phase C now uses `AuiIf`.

### Removed

- **Q3 (removed)** Header comment markers for justified-custom files were
  needed by the F2 audit script. Phase F was trimmed; Q3 is moot.

### Still open (deferred)

- **Q4.** When plan 001 Unit 5 lands, will `terragon-thread.tsx` actually
  thin out, or are there terragon-specific concerns the assistant-ui
  runtime can't accommodate? Decide during Unit 5 review.
- **Q5.** Does our markdown copy semantic (image syntax via `getTextContent`)
  break anything if we move to `useActionBarCopy` + custom callback? Verify
  in Phase C pilot — the public copy contract is "copies what the user sees,
  with reproducible markdown when applicable."

## Sources & References

- Companion plan: `docs/plans/2026-04-27-001-refactor-ag-ui-native-runtime-plan.md`
- assistant-ui Tool UI: `https://assistant-ui.com/docs/guides/tool-ui`
- assistant-ui Migration v0-12: `https://assistant-ui.com/docs/migrations/v0-12`
- assistant-ui Migration v0-14: `https://assistant-ui.com/docs/migrations/v0-14`
- AG-UI Events: `https://docs.ag-ui.com/concepts/events`
- AG-UI Reasoning: `https://docs.ag-ui.com/concepts/reasoning`
- @ag-ui/client SDK: `https://github.com/ag-ui-protocol/ag-ui/tree/main/sdks/typescript/packages/client`
- Internal research from sub-agent audits, captured in conversation
  transcript 2026-04-27.
