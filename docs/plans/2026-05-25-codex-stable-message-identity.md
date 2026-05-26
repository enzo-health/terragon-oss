# Codex stable message identity (root fix for transcript duplication)

**Date:** 2026-05-25
**Branch:** `fix/chat-message-duplication-and-tool-condensing`
**Status:** awaiting approval

## Problem

On Codex (GPT-5.x) threads, agent text renders multiple times — the same
paragraph stacked N times in one bubble. Root cause: **one logical Codex agent
message is emitted under three different message ids**, all persisted to the
AG-UI event log and replayed on reconnect/resume.

| #   | Source                                                        | Where                 | messageId                          |
| --- | ------------------------------------------------------------- | --------------------- | ---------------------------------- |
| 1   | Streaming deltas (`item.updated` / `item/agentMessage/delta`) | `daemon.ts:1637-1683` | Codex item id `msg_<hex>` (stable) |
| 2   | Generic per-block delta on `item.completed`                   | `daemon.ts:2393-2424` | `randomUUID()` (reset per turn)    |
| 3   | Canonical `assistant-message` on `item.completed`             | `daemon.ts:3320-3362` | fresh `baseEvent.eventId`          |

The rendered transcript comes from the `@assistant-ui/react-ag-ui` runtime
store (`use-terragon-transcript.ts:28`), not the view-model reducer — so the
existing `collapseHydrationReplayTextDuplicates` dedup (reducer.ts:157) is
**dead code for the rendered path**. The runtime keys by message id, so three
ids = three messages; `coalesceContiguousAgentMessages`
(transcript-display-model.ts:74) then concatenates their parts with no
content-level dedup → stacked duplicates.

Secondary contributor: `parseCodexLine` never sees `item.updated` (the daemon
intercepts and returns early at `daemon.ts:1682`), so its
`lastEmittedTextByItemId` dedup is empty at `item.completed` — guaranteeing the
final full-text emission is never suppressed.

## Goal

One stable `messageId` per Codex agent message (and reasoning), backing exactly
one content-bearing event stream end to end: live stream → persist → replay →
hydration. No second representation.

## Strategy: deltas are the single source of truth

Deltas already stream char-by-char AND are persisted + replayed under the stable
Codex item id. They are the natural single representation. The `item.completed`
canonical/generic emissions are redundant duplicates under different ids.

**Fix = stop `item.completed` from creating AG-UI representations for
delta-streamed Codex items; keep deltas as the one persisted stream.**

### Changes

1. **Thread the Codex item id onto emitted messages.** In `parseCodexItem`
   (`codex.ts`), tag the `agent_message` and `reasoning` ClaudeMessages with
   their source item id (new optional field, e.g. `_codexItemId`, read
   structurally — does not change the Anthropic SDK type at rest).

2. **Flush a final delta on `item.completed`.** At the delta-routing site
   (`daemon.ts:1637`), extend the guard to also handle `item.completed` for
   `agent_message`: enqueue the remaining text (`fullText` minus
   `agentMessageTextById[itemId]`) under the same item id, then return early —
   so `item.completed` never reaches the generic delta path (#2) or the
   canonical builder (#3) for these items.

3. **Suppress redundant canonical emission.** In `buildCanonicalEventsForBatch`
   (`daemon.ts:3320`), skip the `assistant-message` / `reasoning-message` event
   when the message carries a `_codexItemId` (its content already lives in the
   delta stream under that id). Defensive: if an item somehow produced no
   deltas, fall back to emitting the canonical event under `messageId =
_codexItemId` (not `baseEvent.eventId`) so identity still reconciles.

4. **DB record unchanged.** `toDBMessage` on the server still persists the
   `DBAgentMessage` for durable history / non-canonical fallback. Canonical-mode
   hydration already uses `includeAssistantHistory: false`
   (snapshot-adapter.ts:131, db-messages-to-ag-ui.ts:53), so the DB copy never
   re-enters the AG-UI runtime as a duplicate.

5. **END synthesis already handled.** `buildDeltaRunEndRows` +
   `findOpenAgUiMessagesForRun` close delta-opened messages at run-terminal
   (daemon-event/route.ts:1324). Verify the flushed-final-delta message is
   closed there.

### Why not "share the id and merge"

Reusing `itemId` on the canonical event while keeping deltas would put two
full-text content streams under one id → assistant-ui appends → text doubled
within one message. One id requires one content source. Deltas win because they
already stream live and persist.

## Non-goals

- Claude path: uses `block:<index>` delta ids + canonical; not in this fix's
  scope. Verify no regression, but do not change.
- Command/search output rendering as raw text (the other reported symptom) —
  separate fix (`commandExecution/outputDelta` routed as `text` kind).
- Removing the now-dead `collapseHydrationReplayTextDuplicates` — follow-up
  cleanup once this lands and soaks.

## Test plan

1. **Replay integration harness** (`apps/www/test/integration/`): record or
   craft a Codex run with streamed agent text + `item.completed`; assert the
   replayed transcript has exactly one agent message per logical message, no
   stacked duplicates. This is the authoritative gate.
2. **Daemon unit tests** (`codex.test.ts`, `daemon` suite): assert
   `item.completed` for `agent_message` flushes a final delta and emits no
   canonical `assistant-message`; assert the unknown-item-type default stays a
   no-op (existing invariant at daemon.ts:1628).
3. **ag-ui-mapper / publisher tests**: unchanged behavior for non-Codex.
4. **Manual**: reload + reconnect a finished Codex thread; confirm single
   render. Resume an active Codex thread mid-stream; confirm no dup on
   active→idle transition (the re-mount that currently multiplies copies).

## Risk & rollback

- **Risk:** dropping the canonical text event could lose text if an item
  produced zero deltas. Mitigated by step 3's fallback (emit under itemId).
- **Risk:** active→idle re-mount + replay ordering. Mitigated by the harness
  test covering exactly that transition.
- **Rollback:** revert the daemon changes; deltas + canonical both re-emit (back
  to duplicated-but-not-broken). No schema/migration changes, so rollback is
  code-only.

## Open question

Confirm the grep-output-as-text symptom is `commandExecution/outputDelta`
streamed as `text` kind (separate fix) vs. the model pasting search results into
its own message (no fix). Doesn't block this identity fix.
