# Native-first: strip the chat layer to AG-UI + assistant-ui, re-add later

**Date:** 2026-05-25 **Status:** needs sign-off (two decisions inline) **Strategy:** Stop preserving every custom renderer through the migration. Cut the transcript down to what AG-UI + assistant-ui render natively, ship that behind a flag, flip it, delete the Terragon transcript layer, then re-add rich parts one at a time as native `ActivityMessage` + custom renderer **only when wanted**. Trades temporary feature loss for a clean native core.

## The native baseline (what survives the strip)

Rendered by assistant-ui primitives reading the `@ag-ui/client` runtime state:

- **User messages** — `MessagePrimitive`, plain text + attachments.
- **Assistant text** — `MessagePrimitive` text parts.
- **Reasoning** — native `REASONING_*` rendering.
- **Tool calls** — `makeAssistantToolUI` / a single default tool UI: name, args, result. Every tool renders through this one path.
- **Run lifecycle** — `RUN_STARTED/FINISHED/ERROR` drive the working indicator.

That is the whole transcript. No projector, no Terragon reducer, no coalescing, no per-part custom components.

## What gets cut (re-add later as ActivityMessage + renderer, when wanted)

Most of these _originated as tool calls_ and keep rendering — just through the generic tool UI instead of a bespoke component. The downgrade is cosmetic, not data loss:

| Today (custom renderer)    | After strip                                                        | Re-add priority       |
| -------------------------- | ------------------------------------------------------------------ | --------------------- |
| Inline diff viewer         | `FileChange`/diff tool → generic tool card (paths + raw diff text) | High (diffs are core) |
| Terminal panel             | `Bash` tool → generic tool card (command + output)                 | Medium                |
| Plan card                  | `TodoWrite` tool → generic tool card                               | Medium                |
| Delegation card            | `Task` tool → generic tool card                                    | Low                   |
| Web-search view            | `WebSearch` tool → generic tool card                               | Low                   |
| auto-approval-review card  | dropped from transcript                                            | Low                   |
| image / audio / pdf inline | dropped (or rendered as a link)                                    | Low                   |
| resource-link view         | dropped (or link)                                                  | Low                   |

Out of scope for the transcript strip (separate surfaces, keep as-is):

- Git-diff **secondary/artifacts panel** — not a transcript message; it is its own panel and not assistant-ui's domain.
- Meta chips, boot checklist, lifecycle/recovery messages — the "lifecycle queue" band, rendered outside the message list.

## Decision 1 — composer (biggest feature cut)

Going native on the composer means `ComposerPrimitive`, which is **plain text only**. We lose: slash commands, mentions, drafts, transcription, multi-message queue.

- **Option A (recommended): keep TipTap as the composer slot.** It is a named permanent divergence already. The composer is not where the shim problem lives — the transcript is. Keep TipTap, go native on rendering only.
- **Option B: go fully native composer too.** Lose the above features now, re-add behind TipTap later. Larger, riskier, and the features are heavily used.

→ **Need your call.** Recommendation: A.

## Decision 2 — markdown renderer

`@assistant-ui/react-markdown` lacks `parseIncompleteMarkdown`; swapping in the native renderer regresses streaming-token rendering (partial code fences, lists).

- {==**Option A (recommended): keep streamdown as the text renderer slot.** Named permanent divergence. It is a leaf renderer, not a shim.==}{>>yeah let's do this<<}{id="c1" by="user" at="2026-05-25T22:26:41.930Z"}
- **Option B: native markdown.** Accept the streaming-render regression.

→ **Need your call.** Recommendation: A.

(If both recommendations stand, "native" = native runtime + native primitives + native tool UI, with TipTap and streamdown as the two documented leaf-renderer divergences. That is the plan-of-record's intended end state, reached faster by cutting the rich-part renderers instead of migrating them.)

## Execution sequence (flag-gated, reversible)

**Phase N1 — Build the native transcript behind a flag (no deletion yet).**

- Add `nativeChatTranscript` feature flag.
- New `NativeThread` component: `ThreadPrimitive.Messages` rendering `MessagePrimitive` + one default `makeAssistantToolUI`. Text via streamdown slot (Decision 2), composer via TipTap slot (Decision 1).
- Wire it to the existing `useAgUiRuntime`. No new transport work — the runtime already holds `thread.messages`.
- Identity must be clean first: W-ID.1/2 done; finish **W-ID.3 (Claude)** and **W-ID.4 (hydration)** so the native path shows one message per message with no dedup band.

**Phase N2 — Prove it on the replay harness.**

- Duplicate-detection assertion + golden-transcript snapshot for a Codex run and a Claude run, flag on. This is the deletion gate.

**Phase N3 — Flip the flag, delete the Terragon transcript layer.**

- Delete: `assistant-runtime-transcript-projector.ts`, `transcript-display-model.ts` (coalescing), `thread-view-model/reducer.ts` + `ag-ui-messages-reducer.ts`, `collapseHydrationReplayTextDuplicates`, `use-terragon-transcript.ts`, the per-part renderers in the cut list, `dbMessagesToAgUiMessages` / `toUIMessages` for new threads.
- Keep the DB→AG-UI converter **only** if historical threads must still render; otherwise old threads degrade to native rendering (plan-of-record already accepts no backfill).

**Phase N4 — Re-add rich parts as native ActivityMessage, by priority.**

- diff first (high), then terminal/plan as wanted. Each is a native `ACTIVITY_*` event + a custom renderer registered through the part registry — additive, no shim, no reducer.

## What this does NOT achieve (still honest)

- Rich-part renderers re-added in N4 are still custom components (no library primitive for a diff/terminal). That is "native event, custom renderer," which is the real ceiling — but now it is _additive and optional_, not a shim band.
- TipTap + streamdown remain (if Decisions A/A) as named leaf divergences.

## Verification

- Replay harness duplicate + golden-transcript gate (N2) blocks N3 deletion.
- `tsc-check` per step.
- Flag default stays off until N2 is green; flip is a one-line revert if wrong.

## Risk & rollback

- **Risk:** flipping the flag degrades rich rendering for live users. Mitigation: N4 re-adds diff fast; flag flip is instantly reversible.
- **Risk:** deleting converters breaks historical threads. Mitigation: keep the read-only DB→AG-UI converter for pre-cutover threads, or accept degraded old threads per the plan-of-record non-goal.
