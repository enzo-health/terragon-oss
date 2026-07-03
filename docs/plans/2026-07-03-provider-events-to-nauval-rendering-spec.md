# Provider events → rendered experience → nauval components

**Date:** 2026-07-03
**Status:** proposal for review
**Direction (from Tyler):** explore everything Codex app-server and ACP can send, work backwards to what must be rendered, and render ALL components with the nauval library (https://ai.nauv.al/) — not assistant-ui.
**Evidence:** three agent catalogs — Codex vocabulary validated against the official Rust protocol source (cloned at `~/code/reference/codex`, `codex-rs/app-server-protocol/src/protocol/common.rs` + `v2/item.rs` @ beca198b), the ACP surface validated against agentclientprotocol.com, and a 48-component nauval inventory with vendored-drift analysis.

## 1. Where we actually stand against the protocols

- **Codex v2 (app-server)**: Terragon consumes ~20 of ~70 server notifications and 1 of 9 server→client requests. The daemon straddles two surfaces — v1/exec JSONL (`@openai/codex-sdk` shape) and v2 app-server JSON-RPC — and several "handled" paths only exist on one of them.
- **ACP**: the core loop is well covered (message/thought chunks, tool_call/update, plan, permission requests). Unknown update kinds get flattened to plain text or dropped; `available_commands_update`, `current_mode_update`, `config_option_update`, and the `fs/*`+`terminal/*` client methods have no handlers; protocol-level `session/cancel` is never sent (cancel = connection teardown).
- **Confirmed bugs found by the sweep** (independent of the pivot — fix regardless):
  1. `deprecationNotice` dropped by method-name mismatch: v2 emits camelCase, Terragon matches `"deprecation/notice"` (`codex-app-server.ts:1399`).
  2. `turn/failed` handling is v1-only; on v2 a failed turn is an `error` notification whose `will_retry` is DROPPED — transient auto-retries render as hard failures.
  3. Item-level `error` → DBErrorPart only exists on the v1 surface.
  4. `file_change` kind (add/delete/update) flattened to `"modified"` (`codex.ts:1443`).

## 2. The rendering map (work backwards from every event)

Legend: ✅ rendered today · 🟡 rendered but degraded · ❌ dropped today, should render · ⬜ dropped today, correctly invisible.

### Conversation core

| Provider event                                            | Today     | Target UX                                                 | Nauval component                                                                                         |
| --------------------------------------------------------- | --------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Codex `agent_message`(+delta) / ACP `agent_message_chunk` | ✅        | streaming markdown bubble                                 | **Message**/MessageContent + streamdown (kept)                                                           |
| Codex `reasoning`(+deltas) / ACP `agent_thought_chunk`    | ✅        | collapsible live thinking; multi-step thinking gets steps | **Reasoning**; upgrade to **Chain Of Thought** when summary parts arrive as steps                        |
| user message (local)                                      | ✅        | outgoing bubble                                           | **Message** `type=outgoing`                                                                              |
| queued user message                                       | ✅ custom | chip above composer                                       | custom (compose Message + **Status**)                                                                    |
| run lifecycle (RUN_STARTED…terminal)                      | ✅ pills  | run container with status; footer states                  | **Agent Run** (running/completed/failed/stopped) + **Status** pill + **Loader** (shimmer while thinking) |

### Tools & execution

| Provider event                                                         | Today                           | Target UX                                                    | Nauval                                                                                          |
| ---------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Codex `command_execution`(+outputDelta) / ACP tool_call kind=execute   | ✅                              | terminal card, streamed stdout/stderr, exit badge            | **Tool** shell + custom terminal body (Console is app-log-semantics; keep terminal body custom) |
| Codex `file_change` / ACP diff content                                 | 🟡 kind flattened               | per-file add/delete/edit chips + unified diff                | **Diff** + `useDiff(patch)`; fix the kind flattening so File chips show add/remove/edit         |
| Codex `mcp_tool_call`(+progress) / ACP tool_call                       | ✅ (structured_content dropped) | tool card with live progress ("step N/M"), structured result | **Tool** (ToolArgument streams partial-json); surface `structured_content` in ToolBlock         |
| Codex `web_search`                                                     | ✅ text-flattened               | query chip → sources list                                    | **Source** cards (+ **Citation** inline) — replaces the flattened text list                     |
| Codex `todo_list`(v1) / `plan` item+`item/plan/delta`(v2) / ACP `plan` | 🟡 v2 plan ITEM + delta dropped | live checklist with pending/progress/completed               | **Todo** — and handle the v2 `plan` item + streaming delta                                      |
| Codex `collab_tool_call` / v2 `subAgentActivity` (dropped)             | 🟡                              | delegation card with per-agent status                        | **Task** (activity lines) inside a **Tool** card; add subAgentActivity                          |
| Codex `dynamicToolCall` item (dropped)                                 | ❌                              | generic tool card                                            | **Tool**                                                                                        |
| aggregated activity receipt                                            | ✅ custom                       | "Explored 4 files, ran 1 command" line                       | **Task**/**Action**                                                                             |

### Approvals & permissions

| Provider event                                                                   | Today                     | Target UX                                             | Nauval                                                                         |
| -------------------------------------------------------------------------------- | ------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------ |
| ACP `session/request_permission` (plan mode)                                     | ✅ custom prompt          | inline approval with options, morphs to decision      | **Confirmation** (pending/approved/rejected, danger tone, async accept/reject) |
| Codex `auto_approval_review`                                                     | ✅ chip (updates dropped) | risk chip pending→approved/denied with rationale      | **Confirmation** read-only state or **Status** + Callout                       |
| Codex v2 approval trio (`requestApproval` ×3, masked by policy today)            | ⬜→future                 | same Confirmation flow if policy ever changes         | **Confirmation**                                                               |
| v2 `item/tool/requestUserInput`, `mcpServer/elicitation/request` (hard-rejected) | ❌ protocol liability     | graceful decline responder now; input prompt UI later | **Confirmation**/composer affordance (later)                                   |

### Errors, recovery, status

| Provider event                                         | Today                       | Target UX                                           | Nauval                                             |
| ------------------------------------------------------ | --------------------------- | --------------------------------------------------- | -------------------------------------------------- |
| item-level errors / `codex-error`                      | ✅                          | inline error callout; typed errors get stack/frames | **Callout**; **Exception** for structured failures |
| v2 `error` with `will_retry:true`                      | ❌ rendered as hard failure | "retrying…" transient state, NOT an error card      | **Status** pending + **Loader**; fix the drop      |
| typed recoverable terminals (rate-limit/oauth/context) | ✅ queued state             | "waiting in queue" with reset countdown             | **Status** + **Callout** info tone                 |
| `thread/compacted` / `contextCompaction` item          | ❌ invisible                | "context compacted" divider chip in transcript      | **Callout** subtle / custom divider                |
| `guardianWarning`, `model/verification`, moderation    | ❌                          | warning chip                                        | **Callout** warning                                |
| `deprecationNotice`, `configWarning`, `warning`        | 🟡 (deprecation lost)       | meta chips                                          | **Callout**/chip; fix the method mismatch          |

### Meta channel (chips)

| Event                                       | Today                 | Target UX                                         | Nauval                                                    |
| ------------------------------------------- | --------------------- | ------------------------------------------------- | --------------------------------------------------------- |
| `thread/tokenUsage/updated`                 | ✅ chip               | context-window meter with animated numbers        | **Usage Meter**                                           |
| `account/rateLimits/updated`                | ✅ chip               | rate-limit meter                                  | **Usage Meter**/**Status**                                |
| `model/rerouted`, `mcpServer/startupStatus` | ✅ chips              | status pills                                      | **Status** (custom chip shell stays)                      |
| ACP `available_commands_update`             | ❌                    | agent-advertised slash commands in composer popup | composer integration (custom; **Suggestion** for display) |
| ACP `current_mode_update`                   | ❌                    | mode indicator sync                               | **Status**                                                |
| Codex `thread/realtime/*`, voice            | ⬜ (product decision) | —                                                 | (Player/Transcript exist if ever wanted)                  |

### Structural (not per-event)

| Need                                                                | Nauval                                                                                       |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| scroll container + stick-to-bottom + scroll button                  | **Conversation** (+useConversation) — replaces ThreadPrimitive viewport + custom scroll hook |
| message actions (copy/retry)                                        | Message action slot + **Action**/**Feedback Bar**                                            |
| attachments/images (`imageView`/`imageGeneration`, ACP image/audio) | **Attachment**, **Generated Image**, **Player** (audio)                                      |
| citations/resource links                                            | **Source**, **Citation**                                                                     |
| composer                                                            | TipTap stays (invariant); nauval Composer NOT adopted                                        |
| markdown                                                            | streamdown stays (parseIncompleteMarkdown); nauval Markdown NOT adopted                      |

## 3. The architecture change: drop assistant-ui

Today: HttpAgent (SSE) → patched `@assistant-ui/react-ag-ui` fork (RunAggregator + AgUiThreadRuntimeCore) → `@assistant-ui/react` primitives → native-thread leaves → nauval visuals. The fork is the stack's biggest upgrade liability, `verifyEvents` throw-strings are pinned by tests to survive upgrades, and the runtime's message store duplicates state we already manage (view-model reducer, TanStack collections).

Target: **canonical AG-UI stream → our own transcript store → nauval components.** No assistant-ui anywhere.

```
HttpAgent (kept: transport + custom seq-cursor replay + 16ms coalescing)
   ▼ AgentSubscriber (typed per-event callbacks, already partially used)
TranscriptStore  — ONE client fold: AG-UI events → TranscriptItem[] view-models
   • absorbs: RunAggregator role, view-model reducer transcript concerns,
     optimistic overlay (kept as the only write layer), replay dedupe by (runId,eventId)
   • hydration: ?history=messages feeds the SAME fold (no separate adapter seam)
   ▼ plain React (memoized per-item selectors, bit-packed hot paths kept)
Conversation → AgentRun → Message/Tool/Reasoning/Todo/Diff/Confirmation/… (nauval)
```

What this deletes: `@assistant-ui/react` (0.12.24), the patched `react-ag-ui` fork + its patch file and README, the ThreadHistoryAdapter seam, `externalMessagesStrategy`/`historyLoadKey`/`waitForInitialLoad`/`targetMessageId` (fold owns these concerns natively), the `verifyEvents` throw-string suppression tests, ComposerPrimitive aspirations. What this keeps: HttpAgent + seq-cursor replay (library has no resume), delta coalescing, optimistic overlay + status machine, TipTap, streamdown, meta-chips, the run-lifecycle/resume policy (feeds the store instead of the runtime).

Honest costs: the fold re-implements RunAggregator's text/tool assembly (bounded, spec'd by the AG-UI event vocabulary we now enforce at write time); every leaf currently reading `useAuiState` migrates to store selectors; the integration harness assertions move from runtime state to store state; ~2-3 weeks of focused work with the harness as the gate.

## 4. Sequencing

```
P0  Protocol bug fixes (independent, ship now): deprecationNotice mismatch, v2 error
    will_retry → transient-retry state, file_change kind preservation, v2 plan item +
    item/plan/delta, thread/compacted → canonical event + divider chip, guardianWarning
    → warning chip, graceful responders (decline, don't -32601-stall) for the five
    unknown server requests. Daemon + mapper + small client additions.
P1  Vendor the needed nauval set (Confirmation, Diff, Todo, Task, Status, Usage Meter,
    Exception, Conversation, Chain Of Thought, Loader, Source, Citation, Attachment,
    Agent Run, Action) at one pinned SHA; extend VENDOR.md; resolve the LICENSE
    open item BEFORE vendoring; re-diff the 4 existing vendored files against HEAD.
P2  TranscriptStore: build the fold beside the runtime (shadow mode — both consume the
    same HttpAgent; assert store output ≡ runtime message state across the harness).
P3  Leaf migration behind a flag: Conversation + nauval leaves read the store; per-leaf
    parity against the shadow assertions; the feel work (delayed flags, caret, fades)
    ports over.
P4  Delete assistant-ui + the fork + the patch; unpin the two libraries from package.json;
    update AGENTS.md invariants (transcript = TranscriptStore + nauval; the "do not
    reintroduce dispatch tables" rule survives — the store folds events, leaves stay
    prop-driven).
P5  New-surface rendering from §2: web_search → Source cards, plan deltas → live Todo,
    compaction divider, will_retry transient, subAgentActivity in Task, permission
    Confirmation everywhere, Usage Meter chips.
```

## 5. Open items

- **Nauval LICENSE unconfirmed** — check `github.com/nauvalazhar/ai` LICENSE before P1 vendoring; VENDOR.md provenance table is the attribution mechanism.
- Terminal card body stays custom (Console has app-log semantics, not shell); Diff is unified-only (no split view) — acceptable.
- ACP cancel: adopt protocol `session/cancel` alongside connection teardown when the emulator/stop work lands (daemon change, small).
- The AGENTS.md invariant "assistant-ui runtime owns the rendered transcript" is superseded by this direction on Tyler's instruction; the consolidated-plan phase numbering freezes (Phases 5-8 of the 04-27 plan are overtaken).
