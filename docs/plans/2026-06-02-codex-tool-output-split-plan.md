# Plan: split Codex tool-output out of the tool-args slot

Status: implemented · Date: 2026-06-02 · Branch: `refactor/assistant-ui-custom-components`

## Goal

Live Codex command stdout / MCP progress should render in the tool card's
**output** block, not glued onto the tool's **args** display. Today it pollutes
`argsText` and double-renders after completion. Make the live transcript match
the reload transcript with the smallest reliable transport change.

## The forced binary (why this design)

assistant-ui's tool-call part has exactly two text channels:

| Channel            | Set by AG-UI event | Aggregator method          | Keeps part "running"?               |
| ------------------ | ------------------ | -------------------------- | ----------------------------------- |
| `argsText` (input) | `TOOL_CALL_CHUNK`  | `appendToolArgs` (append)  | **yes** (until `result` set)        |
| `result` (output)  | `TOOL_CALL_RESULT` | `finishToolCall` (replace) | **no** — status flips to `complete` |

There is no third "progress" channel without patching the vendored aggregator.
The part's status is derived from result-presence (`toToolCallPart` →
`part.result`; `NativeToolCall.active = status.type === "running" || result === undefined`).
So the choices are:

1. **stream live + keep spinner** → must use `argsText` → stdout pollutes args + double-renders (today).
2. **clean args + output in its own block** → must use `result` → per-tool spinner stops when output starts. _(chosen)_
3. **all three** → patch the aggregator for a progress channel + re-vendor `Console` + adapter + DB-render. _(deferred; most hoops, patches a vendored lib)_

Owner priority is explicit: simplification and fewest hoops over visual purity.
**Chosen: option 2.** One mapper line, zero new surface, deletes two real
defects (args pollution + post-completion double-render), and makes the live
path consistent with reload (both render output in `result`).

Trade accepted: the per-tool spinner stops when output begins streaming. The
global run indicator still shows activity, and growing output is itself
progress. Option 3 (patched `Console` channel) is the upgrade path if the
per-tool spinner must be preserved.

## Non-goals

- No aggregator patch, no re-vendored `Console`, no new DB part variant.
- Do not stop persisting `progressChunks` (separate, harmless; not rendered by
  `NativeToolCall` before or after this change — reload output comes from the
  terminal `tool_result` → `result`).
- Do not touch the daemon `tool-output` delta contract (kind, `toolCallId`,
  `stream`) — only the client mapper's choice of AG-UI event.
- Do not touch args streaming for real tool calls (TOOL_CALL_ARGS is unchanged).

## Current vs target call stack

```text
Codex outputDelta (daemon)
  -> [io] codex-notification-router.ts: enqueue-delta { kind:"tool-output", toolCallId:itemId, text:aggregated_output }
  -> [adapter] ag-ui-mapper.ts: mapDaemonDeltaToAgui()
       CURRENT: kind:"tool-output" -> TOOL_CALL_CHUNK{ toolCallId, delta }   // appendToolArgs -> argsText (pollution)
       TARGET:  kind:"tool-output" -> TOOL_CALL_RESULT{ messageId, toolCallId, content }  // finishToolCall -> result (clean)
  -> [runtime] patched RunAggregator -> tool part snapshot
  -> [ui] native-thread.tsx NativeToolCall: argsText=command only; result=streaming output (<ToolBlock>)
```

`aggregated_output` is cumulative, so `TOOL_CALL_RESULT` (replace) is the right
fit — no quadratic append. The terminal `command_execution completed ->
tool_result` sends the final `TOOL_CALL_RESULT` that finalizes `result` + `isError`.

## Implementation

1. `packages/agent/src/ag-ui-mapper.ts`

   - Change the `kind === "tool-output"` branch to build a `ToolCallResultEvent`
     (`messageId = toolCallId = delta.toolCallId ?? delta.messageId`,
     `content = capToolResultContent(delta.text)`, no `role` so `isError`
     stays undefined until the terminal result).
   - Rewrite the branch comment to describe the result-channel routing.

2. `packages/agent/src/ag-ui-mapper.test.ts`
   - Flip the two `tool-output` cases to assert `TOOL_CALL_RESULT` + `content`
     - `toolCallId`/`messageId` fallback.

## Tests / checks

```bash
cd packages/agent && npx vitest run src/ag-ui-mapper.test.ts
cd packages/daemon && npx vitest run src/codex-notification-router.test.ts   # delta shape unchanged -> stays green
cd apps/www && npx vitest run test/integration/codex-turn.test.tsx           # persisted terminal-part synthesis -> stays green
pnpm tsc-check
```

## Completion criteria

- [x] `tool-output` maps to `TOOL_CALL_RESULT`; args slot no longer receives stdout.
- [x] Mapper + daemon-router + integration tests green; tsc 17/17.
- [ ] Live streaming UX (spinner behavior, growing output) verified against a
      real Codex sandbox run — cannot be driven here; verify post-merge.
