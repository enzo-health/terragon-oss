# Plan: Real-Time Streaming Architecture

**Generated**: 2026-03-20
**Estimated Complexity**: High

## Overview

Replace the current DB-patch-based real-time messaging system with a direct streaming architecture that delivers agent output to clients with minimal latency. The current system writes messages to DB first, then publishes patches via PartyKit — causing race conditions, cache reconciliation failures, and visible latency (text doesn't appear until page refresh).

**Approach**: Keep the daemon→server→DB persistence path, but add a parallel daemon→broadcast→client streaming path for immediate display. Migrate one concern at a time (messages first, then status updates). Support token-level streaming for both ACP (Claude) and Codex app-server transports.

## Current Architecture (Problems)

```
Daemon ──HTTP POST──→ /api/daemon-event ──→ DB write ──→ publishBroadcast ──→ PartyKit ──→ Client
                                                              ↑
                                                    Transform to patch
                                                    (chatSequence, expectedMessageCount,
                                                     appendMessages, tailMatchesAppend...)
```

- **~900 lines** of patch reconciliation in `thread-patch-cache.ts`
- `expectedMessageCount` mismatch → falls back to refetch
- `chatSequence` is timestamp-based, not monotonic
- Rapid consecutive patches race with each other and background refetches
- No token-level streaming — chunks arrive per flush (250ms-1000ms batches)

## Target Architecture

```
                    ┌─── STREAMING PATH (fast, ephemeral) ────────────────────┐
                    │                                                          │
Daemon ──HTTP POST──┤──→ /api/daemon-event ──→ PartyKit room ──→ Client       │
                    │         │                   (stateful,                   │
                    │         │                    buffered,                   │
                    │         │                    seq-numbered)               │
                    │         │                                                │
                    │         └─── PERSISTENCE PATH (durable, async) ──→ DB   │
                    └──────────────────────────────────────────────────────────┘
```

**Key change**: PartyKit room becomes a **stateful message buffer** with monotonic sequence numbers. Client applies messages via simple append. DB write and broadcast happen in the same server endpoint but are decoupled — the client doesn't depend on the DB write completing to see messages.

## Prerequisites

- PartyKit server (`apps/broadcast/`) — currently stateless, needs to become stateful
- Understanding of both agent transport paths:
  - **ACP** (Claude): SSE streaming via sandbox-agent, token-level content blocks
  - **Codex app-server**: JSON-RPC WebSocket, `item/agentMessage/delta` for token deltas
- Redis (already deployed) — used for sequence numbers and cross-process coordination
- Feature flag infrastructure (already exists) for rollout

## Sprint 1: Monotonic Sequences + Stateful PartyKit Room

**Goal**: Replace timestamp-based `chatSequence` with monotonic counters and make the PartyKit room buffer messages for replay.

**Demo/Validation**:
- Connect two browser tabs to same thread — both see messages in order
- Disconnect tab, reconnect — replays missed messages without DB refetch
- `pnpm -C apps/www test -- thread-patch-cache`

### Task 1.1: Add monotonic sequence counter

- **Location**: `packages/shared/src/model/threads.ts`, `packages/shared/src/db/schema.ts`
- **Description**: Add `messageSeq` integer column to `threadChat` table. Increment atomically on each message append using `SET messageSeq = messageSeq + 1 RETURNING messageSeq`. Replace `chatSequence = updatedAt.getTime()` with the returned `messageSeq`.
- **Dependencies**: None
- **Acceptance Criteria**:
  - `messageSeq` increments by 1 per `updateThreadChat` call with `appendMessages`
  - Patch includes `chatSequence: messageSeq` (integer, not timestamp)
  - Existing `usesTimestampChatSequence` logic handles migration (old patches still work)
- **Validation**:
  - `pnpm -C packages/shared test`
  - `pnpm -C apps/www test -- thread-patch-cache`

### Task 1.2: Make PartyKit room stateful with message buffer

- **Location**: `apps/broadcast/src/server.ts`
- **Description**: Add per-room in-memory message buffer (capped at last 500 messages). On `onRequest` POST, push messages to buffer with sequence number. On `onConnect`, replay messages from client's `lastSeq` query param.
- **Dependencies**: Task 1.1
- **Acceptance Criteria**:
  - Room stores messages in memory array with seq numbers
  - New connections receive replay of missed messages
  - Buffer capped at 500 messages (configurable)
  - Buffer cleared when room hibernates (client reconnect falls back to DB)
- **Validation**:
  - Integration test: connect, disconnect, reconnect with lastSeq → get missed messages
  - `pnpm -C apps/broadcast test`

### Task 1.3: Simplify client patch application with seq-based append

- **Location**: `apps/www/src/queries/thread-patch-cache.ts`
- **Description**: Add a new fast path for patches with integer `chatSequence`: if `incoming.seq === cached.seq + 1`, append directly (no `expectedMessageCount`, no `tailMatchesAppend`). If gap detected, request replay from PartyKit room. Keep existing timestamp-based path as fallback.
- **Dependencies**: Task 1.1, Task 1.2
- **Acceptance Criteria**:
  - Sequential patches applied without any invalidation/refetch
  - Sequence gaps trigger replay request (not DB refetch)
  - Duplicate sequences ignored
  - Existing timestamp path still works (backwards compat)
- **Validation**:
  - Unit test: rapid consecutive patches applied correctly
  - Unit test: gap triggers replay request
  - `pnpm -C apps/www test -- thread-patch-cache`

### Task 1.4: Update useRealtime to support replay on reconnect

- **Location**: `apps/www/src/hooks/useRealtime.ts`
- **Description**: Track `lastSeq` per thread. On WebSocket reconnect, send `lastSeq` as query param. Handle replay messages (bulk append). Remove user-level 1000ms debounce for thread patches (now that sequences prevent duplicates).
- **Dependencies**: Task 1.2, Task 1.3
- **Acceptance Criteria**:
  - Reconnect sends `lastSeq` to PartyKit
  - Replay messages applied to cache correctly
  - No 1000ms debounce on thread message patches
- **Validation**:
  - Manual: kill WebSocket, reconnect → messages appear without refresh

---

## Sprint 2: Daemon Message Streaming (Decouple Display from Persistence)

**Goal**: Make messages appear in the UI as soon as the server receives them from the daemon, without waiting for DB write completion.

**Demo/Validation**:
- Agent message appears in <100ms of daemon POST (vs current ~500ms-2s)
- DB write failure doesn't prevent message display
- `pnpm -C apps/www test -- daemon-event`

### Task 2.1: Broadcast before DB write in daemon-event route

- **Location**: `apps/www/src/app/api/daemon-event/route.ts`
- **Description**: In `handleDaemonEvent`, publish the broadcast patch with `appendMessages` BEFORE the DB transaction. Mark messages as "unconfirmed" in the patch. After DB write succeeds, publish a confirmation patch (just the seq number, no message data).
- **Dependencies**: Sprint 1
- **Acceptance Criteria**:
  - Messages broadcast to PartyKit within 10ms of daemon POST arrival
  - DB write happens async after broadcast
  - Confirmation patch sent after DB write
  - If DB write fails, error patch sent (client can show warning indicator)
- **Validation**:
  - Timing test: measure broadcast latency vs current
  - `pnpm -C apps/www test -- daemon-event`

### Task 2.2: Client optimistic rendering with confirmation

- **Location**: `apps/www/src/queries/thread-patch-cache.ts`, `apps/www/src/components/chat/`
- **Description**: Apply "unconfirmed" messages to the cache immediately (optimistic rendering). When confirmation arrives, mark as confirmed. If error arrives, show warning but keep message visible (it may be retried by daemon).
- **Dependencies**: Task 2.1
- **Acceptance Criteria**:
  - Messages render immediately on broadcast receipt
  - No visual difference between confirmed/unconfirmed (optional: subtle indicator)
  - Error state shown only if persistence permanently fails
- **Validation**:
  - Visual: messages appear instantly during streaming
  - `pnpm -C apps/www test -- thread-patch-cache`

### Task 2.3: Normalize daemon message format for both ACP and Codex

- **Location**: `apps/www/src/app/api/daemon-event/route.ts`, `packages/shared/src/model/threads.ts`
- **Description**: Ensure the broadcast patch format works identically for messages from both transport paths. The daemon already normalizes both ACP and Codex events into `ClaudeMessage[]` / `DBMessage[]` format — verify the broadcast path handles all message types (assistant, thinking, tool-use, tool-result, system, meta).
- **Dependencies**: Task 2.1
- **Acceptance Criteria**:
  - ACP messages (Claude) broadcast correctly with all content block types
  - Codex messages (app-server) broadcast correctly including thinking blocks + text
  - Message format in broadcast matches DB format (so cache → refresh is seamless)
- **Validation**:
  - Integration test with both agent types
  - Verify refresh after streaming shows identical content

---

## Sprint 3: Token-Level Streaming

**Goal**: Stream individual tokens/deltas to the client so text appears character by character.

**Demo/Validation**:
- Text appears character by character in the chat UI
- Works for both Claude (ACP) and Codex (`agentMessage/delta`)
- Streaming stops cleanly when agent completes

### Task 3.1: Add delta message type to broadcast protocol

- **Location**: `packages/types/src/broadcast.ts`, `apps/broadcast/src/server.ts`
- **Description**: Add a new patch operation `"delta"` that carries partial text updates for an in-progress message. Format: `{ op: "delta", messageId, partIndex, text, seq }`. PartyKit room buffers these separately (not in the main message buffer — deltas are ephemeral and replaced by the complete message).
- **Dependencies**: Sprint 2
- **Acceptance Criteria**:
  - Delta patches flow through PartyKit to clients
  - Deltas are NOT persisted to DB (ephemeral display only)
  - Complete message replaces accumulated deltas when `item.completed` arrives
  - PartyKit room does NOT replay deltas on reconnect (only complete messages)
- **Validation**:
  - Unit test: delta accumulation → replacement with complete message

### Task 3.2: Daemon streams deltas for ACP (Claude)

- **Location**: `packages/daemon/src/daemon.ts`, `apps/www/src/app/api/daemon-event/route.ts`
- **Description**: For ACP transport, Claude streams content blocks via SSE. The daemon currently buffers these and flushes periodically. Add a new endpoint or extend daemon-event to accept delta payloads. The daemon sends deltas as they arrive from the ACP SSE stream (content_block_delta events), and the server broadcasts them immediately without DB write.
- **Dependencies**: Task 3.1
- **Acceptance Criteria**:
  - Claude text streaming appears character by character in UI
  - Thinking block content streams incrementally
  - Tool results still arrive as complete messages (not streamed)
- **Validation**:
  - Manual: run Claude agent, observe text streaming in UI

### Task 3.3: Daemon streams deltas for Codex (app-server)

- **Location**: `packages/daemon/src/daemon.ts`, `packages/daemon/src/codex-app-server.ts`
- **Description**: For Codex app-server transport, `item/agentMessage/delta` notifications carry incremental text. Route these through the same delta broadcast path as ACP. The daemon already parses these as `item.updated` events (from our earlier work) — extend to also emit delta broadcasts.
- **Dependencies**: Task 3.1
- **Acceptance Criteria**:
  - Codex text streaming appears in UI as deltas arrive
  - Works with WebSocket transport (already implemented)
  - Delta text matches final `item.completed` text
- **Validation**:
  - Manual: run Codex agent, observe text streaming in UI

### Task 3.4: Client-side delta rendering

- **Location**: `apps/www/src/components/chat/toUIMessages.ts`, `apps/www/src/components/chat/text-part.tsx`
- **Description**: Add delta accumulator to the message state. When delta patches arrive, append text to the in-progress message part. When the complete message arrives (non-delta patch), replace the accumulated delta with the final content. Streamdown (the markdown renderer) already handles streaming input.
- **Dependencies**: Task 3.1
- **Acceptance Criteria**:
  - Delta text appears immediately in the chat UI
  - Markdown renders progressively (Streamdown supports this)
  - Complete message seamlessly replaces delta accumulation
  - No flicker or duplicate content during transition
- **Validation**:
  - Visual: smooth text streaming for both Claude and Codex
  - Unit test: delta accumulation → complete message replacement

---

## Sprint 4: Cleanup + Migration

**Goal**: Remove legacy patch reconciliation code, migrate all message delivery to the new streaming path.

**Demo/Validation**:
- `thread-patch-cache.ts` reduced from ~900 lines to ~200
- All tests pass
- No regressions on message delivery

### Task 4.1: Remove legacy patch reconciliation

- **Location**: `apps/www/src/queries/thread-patch-cache.ts`
- **Description**: Remove `expectedMessageCount`, `tailMatchesAppend`, timestamp-based `chatSequence` fallback, and the multiple invalidation paths. The seq-based fast path from Sprint 1 becomes the only path.
- **Dependencies**: Sprint 3 complete and verified in production
- **Acceptance Criteria**:
  - `applyChatFields` uses only seq-based logic
  - No `shouldInvalidate: true` for message appends (only for explicit refetch requests)
  - File reduced significantly
- **Validation**:
  - `pnpm -C apps/www test -- thread-patch-cache`
  - Soak test in production for 1 week

### Task 4.2: Remove user-level broadcast debounce

- **Location**: `apps/www/src/hooks/useRealtime.ts`
- **Description**: Remove the 1000ms `maxWait` debounce on `useRealtimeUser`. With monotonic sequences and dedup, there's no need for debouncing.
- **Dependencies**: Task 4.1
- **Acceptance Criteria**:
  - All broadcasts arrive immediately
  - No duplicate processing (seq dedup handles this)
- **Validation**:
  - `pnpm -C apps/www test`

### Task 4.3: Evaluate PartyKit replacement

- **Location**: `apps/broadcast/`
- **Description**: With the room now stateful (message buffer, seq tracking), evaluate whether PartyKit is still the right fit or if a simpler WebSocket server (e.g., built into the Next.js app via `ws` library, or a standalone Hono/Elysia server) would be better. PartyKit's hibernation model conflicts with stateful rooms. Document findings and recommendation.
- **Dependencies**: Sprint 3
- **Acceptance Criteria**:
  - Written comparison of PartyKit vs alternatives (cost, complexity, latency)
  - Recommendation with rationale
  - If replacing: migration plan as a separate epic
- **Validation**:
  - Design doc reviewed by team

---

## Testing Strategy

### Per-Sprint
- **Sprint 1**: Unit tests for seq-based cache application, integration test for PartyKit replay
- **Sprint 2**: Timing tests for broadcast latency, integration test for optimistic rendering
- **Sprint 3**: Visual validation of streaming for both ACP and Codex, unit tests for delta accumulation
- **Sprint 4**: Full regression suite, soak test in production

### Cross-Cutting
- **Both transports**: Every feature tested with Claude (ACP) AND Codex (app-server)
- **Reconnection**: Disconnect/reconnect during streaming — messages resume correctly
- **Multiple tabs**: Two tabs on same thread — both see messages in real-time
- **Page refresh**: After streaming, refresh shows identical content from DB

## Potential Risks & Gotchas

1. **PartyKit hibernation vs stateful rooms**: PartyKit's `hibernate: true` setting may evict room state. Need to either disable hibernation for active rooms or accept that cold reconnects fall back to DB. Test with Cloudflare Workers memory limits.

2. **Delta → complete message race**: If the complete message arrives before all deltas are processed, the client could briefly show partial content then jump to full content. Solution: complete message always wins — overwrite delta state entirely.

3. **DB write failure after broadcast**: Client sees message but it's not persisted. On refresh, message disappears. Mitigation: retry DB write, and if permanently failed, show error indicator. The daemon will also retry on its end.

4. **Message ordering across daemon restarts**: If daemon crashes and restarts, seq numbers from the new daemon session may not align. Solution: seq is server-side (Redis counter), not daemon-side.

5. **Large message buffers in PartyKit**: If an agent produces 500+ messages, the room buffer becomes expensive. Cap buffer size and fall back to DB for anything older.

6. **ACP delta format differs from Codex delta format**: ACP sends `content_block_delta` with structured content blocks, Codex sends `agentMessage/delta` with plain text. The daemon must normalize both into a common delta format before broadcasting.

7. **Backward compatibility during rollout**: Old daemon versions (in existing sandboxes) won't send deltas. The system must handle both old (batch) and new (streaming + batch) daemon versions gracefully.

## Rollback Plan

Each sprint is independently deployable and reversible:
- **Sprint 1**: Revert `messageSeq` column (add migration to drop). Revert PartyKit room to stateless. Seq-based path was behind a code check, remove it.
- **Sprint 2**: Remove broadcast-before-DB-write. Patches go back to after-DB-write path.
- **Sprint 3**: Remove delta handling. Messages go back to chunk-level delivery.
- **Sprint 4**: Re-add legacy code (git revert).

Feature flags for each sprint milestone allow per-user rollback in production.

## Key Files

| File | Role |
|------|------|
| `apps/broadcast/src/server.ts` | PartyKit server — stateless relay → stateful buffer |
| `packages/shared/src/broadcast-server.ts` | `publishBroadcastUserMessage()` |
| `packages/types/src/broadcast.ts` | `BroadcastThreadPatch` type definitions |
| `apps/www/src/hooks/useRealtime.ts` | Client WebSocket connection + message handling |
| `apps/www/src/queries/thread-patch-cache.ts` | Patch reconciliation (~900 lines) |
| `apps/www/src/app/api/daemon-event/route.ts` | Daemon event processing endpoint |
| `packages/shared/src/model/threads.ts` | `updateThreadChat` + patch publishing |
| `packages/daemon/src/daemon.ts` | Message buffering + flushing |
| `packages/daemon/src/codex-app-server.ts` | Codex WebSocket transport + deltas |
| `apps/www/src/components/chat/toUIMessages.ts` | DBMessage → UIMessage conversion |
| `apps/www/src/components/chat/text-part.tsx` | Text rendering (Streamdown) |
