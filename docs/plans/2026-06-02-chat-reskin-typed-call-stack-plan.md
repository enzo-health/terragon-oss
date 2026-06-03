# Plan: chat visual re-skin onto nauval + render-architecture simplification

Status: proposed · Date: 2026-06-02 · Owner: chat layer
Branch: `refactor/assistant-ui-custom-components` (WS-A Base UI + WS-B nauval vendoring + WS-C Codex streaming already committed; tsc 17/17).

## Goal

Render the live agent transcript through the vendored nauval components (`apps/www/src/components/ai/*`) **and** collapse the chat render architecture to its minimal reliable form: one message store, one render path, one adapter seam, the fewest layers between an AG-UI event and a pixel. Simplification is the primary objective; the visual swap is the second.

## Non-goals (do not touch)

Verified by `explore-write`. These are the transport/write/chrome spine — preserve exactly:

- **Write path:** `usePromptBox.submitForm` → `routeComposerSubmit` → `runtime.append` → `POST /api/ag-ui/[id]` → `handleAgUiPostCommand` → `followUp()`. Cancel: doc-level Esc (`use-promptbox.tsx:794-805`) → `handleStop` → `POST .../cancel` → `stopThreadInternal`.
- **Scroll engine:** `useScrollToBottom` (250ms grace, `forceScrollToBottom`) in `chat-ui.tsx`. No debounce/polling.
- **Lifecycle/system chrome:** `chat-message-system.tsx` (`SystemMessage`: retry/clear/stop/git-diff notices) and `git-diff-comment-widget.tsx` (submits via `followUp()`, not `runtime.append`).
- **Meta-chips** (`meta-chips/*`), **TipTap composer**, **streamdown** (`text-part.tsx` / `markdown-renderer.tsx`), the **AG-UI transport**, and the shared **`DBPart` DB/wire schema** (`packages/shared/src/db/db-message.ts`).
- **Do NOT** fold WS-C live tool-output streaming into this cosmetic re-skin — it is a separate runtime task (see "Deferred").
- Do not add functionality not listed here.

## Current state (verified)

```
LIVE transcript (the ONLY thing that renders agent messages):
  [io] AG-UI HttpAgent ──┐
                         ├─► [domain] useAgUiRuntime (@assistant-ui/react-ag-ui)  (assistant-runtime-session.tsx:118)
  ThreadHistoryAdapter ──┘        = the SINGLE live message store
   (assistant-history-hydration-adapter.ts, fed by server fetchAgUiHistoryMessages)
        ─► AssistantRuntimeProvider ─► ThreadPrimitive.Messages ─► MessagePrimitive.Parts
        ─► native-thread.tsx leaves: NativeText / NativeReasoning / NativeToolCall / NativeToolGroup
        ─► native-thread-utils.ts (pure view-prop fns) + text-part.tsx (streamdown)
```

- `native-thread.tsx`: `NativeText` (already a thin shell over `TextPart`), `NativeReasoning` (hand-rolled `<details>`, **does not use** the existing `reasoningViewProps`), `NativeToolCall`/`NativeToolGroup` (~120 lines of hand-rolled `<details>`/`<pre>`).
- nauval components are vendored at `components/ai/*` but **currently imported by nothing**.

### Verified dead code (this is the simplification surface)

- **Dead aggregator island, ~1,500 LOC** — only external importer is the test harness `apps/www/test/integration/streaming-harness/reducer-harness.ts`; the rest cross-import each other only (`grep` confirmed): `ag-ui-messages-reducer.ts` (397), `terragon-run-aggregator.ts` (492, **0 importers**) + `terragon-run-aggregator-helpers.ts` (121), `ag-ui-message-mutations.ts` (384), `ag-ui-reducer-utils.ts`, `ag-ui-part-validation.ts`, `ag-ui-snapshot-projection.ts`. This is pre-runtime-era code; the live runtime is the assistant-ui library store.
- **`runtimeState`/`runtimeActivities`** in `thread-view-model/reducer.ts` (via `thread-view-model-runtime-events.ts`, ~131 LOC): populated, never read.
- **Legacy dispatch (`PART_REGISTRY` + `TOOL_DISPATCH`), ~4,450 LOC** — `part-registry.ts`, `message-part.tsx`, `tool-part.tsx`, `chat-message.tsx`, `chat-message.utils.ts`, `tools/*`. Reachable at runtime through **exactly one** transcript-adjacent caller: the queued-user-message preview (`promptbox/queued-messages.tsx` → `ChatMessage` role:user), whose parts are a **closed 5-variant union** (`text | image | rich-text | pdf | text-file`) — plus `SystemMessage` (a separate inline `switch`, not the registry) and the secondary panel.

### WS-C streaming — where it actually renders (verified)

Streamed Codex tool-output **does** reach the live transcript — via `argsText`, not `progressChunks`. The **patched** `@assistant-ui/react-ag-ui` runtime (`run-aggregator.js:113-117, 229-233, 306`) routes BOTH `TOOL_CALL_ARGS` and `TOOL_CALL_CHUNK` to `appendToolArgs` → `entry.argsText += delta`, and emits `argsText` on the tool part. WS-C's `tool-output` deltas (mapped to `TOOL_CALL_CHUNK` in `ag-ui-mapper.ts`) are therefore concatenated into the running tool's `argsText`, which `NativeToolCall` already renders via `toolArgsDisplayText` while active. So it is **visible live** — but appended after the JSON args (the runtime even tries `JSON.parse(argsText)` at `:235`, which fails for raw stdout, leaving the concatenation).

The SEPARATE Terragon `appendToolProgressChunk` → `progressChunks` path (`ag-ui-messages-reducer`/`terragon-run-aggregator`) is **dead** — only `reducer-harness.ts` imports it — and is NOT the live mechanism. Delete it with the aggregator island. The WS-C integration test asserts that dead pipeline, so it must be re-pointed at the live runtime (`useAgUiRuntime`) / DOM.

NET: the re-skin's nauval `<ToolArgument value={stream.text} state="streaming">` (Slice 3) is the correct home for this live stream — **no new plumbing needed**. The only OPEN UX QUESTION (an enhancement, not a gap): stdout currently shares the args slot; optionally split `tool-output` into its own field server-side later for a cleaner console-style presentation.

## Target contracts (typed)

```ts
// native-thread-utils.ts — ONE streaming shape for every nauval leaf (from plan-stream)
export type StreamingView = {
  readonly text: string;
  readonly streaming: boolean;
};
export const streamingView = (
  text: string,
  status: { type: string },
): StreamingView => ({ text, streaming: status.type === "running" }); // text + reasoning
export const toolProgressView = (
  chunks: readonly { seq: number; text: string }[] | undefined,
  active: boolean,
): StreamingView => ({
  text: chunks?.map((c) => c.text).join("") ?? "",
  streaming: active,
});

// Tool lifecycle state is SEPARATE from the streaming pulse (do not merge them)
export type ToolCallState =
  | "pending"
  | "approval"
  | "running"
  | "success"
  | "error";
export const toolCallState = (
  active: boolean,
  failed: boolean,
): ToolCallState => (failed ? "error" : active ? "running" : "success");

// Per-leaf view-props (from plan-render) — pure, compose existing helpers, no runtime part in any nauval leaf
export type ToolViewProps = {
  name: string; // toolName
  preview: string | null; // toolArgPreview(argsText)            [existing]
  state: "pending" | "running" | "success" | "error"; // toolCallState(active, failed)
  stream: StreamingView; // { toolArgsDisplayText(argsText, active), streaming: active }
  resultText: string; // toolCallResultText(result)          [existing]
  errorText: string; // state==="error" ? (resultText || argsText) : ""
  defaultOpen: boolean; // active (collapse once done)
};
export type ToolGroupViewProps = {
  count: number;
  state: "running" | "error" | "success"; // from getToolGroupFlags/decodeToolGroupFlags (keep the bit-pack)
  statusLabel: string; // "Running" | "Needs attention" | "Completed"
  defaultOpen: boolean; // hasActive
};
// getToolGroupFlags STAYS inside useAuiState (reactive selector over sibling parts); decode→toolGroupViewProps after.

// Queued user preview — replaces the ChatMessage detour (from plan-dispatch)
type UserPart = Extract<
  UIUserMessage["parts"][number],
  { type: "text" | "image" | "rich-text" | "pdf" | "text-file" }
>;
// QueuedUserPart: switch(part.type) over UserPart, `const _: never = part` default.
```

Nauval slots consumed (real names from `components/ai/*`): `Reasoning`/`ReasoningTrigger`/`ReasoningContent`; `Tool`/`ToolTrigger`/`ToolName`/`ToolLabel`/`ToolIcon`/`ToolContent`/`ToolArgument`/`ToolBlock`/`ToolError`; `Message`/`MessageContent`/`MessageText`/`MessageAction`; `Callout`/`CalloutIcon`/`CalloutContent`.

## Target minimal boundary map (from plan-layers)

```
transport (HttpAgent) + history adapter
   ─► useAgUiRuntime (react-ag-ui)          ← the ONLY message store
   ─► AssistantRuntimeProvider
   ─► ThreadPrimitive.Messages / MessagePrimitive.Parts
   ─► thin nauval shells  ← native-thread-utils (pure props) ─► components/ai/*
writer (unchanged):  composer → runtime.append → POST /api/ag-ui → followUp ; cancel → stopThreadInternal
SIDE-CHANNEL (NOT the transcript): a SLIM thread-view-model owning ONLY
   lifecycleMessages · meta(chips) · githubSummary · artifact descriptors · queued/optimistic state
```

Boundaries: the runtime owns message state; the adapter owns all view-prop derivation (leaves never see a runtime part); nauval owns presentation only; the view-model is demoted to lifecycle/meta/artifact/optimistic side-channel.

## Current vs target call stacks

```
TEXT  current (6 hops): Messages → NativeAssistantMessage → MessagePrimitive.Parts → [dispatch type=text]
                        → NativeText → TextPart(streamdown) → DOM
TEXT  target:           … → NativeText → <MessageText variant="plain"><TextPart streaming={view.streaming}/> (Slice 6)

REASONING current (5):  … → NativeReasoning(<details> hand-rolled) → TextPart → DOM   (reasoningViewProps UNUSED)
REASONING target:       … → NativeReasoning → reasoningViewProps(text,status)
                        → <Reasoning><ReasoningTrigger/><ReasoningContent><TextPart streaming={view.streaming}/>

TOOL  current (8):      … → NativeToolCall({toolName,argsText,result,status,isError})
                        → toolArg*/toolCallResultText (adapter) → <details><pre/></details>    (NO progressChunks)
TOOL  target:           … → NativeToolCall → toolCallState()+arg/result adapters
                        → <Tool state><ToolTrigger><ToolName/><ToolLabel/></ToolTrigger><ToolContent>
                              <ToolArgument value=…/> · result <ToolBlock/> · error <ToolError/>
```

## Streaming + error stacks

```
TEXT/REASONING token stream:  AG-UI TEXT/REASONING delta → runtime part {text,status}
   → streamingView(text,status) → <TextPart streaming/>          (already live; pulse only)
TOOL-OUTPUT stream (LIVE via argsText):  AG-UI TOOL_CALL_CHUNK
   → patched run-aggregator appendToolArgs → entry.argsText += delta  (run-aggregator.js:113-117,233)
   → NativeToolCall argsText → toolViewProps.stream
   → <ToolArgument value={stream.text} state="streaming">           (Slice 3; no new plumbing)
ITEM ERROR:  DBErrorPart → PART_REGISTRY.error → InlineErrorCard → (Slice 5) <Callout tone="danger">
```

## Implementation steps (vertical slices)

Each slice touches only the named leaf + the adapter + its story; write/scroll/chrome/transport untouched; rollback = revert the leaf const (override-table keys unchanged so the build stays valid). Verify each with `pnpm tsc-check` + `native-thread.stories.test.tsx` + one integration-harness replay.

**Pre-flight (do first, cross-cutting).** Slices 1/3/4 replace `<details>` with Base UI `Collapsible` — there is no `<details>`/`.open` and the "Running/Failed/Done" labels become a `data-state` attr. Update `native-thread.stories.test.tsx` (asserts `querySelectorAll("details")`, `.open`, label textContent at L66-96) to assert `[data-slot=tool|reasoning]` + `data-state` + `data-open`. Resolve this convention once or every slice rediscovers it.

1. **NativeReasoning → `components/ai/reasoning.tsx`** (lowest-risk; `reasoningViewProps` already exists, just consume it). Files: `native-thread.tsx:39-46`, stories. Boundary: io leaf.
2. **NativeText → `<MessageText variant="plain">`** wrapping the unchanged streamdown `TextPart`. Recommend folding into Slice 6. Boundary: io leaf.
3. **NativeToolCall → `components/ai/tool.tsx`** (core re-skin). Map `active/failed → toolCallState`. Add `toolCallState()` to the adapter to keep the leaf pure. Files: `native-thread.tsx:99-173`, adapter, stories. Boundary: io leaf + adapter.
4. **NativeToolGroup → nauval grouped `Tool`** (after 3; keep `getToolGroupFlags`/`decodeToolGroupFlags`, the `count<=1` early-out). Files: `native-thread.tsx:48-94`.
5. **`InlineErrorCard` → `components/ai/callout.tsx`** (independent dispatch path — parallelizable any time). Files: `parts/part-registry.ts:186-195`, registry test. Boundary: io leaf (registry shape unchanged).
6. **Message bubbles → `components/ai/message.tsx`** (widest visual change; absorbs Slice 2). PRESERVE load-bearing classes: user `bg-card`/`shadow-warm-lift`; assistant `[content-visibility:auto]`/`contain-intrinsic-size` + enter animations; rename `group/native-msg` → `group/message` so copy/link survive. Files: `native-thread.tsx:200-293`.

### Simplification slices (the primary objective — sequence after the re-skin is harness-green)

7. **Delete the dead aggregator island (~1,500 LOC). — DEFERRED (2026-06-02, found during implementation).** The island is _production_-dead (0 `src/` importers, confirmed) but _test_-LIVE: `reducer-harness.ts` is not a lone leaf — it anchors a 5-file integration-replay test layer (`streaming-harness/stress.test.ts`, `reducer-harness.test.ts`, `streaming-reliability-simple.test.ts`, and `ag-ui-replayer.ts` → the ~500-line `ag-ui-replayer.test.ts` + `prompt-daemon-client-trace.test.tsx`). The reducer is the message-store stand-in for that replay harness. Deleting it requires first migrating those tests onto the live `useAgUiRuntime` store / rendered DOM — a real workstream, not a dead-code deletion. Schedule as its own slice; the dead code carries no runtime cost meanwhile.
8. **Delete `runtimeState`/`runtimeActivities`** from `thread-view-model/reducer.ts` + `thread-view-model-runtime-events.ts` (preserve the quarantine side-effect). ~131 LOC.
9. **Collapse the legacy dispatch (~4,450 LOC).** Add `promptbox/queued-user-parts.tsx` (~40-line `switch(part.type)` over the 5 user-part types reusing existing `TextPart`/`ImagePart`/`RichTextPart`/`PdfPart`/`TextFilePart`, `const _: never` default); rewrite `queued-messages.tsx` to use it; re-point `assistant-ui/system-message.tsx` directly at `SystemMessage`; then delete `part-registry.ts`, `message-part.tsx`, `tool-part.tsx`, `chat-message.tsx`, `chat-message.utils.ts`, `chat-message-collapsible-activity.tsx`, `chat-message-image-group.tsx`, `tools/*` renderers + `tool-registry.ts`. KEEP (live external consumers): `tools/utils.ts` (`ansiToHtml`), `tools/plan-utils.ts`, the `UIPartExtended` **type**. This contradicts the AGENTS.md framing of these tables as THE dispatch — update AGENTS.md to match reality (they were a non-transcript renderer).

   **PARTIAL (2026-06-02, implemented).** The PREP landed (commit `a41d0dd3`): `QueuedUserPart` created, `queued-messages.tsx` + `system-message.tsx` re-pointed off `ChatMessage` (both live `ChatMessage` callers now gone), and `DBErrorPart` confirmed rendering live via a new `NativeError` data-part (`ASSISTANT_PART_COMPONENTS.data.by_name["terragon.error"]`) → nauval `Callout`. The ~4,450-LOC **deletion is deferred** — an actual `git rm` + `tsc` proved the dispatch is entangled with ~25 non-named references the design under-traced: (a) live TYPES `MessagePartProps`/`ToolPartProps` (`chat-message.types.ts` → live `thread-context.tsx` → `terragon-thread-runtime-content.tsx:221`); (b) `toUIMessages.ts:15` → `tool-part-projection.ts` `projectDBToolCall` (live, artifact descriptors) — itself gated on the deferred slice 7 / `toUIMessages` reduction; (c) the integration harness `test/integration/chat-page.tsx` renders via the legacy `MessagePart` (used by every turn test); (d) ~16 stories + several live tests. **Prerequisite chain to finish:** relocate the dispatch TYPES to a standalone module → migrate the integration harness off `MessagePart` onto `native-thread` → resolve `toUIMessages`/`tool-part-projection` (needs slice 7) → then delete. Its own multi-step workstream, not a slice.

## Deferred / optional (NOT required for the re-skin)

- **Cleaner tool-output presentation (UX enhancement, not a gap).** Streamed stdout already renders live via `argsText` (see "WS-C streaming" above); the nauval `<ToolArgument>` streaming slot surfaces it in Slice 3. The only improvement left is _separating_ command stdout from the JSON args — split `tool-output` into its own field server-side (`ag-ui-mapper.ts`) so it can render in a dedicated console block instead of sharing the args slot. Do NOT route through nauval `Console` until that split exists (Console wants discrete entries; `argsText` is one blob).
- **Re-point the WS-C streaming test before deleting the island.** `codex-tool-output-streaming.test.ts` asserts the dead `reducer-harness`; rewrite it to assert against the live `useAgUiRuntime` store / rendered `ToolArgument` (Slice 7 gate).
- **Transport redundancy** (`explore-codex`): deltas persisted to `agent_event_log` then replayed. Out of scope.

## Tests / checks

```bash
pnpm tsc-check                                   # exhaustiveness asserts stay green
pnpm -C apps/www vitest run \
  src/components/chat/assistant-ui/native-thread.stories.test.tsx
pnpm -C apps/www vitest run test/integration     # claude-code-turn replay; re-point codex streaming test
# Ladle: render each re-skinned leaf in both :root and .dark
```

## Completion criteria

- [ ] Live transcript renders agent text/reasoning/tool/tool-group + queued-user parts via nauval components, driven solely by `native-thread-utils` adapter fns (no runtime-part shape in any nauval leaf).
- [ ] `StreamingView` + `toolCallState` contracts exist; `reasoningViewProps` consumed.
- [ ] Dead aggregator island + `runtimeState` deleted (verified 0 non-test importers); legacy dispatch collapsed to `QueuedUserPart`; `UIPartExtended` type + `ansiToHtml`/`plan-utils` preserved; exhaustiveness guards green.
- [ ] Write path, scroll, lifecycle/system chrome, meta-chips, git-diff widget, AG-UI transport unchanged.
- [ ] WS-C streamed tool-output confirmed rendering live via nauval `ToolArgument` (Slice 3); dead `progressChunks` reducer deleted and its test re-pointed at the live runtime.
- [ ] No functionality added beyond this plan.

```

```
