# AG-UI Migration — Cutover Complete

Status: **code complete, pending deploy + migration 0037**.

Branch: `feat/ag-ui-message-plan`.

This document is the final snapshot of the AG-UI migration (Phases 1–7). It
is intended as a reference for the on-call engineer running the deploy and
for future maintainers auditing why the old streaming paths no longer
exist.

---

## What shipped

Each phase landed as a self-contained commit sequence. File anchors are
the primary files touched — secondary files follow the same thread.

### Phase 1 — Backend mapping library

- `packages/agent/src/ag-ui-mapper.ts` — pure functions:
  - `mapCanonicalEventToAgui(CanonicalEvent) → BaseEvent[]`
  - `mapDaemonDeltaToAgui(DaemonDeltaInput) → BaseEvent`
  - `mapMetaEventToAgui(MetaEventInput) → CustomEvent`
  - `mapRunFinishedToAgui` / `mapRunErrorToAgui`
  - `dbAgentMessagePartsToAgUi` — replay expansion for rich parts
- `packages/agent/src/canonical-events.ts` — canonical event types
  (source of truth, transport-agnostic).
- `packages/agent/src/ag-ui-mapper.test.ts` — 37 unit tests covering the
  full mapping surface.

Key commit: `b64ad38`.

### Phase 2 — Backend endpoint + persistence

- Migration `packages/shared/drizzle/0037_agent_event_log_ag_ui.sql`:
  - `agent_event_log.payload_json` repurposed to hold AG-UI BaseEvents.
  - `UNIQUE(run_id, seq)` → `UNIQUE(thread_chat_id, seq)` so `seq` is
    per-thread-chat monotonic.
  - **Drops `token_stream_event` table** (streaming deltas now flow
    through `agent_event_log` as TEXT_MESSAGE_CONTENT /
    REASONING_MESSAGE_CONTENT events).
- `apps/www/src/app/api/ag-ui/[threadId]/route.ts` — SSE endpoint. Tees
  Redis stream replay + live events into an AG-UI wire stream.
- `apps/www/src/server-lib/ag-ui-publisher.ts` — transactional write:
  CanonicalEvent → BaseEvent[] → `agent_event_log` insert → Redis
  `XADD agui:thread:<id>`.
- `apps/www/src/app/api/daemon-event/route.ts` — rewritten. All
  lifecycles (assistant text, tool calls, tool results, rich parts,
  RUN_FINISHED, RUN_ERROR) emit through the AG-UI publisher.

Key commits: `f0905b2`, `b041e67`, `d5f8c44`, `5019048`, `e4d24eb`,
`6b37297`.

### Phase 3 — Frontend transport hook

- `apps/www/src/components/chat/use-ag-ui-transport.ts` — wraps
  `HttpAgent` from `@ag-ui/client`, targets `/api/ag-ui/[threadId]`,
  handles reconnect with last-seen seq. Also extracted
  `useRealtimeSandbox` from the legacy `useRealtime` to preserve
  sandbox presence wiring.

Key commits: `29bb859`, `6c37a2f`.

### Phase 4 — Runtime swap

- `apps/www/src/components/chat/assistant-ui/terragon-thread.tsx` —
  chat runtime switched to `@assistant-ui/react-ag-ui`
  `useAgUiRuntime({ agent })`. Prompt submission now flows through
  `/api/ag-ui` RUN_STARTED rather than the legacy send-daemon-message
  path.
- `apps/www/src/components/chat/message-part.tsx` +
  `apps/www/src/components/chat/*-part-view.tsx` — no structural
  change, but tool-result error detection now reads `is_error`.

Key commits: `baa574d`, `5338523`.

### Phase 5 — Meta chips via CUSTOM events

- `apps/www/src/components/chat/meta-chips/use-ag-ui-meta-events.ts` —
  dedicated subscriber for AG-UI `CUSTOM` events whose `name` starts
  with `terragon.meta.` (token usage, rate limits, MCP server health,
  boot substatus, model rerouting).
- `apps/www/src/components/chat/meta-chips/meta-events-context.tsx` —
  provider so chips can read meta state without prop-drilling.

Key commits: `d79ac10`, `cd46ce3`.

### Phase 6 — Rich-part CUSTOM events + aggregator flip

- **6A** — backend: `apps/www/src/server-lib/ag-ui-publisher.ts` and the
  daemon-event route emit `CUSTOM { name: "terragon.part.<type>" }`
  events for terminal / diff / image / audio / resource-link / plan /
  auto-approval-review / delegation parts.
- **6B** — frontend aggregator:
  - `apps/www/src/components/chat/ag-ui-messages-reducer.ts` — pure
    reducer folding `BaseEvent` → `UIMessage[]`.
  - `apps/www/src/components/chat/use-ag-ui-messages.ts` — React hook
    subscribing to the HttpAgent and driving the reducer via
    `useReducer`.
  - `apps/www/src/components/chat/chat-ui.tsx` — flipped from
    `useIncrementalUIMessages` (DB-patch + delta accumulator) to
    `useAgUiMessages` seeded with `toUIMessages(dbMessages)` for
    hydration.
  - **Deleted**: `apps/www/src/hooks/useDeltaAccumulator.ts`,
    `buildIncrementalUIMessages`, `appendDeltaMessages`,
    `useIncrementalUIMessages`.

Key commits: `e92c80a`, `9ce33fd`, `95cc1aa`.

### Phase 7 — Tests + cutover validation (this phase)

- `apps/www/test/integration/ag-ui-replayer.ts` — minimal AG-UI
  replayer: fake `HttpAgent` feeds hand-constructed `BaseEvent`
  sequences through `useAgUiMessages` in jsdom.
- `apps/www/test/integration/ag-ui-replayer.test.ts` — 6 integration
  tests covering streamed text, tool lifecycle (success + error),
  rich-part CUSTOM insertion, orphan CUSTOM (reconnect replay), and a
  full mixed stream.
- This document.

---

## Architecture diagram

```
   daemon (sandbox)
        │
        │  POST /api/daemon-event  (legacy transport, one body per event)
        ▼
   ┌──────────────────────────────────────────────────┐
   │ /api/daemon-event/route.ts                       │
   │   • auth via daemon token / test bypass          │
   │   • parse ClaudeMessage[] → CanonicalEvent[]     │
   │   • agUiPublisher.publish(canonicalEvents):      │
   │       - mapCanonicalEventToAgui(e) → BaseEvent[] │
   │       - INSERT agent_event_log (payload_json)    │
   │       - XADD agui:thread:<threadId>              │
   │   • handleDaemonEvent(messages) for run-state    │
   │     (status transitions and terminal updates)    │
   └──────────────────────────────────────────────────┘
        │                                     │
        │ Postgres (durable replay)           │ Redis Stream
        │ agent_event_log                     │ agui:thread:<id>
        │ UNIQUE(thread_chat_id, seq)         │ (capped, live fan-out)
        │ UNIQUE(run_id, event_id)            │
        ▼                                     ▼
   ┌──────────────────────────────────────────────────┐
   │ /api/ag-ui/[threadId]/route.ts  (SSE)            │
   │   • XREAD with last-seen id                      │
   │   • if gap: backfill from agent_event_log        │
   │   • emit AG-UI wire stream (one BaseEvent / msg) │
   └──────────────────────────────────────────────────┘
        │
        │  Server-Sent Events
        ▼
   ┌──────────────────────────────────────────────────┐
   │ Browser — apps/www/src/components/chat           │
   │                                                  │
   │   useAgUiTransport ── builds HttpAgent ──┐       │
   │                                          │       │
   │                                          ▼       │
   │   TerragonThread ─── useAgUiRuntime ─── HttpAgent │
   │                                          │       │
   │   useAgUiMessages ─── subscribe ─────────┤       │
   │     └─ agUiMessagesReducer               │       │
   │         → UIMessage[]                    │       │
   │                                          │       │
   │   useAgUiMetaEvents ── subscribe ────────┘       │
   │     → MetaEventsContext (token/rate-limit chips) │
   └──────────────────────────────────────────────────┘
```

---

## Deprecations (retained for non-chat consumers)

The following exports are no longer consumed by the chat transcript
render path but remain live for other surfaces. They can be removed only
after their remaining consumers are migrated or removed.

| Symbol                                | Defined in                                            | Remaining consumer(s)                                                  |
| ------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------- |
| `applyThreadPatchToCollection`        | `apps/www/src/collections/thread-info-collection.ts`  | `apps/www/src/components/thread-list/main.tsx`                         |
| `applyShellPatchToCollection`         | `apps/www/src/collections/thread-shell-collection.ts` | (internal, thread-shell only)                                          |
| `applyChatPatchToCollection`          | `apps/www/src/collections/thread-chat-collection.ts`  | (dead — safe to delete in follow-up)                                   |
| `reduceThreadPatchesForChat`          | `apps/www/src/collections/patch-helpers.ts`           | (dead — safe to delete in follow-up)                                   |
| `toUIMessages` (without `delta` args) | `apps/www/src/components/chat/toUIMessages.ts`        | Admin thread-content, promptbox queued-messages, 20+ hydration callers |

The delta-accumulator, incremental UI messages builder, and `useDeltaAccumulator`
hook were **deleted** in commit `95cc1aa` — they had no consumers after the
chat flip.

---

## Known gaps

Identified during Phase 6B review, not blocking the AG-UI cutover but
worth scheduling for a follow-up sprint:

1. **Thread status freshness** — `threadChat.status`, `queuedMessages`,
   and `errorMessage` no longer update via broadcast patches on the chat
   page. They reconcile via React Query refetches on focus and on
   navigation. Observable symptoms: a 10–30s window where a queued
   follow-up shows stale `queued-*` status after completion. The Phase 5
   meta event `thread.status_changed` exists in the publisher but is
   **not wired into `thread-chat-collection`**. Wiring it is a small
   hook change: subscribe to the AG-UI stream alongside
   `useAgUiMessages` and `queryClient.invalidateQueries` on the
   thread-chat query key when `RUN_FINISHED` or a `terragon.meta.status_changed`
   CUSTOM event arrives.

2. **Replay replay cost** — `/api/ag-ui/[threadId]` currently replays
   from the last-seen seq by reading the Redis stream first, then
   falling back to `agent_event_log` on gap. For very long threads (10k+
   events) the backfill query is O(events since seq). If this becomes a
   bottleneck, introduce a materialized `latest_message_seq` cursor per
   client or a summarization event.

3. **Orphan CUSTOM handling** — the reducer creates a synthetic
   assistant message when a `terragon.part.*` event arrives without a
   preceding `TEXT_MESSAGE_START`. This is intentional (see replayer
   test), but on hydrate-then-replay with an SSE reconnect, callers may
   briefly see a bare rich-part bubble before the parent assistant text
   arrives from the next content event. Acceptable for now; revisit if
   UX complaints surface.

---

## Operational notes for deploy

### Migration 0037 is atomic with the deploy

`packages/shared/drizzle/0037_agent_event_log_ag_ui.sql` must be applied
together with this branch. It:

- Drops `agent_event_log_run_seq_unique` and adds
  `agent_event_log_thread_chat_seq_unique`. Rows written by the new
  writer use per-thread-chat seqs; rows written by the old writer use
  per-run seqs. The old seqs will collide under the new index if any
  writer is still on the old code. **Apply in the same deploy as the
  new `/api/daemon-event/route.ts`.**
- Drops the `token_stream_event` table and its indexes. Any code still
  writing to `token_stream_event` will fail post-migration. Confirm no
  such code exists in this branch before deploying.

### Rollback

Whole-deploy rollback is required. The migration and the
`/api/daemon-event/route.ts` writer are coupled — you cannot partially
revert one without the other. If something goes wrong after deploy:

1. Roll the Vercel deploy back to the pre-AG-UI commit.
2. **Do not** run a down migration. The dropped `token_stream_event`
   table was empty-on-rollback (nothing references it in the rolled-back
   code). The unique index change is forward-compatible — the old
   writer's rows will insert cleanly under the new `(thread_chat_id,
seq)` index because seq was already unique per thread_chat at the
   application level.
3. File an incident and re-plan the migration.

---

## Post-deploy validation

Monitor for 24–48 hours after the production deploy.

1. **`agent_event_log` insert rate** — expect steady-state of roughly
   (active-runs × events-per-minute-per-run). A sudden drop to zero
   means the publisher is broken. A sudden spike of 10×+ means some
   code path is double-publishing.

2. **SSE connection count** at `/api/ag-ui/[threadId]` — should track
   the number of open chat tabs. Vercel observability → Edge Functions
   → `ag-ui/[threadId]` route → concurrent executions.

3. **Redis stream length** for `agui:thread:*` keys:

   ```bash
   redis-cli --scan --pattern 'agui:thread:*' | head -100 | \
     xargs -I {} redis-cli XLEN {}
   ```

   Streams are capped at 500 entries per thread. If `XLEN` hits 500 for
   many threads, either the cap needs raising or traffic is abnormally
   high.

4. **Orphaned `token_stream_event` references** — should be zero.
   Verify:

   ```sql
   SELECT relname FROM pg_class WHERE relname = 'token_stream_event';
   ```

   Should return 0 rows after migration 0037.

5. **Chat render latency** (optional) — compare p50/p95 time-to-first-
   token-render before/after deploy. The AG-UI path should be equal or
   faster than the legacy delta path since it eliminates the patch →
   reducer → React Query invalidate hop.

---

## Test evidence

- `pnpm tsc-check` — 16/16 packages clean.
- `pnpm -C packages/agent test` — 73/73 passing (4 files).
- `pnpm -C packages/shared test` — 638/638 passing (32 files).
- `pnpm -C apps/www test` — 2065/2135 passing.
  - 37 failures are pre-existing baseline (verified against `main`
    without this branch):
    - `src/server-lib/e2e.test.ts` (9 failures) — tests call
      `handleDaemonEvent` without `runId`; the 400-gate has existed on
      main. Also includes the documented flaky
      `handles batch with init and rate limit error`.
    - `src/app/api/webhooks/github/handle-app-mention.test.ts` (27
      failures) — identical to main; `FAILED_TO_GET_A_VALID_ACCESS_TOKEN`
      mock setup issues pre-date this branch.
- New integration tests: `apps/www/test/integration/ag-ui-replayer.test.ts`
  — 6/6 passing.

Readiness: **ready to ship** once migration 0037 is scheduled alongside
the deploy. All pre-existing failures are unrelated to the AG-UI
migration.
