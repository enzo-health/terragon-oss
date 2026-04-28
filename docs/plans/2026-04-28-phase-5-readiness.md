# Phase 5 Readiness — assistant-ui Runtime Owns Transcript

**Status**: NOT READY for execution. Document captures current state, gaps, and sequencing for a deliberate Phase 5 session.

**Cross-references**: This doc audits the prerequisites for Phase 5 of [`2026-04-27-refactor-chat-layer-consolidated-plan.md`](./2026-04-27-refactor-chat-layer-consolidated-plan.md). Phase 5's stated budget is 3–4 days and its acceptance criteria are non-trivial. This audit is the input that lets a future session execute against those criteria deliberately.

## Why this doc exists

A "make all messages and tool calls use assistant-ui primitives" sweep was attempted on 2026-04-28. After auditing the rendering pipeline, the smallest meaningful primitive adoption (`MessagePrimitive.Root` per message, `ActionBarPrimitive.Root` for the toolbar) was found to depend on Phase 5 being substantively done. Attempting Phase 5 in a single session would land in a half-state.

This doc is the alternative deliverable: a thorough current-state audit so the next session can execute Phase 5 deliberately with the right test infrastructure in place.

## Current state — what actually exists

### Runtime layer (assistant-ui side)

| File                                                            | State                               | Notes                                                                                                                                     |
| --------------------------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/www/src/components/chat/assistant-runtime.ts`             | ✅ Wired                            | Uses `useAgUiRuntime` from `@assistant-ui/react-ag-ui`. Receives `historyMessages` prop and seeds via `createAgUiHistoryAdapter`.         |
| `apps/www/src/components/chat/ag-ui-history-adapter.ts`         | ⚠️ Half-implemented                 | `load()` correctly projects `AgUiMessage[]` → `ThreadMessage[]`. **`append` is a no-op** (line 308). User submissions bypass the runtime. |
| `apps/www/src/components/chat/use-ag-ui-messages.ts`            | Unknown — needs audit               | Not read in this audit.                                                                                                                   |
| `apps/www/src/components/chat/assistant-ui/terragon-thread.tsx` | ✅ Wraps `AssistantRuntimeProvider` | Custom rendering inside (`messages.map()`), not `ThreadPrimitive.Messages`.                                                               |

### Rendering layer (Terragon side)

| File                                                              | State                | Notes                                                                                                                                                               |
| ----------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/www/src/components/chat/assistant-ui/assistant-message.tsx` | Custom               | Uses `ChatMessage` + `MessageToolbar`, no `MessagePrimitive`. Receives `message: UIMessage` as prop.                                                                |
| `apps/www/src/components/chat/assistant-ui/user-message.tsx`      | Custom               | Same pattern.                                                                                                                                                       |
| `apps/www/src/components/chat/assistant-ui/system-message.tsx`    | Custom               | Same pattern.                                                                                                                                                       |
| `apps/www/src/components/chat/chat-message.tsx`                   | PART_REGISTRY-driven | Already typed dispatch via Phase 4 Approach B.                                                                                                                      |
| `apps/www/src/components/chat/tool-part.tsx`                      | TOOL_DISPATCH-driven | Phase 3a done. **Phase 3b cancelled by kill switch** (4 tools need sibling state).                                                                                  |
| `apps/www/src/components/chat/chat-message-toolbar.tsx`           | Custom (168 LOC)     | Comment line 15: "Manual composition (no ActionBarPrimitive.Root) until per-message MessagePrimitive context lands." Punted by previous author for the same reason. |

### Data flow (current)

```
HttpAgent (AG-UI transport)
  ├─→ historyMessages prop ───→ createAgUiHistoryAdapter ───→ useAgUiRuntime ──→ runtime.thread.messages
  │                                                                              ↓ (unused for rendering)
  └─→ AG-UI events ──→ useAgUiMessages ──→ useThreadViewModel ──→ TerragonThreadContext ──→ messages.map()
                                                                                    ↓
                                                                          TerragonAssistantMessage
                                                                                    ├─→ ChatMessage (PART_REGISTRY)
                                                                                    └─→ MessageToolbar (custom buttons)
```

**Key observation**: the runtime has the messages but the rendering pipeline reads from a parallel `useThreadViewModel`. Two sources of truth, both fed by the same upstream events.

## Phase 5 acceptance criteria (from consolidated plan)

| Criterion                                                           | Current state                                  | Gap                                                             |
| ------------------------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------- |
| Active task page does not call `toUIMessages` for runtime rendering | ❌ Active page reads from `useThreadViewModel` | Switch reads to `useAuiState(s => s.thread.messages)`           |
| Token streaming flows through assistant-ui runtime state            | ❌ Currently flows through Terragon reducer    | Plumb AG-UI text deltas to runtime, not the parallel reducer    |
| `RUN_ERROR` surfaces error message in task UI                       | ⚠️ Unknown — needs verification                | Audit current error rendering path                              |
| `memo-rerenders.test.tsx` passes (no rendering perf regression)     | ⚠️ Test exists, status unknown                 | Run test before/after each change                               |
| Optimistic submits show pending state and roll back on failure      | ❌ Currently via `followUp` server action      | Convert to AG-UI user message events with stable IDs + rollback |

## What's actually blocking Phase 5

### Block 1: Terragon `UIMessage` shape is richer than runtime `ThreadMessage`

The runtime's `ThreadMessage` (from `@assistant-ui/react`) carries text/tool-call/image/file parts. Terragon's `UIMessage` (from `@terragon/shared`) carries additional variants:

- `rich-text` (TipTap nodes)
- `image` with metadata
- `delegation`, `plan`, `diff`, `terminal`, `auto-approval-review` (durable activity parts)
- Lifecycle messages (auto-compact, oauth-retry — synthesized server-side)

**Implication**: switching the rendering source to `useAuiState(s => s.thread.messages)` loses everything outside the standard ThreadMessage shape. Phase 5's solution per the plan is `ActivityMessage` projection and a thin `terragon-projection.ts` (≤100 LOC) — but this is Phase 6 work that's _implicitly_ required for Phase 5 to land cleanly.

### Block 2: `messagesRef` pattern in tool-part.tsx

`tool-part.tsx` passes a `messagesRef: { current: UIMessage[] }` through `ToolRenderContext` to four sibling-state tools (Task, ExitPlanMode, PermissionRequest, SuggestFollowupTask). This pattern relies on `messages` being a stable React prop.

If the messages array becomes a runtime selector (`useAuiState(...)`), the ref pattern needs replacing with direct `useAuiState` reads inside each tool component. This is the exact "useAuiState read from inside tool components" anti-pattern that the Phase 3b kill switch was designed to prevent.

**Implication**: Phase 5 either (a) keeps the messagesRef pattern by exposing the same UIMessage[] from a Terragon projection layer, OR (b) refactors the four sibling-state tools to read directly from `useAuiState`. Path (a) is cleaner; path (b) couples those four tools tightly to assistant-ui internals.

### Block 3: `append` is a no-op in the history adapter

Line 308 of `ag-ui-history-adapter.ts`: `append: async () => {},`. This means the runtime never sees user submissions. They go through the `followUp` / `queueFollowUp` server actions and propagate via the AG-UI event stream which then re-feeds the history adapter on next reload.

**Implication**: Phase 5's "convert optimistic user submissions to AG-UI user message events" requires implementing the `append` function to emit a user message event into the runtime. This needs:

- Stable client-message ID generation
- Server reconciliation to use the same ID
- Duplicate suppression on replay
- Rollback on failed submit

This is non-trivial and needs an end-to-end test fixture.

### Block 4: No replay-fixture test suite

Phase 6 in the consolidated plan mandates a "comprehensive replay-fixture suite" _before_ deleting any reducer code. Phase 5 implicitly relies on this same suite to verify it doesn't regress streaming, tool calls, or activity rendering. The suite doesn't exist yet.

`apps/www/test/integration/ag-ui-replayer.test.ts` exists but its coverage of the streaming + tool + activity matrix needs verification.

## Sequenced execution plan for Phase 5

The work breaks into five sub-phases. Each has its own acceptance criteria and can be checkpointed.

### 5.0 — Replay-fixture suite (1 day; prerequisite)

Build the replay-fixture suite that Phase 5 will use as a regression gate. Each fixture is a recorded AG-UI event sequence that asserts the rendered transcript matches an expected snapshot.

**Coverage**:

- User message → assistant text streaming → completion
- User message → tool call → tool progress chunks → tool result → completion
- User message → ActivityMessage (plan/diff/terminal) → completion
- Run error mid-stream
- SSE reconnect mid-stream
- Lifecycle message synthesis (auto-compact, oauth-retry)

**Files to create**:

- `apps/www/test/integration/fixtures/streaming.test.ts`
- `apps/www/test/integration/fixtures/tool-call.test.ts`
- `apps/www/test/integration/fixtures/activity.test.ts`
- `apps/www/test/integration/fixtures/run-error.test.ts`
- `apps/www/test/integration/fixtures/sse-reconnect.test.ts`

**Acceptance**: all fixtures pass against current implementation. If any fail, the corresponding Phase 5 sub-phase blocks until the gap is understood.

### 5.1 — Implement `append` in the history adapter (1 day)

Convert `append: async () => {}` (line 308) to emit AG-UI user message events into the runtime.

**Approach**:

- Generate stable client-side message IDs (`ulid()` or similar)
- Emit `MESSAGES_SNAPSHOT` or appropriate event family for user message submission
- Server reconciliation: when the same submission echoes back, dedup by ID
- Rollback: on submit failure, emit a removal event

**Acceptance**:

- Optimistic user message appears in `useAuiState(s => s.thread.messages)`
- Submission failure removes the optimistic entry
- Re-replay after refresh doesn't duplicate the message

### 5.2 — Wire token streaming through runtime state (0.5 days)

Currently AG-UI text deltas flow to the Terragon reducer. Switch to runtime state.

**Acceptance**:

- A streaming response renders progressively from `useAuiState`
- `memo-rerenders.test.tsx` passes (no row-level re-render regression)
- Streaming latency unchanged within 10%

### 5.3 — Switch rendering source from `useThreadViewModel` to runtime (0.5 days)

Refactor `terragon-thread.tsx` to read messages from `useAuiState(s => s.thread.messages)` instead of `useThreadViewModel`. Keep `useThreadViewModel` for non-transcript metadata only.

**Constraint**: this requires the Terragon projection layer (Phase 6 work) to be at least skeletal, OR accept that lifecycle/activity messages render incorrectly until Phase 6 completes. The plan's stance is the latter — Phase 5 lands the transcript switch and Phase 6 cleans up the projection.

### 5.4 — RUN_ERROR surface (0.5 days)

Audit current error rendering path. Wire `RUN_ERROR` events from the runtime to a visible error pill or banner in the task UI.

**Acceptance**:

- Injecting a RUN_ERROR event in dev shows a visible error in the chat
- Error includes the `code` field per Phase 1's contract

### 5.5 — Memoization audit (0.5 days)

Run `memo-rerenders.test.tsx` after each sub-phase. If any sub-phase regresses row-level memoization, revert and add the missing `useStableRef` / `useMemo` boundary.

## Adoption sequence for the toolbar (Phase 3c)

Phase 3c is gated on Phase 5 because `ActionBarPrimitive.Root` needs `MessageRuntime` context, which requires `MessagePrimitive.Root`, which requires the runtime to own the messages.

Once Phase 5 lands, Phase 3c is a 1-day migration:

1. Wrap each message component in `MessagePrimitive.Root` (one-line change inside each).
2. Replace `chat-message-toolbar.tsx` with `ActionBarPrimitive.Root` composition.
3. Use `useActionBarCopy` for the markdown-aware copy logic (`partsToMd`).
4. Use `AuiIf` for visibility predicates (replaces `isFirstUserMessage`, `isLatestAgentMessage` props).
5. Custom items (redo, fork, share) stay as plain `<button>` children.
6. Target file size: ≤50 LOC.

**Do not attempt Phase 3c before Phase 5 lands.** The previous author already tried and explicitly punted (see chat-message-toolbar.tsx line 15).

## Risks

- **Rich-text parts are Terragon-specific.** Standard `MessagePrimitive.Content` doesn't know how to render TipTap nodes. The Terragon projection layer must handle rich-text → ThreadMessagePart conversion. If this conversion is lossy, message rendering regresses.
- **Lifecycle messages are server-synthesized.** The plan's "justified divergences" list includes auto-compact and oauth-retry — they're synthesized in `daemon-event/route.ts`. The runtime must learn to render them or Phase 5 leaves them broken. The plan's answer is `MESSAGES_SNAPSHOT` synthesis, but the implementation isn't yet specified.
- **`ag-ui-messages-reducer.ts` is 850 LOC.** Phase 6 audits it (Categories A/B/C) and reduces to ≤100 LOC. Phase 5 doesn't delete it but its existence means there are multiple event-folding code paths during the Phase 5 window. Tests must verify both paths produce equivalent output, otherwise Phase 6 deletion creates regressions.

## Recommended next session shape

A dedicated 1-day block for sub-phase 5.0 (the replay-fixture suite) is the right entry point. Once the test gate exists, sub-phases 5.1–5.5 can be executed against it deliberately.

Do not attempt Phase 5 in a session that's also doing other work. The memoization audit (5.5) is genuinely full-attention work — false positives in memo-rerenders.test.tsx are easy to dismiss as flaky and represent real regressions.

## Why this readiness doc was the right deliverable

The original ask was "make sure all tool calls and messages use assistant-ui primitives." The honest reading: this is Phase 5 work. The honest answer: Phase 5 is 3–4 days, has specific test gates that don't yet exist, and would land in a half-state if attempted in a single session.

This doc converts a 3–4 day blob into 5 sequenced sub-phases with concrete acceptance criteria, surfacing the gaps that block today's smallest possible primitive adoption (toolbar, MessagePrimitive). The next session that executes Phase 5 has a roadmap; the engineer doing it doesn't have to re-derive what the audit already established.
