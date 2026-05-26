# Codex-style tool-call activity display + output caps

**Status:** proposal — for review **Date:** 2026-05-25 **Author:** investigation off task `2a5a7ec7-2c4a-4f07-86e7-2389a7507222`**Related:** `2026-05-25-daytona-boot-snapshot-fix.md` (separate; same task surfaced both)

## Problem

Thread `2a5a7ec7…` dumped a wall of useless text and threw a recurring `Cannot send 'RUN_STARTED' while a run is still active` error. The prod event log (`agent_event_log`) shows two distinct failures, and they are different in kind:

1. **Display.** The agent ran two unbounded Bash commands whose output went straight into the thread:

- An over-broad `rg "…|send|logger\.(info|error|warn|debug)…"` returned an **840 KB** `TOOL_CALL_RESULT` (+ a 202 KB sibling) 13 s into the run.
- `npx agent-reviews --watch` streamed an ANSI-colored `Poll #N: No new comments (Xs/600s idle)` line every ~30 s for 10 minutes.

2. **Context.** The 840 KB result was also fed back to the model, bloating codex's context until it auto-compacted mid-run (the stray `MESSAGES_SNAPSHOT` at seq 5391).

The `--watch` command also held run `a6ad0bb4` "active" for 10 minutes with no `RUN_FINISHED`; any new-run attempt during that window collided with the active run and `@ag-ui/client`'s `verifyEvents` threw the `RUN_STARTED` error client-side.

**These are two problems, not one.** Display = what the human sees in the thread. Context = what bytes reach the model. The fixes are independent and we should ship them as separate layers.

## What we want

Replicate the Codex app's activity display: the agent's reasoning shows as prose; a burst of tool calls collapses to one dim receipt line (`Explored 4 files, 1 search, ran 1 command`); a single notable command shows verbatim (`Ran pnpm … perf:route-graph:check`); raw output appears nowhere by default.

## How Codex does it (verified against `openai/codex`)

The screenshot is the **Codex Desktop/web app "For coding" view**, not the CLI. The CLI renders an expanded tree; the app re-aggregates it into a counted sentence. The app's string-builder is closed-source, but the classifier and verb taxonomy it sits on are open.

### Verb taxonomy — `codex-rs/protocol/src/parse_command.rs`

Every shell/tool command is parsed into a `ParsedCommand` with four variants:

| Variant     | Matches                                       | Verb bucket     |
| ----------- | --------------------------------------------- | --------------- |
| `Read`      | `cat`, `sed -n`, `head`, view-file, Read tool | explored        |
| `Search`    | `grep`, `rg`, ripgrep                         | search          |
| `ListFiles` | `ls`, `find`, `tree`                          | list            |
| `Unknown`   | everything else (real commands)               | command / `Ran` |

File edits are **not** a `ParsedCommand` variant — they arrive on the patch/diff channel and are counted separately as `Created` / `edited`. The app's summary fuses two streams: parsed-command counts + patch counts.

### Grouping rule — `codex-rs/tui/src/exec_cell/model.rs`

A cell is an "exploring" receipt iff every call is read-only and not a user shell command:

```rust
fn is_exploring_call(call) -> bool {
    !matches!(call.source, UserShell)
      && !call.parsed.is_empty()
      && call.parsed.iter().all(|p| matches!(p, Read | ListFiles | Search))
}
```

Any group containing an `Unknown` (a real command) breaks out as a standalone `Ran <verbatim cmd>`. Consecutive read-only calls are coalesced and filenames de-duplicated (`render.rs` uses `.unique()`).

### Reasoning vs receipt — `codex-rs/core/gpt_5_1_prompt.md`

The white prose is model-emitted preamble/progress (1–2 sentences; progress updates ≤8–10 words), on a separate event channel from tool calls. Reasoning is always a hard boundary between receipt groups; the two never merge.

### Drill-down + the cautionary tale

The receipt line is click-to-expand. Raw output is never inline — the CLI caps at `TOOL_CALL_MAX_LINES = 5` and points to a transcript; the app stores a full transcript and gates inline output behind a setting. Codex issue [#19891](https://github.com/openai/codex/issues/19891) complains the app hides **edited filenames and commands** behind the aggregate. Lesson: aggregate the line, but always reveal edited filenames + commands on expand.

## Cross-harness validation

Collapsed-by-default + a semantic summary line is the field default:

- **GitHub Copilot agent mode** — tool details collapsed by default (`chat.agent.thinking.collapsedTools`); output routes to the terminal.
- **Claude Code** issue #49646 (nearly our exact ask) — "text responses are what users act on — tool calls are implementation detail"; proposes `show`/`collapsed`/`hidden` per tool + grouping consecutive calls.
- **HumanLayer** — _success is silent, errors are verbose_: auto-expand errors/diffs/final results; collapse reads, greps, passing builds.
- **Devin / Cursor compact mode / Replit** `report_progress` — same shape.

## Design for our stack (assistant-ui + AG-UI)

We receive `TOOL_CALL_START/ARGS/END/RESULT` + reasoning/`TEXT_MESSAGE`. Our chat layer already dispatches tools and parts through typed registries (`tool-part.tsx` `TOOL_DISPATCH`, `parts/part-registry.ts`). The plan extends those, not a parallel component system.

### Layer 1 — display (the receipt line)

1. **Classify** each tool call into a verb bucket. Tool-name tools map directly (Read→explored, Grep→search, Edit→edited, Write→created). Bash needs a command parser mirroring `parse_command.rs` (detect `cat/sed/head`→read, `rg/grep`→search, `ls/find/tree`→list, else→command).

2. **Group** by walking events in order, maintaining a current group:

- reasoning/`TEXT_MESSAGE` → flush group, emit prose (hard boundary);
- read/search/list/edit/create → accumulate counts;
- a notable standalone command → flush as `Ran <verbatim cmd>`; otherwise fold into `…, ran N commands`.

3. **Render grammar** (segments comma-joined, non-zero only, canonical order): `Created {c} file(s), edited {e} file(s), explored {r} file(s), {s} search(es), {l} list(s), ran {k} command(s)`. Lead segment capitalized; later verbs lowercase; pluralize by count; de-dup explored filenames; header verb `Exploring…` while streaming, `Explored` when done.

4. **Wire to UI** via assistant-ui `ToolGroup` / `MessagePrimitive.GroupedParts` (`groupBy → "group-tool"`) — already collapsed-by-default. Replace the `"N tool calls"` label with the verb-count grammar.

5. **Expand** reveals per-call detail. Always show edited filenames + commands (the #19891 lesson). Map `TOOL_CALL_RESULT` here, never into the line.

### Layer 2 — context + output caps (the 840 KB / ANSI fix)

In the daemon, before persisting/streaming `TOOL_CALL_RESULT`:

| Dial                    | Default                                                      | Precedent                            |
| ----------------------- | ------------------------------------------------------------ | ------------------------------------ |
| Per-result cap to model | 30 KB, middle-truncate                                       | Claude Code `BASH_MAX_OUTPUT_LENGTH` |
| Truncation marker       | `…{N} chars truncated…`                                      | Codex `truncate_middle_*`            |
| Search capping          | `rg --max-count` + harness total-match cap + `--max-columns` | fixes the 840 KB `rg`                |
| ANSI                    | strip before store/display                                   | the poll-loop noise                  |
| `--watch`/streaming     | wall-clock + output-rate cap (idle timer won't fire)         | fixes `agent-reviews --watch`        |
| Spill overflow          | >2K tokens → temp file + 10-line preview + path              | opencode / Gemini / Codex converge   |
| UI result clamp         | `max-h` + "show full output" on `ToolFallback` `<pre>`       | assistant-ui gap (no built-in)       |

## Examples to mine (verified source, 2026-05-25 round 2)

Three projects converged on this shape, which de-risks the design. Port
opencode's verb grammar onto assistant-ui's grouping; adopt t3code's
"one line, no raw output inline" rule.

**Primary — opencode (`sst/opencode`, SolidJS UI).** The cleanest per-verb
implementation.

- `packages/ui/src/components/message-part.tsx` — `groupParts` (consecutive-run
  state machine) coalesces `CONTEXT_GROUP_TOOLS = {read, glob, grep, list}` into
  one `ContextToolGroup`; `contextToolSummary` counts `{read, search (glob+grep),
list}`; `AnimatedCountList` drops zero counts and comma-joins.
- i18n `Exploring` (active) → `Explored` (done); `{count} read(s)`,
  `{count} search(es)`, `{count} list(s)`.
- Output capped to a 240px scroll region (`message-part.css`), not "+N more".

**Confirms the rules — t3code (`pingdotgg/t3code`, MIT, Theo's agent GUI).**
Renders Codex CLI activity, so it matches the screenshot. Custom Effect runtime,
not Vercel AI SDK.

- `apps/web/src/session-logic.ts` `collapseDerivedWorkLogEntries` (merge by
  `toolCallId`) + `apps/web/src/components/chat/MessagesTimeline.tsx`
  `deriveMessagesTimelineRows` (merge adjacent rows) → one `WorkGroupSection`.
- `MAX_VISIBLE_WORK_LOG_ENTRIES = 6` — show last 6, "Show N more"; header
  `Tool calls (N)`.
- `truncateInlinePreview` (84 chars), `summarizeToolTextOutput` → first line or
  `"N lines"`; listings → `"N files"`. No raw-output affordance in the timeline.
- Caveat: t3code uses a generic `Tool calls (N)` count; we want opencode's
  per-verb breakdown.

**Our runtime — assistant-ui (`assistant-ui/assistant-ui`).** The only library
with first-class consecutive-tool aggregation.

- `packages/ui/src/components/assistant-ui/thread.tsx` —
  `MessagePrimitive.GroupedParts` + `groupBy → "group-tool"` /
  `"group-reasoning"` under `"group-chainOfThought"`.
- `tool-group.tsx` — `ToolGroupTrigger count={…}` renders `N tool calls`,
  `defaultOpen=false`, `ANIMATION_DURATION=200`, `useScrollLock`. **Swap this
  label for the verb-count grammar.**
- `examples/with-opencode/components/tools/` — `truncate(value, 80)` +
  `max-h-96 overflow-y-auto` output box (the display caps core lacks).

**Also useful:** `openai/codex` `codex-rs/tui/src/exec_cell/{model,render}.rs` +
`protocol/src/parse_command.rs` (the classifier port); Cline
`groupLowStakesTools` / `ToolGroupRenderer` (`read 3 files, 1 folder`); Vercel AI
Elements `reasoning.tsx` `AUTO_CLOSE_DELAY=1000` (auto-open-while-streaming).

## Scope / phasing

- **Phase 1 (display).** Classifier + grouping + grammar + `ToolGroup` wiring. No daemon change. Reversible, UI-only.
- **Phase 2 (caps).** Daemon result cap + ANSI strip + search capping. Stops context bloat and the 840 KB dump at the source.
- **Phase 3 (run lifecycle).** Bound long-running Bash + reconcile stuck `processing` runs so the `RUN_STARTED` collision can't recur. (Overlaps the delivery-loop reaper pattern.)

## Open questions

1. What counts as a "notable" standalone command vs foldable? (Codex breaks out any `Unknown`; we may want test/build/check commands verbatim but fold `cd`/`echo`/`mkdir`.)

2. Do we strip ANSI at the daemon (context + display) or only at display?

3. Phase 1 against `ToolGroup` directly, or a new `ActivityReceipt` part in `part-registry.ts`? (Leaning `ToolGroup` to avoid schema churn.)

4. Is the 30 KB model cap right for codex specifically, given its own compaction already runs?

## Status

- **Phase 1 (display): implemented + tested.** Branch
  `fix/daytona-boot-snapshot-and-background-setup`.
  - `apps/www/src/components/chat/tools/activity-summary.ts` —
    `summarizeActivityGroup()` ports the Codex/opencode verb taxonomy +
    grammar (classifier incl. a `bash -lc` unwrapper, distinct-path counting,
    pluralization). 10/10 unit tests pass.
  - `chat-message-collapsible-activity.tsx` — the collapsed group label now
    renders the summary (`Explored 4 files, 1 search, ran 1 command`) instead
    of the generic "Finished working"; reasoning-only groups still fall back.
  - Plugged into the existing `groupParts` → `collapsible-agent-activity`
    seam; no new component, no schema change. Standalone trailing commands
    already render expanded (handled by `groupParts`).
- **Phase 2 (caps): implemented + tested.** Provider-agnostic, at the
  canonical → AG-UI boundary so it caps persistence, stream, and display in one
  place.
  - `packages/agent/src/tool-output-cap.ts` — `capToolResultContent()`,
    `MAX_TOOL_RESULT_CHARS = 30_000`, middle-truncate with
    `…{N} characters truncated…`. 7/7 unit tests pass (incl. the 840 KB size).
  - `ag-ui-mapper.ts` `mapToolCallResult` applies it. 44/44 existing mapper
    tests still pass.
  - **Deliberately not stripping ANSI** at the daemon: the UI renders ANSI as
    color via `ansiToHtml`; stripping would regress legitimate colored output.
  - **Search capping (`rg --max-count` etc.) deferred** — the byte cap already
    bounds the 840 KB dump; per-command flag injection is a separate change.
- **Phase 3 (run lifecycle): partially implemented — the safe half.**
  Investigation found the two "root cause" levers are both unsafe/unavailable
  right now:
  - _Bounding the command_ is not controllable: under `codex-app-server`, codex
    runs `command_execution` (the `--watch`) internally; the daemon observes but
    can't impose a wall-clock cap (no codex timeout knob exposed).
  - _A time-based stalled-run reaper_ would kill quiet-but-alive runs (a codex
    build can emit nothing for minutes). Doing it correctly needs a daemon
    heartbeat to distinguish "alive but quiet" from "dead" — a larger design.
  - **Shipped instead (safe, contained):** the user-visible error was the
    `RUN_STARTED`-while-active throw rendering as "An error occurred". That race
    is benign — the prior run is still streaming. `runtime-error-classification.ts`
    `isTransientRunLifecycleError()` classifies it (5/5 tests) and
    `assistant-runtime-session.tsx` `handleRuntimeError` swallows it instead of
    flipping the thread into an error state. Real failures still surface. No
    lifecycle / SSE / daemon change; zero risk to live runs.
  - **Still open:** finalizing genuinely stuck `processing` runs (needs the
    heartbeat). Tracked; overlaps the delivery-loop reaper.
- `tsc-check` clean except the pre-existing unrelated `@pierre/trees`
  missing-dep error.

## Non-goals

- Replacing TipTap composer or the markdown renderer (documented divergences).
- Streaming raw long-running output inline (we explicitly don't want this).
- Per-tool user-configurable visibility (defer; ship sensible defaults first).
