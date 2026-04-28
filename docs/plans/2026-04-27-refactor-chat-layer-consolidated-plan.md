---
title: "refactor: Chat layer convergence on AG-UI + assistant-ui (consolidated)"
type: refactor
status: draft
date: 2026-04-27
supersedes:
  - docs/plans/2026-04-27-001-refactor-ag-ui-native-runtime-plan.md
  - docs/plans/2026-04-27-002-refactor-ag-ui-assistant-ui-primitives-convergence-plan.md
  - docs/plans/2026-04-27-003-refactor-eliminate-chat-layer-legacy-plan.md
---

# refactor: Chat layer convergence on AG-UI + assistant-ui

## Overview

This plan replaces the chat-layer split-brain (DBMessage transcript writes,
custom reducers, hand-rolled toolbar/dispatch, parallel bridge components)
with a single architecture: AG-UI events as the source of truth, the
`@ag-ui/client` SDK + `@assistant-ui/react` runtime for state, and library
primitives where they fit. Justified divergences (TipTap composer,
streamdown markdown, lifecycle queue) are documented as permanent.

This is a single consolidated plan. Three predecessor plans (001, 002, 003)
exist on disk for history; this document is authoritative.

**Estimated total effort:** 5-7 weeks, 9 phases, sequenced by dependency.
Phase 0 is shippable today; phases 6-8 require earlier phases to land.

## Problem Frame

The chat layer has three structural duplications:

1. **Split-brain transcript storage.** `agent_event_log` stores AG-UI
   events. `thread_chat.messages` stores `DBMessage[]`. Both are written
   on every daemon event; readers diverge.
2. **Custom rendering layer duplicates library primitives.**
   `tool-part.tsx` switches on tool name; `message-part.tsx` switches on
   part type; `chat-message-toolbar.tsx` hand-rolls hover/copy. The
   library has `makeAssistantToolUI`, `MessagePrimitive`, and
   `ActionBarPrimitive` for these.
3. **Three reducers folding the same event stream.**
   `ag-ui-messages-reducer.ts` (850 LOC), `thread-view-model/reducer.ts`
   (1374 LOC), and `@ag-ui/client`'s `defaultApplyEvents` all process the
   same AG-UI event stream into different shapes.

After this plan, the architecture is: AG-UI events flow into the SDK's
`AbstractAgent.messages` state; `@assistant-ui/react`'s runtime owns the
rendered transcript; terragon-specific concerns (rich activity payloads,
lifecycle queue, prompt composer) live in narrow, documented modules.

## Goals & Non-Goals

**Goals:**
- AG-UI events are the canonical persisted form of the runtime transcript.
- Tool UIs registered via `makeAssistantToolUI` with typed `Args`/`Result`
  generics from a central `tool-registry.ts`.
- Message-level actions composed via `ActionBarPrimitive` + `AuiIf`.
- Part rendering dispatched via a typed `part-registry.ts`, not a switch.
- Custom reducers collapsed to ≤100 LOC of documented terragon transformations.
- `assistant-ui/` bridge directory reduced from 7 source files to ≤2.
- `chat-ui.tsx` reduced from 1,065 LOC to ≤400 via `<ThreadProvider/>`
  extraction.
- `AGENTS.md` codifies the resulting invariants in one canonical section.

**Non-goals:**
- TipTap promptbox migration to `ComposerPrimitive`. The library is plain-text
  only; our slash commands, mentions, drafts, transcription, and queue have
  no equivalent. Stays custom forever.
- streamdown markdown migration to `@assistant-ui/react-markdown`. The
  library lacks `parseIncompleteMarkdown` and would regress streaming UX.
  Stays custom.
- `ActionBarPrimitive.Reload` adoption. It calls `runtime.reload()`,
  incompatible with our DB-source model. Use a custom button calling
  existing server actions.
- Branching, edit, regenerate UX. Defer until users ask.
- Historical `thread_chat.messages` data migration. Active tasks may show
  empty/degraded transcripts after cutover; old data is not backfilled.
- TipTap rich-text replacement; `meta-chips/`, `secondary-panel-*`,
  `git-diff-*`, lifecycle recovery flows in `daemon-event/route.ts` —
  separate concerns.

## Justified Divergences

These stay custom forever. Future contributors should not propose migrating
them; the table is in AGENTS.md after Phase 8.

| Surface | Library equivalent | Why custom |
|---|---|---|
| `promptbox/use-promptbox.tsx` (~913 LOC) | `ComposerPrimitive` | TipTap with slash commands, mentions, drafts, transcription, multi-message queue. ComposerPrimitive is plain text only. |
| `streamdown` markdown renderer (~491 LOC) | `@assistant-ui/react-markdown` | streamdown's `parseIncompleteMarkdown` has no equivalent — migration would regress streaming UX. `useSmoothText` requires runtime adoption beyond this plan. |
| Lifecycle messages (auto-compact / oauth-retry) | `MESSAGES_SNAPSHOT` synthesis | Server-side recovery flows in `daemon-event/route.ts` need durable persistence + queued Continue. |
| Server-action `followUp` / `queueFollowUp` | `runtime.append` / `ActionBar.Reload` | DB-source-of-truth model; runtime stays read-side. Custom button replaces Reload primitive. |

## Hard Architecture Decisions

These decisions are load-bearing. Re-litigating any of them invalidates the plan.

- **AG-UI event log is the transcript source of truth.** `agent_event_log`
  is the durable transcript; `thread_chat.messages` stops receiving new
  runtime transcript writes (kept nullable for one deploy boundary, dropped
  later).
- **Use native AG-UI event families before `CUSTOM`.** Text, tools,
  lifecycle, reasoning, state, messages, activity all have native events.
  `CUSTOM` is reserved for terragon-specific widgets with no native shape.
- **REASONING_***, not THINKING_*. THINKING_* is deprecated, scheduled
  for removal in AG-UI 1.0.
- **`ActivityMessage` for durable rich parts.** Plan, diff, terminal,
  audio, resource-link, auto-approval-review use
  `ACTIVITY_SNAPSHOT`/`ACTIVITY_DELTA`, not `terragon.part.*` CUSTOM events.
  ActivityMessage is the spec-canonical primitive for "durable custom
  events as message objects."
- **Assistant-ui runtime owns the rendered transcript.** Terragon
  components adapt and render runtime messages, not maintain a parallel
  reducer.
- **The SDK's `AbstractAgent.messages` is the authoritative message list.**
  Custom code projects from it (for ActivityMessage rendering, lifecycle
  messages); it does not re-fold events.
- **Pin AG-UI versions exact.** `@ag-ui/client`, `@assistant-ui/react`,
  `@assistant-ui/react-ag-ui` are all pre-1.0 (0.0.x or 0.12.x). Three
  backcompat shims in 13 versions of `@ag-ui/client` confirm churn.
- **No silent drops.** Unknown provider events become AG-UI `RAW` or typed
  `CUSTOM` quarantine, not `[]`. Failed validation becomes diagnostic
  events, not omissions.

## Dependency Graph

```
Phase 0 (Hardening) ──────────────────────────────► (independent)
Phase 1 (Event contract + render viability) ──┬──► Phase 2 (Switch writes)
                                              └──► Phase 3 (Library primitives)
Phase 3 ──► Phase 4 (Part registry, depends on Phase 3 patterns)
Phase 1 ──► Phase 5 (Runtime owns transcript)
Phases 2 + 5 ──► Phase 6 (Reducer + bridge cleanup)
Phase 0 ──► Phase 7 (chat-ui extraction; can run in parallel with anything)
Phase 6 ──► Phase 8 (reliability tests + AGENTS.md final)
```

**Parallelizable today:** Phase 0 + Phase 1 prep + Phase 7. After Phase 1
lands, Phases 2 and 3 can ship in parallel. Phase 4 depends on Phase 3's
registry pattern. Phase 5 depends on Phase 1. Phase 6 is the bottleneck.

## Phased Delivery

### Phase 0 — Hardening (1 day; independent)

Three concrete items, all reviewer-approved.

- **0.1.** Memoize `useTerragonRuntime` props in `terragon-thread.tsx:162`.
  Explicit deps `[agent, threadId, showThinking, onCancel]` (verify against
  hook signature). `useMemo` returning a config object; `useCallback` for
  `onCancel` separately.
- **0.2.** Wrap `<TerragonThread/>` in an error boundary. Class component
  or `react-error-boundary`, fallback reuses existing `ChatError`.
- **0.3.** Run `pnpm install`, then pin `@assistant-ui/react` and
  `@assistant-ui/react-ag-ui` to exact versions in `apps/www/package.json`
  (no `^`). Order matters: install first to observe what resolves with
  current `@ag-ui/client@0.0.52` peer, then pin.

**Acceptance:**
- No `^` in those two dependencies.
- `pnpm tsc-check` passes.
- Manual error injection in dev shows the boundary catches and offers retry.
- `node_modules/@assistant-ui/react` exists.

### Phase 1 — Native AG-UI event contract & render viability (4-5 days)

**Goal:** Define the typed AG-UI event contract end-to-end and prove
assistant-ui can render the rendered transcript from native AG-UI events
(not from `DBMessage[]` hydration). This is the gate for everything else.

**Files:**
- `packages/agent/src/ag-ui-mapper.ts` — modify
- `packages/shared/src/model/agent-event-log.ts` — modify
- `apps/www/src/server-lib/ag-ui-publisher.ts` — modify
- `apps/www/src/app/api/ag-ui/[threadId]/route.ts` — modify
- `apps/www/src/components/chat/assistant-runtime.ts` — modify
- `apps/www/src/components/chat/use-ag-ui-messages.ts` — modify
- `apps/www/test/integration/ag-ui-replayer.test.ts` — modify
- `apps/www/test/integration/ag-ui-replayer.ts` — modify

**Approach:**

- **1.1. Event contract:** `BaseEvent` payloads stay spec-valid. Publisher
  attaches durable identity (`eventId`, `seq`, `runId`, `threadId`,
  `threadChatId`, SSE `id:`) via a Terragon transport envelope, not by
  stuffing arbitrary fields into AG-UI events. Mapper output preserves
  `timestamp` and source/idempotency hints.
- **1.2. Quarantine path:** unknown provider events map to `RAW` or typed
  `CUSTOM` quarantine, redacted and size-limited. No silent drops.
- **1.3. Replay/live-tail:** `/api/ag-ui/[threadId]` supports cursor
  reconnect via `fromSeq` and SSE `Last-Event-ID`. SSE frames carry durable
  `id:`. Validation rejects malformed events with a diagnostic, not
  silent skip. All replay queries are scoped through authenticated
  thread ownership.
- **1.4. Render viability spike:** vertical fixture with real AG-UI events
  rendering one user message, assistant text streaming, tool call/result,
  tool progress, activity update, reconnect, completion, run error.
  Rendering must work without `DBMessage[]` hydration.

**Acceptance:**
- Vertical fixture passes: text streaming, tool call+progress, activity,
  reconnect, terminal success, RUN_ERROR, all without DBMessage hydration.
- Replay route validation rejects malformed events with a diagnostic.
- Cross-user `threadChatId` and foreign cursor return no events.
- `pnpm tsc-check` passes.

**Decision gate:** if assistant-ui native rendering can't be proven, define
a thin AG-UI-native Terragon adapter as the fallback. Either way, no
`DBMessage[]` hydration is in the active task render path going forward.

### Phase 2 — Switch transcript writes to AG-UI events (3-4 days)

**Goal:** Stop appending runtime transcript to `thread_chat.messages`;
daemon ingest writes native AG-UI rows to `agent_event_log`.

**Depends on:** Phase 1.

**Files:**
- `apps/www/src/server-lib/handle-daemon-event.ts` — modify
- `apps/www/src/app/api/daemon-event/route.ts` — modify
- `packages/daemon/src/daemon.ts` — modify
- `packages/daemon/src/codex.ts` — modify

**Approach:**
- Provider output normalizes into AG-UI events before persistence; do not
  convert to `DBMessage[]` for storage.
- Delta buffer becomes AG-UI streaming: `TEXT_MESSAGE_CONTENT`,
  `REASONING_MESSAGE_CONTENT`, `TOOL_CALL_ARGS`, `TOOL_CALL_CHUNK`.
- Lifecycle: `RUN_STARTED`, `RUN_FINISHED`, `RUN_ERROR`, `STEP_*`, meta
  events (token usage, model reroute, MCP status, boot progress, permission
  signals) persist durably, not fire-and-forget.
- Migrate `THINKING_*` references to `REASONING_*`.
- Token streaming cadence preserved; transport shape changes, not latency.
- `thread_chat.messages` column kept nullable for one deploy boundary
  (rollback safety); column drop is a follow-up.

**Acceptance:**
- New runs produce transcript rows only in `agent_event_log`.
- `thread_chat.messages` is no longer modified by daemon ingest.
- Token streaming benchmark unchanged within 10% latency.
- Codex text/tool/progress streams persist as AG-UI rows; `RUN_ERROR`
  persists with code.
- Replay reconstructs transcript without DBMessage data.

### Phase 3 — Tool registry + ActionBar primitives (5-6 days)

Two parallel adoptions: typed tool registration and library-composed toolbar.

#### 3a. Tool registry types (1 day; blocks 3b)

**Goal:** Type the per-tool args/result so `makeAssistantToolUI<Args, Result>`
generics are real, not `<any, any>`.

- Create `apps/www/src/components/chat/tools/tool-registry.ts`:
  ```ts
  export type ToolRegistry = {
    Bash: { args: BashArgs; result: BashResult };
    // one entry per tool the daemon emits
  };
  export type ToolName = keyof ToolRegistry;
  export type ToolArgs<T extends ToolName> = ToolRegistry[T]["args"];
  export type ToolResult<T extends ToolName> = ToolRegistry[T]["result"];
  ```
- Source per-tool types from existing daemon tool definitions or zod
  schemas (pick one approach; document choice).
- Test asserts `keyof ToolRegistry` matches runtime tool name set.

**Decision gate:** if args/result types are genuinely unrecoverable
(arbitrary JSON, no schema), accept `<unknown, unknown>` and runtime-validate
inside each component. Record decision explicitly.

#### 3b. Tool UI registration (2-3 days)

**Goal:** Replace `tool-part.tsx`'s switch with `makeAssistantToolUI`
registrations.

**Depends on:** 3a.

- **Pilot end-to-end** with the simplest tool with progress chunks
  (`BashTool`):
  ```tsx
  makeAssistantToolUI<ToolArgs<"Bash">, ToolResult<"Bash">>({
    toolName: "Bash",
    render: BashTool
  })
  ```
- **Hard kill switch:** if `progressChunks`/`mcpMetadata`/`toolStatus`
  cannot be expressed via the library's `status` union AND requires
  reading sibling state via `useAuiState` to render anything interesting:
  - 1-2 tools needing sibling state: acceptable, document.
  - **3+ tools: STOP**. Cancel 3b; the switch is more honest than
    `<any, any>`-style registrations with sibling-state reads.
- Cascade to remaining tools.
- **Intermediate gate** before deleting the switch: test that
  `Object.keys(ToolRegistry)` equals the switch's case set.
- Delete or shrink `tool-part.tsx`. Barrel re-export remaining non-dispatch
  parts to avoid breaking import sites.

#### 3c. ActionBar / toolbar (1 day)

**Goal:** Replace `chat-message-toolbar.tsx` (~241 LOC) with
`ActionBarPrimitive` composition.

- Use `ActionBarPrimitive.Root` with `autohide="not-last"` and
  `hideWhenRunning` (replaces manual `opacity-0 group-hover:opacity-100`).
- Use `ActionBarPrimitive.Copy` for plain-text. For markdown-aware copy
  (current `getTextContent` builds image syntax), use `useActionBarCopy`
  from `@assistant-ui/core/react` with custom `copyToClipboard` callback.
  **Closure caveat:** `useCallback` with explicit `[parts]` deps — free
  function captures stale parts during streaming.
- Visibility predicates use `AuiIf`, NOT deprecated `MessagePrimitive.If`.
- Custom items (redo, fork, share) are plain `<button>` children of `Root`.
- **DO NOT use `ActionBarPrimitive.Reload`.** Custom button opens
  `RedoTaskDialog`; disable via `useAuiState((s) => s.thread.isRunning)`.
- Target: file ≤50 LOC or deleted.

**Acceptance for Phase 3 overall:**
- `tool-registry.ts` exists with typed entries for all daemon-emitted tools.
- `rg "switch \\(toolPart\\.name\\)" apps/www/src` returns empty.
- Every tool has one `makeAssistantToolUI<ToolArgs<T>, ToolResult<T>>` call;
  no `<any, any>` (or explicitly accepted `<unknown, unknown>`).
- Pilot kill-switch respected (≤2 tools needed sibling state, OR cancelled).
- `chat-message-toolbar.tsx` ≤50 LOC or deleted.
- No `MessagePrimitive.If` usage; redo/retry uses custom button.
- `pnpm tsc-check` passes.

### Phase 4 — Part renderer registry (3-4 days)

**Goal:** Eliminate `message-part.tsx`'s `switch (extendedPart.type)` via
a typed registry. Same anti-pattern as Phase 3b but for non-tool parts.

**Depends on:** Phase 3 (pattern established).

**Open structural question (resolve in pilot):** assistant-ui v0.12.x has
no `makeAssistantPartUI` analogue. Two viable approaches:

- **Approach A — `MessagePrimitive.Content` composition** with a custom
  component table.
- **Approach B — Typed dispatch table** (no library coupling). Replace
  switch with `Record<PartType, ComponentType>`.

Phase 4's pilot determines which fits.

**Files:**
- Create: `apps/www/src/components/chat/parts/part-registry.ts`
- Modify: `apps/www/src/components/chat/message-part.tsx`

**Approach:**
- Define `PartRegistry` typed map covering all `DBAgentMessagePart`
  variants: text, thinking, image, audio, plan, diff, terminal,
  resource-link, auto-approval-review, rich-text, text-file, pdf.
- Pilot the migration shape on `plan-part` (smallest, ~85 LOC). Try
  Approach A first; fall back to B if library can't carry terragon props.
- **Same hard kill switch as Phase 3b:** if 3+ part types need sibling-state
  reads, fall back to Approach B and accept the typed dispatch table as
  the destination shape.
- **Intermediate gate:** test that `Object.keys(PART_REGISTRY)` equals the
  `DBAgentMessagePart["type"]` union.
- Delete the switch in `message-part.tsx`. File becomes either ~30 LOC of
  registry lookup or deleted entirely if `MessagePrimitive.Content` does
  the lookup.

**Acceptance:**
- `rg "switch \\(.*Part.*\\)" apps/www/src/components/chat` returns empty.
- `part-registry.ts` exists with all variants typed.
- Pilot kill-switch respected.
- Per-part smoke test renders a fixture for each variant; visual parity.
- `pnpm tsc-check` passes.

### Phase 5 — Assistant-ui runtime owns the transcript (3-4 days)

**Goal:** Stop reading from `useThreadViewModel` for active rendering.
Runtime/library state is the rendered source.

**Depends on:** Phase 1.

**Files:**
- `apps/www/src/components/chat/assistant-runtime.ts`
- `apps/www/src/components/chat/assistant-ui/terragon-thread.tsx`
- `apps/www/src/components/chat/chat-ui.tsx`
- `apps/www/src/components/chat/use-ag-ui-messages.ts`
- `apps/www/src/components/chat/thread-view-model/types.ts`
- `apps/www/src/components/chat/thread-view-model/reducer.ts`

**Approach:**
- Wire assistant-ui history/runtime loading to AG-UI replay stream, not
  pre-computed `UIMessage[]` from `DBMessage[]`.
- Replace the stub history adapter with a real loader that emits
  `MESSAGES_SNAPSHOT` from the event log.
- Convert optimistic user submissions to AG-UI user message events
  (stable client/server message IDs, duplicate suppression after replay,
  rollback on failed submit), not optimistic `DBUserMessage` entries.
- Keep a small Terragon view model only for non-transcript metadata
  (thread status, permissions, GitHub summary, artifacts, side panel,
  optimistic input).
- Memoization: preserve row-level rendering isolation. Use
  `memo-rerenders.test.tsx` as the regression gate.

**Acceptance:**
- Active task page does not call `toUIMessages` or hydrate from
  `thread_chat.messages` for active runtime rendering.
- Token streaming flows through assistant-ui runtime state.
- `RUN_ERROR` surfaces error message in task UI.
- `memo-rerenders.test.tsx` passes (no rendering perf regression).
- Optimistic submits show pending state and roll back on failure.

### Phase 6 — Reducer collapse + legacy deletion (5-7 days)

**Goal:** Delete legacy DB-message adapters. Audit and shrink
`ag-ui-messages-reducer.ts` to ≤100 LOC. Reduce `assistant-ui/` bridge.

**Depends on:** Phases 2 and 5.

**Files to delete:**
- `apps/www/src/components/chat/toUIMessages.ts` (~391 LOC)
- `apps/www/src/components/chat/db-messages-to-ag-ui.ts` (~198 LOC)
- `apps/www/src/components/chat/thread-view-model/legacy-db-message-adapter.ts`
  (if exists)

**Files to audit/modify:**
- `apps/www/src/components/chat/ag-ui-messages-reducer.ts` (850 LOC) — audit
- `apps/www/src/components/chat/thread-view-model/reducer.ts` (1374 LOC) —
  split or replace
- `apps/www/src/components/chat/assistant-ui/*` (7 source files) — reduce
- `apps/www/src/collections/patch-helpers.ts` — modify
- `apps/www/src/queries/thread-patch-cache.ts` — modify

**Approach:**

**6.1. Reducer audit (high risk; mandatory replay-fixture suite first).**
Categorize each event handler in `ag-ui-messages-reducer.ts`:
- **Category A:** SDK does this (`defaultApplyEvents` in `@ag-ui/client`).
  Standard event handler. Trust the SDK.
- **Category B:** Terragon-specific transformation (ActivityMessage projection,
  `progressChunks` tracking, lifecycle synthesis). Must survive.
- **Category C:** Dead code. Handlers no longer firing post-Phase 5.

**Build comprehensive replay-fixture tests before deleting anything.**
Each event family round-trips: A persists → B replays → C renders. Run
the suite before and after each handler removal.

**6.2. Move Category B to a thin module.**
`apps/www/src/components/chat/parts/terragon-projection.ts`, ≤100 LOC.
Subscribes via `AgentSubscriber` callbacks (NOT a parallel reducer);
transforms AG-UI events to terragon-specific UIPart fields only where
the library shape doesn't carry the data.

**6.3. Delete `ag-ui-messages-reducer.ts`** or shrink to <100 LOC with
a top-of-file comment listing remaining transformations.

**6.4. Update `useThreadViewModel`** to either read from `useAuiState` +
terragon-projection, or become a thin selector hook.

**6.5. `assistant-ui/` directory cleanup.**
- `terragon-thread.tsx` (406 LOC): thin to <100 LOC. Replace internal
  message map with `MessagePrimitive` composition.
- `assistant-message.tsx`, `user-message.tsx`, `system-message.tsx`:
  delete; compose via `MessagePrimitive` directly.
- `thread-context.tsx`: keep (terragon thread metadata).
- `plan-occurrences.ts`: integrate into `terragon-projection.ts` or keep
  as utility.
- `ctx-stability.ts`: **audit first** — with `useAuiState` reads, the
  per-row memoization may already be handled. Run `memo-rerenders.test.tsx`
  without `useStableRef` to verify. Revert if regression.

**6.6. Patch helper cleanup.**
- Remove transcript fields from broadcast patch types and handlers; keep
  metadata patching only where sidebar/list freshness still needs it.
- `thread_chat.messages` column kept nullable through this phase; drop in
  a follow-up after non-runtime consumers (admin views, follow-up context,
  PR automation summaries) are converted or accepted as out-of-scope.

**Acceptance:**
- Replay-fixture suite passes before any reducer/adapter deletion.
- `toUIMessages.ts` and `db-messages-to-ag-ui.ts` deleted.
- `ag-ui-messages-reducer.ts` deleted or ≤100 LOC.
- `terragon-projection.ts` exists, ≤100 LOC, uses `AgentSubscriber`.
- No duplicate event-folding logic between SDK and terragon code.
- `assistant-ui/` directory has ≤2 source files.
- `terragon-thread.tsx` ≤100 LOC.
- `memo-rerenders.test.tsx` passes (no streaming render regression).
- `pnpm tsc-check` passes; no new `any`.

### Phase 7 — chat-ui.tsx extraction (2 days; independent of Phase 1)

**Goal:** Reduce `chat-ui.tsx` from 1,065 LOC to ≤400 by extracting React
Query plumbing into `<ThreadProvider/>`.

**Files:**
- Create: `apps/www/src/components/chat/thread-provider.tsx`
- Modify: `apps/www/src/components/chat/chat-ui.tsx`

**Approach:**
- Identify boundary: bootstrap (collection queries, snapshot loading,
  loading/error states, redirect-on-not-found, auth guards) vs. chat UI
  (rendered transcript, composer, toolbar).
- Extract `<ThreadProvider/>` owning the React Query plumbing; provide
  thread data via context.
- Slim `chat-ui.tsx` to a presentation consumer.
- Update callers to wrap with `<ThreadProvider threadId={...}>`.

**Incremental extraction recommended:** queries → loading → error in
separate PRs. React Query cache topology may not survive a clean boundary
in one shot.

**Acceptance:**
- `chat-ui.tsx` ≤400 LOC.
- `thread-provider.tsx` exists.
- All `chat-ui.tsx` callers wrap with `<ThreadProvider/>`.
- No behavior change (manual smoke test + automated tests).

### Phase 8 — Reliability tests + AGENTS.md final (2 days)

**Goal:** Full integration coverage of the new path; canonical AGENTS.md
invariants.

**Files:**
- `apps/www/test/integration/ag-ui-replayer.test.ts` — expand
- `packages/daemon/src/streaming-benchmark.test.ts` — expand
- `apps/www/src/components/chat/assistant-ui/memo-rerenders.test.tsx` —
  preserve
- `AGENTS.md` — update

**Approach:**
- Integration fixtures cover actual publisher output, not hand-authored
  reducer events.
- Reconnect, duplicate, dropped-Redis-entry, malformed-event, and terminal
  fallback tests.
- Token streaming benchmark from daemon delta to browser consumption.
- Bounded quarantine retention/size expectations: invalid provider output
  cannot grow the append-only log without limits.

**AGENTS.md invariants section** (single canonical block):

```
## Chat Layer Architecture Invariants

- AG-UI events are the source of truth for the runtime transcript.
  agent_event_log is durable; thread_chat.messages is nullable/unused.
- The @ag-ui/client SDK's AbstractAgent.messages is the authoritative
  message list. Custom code projects from it, never re-folds events.
- assistant-ui runtime owns the rendered transcript. terragon code adapts;
  it does not maintain a parallel reducer.
- Tool UIs are registered via makeAssistantToolUI<ToolArgs<T>, ToolResult<T>>
  from tool-registry.ts. No tool name switches.
- Part renderers are registered via part-registry.ts. No part type switches.
- Message-level actions compose ActionBarPrimitive + AuiIf. No deprecated
  MessagePrimitive.If; no ActionBarPrimitive.Reload (DB-source incompat).
- Reasoning events are REASONING_*, never THINKING_*.
- Rich custom parts use ActivityMessage (ACTIVITY_SNAPSHOT/DELTA), not
  CUSTOM events. CUSTOM is for terragon-specific widgets only.
- @ag-ui/client and @assistant-ui/react-ag-ui pin to exact versions;
  both are pre-1.0 with documented churn.
- TipTap promptbox stays custom. ComposerPrimitive is not the target.
- streamdown markdown stays custom. @assistant-ui/react-markdown lacks
  parseIncompleteMarkdown.
- DB writes happen ONLY in apps/www/src/app/api/daemon-event/route.ts.
  The runtime's history.append is a no-op by contract.
```

**Acceptance:**
- Integration coverage proves replay/live-tail parity for text, reasoning,
  tools, activity, state, terminal, and error events.
- Token streaming latency budget held end-to-end.
- AGENTS.md contains the invariants section.
- All previous plans (001, 002, 003) referenced as superseded in
  `docs/plans/`; consider archiving.

## Acceptance Gates (rollup)

A PR (or PR train) can claim "this plan is done" when ALL hold:

- [ ] Phase 0: runtime memoized, error boundary tested, deps pinned exact
- [ ] Phase 1: vertical render fixture passes without DBMessage hydration;
      replay route validation rejects malformed events
- [ ] Phase 2: `agent_event_log` is sole transcript writer for new runs;
      `thread_chat.messages` nullable but not modified
- [ ] Phase 3: `tool-registry.ts` typed; switch deleted; ActionBarPrimitive
      composition replaces toolbar; no `MessagePrimitive.If`; no `Reload`
      primitive
- [ ] Phase 4: `part-registry.ts` typed; part switch deleted
- [ ] Phase 5: active rendering reads from runtime/library state, not
      `useThreadViewModel`
- [ ] Phase 6: replay-fixture suite passes before each deletion;
      `ag-ui-messages-reducer.ts` ≤100 LOC or deleted; `assistant-ui/`
      ≤2 files; `terragon-thread.tsx` ≤100 LOC
- [ ] Phase 7: `chat-ui.tsx` ≤400 LOC; `<ThreadProvider/>` extracted
- [ ] Phase 8: integration suite covers reconnect, duplicate, malformed,
      terminal fallback; token streaming benchmark in budget; AGENTS.md
      invariants section present
- [ ] **Cumulative source LOC reduction** in
      `apps/www/src/components/chat` ≥3,000 LOC vs. baseline
- [ ] **Bundle size delta** for `apps/www` ≤0 KB. Baseline:
      `pnpm -C apps/www build && du -sb .next | awk '{print $1}'`.
      Positive deltas justified in PR description.
- [ ] `pnpm tsc-check` passes; no new `any`
- [ ] `pnpm test` passes for `www`, `shared`, `daemon`, `sandbox`
- [ ] No user-visible behavior change (manual smoke: streaming text,
      every part type renders, tool calls with progress, copy, redo,
      fork, scroll-to-bottom, error states, reconnect mid-stream)
- [ ] Predecessor plans (001, 002, 003) marked superseded

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Phase 1 native rendering can't be proven | Fall back to thin AG-UI-native Terragon adapter (still no DBMessage hydration); blocks Phase 5 if fallback is the actual path |
| `makeAssistantToolUI` becomes type laundering (`<any, any>`) | Phase 3a `tool-registry.ts` is the typed source of truth; Phase 3b blocks until it lands |
| Tool registration cascade smuggles complexity into per-tool sibling-state reads | Hard kill switch in 3b: ≤2 tools may need `useAuiState` lifecycle reads; 3+ cancels Phase 3b |
| `ActionBar.Reload` incompatible with DB-source model | Use custom button calling `RedoTaskDialog`; documented in 3c and AGENTS.md |
| Phase 4 library composition can't carry terragon props | Approach B (typed dispatch table) is the documented fallback; both eliminate the switch |
| Phase 6 reducer audit misses Category B handlers; deletion loses behavior | **Replay-fixture suite as mandatory deletion gate.** Each event family round-trips before any handler removal. Build the suite first; delete only after it's green |
| Phase 6 removes `ctx-stability` and streaming render regresses | Run `memo-rerenders.test.tsx` before/after; revert if regression |
| Phase 7 React Query extraction breaks cache topology | Incremental extraction across separate PRs (queries → loading → error) |
| Pre-1.0 SDK churn breaks mid-migration | Add Renovate/Dependabot config (PRs without auto-merge) for `@ag-ui/client`, `@assistant-ui/react`, `@assistant-ui/react-ag-ui` |
| Optimistic events differ from server replay; duplicate text or missing rollback | Stable client/server message IDs; duplicate suppression after replay; explicit rollback on failed submit |
| Quarantine path grows unbounded | Bounded retention/size with observability; redact secrets, env values, OAuth/session material before persistence |
| Token streaming latency regresses | Benchmark gate in Phase 8; fail if >10% regression |
| `streamdown` markdown migration is re-proposed | Documented in AGENTS.md as permanent justified divergence |
| Migrating off `thread_chat.messages` breaks admin/debug consumers | Column kept nullable through Phase 6; drop in follow-up after admin/debug views are converted or accepted as out-of-scope |
| Multiple workstreams collide on the same file | PR labels per phase; coordinate via the dependency graph |

## Scope Boundaries (deferred)

These are out of scope; tracked separately if they ever come up:

- Branch / edit / regenerate UX (needs runtime→server-action bridge)
- Path-A pure event sourcing (replace `DBMessage` storage entirely with
  derived projection)
- TipTap composer migration to ComposerPrimitive (justified divergence)
- streamdown migration to react-markdown (justified divergence)
- Historical `thread_chat.messages` data backfill
- Admin/debug transcript views beyond AG-UI replay readers
- `meta-chips/`, `secondary-panel-*`, `git-diff-*` rewrites — separate
  concerns
- Lifecycle recovery flows in `daemon-event/route.ts` — kept as terragon
  server-side concerns

## Open Questions

- **Q1.** Does `MessagePrimitive.Content` accept custom component overrides
  per part type? (Phase 4 Approach A viability gate.) Verify by reading
  the local `.d.ts` for `@assistant-ui/react`.
- **Q2.** Does `defaultApplyEvents` cover ActivityMessage events? (Phase 6
  Category-A audit gate.) Test with a fixture before deleting any current
  handler.
- **Q3.** After Phase 5, does `useAuiState` re-rendering granularity match
  what `ctx-stability` provides today? (Phase 6.5 gate.)

## System-Wide Impact

- **Interaction graph:** daemon provider adapters, daemon-event ingest,
  `agent_event_log`, Redis live-tail, `/api/ag-ui`, assistant-ui runtime,
  task renderer, sidebar metadata collections, admin/debug surfaces,
  CLI/API consumers — all affected.
- **Build:** version pin changes only. No new dependencies.
- **Tests:** `memo-rerenders.test.tsx` and the replay-fixture suite are
  load-bearing.
- **Bundle size:** net-decrease expected; verified at each phase.
- **Behavior:** no user-visible change at any phase boundary.
- **Unchanged invariants:** thread ownership checks, sandbox lifecycle,
  GitHub metadata, permission mode metadata, run status metadata.

## Documentation / Operational Notes

- `AGENTS.md` invariants section per Phase 8 is the only architecture
  surface. Do NOT create `docs/architecture/chat-layer.md`.
- Renovate or Dependabot config for AG-UI dependencies opens PRs but
  does NOT auto-merge.
- Monitor: event insert rate, SSE reconnect counts, malformed-event
  quarantine counts, token delta latency.
- After this plan lands, the predecessor plans (001, 002, 003) are
  superseded — keep on disk for history but no longer authoritative.

---

## Appendix A — Native Event Mapping Matrix

(Preserved verbatim from plan 001 for reference during Phases 1-4.)

| Terragon surface | AG-UI home | Rendering owner | Fallback rule |
|---|---|---|---|
| Assistant/user text | `TEXT_MESSAGE_*` / AG-UI messages | assistant-ui runtime | Quarantine malformed message lifecycle |
| Reasoning | `REASONING_MESSAGE_*`, `REASONING_ENCRYPTED_VALUE` | assistant-ui runtime or visibility adapter | Hide encrypted/private content; never fold into assistant text |
| Tool args/result | `TOOL_CALL_START`, `TOOL_CALL_ARGS`, `TOOL_CALL_END`, `TOOL_CALL_RESULT` | assistant-ui runtime + Terragon tool renderer | Quarantine orphaned result unless parent resolvable |
| Tool stdout/progress | `TOOL_CALL_CHUNK` when tied to a tool call | Terragon tool renderer adapter | `ACTIVITY_*` only when no tool call owns the progress |
| Terminal session output | `ACTIVITY_*` unless direct tool-call progress | Terragon activity renderer | Size-limit chunks; preserve scroll/focus |
| Diff / file change | `ACTIVITY_*` for progress, typed `CUSTOM` for inspectable artifact | Terragon artifact/activity renderer | Keep artifact payload redacted and bounded |
| Plan / checklist | `STATE_*` for shared machine state, `ACTIVITY_*` for frontend-only progress | Terragon state/activity adapter | Snapshot before deltas on reconnect |
| Permission prompt | `STATE_*` for prompt state plus typed `CUSTOM` for terragon action metadata | Permission prompt renderer | Role-filter shared/read-only views |
| Artifact link | Typed `CUSTOM` | Artifact descriptor adapter | No raw file contents in event payload |
| MCP status / boot progress | `ACTIVITY_*` for visible progress, `STATE_*` for durable machine state | Meta/activity adapters | Redact internal config and credentials |

## Appendix B — Sources & References

- AG-UI introduction: https://docs.ag-ui.com/introduction
- AG-UI events: https://docs.ag-ui.com/concepts/events
- AG-UI messages: https://docs.ag-ui.com/concepts/messages
- AG-UI reasoning: https://docs.ag-ui.com/concepts/reasoning
- AG-UI state management: https://docs.ag-ui.com/concepts/state
- AG-UI serialization: https://docs.ag-ui.com/concepts/serialization
- AG-UI JS events: https://docs.ag-ui.com/sdk/js/core/events
- assistant-ui Tool UI: https://www.assistant-ui.com/docs/guides/tool-ui
- assistant-ui v0.12 migration: https://www.assistant-ui.com/docs/migrations/v0-12
- assistant-ui v0.14 migration: https://www.assistant-ui.com/docs/migrations/v0-14
- `@ag-ui/client` source:
  https://github.com/ag-ui-protocol/ag-ui/tree/main/sdks/typescript/packages/client
- Predecessor plans (superseded):
  - `docs/plans/2026-04-27-001-refactor-ag-ui-native-runtime-plan.md`
  - `docs/plans/2026-04-27-002-refactor-ag-ui-assistant-ui-primitives-convergence-plan.md`
  - `docs/plans/2026-04-27-003-refactor-eliminate-chat-layer-legacy-plan.md`
- Internal research from sub-agent audits (conversation transcript 2026-04-27):
  - assistant-ui ActionBar / MessagePrimitive API extraction
  - `@assistant-ui/react-markdown` capability gap analysis
  - `@ag-ui/client` SDK statefulness analysis
  - AG-UI protocol extensibility (Issue #26 on CustomMessages)
  - simplicity / DHH / Kieran review passes on plans 002 and 003
