---
title: "refactor: Eliminate post-cutover chat-layer legacy"
type: refactor
status: draft
date: 2026-04-27
companion: docs/plans/2026-04-27-001-refactor-ag-ui-native-runtime-plan.md
companion_2: docs/plans/2026-04-27-002-refactor-ag-ui-assistant-ui-primitives-convergence-plan.md
---

# refactor: Eliminate post-cutover chat-layer legacy

## Overview

Plans 001 and 002 together solve the transport layer (events as source of
truth, REASONING/ACTIVITY native event mapping) and the toolbar/tool-dispatch
layer (ActionBar adoption, `makeAssistantToolUI` registry). They leave four
specific pieces of legacy code in place. This plan removes them.

The four targets, with verified LOC:

| Target | LOC | Removal vehicle |
|---|---|---|
| `message-part.tsx` `switch (extendedPart.type)` | 283 | Phase G — part renderer registry |
| `ag-ui-messages-reducer.ts` (custom event reducer) | 850 | Phase H — collapse after assistant-ui owns transcript |
| `thread-view-model/` (6 files: reducer + adapters) | ~2,100 (incl. test) | Phase I — collapse after Unit 5 |
| `assistant-ui/` bridge (5 wrappers + 2 helpers) | ~300 (excl. test) | Phase J — composition replaces wrappers |
| `chat-ui.tsx` React Query plumbing | ~700 of 1,065 | Phase K — extract `<ThreadProvider/>` |

**Total estimated reduction:** ~4,800 LOC of source (excl. tests),
~6,200 LOC including tests.

## Problem Frame

After plans 001 and 002 land, the chat layer still has three structural
duplications that the migrations didn't reach:

1. **Two switch-based dispatchers.** Plan 002 deletes `tool-part.tsx`'s
   switch on tool name. `message-part.tsx`'s switch on part type is
   structurally identical and unaddressed.

2. **Three reducers folding the same event stream.**
   - `ag-ui-messages-reducer.ts` (850 LOC) folds AG-UI events into UIMessages.
   - `thread-view-model/reducer.ts` (1374 LOC) wraps the above with thread
     status, lifecycle messages, artifacts, optimistic input.
   - `@ag-ui/client`'s `defaultApplyEvents` already maintains
     `agent.messages` and `agent.state` as a third reducer.

   After plan 001 Unit 5 makes the assistant-ui runtime the rendered
   transcript owner, the first two should mostly collapse — but plan 001
   doesn't itemize the deletion.

3. **Bridge components** in `assistant-ui/` directory wrap library
   primitives because the chat doesn't fully use them. After the runtime
   becomes authoritative, the wrappers are between the runtime and itself.

## Requirements Trace

- R1. No string-keyed switch on part type anywhere in the chat layer.
  `message-part.tsx`'s switch is replaced by typed dispatch via a
  `part-registry.ts` (mirroring `tool-registry.ts` from plan 002 B0.5).
- R2. `ag-ui-messages-reducer.ts` is deleted, OR reduced to <100 LOC of
  documented terragon-specific transformations the SDK doesn't perform.
- R3. `thread-view-model/reducer.ts` is split into ≤2 focused reducers
  OR replaced by direct `useAuiState` selectors.
- R4. `assistant-ui/` bridge directory contains only files that have a
  documented reason to wrap the library — defensible per AGENTS.md
  invariants. Target: ≤2 files (down from 7).
- R5. `chat-ui.tsx` has its React Query plumbing extracted into a
  `<ThreadProvider/>` component. Target: chat-ui.tsx ≤400 LOC.
- R6. After completion, `cloc apps/www/src/components/chat` shows total
  reduction of ≥3,000 source LOC vs. baseline measured at plan 003 start.
- R7. No user-visible behavior change. All existing chat tests pass.

## Success Criteria

- `rg "switch \\(.*Part.*\\)" apps/www/src/components/chat` returns empty
  (catches both the part switch and any leftover variants).
- `ag-ui-messages-reducer.ts` is deleted, or contains a top-of-file comment
  listing exactly which terragon-specific transformations remain and why.
- `thread-view-model/` directory has ≤2 source files (excluding tests).
- `assistant-ui/` directory has ≤2 source files (excluding tests).
- `chat-ui.tsx` is ≤400 LOC.
- `pnpm tsc-check` passes with no new `any`.
- Bundle size delta ≤0 KB vs. plan 003 baseline.

## Scope Boundaries

**In scope:**
- `message-part.tsx` switch elimination
- Reducer collapse (custom + thread-view-model)
- Bridge component cleanup
- `chat-ui.tsx` extraction

**Out of scope:**
- Anything plan 001 or plan 002 owns
- TipTap promptbox (justified divergence forever)
- streamdown markdown renderer (justified divergence per plan 002 D)
- Per-part renderers (text-part, diff-part, plan-part, etc.) — these stay,
  only their dispatcher changes
- Git diff sub-components (8 files) — separate question; defer
- `secondary-panel-*` files — sidecar UI, separate concern
- `meta-chips/` — separate concern, possibly first-class terragon UX

## Hard Dependencies

This plan **cannot start** until:

- ✅ Plan 002 Phase A (hardening + version pin)
- ✅ Plan 002 Phase B0.5 (`tool-registry.ts` exists; pattern proven)
- ✅ Plan 002 Phase B (tool-part switch deleted; the cascade pattern works)

This plan's Phases H, I, J **cannot start** until:

- ✅ Plan 001 Unit 5 (assistant-ui runtime owns the rendered transcript)

This plan's Phase G **can start** independently of plan 001 — it mirrors
plan 002 Phase B for parts instead of tools.

## Context & Research

### Codebase baseline (verified 2026-04-27)

```
message-part.tsx                              283 LOC
ag-ui-messages-reducer.ts                     850 LOC
thread-view-model/reducer.ts                 1,374 LOC
thread-view-model/types.ts                    197 LOC
thread-view-model/snapshot-adapter.ts         210 LOC
thread-view-model/ag-ui-adapter.ts            132 LOC
thread-view-model/optimistic-events.ts         35 LOC
thread-view-model/reducer.test.ts             935 LOC (test, retained)
assistant-ui/terragon-thread.tsx              406 LOC
assistant-ui/assistant-message.tsx             60 LOC
assistant-ui/user-message.tsx                  55 LOC
assistant-ui/system-message.tsx                43 LOC
assistant-ui/thread-context.tsx                65 LOC
assistant-ui/plan-occurrences.ts               38 LOC
assistant-ui/ctx-stability.ts                  36 LOC
chat-ui.tsx                                  1,065 LOC
```

### Open structural question

**Does assistant-ui have a `makeAssistantPartUI` analogue?**

The library has `makeAssistantToolUI` for tools. It does NOT (as of
v0.12.x) have an equivalent registration primitive for non-tool parts.
Parts compose differently — typically through `MessagePrimitive.Content`
which iterates parts and renders them via `components` prop or render
function children.

**This means Phase G's migration shape differs from plan 002 Phase B's.**

Two viable approaches for Phase G:

- **Approach G-1: Composition via `MessagePrimitive.Content`.** The library
  iterates message.parts and renders each via a custom component table.
  We pass our component map. The switch becomes a typed map lookup.
- **Approach G-2: Typed dispatch table** (no library involvement). Replace
  `switch (extendedPart.type)` with a `Record<PartType, ComponentType>`.
  Same anti-pattern eliminated, no library coupling added.

Phase G's pilot must answer which approach fits.

## Phased Delivery

### Phase G — Part renderer registry (3-4 days; **independent of plan 001**)

**Goal:** Eliminate `message-part.tsx`'s switch via a typed registry.

- **G0.5. Type the parts.** Define `apps/www/src/components/chat/parts/part-registry.ts`:

  ```ts
  // Sketch — exact shape decided during implementation.
  export type PartRegistry = {
    text: { component: ComponentType<TextPartProps> };
    thinking: { component: ComponentType<ThinkingPartProps> };
    image: { component: ComponentType<ImagePartProps> };
    audio: { component: ComponentType<AudioPartProps> };
    plan: { component: ComponentType<PlanPartProps> };
    diff: { component: ComponentType<DiffPartProps> };
    terminal: { component: ComponentType<TerminalPartProps> };
    "resource-link": { component: ComponentType<ResourceLinkProps> };
    "auto-approval-review": { component: ComponentType<AutoApprovalProps> };
    "rich-text": { component: ComponentType<RichTextProps> };
    "text-file": { component: ComponentType<TextFileProps> };
    pdf: { component: ComponentType<PdfProps> };
  };

  export type PartType = keyof PartRegistry;
  export const PART_REGISTRY: PartRegistry = { ... };
  ```

- **G1. Pilot the migration shape.** Pick `plan-part` (smallest, ~85 LOC).
  Try Approach G-1 first (`MessagePrimitive.Content` composition). If the
  library can't pass terragon-specific props (e.g. thread context for plan
  occurrences), fall back to Approach G-2 (typed dispatch table).
- **G2. Hard kill switch (mirroring plan 002 B2).** If 3+ part types
  require terragon sibling-state reads to render, **STOP** the cascade and
  keep `message-part.tsx` as the dispatcher (renamed to make the typed
  dispatch explicit, but preserved). Document the failure mode.
- **G3. Cascade** to remaining part types. Each migration:
  - Update `PART_REGISTRY` entry
  - Verify per-part component still receives needed props
  - Add to acceptance test (registry keys === union variants)
- **G4. Intermediate gate.** Test asserting
  `Object.keys(PART_REGISTRY) === DBAgentMessagePart["type"] union`. Catches
  silent drops during cascade.
- **G5. Delete the switch.** `message-part.tsx` becomes either:
  - A thin lookup function (`PART_REGISTRY[part.type].component`), ~30 LOC
  - Deleted entirely if `MessagePrimitive.Content` does the lookup
- **G6. AGENTS.md update.** Add invariant: "Part renderers are registered
  in `part-registry.ts`. Do not add part switches keyed on type."

**Acceptance:**
- `rg "switch \\(.*Part.*\\)" apps/www/src/components/chat` returns empty
- `part-registry.ts` exists with all variants typed
- `pnpm tsc-check` passes
- Per-part smoke test: render a fixture with each part type; visual parity
- Pilot kill-switch was respected: ≤2 part types needed sibling-state reads,
  OR Phase G fell back to Approach G-2

**Risk:** if `DBAgentMessagePart` adds new variants in plan 001 Unit 4
(ActivityMessage migration), the registry needs an entry. Coordinate via
PR labels.

---

### Phase H — Reducer collapse (4-6 days; **depends on plan 001 Unit 5**)

**Goal:** Delete or shrink `ag-ui-messages-reducer.ts` (850 LOC) once
assistant-ui's runtime owns the transcript.

**Prerequisite verification (before starting):**
- Plan 001 Unit 5 has landed
- `useThreadViewModel` is no longer the rendering source
- `useAuiState((s) => s.thread.messages)` is the rendering source
- `defaultApplyEvents` (SDK-internal) handles standard event folding

- **H1. Audit the reducer.** Categorize each event handler:
  - **A: SDK does this.** Standard event handler; the SDK's
    `defaultApplyEvents` covers it.
  - **B: Terragon-specific transformation.** ActivityMessage projection,
    progressChunks tracking, lifecycle synthesis — must survive.
  - **C: Dead code.** Handlers that no longer fire post-Unit 5.
- **H2. Delete category A handlers.** Trust the SDK.
- **H3. Delete category C handlers.** With justification per handler.
- **H4. Move category B to a thin "terragon projection" module.** Target:
  `apps/www/src/components/chat/parts/terragon-projection.ts`, ≤100 LOC.
  Subscribes to the SDK's event stream via `AgentSubscriber` callbacks
  (NOT a parallel reducer); transforms to UIPartExtended only where the
  library shape doesn't carry the data.
- **H5. Delete `ag-ui-messages-reducer.ts`.** Or shrink to <100 LOC with
  documented reason.
- **H6. Update `useThreadViewModel`** to either:
  - Read directly from `useAuiState` for messages and from the new
    terragon-projection module for terragon-specific fields, OR
  - Become a thin selector hook that combines library state + terragon
    sidecars without folding events itself.

**Acceptance:**
- `ag-ui-messages-reducer.ts` deleted OR ≤100 LOC with top-of-file comment
  listing remaining transformations.
- `terragon-projection.ts` exists, ≤100 LOC, uses `AgentSubscriber`.
- No duplicate event-folding logic between SDK and terragon code.
- `pnpm tsc-check` passes.
- All existing reducer tests pass against the new structure (or are
  rewritten as tests against `terragon-projection`).

**Risk — biggest in this plan:** the SDK's `defaultApplyEvents` may not
cover everything we currently fold. H1's audit must be thorough or H5
deletes load-bearing logic. **Mitigation:** characterize current reducer
behavior with a comprehensive replay test suite before any deletion. Use
an existing replay fixture if one exists; otherwise create one.

---

### Phase I — Bridge directory cleanup (2-3 days; **depends on Unit 5 + Phase H**)

**Goal:** Reduce `assistant-ui/` from 7 source files to ≤2.

After Unit 5 + Phase H, the wrappers should be redundant:

| File | Plan |
|---|---|
| `terragon-thread.tsx` (406 LOC) | Thin to <100 LOC. The custom thread component justified during transition (per plan 002) is no longer justified post-Unit 5. Replace with library `<Thread/>` + minimal terragon shell. |
| `assistant-message.tsx` (60 LOC) | Delete. Compose via `MessagePrimitive` directly in the new thread shell. |
| `user-message.tsx` (55 LOC) | Delete. Same. |
| `system-message.tsx` (43 LOC) | Delete or move to a `lifecycle-message.tsx` if terragon-specific. |
| `thread-context.tsx` (65 LOC) | **Keep.** Terragon-specific thread metadata not modeled by library. |
| `plan-occurrences.ts` (38 LOC) | Decide: integrate into `terragon-projection.ts` or keep as utility module. |
| `ctx-stability.ts` (36 LOC) | Decide: post-Unit 5, do we still need stable refs? Library may handle memoization differently when it owns transcript. **Audit first.** |

- **I1. Audit `ctx-stability` necessity.** With `useAuiState`-based reads,
  the per-row memoization may already be handled by the library. Run the
  `memo-rerenders.test.tsx` suite without `useStableRef` to find out.
- **I2. Replace per-role wrappers** with `MessagePrimitive` composition
  inside the new thinned `terragon-thread.tsx`.
- **I3. Move `plan-occurrences` and (if needed) `ctx-stability` into
  the `parts/` directory or into `terragon-projection.ts`.**
- **I4. Verify** `assistant-ui/` ends with ≤2 files: `terragon-thread.tsx`
  and `thread-context.tsx`.

**Acceptance:**
- `assistant-ui/` contains ≤2 source files (excluding tests).
- `terragon-thread.tsx` ≤100 LOC.
- `memo-rerenders.test.tsx` passes (no rendering perf regression).
- `pnpm tsc-check` passes.

**Risk:** removing `ctx-stability` could regress streaming render
performance. Mitigation: run the memo test before and after; revert if
regression observed.

---

### Phase J — `chat-ui.tsx` extraction (2 days; **independent of plan 001**)

**Goal:** Reduce `chat-ui.tsx` from 1,065 LOC to ≤400 LOC by extracting
React Query plumbing.

**Prior audit finding:** ~70% of `chat-ui.tsx` is React Query collection
setup (threadChat, threadInfo, threadShell), not chat UI logic.

- **J1. Identify boundaries.** What's "chat UI" vs. "thread bootstrap"?
  Roughly:
  - **Bootstrap:** collection queries, snapshot loading, loading/error
    states, redirect-on-not-found, auth guards
  - **Chat UI:** the rendered transcript + composer + toolbar
- **J2. Extract `<ThreadProvider/>`.** New file:
  `apps/www/src/components/chat/thread-provider.tsx`. Owns the React Query
  plumbing. Provides thread data via context to children.
- **J3. Slim `chat-ui.tsx`.** Becomes a consumer of `<ThreadProvider/>`
  context — pure presentation. Target ≤400 LOC.
- **J4. Update consumers.** Any file that renders `<ChatUI/>` now wraps
  it in `<ThreadProvider threadId={...}>`.

**Acceptance:**
- `chat-ui.tsx` ≤400 LOC.
- `thread-provider.tsx` exists.
- All `chat-ui.tsx` callers wrap with `<ThreadProvider/>`.
- No behavior change (manual smoke test + automated tests).
- `pnpm tsc-check` passes.

**Risk:** React Query cache invalidation patterns may not survive a clean
context boundary. Mitigation: extract incrementally — first the queries,
then the loading state, then the error state. Each step is a separate PR.

---

## System-Wide Impact

- **Component graph:** every chat layer file is touched. `message-part.tsx`,
  `chat-ui.tsx`, `assistant-ui/*`, `thread-view-model/*`,
  `ag-ui-messages-reducer.ts` are all in scope.
- **Tests:** `memo-rerenders.test.tsx` is the load-bearing test for
  Phase I. `reducer.test.ts` (935 LOC) needs rewriting against the new
  terragon-projection structure in Phase H.
- **Build:** No new dependencies. Bundle should net-decrease.
- **Behavior:** No user-visible change. Performance characteristics may
  shift slightly (different memoization strategy) — measure.

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Phase H's audit (H1) misses category-B handlers; deletion loses behavior | Build a comprehensive replay fixture suite before any reducer deletion; test each event family end-to-end |
| Phase G's library composition can't carry terragon props | Approach G-2 (typed dispatch table) is the documented fallback; both eliminate the switch |
| Phase I removes `ctx-stability` and streaming regresses | Run memo test before/after; revert if regression |
| Plan 001 Unit 5 doesn't fully land before H/I/J start | Hard prerequisite check at start of each phase; cannot bypass |
| Phase J extraction breaks React Query cache topology | Incremental extraction (queries → loading → error), each in its own PR |
| The cumulative reduction (~4,800 LOC) is a tempting "big bang" PR | Ship each phase as its own PR; no PR may land both Phase H and Phase I |
| Plan 003 starts but plan 001 Unit 5 stalls indefinitely | Phase G + Phase J can ship independently and provide ~30% of the reduction |

## Documentation / Operational Notes

- Update AGENTS.md per Phase G6 with the part-registry invariant.
- After all phases, refresh the chat-layer architecture summary in AGENTS.md
  to reflect the post-cleanup state.
- No new operational tooling required.

## Acceptance Gates (rollup)

A PR can claim "this plan is done" when ALL hold:

- [ ] Phase G: `rg "switch \\(.*Part.*\\)" apps/www/src/components/chat`
      returns empty
- [ ] Phase G: `part-registry.ts` exists with typed entries for every
      `DBAgentMessagePart` variant
- [ ] Phase G: pilot kill-switch was respected (≤2 part types needed
      sibling-state, OR fell back to Approach G-2)
- [ ] Phase H: `ag-ui-messages-reducer.ts` deleted OR ≤100 LOC
- [ ] Phase H: `terragon-projection.ts` exists with documented terragon-only
      transformations
- [ ] Phase I: `assistant-ui/` directory has ≤2 source files
- [ ] Phase I: `terragon-thread.tsx` ≤100 LOC
- [ ] Phase J: `chat-ui.tsx` ≤400 LOC
- [ ] Phase J: `<ThreadProvider/>` exists and is the only owner of thread
      bootstrap React Query
- [ ] **Cumulative LOC reduction** in `apps/www/src/components/chat`
      (excluding tests) is ≥3,000 LOC vs. plan 003 start baseline
- [ ] **Bundle size delta** ≤0 KB vs. plan 003 start
- [ ] `pnpm tsc-check` passes; no new `any`
- [ ] All existing chat tests pass; new tests cover Phase G's registry
      equality and Phase H's terragon-projection
- [ ] No user-visible behavior change (manual smoke test:
      streaming text, every part type renders, all tool types render,
      copy, redo, fork, scroll-to-bottom, error states)

## Open Questions

- **Q1.** Does `assistant-ui` v0.12.x's `MessagePrimitive.Content` accept
  custom component overrides per part type? (Phase G-1 viability gate.)
  Verify by reading the local `.d.ts` extracted in plan 002 deepening.
- **Q2.** Does `defaultApplyEvents` cover ActivityMessage events that plan
  001 Unit 4 introduces? (Phase H category-A audit gate.) Test with a
  fixture before deleting any current handler.
- **Q3.** After Unit 5, does `useAuiState` re-rendering granularity match
  what `ctx-stability` provides today? (Phase I-1 gate.)
- **Q4.** Should `plan-occurrences.ts` and `ctx-stability.ts` move into
  `parts/` (alongside `part-registry.ts`) or `terragon-projection.ts`?
  Phase I-3 decision.

## Sources & References

- Companion plan 001: `docs/plans/2026-04-27-001-refactor-ag-ui-native-runtime-plan.md`
- Companion plan 002: `docs/plans/2026-04-27-002-refactor-ag-ui-assistant-ui-primitives-convergence-plan.md`
- assistant-ui MessagePrimitive: `https://www.assistant-ui.com/docs/api-reference/primitives/Message`
- `@ag-ui/client` AbstractAgent + defaultApplyEvents:
  `https://github.com/ag-ui-protocol/ag-ui/tree/main/sdks/typescript/packages/client/src`
- Internal research from sub-agent audits, captured in conversation
  transcript 2026-04-27.
