---
title: "Phase 6 prep: ag-ui-messages-reducer audit"
type: research
date: 2026-04-27
related_plan: docs/plans/2026-04-27-refactor-chat-layer-consolidated-plan.md
---

# Phase 6 prep: ag-ui-messages-reducer audit

## Approach

Read the reducer end-to-end (`apps/www/src/components/chat/ag-ui-messages-reducer.ts`,
850 LOC) and cross-checked every `case` against the bundled
`defaultApplyEvents` in
`node_modules/.pnpm/@ag-ui+client@0.0.52/node_modules/@ag-ui/client/dist/index.mjs`
(symbol `I=...`, the only handler tree in the SDK). The SDK's reducer
maintains a flat `Message[]` shape with `{id, role, content, toolCalls?}`
plus separate `activity` / `reasoning` rows. Our reducer maintains
`UIMessage[]` with a discriminated `parts` array. That shape mismatch is
the structural reason we cannot delegate 1:1 — but most _event sequencing_
logic (creating a message on first START, appending content deltas,
buffering tool args, finalizing on END) is duplicated. Phase 5 makes the
SDK's `AbstractAgent.messages` the source of truth, after which the
reducer's job collapses to "translate SDK message shape → UIMessage" plus
the terragon-specific cases the SDK does not model.

SDK coverage (confirmed by reading bundled `I=...` switch):

- TEXT_MESSAGE_START / \_CONTENT / \_END — creates row, appends to `content`, fires `onNewMessage`.
- TOOL_CALL_START / \_ARGS / \_END — attaches tool call to nearest assistant message, buffers args, parses on END.
- TOOL_CALL_RESULT — appends a `tool`-role message with content.
- REASONING_MESSAGE_START / \_CONTENT — creates `reasoning`-role row, appends content. (REASONING_MESSAGE_END not present in the bundle's switch — likely a no-op.)
- MESSAGES_SNAPSHOT — diffs by id, preserves `activity` / `reasoning` rows, appends new ones.
- STATE_SNAPSHOT / \_DELTA — replaces or JSON-patches `state`.
- ACTIVITY_SNAPSHOT / \_DELTA — first-class activity-message lifecycle (the SDK already projects ActivityMessage; our reducer ignores these events today).
- RUN_STARTED — seeds `input.messages` if present.
- RUN_FINISHED / \_ERROR / STEP_STARTED / \_FINISHED / RAW / CUSTOM — fire subscriber hooks only, no state mutation.
- TEXT_MESSAGE_CHUNK / TOOL_CALL_CHUNK — SDK _throws_ unless pre-transformed via `transformChunks`.
- THINKING\_\*, REASONING_START / \_END / \_CHUNK / \_ENCRYPTED_VALUE — no-ops or hook-only.

## Per-handler categorization

| #   | Case / Helper                                                                                                                                     | Lines                              | Cat              | Reasoning                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `TEXT_MESSAGE_START`                                                                                                                              | 125–142                            | **A**            | SDK creates the assistant row on START (`I=...case i.TEXT_MESSAGE_START`). The only Terragon-only side effect is `activeAssistantMessageId` tracking, which exists solely to anchor _orphan_ TOOL_CALL_START events (case 6 below). After Phase 5 the SDK owns row creation.                                                                                                                                                                                          |
| 2   | `TEXT_MESSAGE_CONTENT` → `applyTextDelta`                                                                                                         | 144–149, 373–402                   | **A**            | SDK appends `delta` to `Message.content` directly. Our wrinkle is that we store deltas in a `{type:"text"}` part instead of a string — that's a shape conversion in `terragon-projection`, not a separate reducer step.                                                                                                                                                                                                                                               |
| 3   | `TEXT_MESSAGE_END`                                                                                                                                | 151–153                            | **A**            | Already a no-op locally; SDK fires `onNewMessage` which we don't need to mirror.                                                                                                                                                                                                                                                                                                                                                                                      |
| 4   | `REASONING_MESSAGE_START` → `ensureReasoningPart`                                                                                                 | 155–161, 404–438                   | **B**            | SDK creates a _separate_ `reasoning`-role message; we fold reasoning into the parent assistant message as a `{type:"thinking"}` part keyed by `<parentId>:thinking:<N>`. The id-parsing convention (`parseReasoningMessageId`, 711–724) is Terragon-specific and depends on the AG-UI mapper. Survives in `terragon-projection`.                                                                                                                                      |
| 5   | `REASONING_MESSAGE_CONTENT` → `appendReasoningDelta`                                                                                              | 163–175, 440–459                   | **B**            | Same shape mismatch as #4: SDK appends to `Message.content`; we mutate `parts[partsIndex].thinking`. Cannot delegate.                                                                                                                                                                                                                                                                                                                                                 |
| 6   | `REASONING_MESSAGE_END`                                                                                                                           | 177–179                            | **A**            | Already a no-op. SDK is also effectively a no-op for this event.                                                                                                                                                                                                                                                                                                                                                                                                      |
| 7   | `TOOL_CALL_START` → `addPendingToolPart`                                                                                                          | 181–223, 461–493                   | **B**            | SDK attaches `{id, type:"function", function:{name, arguments:""}}` to `assistantMessage.toolCalls`. We attach `{type:"tool", id, name, parameters:{}, status:"pending", parts:[], agent}` to `parts`. The `parts: []` and per-tool `agent` stamping are Terragon extensions for tool-result rendering. The orphan-tool fallback (`agent-${toolCallId}` synthetic message) is also Terragon-specific. Reduces to ~15 LOC in projection.                               |
| 8   | `TOOL_CALL_ARGS` (buffer)                                                                                                                         | 225–237                            | **A**            | SDK buffers args identically (concatenates into `toolCall.function.arguments`). After Phase 5 the SDK's buffer is authoritative.                                                                                                                                                                                                                                                                                                                                      |
| 9   | `TOOL_CALL_CHUNK` → `appendToolProgressChunk`                                                                                                     | 239–249, 517–544                   | **B**            | **No SDK equivalent.** SDK _throws_ on TOOL_CALL_CHUNK unless pre-transformed away. Terragon uses CHUNK to stream interim progress (`progressChunks: [{seq, text}]`, `toolStatus: "in_progress"`). The `progressChunks` field is a known DBToolCall lifecycle column. Must survive.                                                                                                                                                                                   |
| 10  | `TOOL_CALL_END` → `updateToolPartParameters` + `safeParseJson`                                                                                    | 251–263, 495–515, 736–747          | **A**            | SDK calls `JSON.parse(toolCall.function.arguments)` on END (the inner `try{l=JSON.parse(s)}catch{}` block in `defaultApplyEvents`). After Phase 5 the parsed args live on the SDK's `toolCall`; projection just reads `toolCall.function.arguments`.                                                                                                                                                                                                                  |
| 11  | `TOOL_CALL_RESULT` → `completeToolPart`                                                                                                           | 265–285, 546–578                   | **B**            | SDK appends a _new_ `tool`-role message with `{toolCallId, content}`. We must instead mutate the original tool _part_ in place to set `status: "completed"\|"error"`, `result`, and conditionally `toolStatus`. The `role === "tool"` → `isError` heuristic is Terragon-specific (the AG-UI mapper's encoding of failed tool calls). The `shouldCarryToolStatus` lifecycle bridge between progressChunks (#9) and final status is also Terragon-specific. Survives.   |
| 12  | `CUSTOM` (`terragon.part.*`) → `insertRichPart` + `isRenderablePart` + `normalizeRenderablePart` + `getPartIdentity`                              | 287–304, 580–616, 757–839, 841–850 | **B**            | SDK CUSTOM is a hook-only no-op. **All terragon rich parts** (plan, plan-structured, diff, terminal, image, audio, resource-link, auto-approval-review, delegation, server-tool-use, web-search-result, rich-text, pdf, text-file) ride through CUSTOM events with the `terragon.part.` namespace. Projection, validation, dedupe-by-id, and the `plan` → `plan-structured` migration normalization are all Terragon-only. The largest must-survive block (~110 LOC). |
| 13  | `MESSAGES_SNAPSHOT` → `appendSnapshotMessages` + `agUiSnapshotMessageToUiMessage` + `snapshotContentToText` + `sideEffectSystemMessageTypeFromId` | 306–318, 618–700                   | **B** (mostly)   | SDK has its own MESSAGES_SNAPSHOT handler, but we project to a _different_ shape. The system-message classification (`/^side-effect-system:.../` regex → `invalid-token-retry` / `compact-result`) is Terragon-only and must survive. Plain user/assistant rows could in principle delegate to SDK after a shape converter; system-message synthesis cannot. Net: keep in projection.                                                                                 |
| 14  | `TEXT_MESSAGE_CHUNK` no-op                                                                                                                        | 320                                | **C**            | Pre-Phase-5 we ran chunk events through `transformChunks` upstream of the reducer; post-Phase-5 the SDK pipeline guarantees the same. The case body is already `return state` — safe to drop.                                                                                                                                                                                                                                                                         |
| 15  | `THINKING_TEXT_MESSAGE_START / _CONTENT / _END / THINKING_START / THINKING_END`                                                                   | 321–325                            | **C**            | These are Vercel-protocol legacy event names. The AG-UI mapper (`packages/agent/src/ag-ui-mapper.ts`) emits `REASONING_*` only. They never fire today; safe to drop after Phase 5 confirms no live emitters.                                                                                                                                                                                                                                                          |
| 16  | `STATE_SNAPSHOT / STATE_DELTA` no-op                                                                                                              | 326–327                            | **C**            | We don't use AG-UI's `state` channel for transcript projection — terragon state lives on threads, not in `AbstractAgent.state`. After Phase 5 the SDK still owns `state`, but our reducer never read it. Safe to drop locally.                                                                                                                                                                                                                                        |
| 17  | `ACTIVITY_SNAPSHOT / ACTIVITY_DELTA` no-op                                                                                                        | 328–329                            | **B (latent)**   | Currently a no-op, but the SDK _does_ fold these into `activity`-role messages, and the consolidated plan calls out "ActivityMessage projection" as a Category B concern. Today we synthesize activity from CUSTOM `terragon.part.*` events instead. Keep an explicit no-op for now and reconsider if Phase 5 starts emitting native ACTIVITY\_\*.                                                                                                                    |
| 18  | `RAW / RUN_STARTED / RUN_FINISHED / RUN_ERROR / STEP_STARTED / STEP_FINISHED` no-op                                                               | 330–335                            | **C**            | Run-state lives outside the UIMessage projection (header chips, status pill). Local no-op cases add nothing the SDK doesn't already do via subscriber callbacks.                                                                                                                                                                                                                                                                                                      |
| 19  | `REASONING_START / _CHUNK / _END / _ENCRYPTED_VALUE` no-op                                                                                        | 336–339                            | **C**            | `_CHUNK` is pre-transformed by the SDK's `transformChunks`; the others are hook-only in the SDK. Local cases never mutate state.                                                                                                                                                                                                                                                                                                                                      |
| 20  | Internal helper `ensureAssistantMessage`                                                                                                          | 353–371                            | **A** (subsumed) | Mirror of SDK's `if(!l.find(t=>t.id===e)){let t={id:e,role:n,content:""};l.push(t)}`. Folds away once SDK is the source.                                                                                                                                                                                                                                                                                                                                              |
| 21  | Internal helper `findLastIndex`                                                                                                                   | 726–734                            | **A** (utility)  | Polyfill for `Array.prototype.findLastIndex`; only used by `applyTextDelta` (#2). Dies with #2.                                                                                                                                                                                                                                                                                                                                                                       |
| 22  | Internal helper `getField`                                                                                                                        | 706–709                            | **B** (utility)  | Defensive accessor on `unknown`. Survives in projection — CUSTOM payloads still need it.                                                                                                                                                                                                                                                                                                                                                                              |
| 23  | Internal helper `safeStringify`                                                                                                                   | 749–755                            | **B** (utility)  | Used by snapshot (#13) and `completeToolPart` (#11). Survives.                                                                                                                                                                                                                                                                                                                                                                                                        |

## Category tally

| Category                                                                     | Handlers | Approx LOC                           |
| ---------------------------------------------------------------------------- | -------- | ------------------------------------ |
| **A — SDK covers** (1, 2, 3, 6, 8, 10, 20, 21)                               | 8        | ~250                                 |
| **B — Terragon-specific, must survive** (4, 5, 7, 9, 11, 12, 13, 17, 22, 23) | 10       | ~430                                 |
| **C — Dead code post-Phase 5** (14, 15, 16, 18, 19)                          | 5        | ~30 (no-op cases) + supporting infra |

LOC estimates include helpers reachable only from the case in question.
The 850-LOC reducer realistically collapses to a ~300-350-LOC
`terragon-projection.ts` once Category A is delegated to SDK and
Category C is dropped. The ≤100-LOC target in Phase 6 is achievable only
if Category B itself is further trimmed — primarily by:

- Replacing `insertRichPart`'s switch-style validator (#12 / `isRenderablePart`,
  ~50 LOC) with a Zod schema or a runtime-validated discriminated union
  generated from `UIPartExtended`.
- Folding the reasoning-id parsing convention back into the AG-UI mapper
  so the projection just reads `event.parentMessageId` directly.
- Deleting `agUiSnapshotMessageToUiMessage` if Phase 5 routes legacy
  snapshots through the same CUSTOM channel rich parts already use.

If those three reductions land, projection drops to ~120 LOC; without
them, target ~250 LOC and update Phase 6 acceptance criteria.

## Recommended pilot for deletion

**Pilot: case 8 — `TOOL_CALL_ARGS` buffer (lines 225–237).**

Reasons:

1. The SDK's behavior is _exactly_ identical: concatenate `delta` into a
   per-toolCallId buffer keyed by id (`s.function.arguments+=a` in the
   bundle).
2. The buffer is stateful (lives in `state.toolArgsBuffers`), so deleting
   it actually exercises the "delegate state to SDK" pattern Phase 6
   needs to validate end-to-end. A pure no-op case (#16, #18, #19) would
   not stress the integration.
3. Failure mode is loud: if the SDK doesn't actually buffer args, the
   subsequent `TOOL_CALL_END` / projection step will see `arguments === ""`
   and tool calls will render with empty parameters — easy to detect in
   any replay fixture that exercises a non-trivial tool call.
4. It is genuinely independent: nothing else in our reducer reads
   `toolArgsBuffers` except case 10 (`TOOL_CALL_END`), and case 10 can
   trivially read the SDK's `toolCall.function.arguments` instead.
5. Small surface (13 lines + 1 state field) — keeps the pilot reviewable.

Once the pilot lands and the replay suite is green, follow up by
deleting #1 (TEXT_MESSAGE_START, including the `activeAssistantMessageId`
field if orphan tool calls also migrate to projection), then #2 / #21,
then #10.

## Replay-fixture scope

Each fixture is a recorded `daemon-event` JSONL stream replayed through
the existing harness in `apps/www/test/integration/`. Coverage matrix:

1. **Plain text turn.** USER input → RUN_STARTED → TEXT_MESSAGE_START /
   \_CONTENT (≥3 deltas) / \_END → RUN_FINISHED. Asserts text accumulates
   into a single `{type:"text"}` part. Targets: cases 1, 2, 3.
2. **Reasoning turn.** Same as #1 plus interleaved REASONING_MESSAGE_START /
   \_CONTENT (≥2 deltas) / \_END before the text. Asserts thinking part
   precedes text part on the same parent message. Targets: cases 4, 5.
3. **Tool call without progress.** Text + TOOL_CALL_START / \_ARGS (≥2
   deltas) / \_END / TOOL_CALL_RESULT (success). Asserts pending → completed
   transition with parsed parameters and string `result`. Targets: cases
   7, 8, 10, 11.
4. **Tool call with TOOL_CALL_CHUNK progress.** Same as #3 but with ≥3
   TOOL_CALL_CHUNK events between START and RESULT. Asserts
   `progressChunks` accumulate with monotonic `seq` and `toolStatus`
   moves `started` → `in_progress` → `completed`. Targets: case 9 plus
   the `shouldCarryToolStatus` branch in case 11. **This is the highest-
   risk fixture** because the SDK _throws_ on raw TOOL_CALL_CHUNK; verify
   the AG-UI mapper still emits CHUNK or migrate to a CUSTOM event.
5. **Tool call with error.** Same as #3 but RESULT carries `role:"tool"`
   or `isError:true`. Asserts `status:"error"` and `toolStatus:"failed"`
   when chunks were present. Targets: case 11 error branch.
6. **Orphan tool call.** TOOL_CALL_START with no preceding
   TEXT_MESSAGE_START and no `parentMessageId`. Asserts synthetic
   `agent-${toolCallId}` message is created. Targets: case 7 fallback.
7. **Rich part: plan.** CUSTOM `terragon.part.plan` with both legacy
   `planText` and modern `entries` payloads. Asserts `plan` →
   `plan-structured` normalization runs. Targets: case 12 +
   `normalizeRenderablePart`.
8. **Rich part: terminal/diff/image dedupe.** Two CUSTOM events with the
   same `id`. Asserts second is dropped. Targets: case 12 dedupe path.
9. **Rich part: invalid payload.** CUSTOM with bad `part` shape (e.g.
   `text` part missing `text` field). Asserts state unchanged. Targets:
   `isRenderablePart` validators.
10. **MESSAGES_SNAPSHOT replay.** Snapshot containing user, assistant,
    and `side-effect-system:invalid-token-retry-...` messages alongside
    rows already present. Asserts only missing rows append, system rows
    classify correctly. Targets: case 13.
11. **Reconnect mid-stream.** Two replays back-to-back with overlapping
    runIds — second replay starts mid-TEXT_MESSAGE_CONTENT and includes
    a CUSTOM event for an unknown messageId. Asserts lazy assistant-
    message creation works (the docstring's "ordering tolerance" path).
12. **No-op fixtures.** Streams containing only RUN*\*, STATE*_, RAW,
    THINKING\__ events. Asserts state reference is unchanged after each.
    Targets: Category C handlers — proves they _can_ be deleted.

The suite gates each handler removal: run before deletion, delete handler,
run again, diff projected `UIMessage[]` byte-for-byte. No diff = safe to
land.

## Open questions

1. **ACTIVITY_SNAPSHOT / \_DELTA (case 17).** Does Phase 5 plan to emit
   native AG-UI activity events, or continue routing activity through
   CUSTOM `terragon.part.*`? If native, case 17 escalates from no-op to
   a Category B projection step. Confirm with the AG-UI mapper owner
   before pilot lands.
2. **Reasoning id format (cases 4, 5).** The `<parentId>:thinking:<N>`
   convention is owned by `packages/agent/src/ag-ui-mapper.ts`. Worth
   considering whether the mapper should populate `parentMessageId` /
   `partIndex` directly on the AG-UI event so projection can drop
   `parseReasoningMessageId` (~14 LOC).
3. **`UIPartExtended` validation (case 12).** `isRenderablePart`'s
   hand-rolled switch is fragile and grows with every new part type.
   Open question: replace with Zod inferred from the discriminated
   `UIPartExtended` union? That would shrink case 12 from ~110 LOC to
   ~20 LOC and make adding new rich parts safe.
4. **Snapshot system-message classification (case 13).** The
   `side-effect-system:` regex is the only place `DBSystemMessage`
   classification logic leaks into the reducer. Consider routing these
   through their own CUSTOM event from the daemon, removing the regex
   path entirely.
5. **`activeAssistantMessageId` survival.** The orphan-tool fallback in
   case 7 relies on this. If we route every TOOL_CALL_START through the
   SDK (which already finds-or-creates the parent assistant message),
   we may be able to drop this field. Verify in pilot that `ae(l,r,e)`
   in the SDK bundle handles the parentMessageId-undefined branch the
   same way.

No handler was impossible to categorize. Cases 14, 15, 16, 18, 19 are
confidently dead post-Phase 5 only if Phase 5 does in fact stop
forwarding raw `TEXT_MESSAGE_CHUNK` / legacy THINKING\_\* events to the
reducer — verify by grepping the AG-UI mapper after Phase 5 lands.
