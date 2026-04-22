# AG UI Cutover Checklist

## Current State

Terragon is not fully AG UI-canonical on `origin/main`.

Today the runtime is split across three layers:

```text
Daemon
  -> /api/daemon-event
       -> handleDaemonEvent(messages)
       -> DB thread/threadChat mutations
       -> token_stream_event
       -> broadcast user-message patches

Client reconnect
  -> /api/thread-replay
       -> transcript projection replay
       -> token_stream_event replay
```

The result is a hybrid system:

- terminal/chat state still enters through legacy `messages`
- token streaming is durable, but separate
- replay is split between `message-stream` and `token_stream_event`
- the UI renders projections around message-oriented state, not a single canonical AG UI event history

## Evidence In Code

- Daemon ingress payload still exposes `messages`, `deltas`, and `metaEvents`, with no `canonicalEvents` field:
  - `packages/daemon/src/shared.ts`
- Main daemon ingress still routes through `handleDaemonEvent(...)`:
  - `apps/www/src/app/api/daemon-event/route.ts`
  - `apps/www/src/server-lib/handle-daemon-event.ts`
- Token deltas now ride the canonical daemon-event ingress and persist through:
  - `apps/www/src/app/api/daemon-event/route.ts`
  - `packages/shared/src/model/token-stream-event.ts`
- Reconnect replay is split:
  - `apps/www/src/app/api/thread-replay/route.ts`
  - `apps/www/src/lib/message-stream.ts`
- Client realtime still reasons in terms of thread patches and delta accumulation:
  - `apps/www/src/hooks/useRealtime.ts`
  - `apps/www/src/hooks/useDeltaAccumulator.ts`
  - `apps/www/src/components/chat/chat-ui.tsx`

## Target End State

We should have one canonical runtime path:

```text
Daemon normalized event
  -> durable append-only AG UI event log
  -> deterministic projections
       -> transcript
       -> tool lifecycle / activity
       -> run graph
       -> artifacts
       -> meta chips
  -> live broadcast / replay from the same event history
  -> React renders projections, not legacy message transforms
```

What "fully using AG UI" means here:

- daemon sends canonical events, not legacy chat messages
- server persists canonical events as the authority
- replay comes from canonical event history or canonical projections, not `message-stream`
- UI surfaces are driven by first-class projections rather than `handleDaemonEvent`-shaped message mutations
- legacy `threadChat` message semantics become a compatibility projection, then disappear

## Checklist

### 1. Introduce a Canonical Ingress Contract

- Add `canonicalEvents` to `DaemonEventAPIBody` in `packages/daemon/src/shared.ts`.
- Define the exact allowed event families for the daemon-to-app boundary:
  - transcript/message lifecycle
  - tool lifecycle
  - run lifecycle
  - operational/meta
  - artifact/run-graph updates only if they cannot be derived downstream
- Keep `messages` as compatibility-only during migration.
- Fail closed on malformed canonical batches:
  - missing `runId`
  - invalid `seq`
  - mismatched `threadId` / `threadChatId`
  - impossible lifecycle ordering

Exit criteria:

- the daemon can post a canonical-only batch without `messages`
- the server rejects invalid canonical envelopes before any legacy mutation path runs

### 2. Normalize the Daemon Before Delivery

- Add a daemon-side normalization step that converts provider-specific output into canonical AG UI events before POST.
- Ensure the daemon flush order is:
  1. canonical events
  2. token deltas
  3. optional compatibility payloads
- Prevent any thread from emitting legacy completion state before its canonical run lifecycle is persisted.
- Keep retries thread-scoped and closed-loop so one thread’s failed canonical flush does not leak stale legacy progress.

Exit criteria:

- every provider path produces the same canonical run/transcript/tool lifecycle shape
- daemon logs can show canonical-only delivery for a run

### 3. Add a Durable Canonical Event Log

- Create a real append-only AG UI event store in `packages/shared/src/model`.
- Store:
  - `eventId`
  - `runId`
  - `threadId`
  - `threadChatId`
  - monotonic `seq`
  - event type/category
  - payload
  - timestamp
  - idempotency key
- Enforce:
  - idempotent replays by `eventId`
  - per-run sequence monotonicity
  - transaction-safe batch append semantics
- Do not treat Redis/pubsub as the source of truth.

Exit criteria:

- canonical events are durably queryable by run and thread
- duplicate delivery is safe
- out-of-order or conflicting sequence writes fail predictably

### 4. Replace `handleDaemonEvent` as the Authority

- Split `apps/www/src/app/api/daemon-event/route.ts` into:
  - canonical ingest and validation
  - compatibility bridge
  - legacy handler path
- Make canonical ingest the first-class path.
- Restrict `handleDaemonEvent(...)` to one of two temporary roles:
  - compatibility projection writer
  - legacy-only fallback for older daemons
- Stop coupling run lifecycle authority to `messages.length === 0` heartbeats and message arrays.

Exit criteria:

- canonical event ingestion can succeed without calling `handleDaemonEvent(...)`
- legacy handler is clearly marked compatibility-only and isolated

### 5. Unify Replay Around Canonical History

- Replace `message-stream` + `thread-replay` split replay with one canonical replay contract.
- Decide the replay source:
  - preferred: canonical event log + projection cursors
  - acceptable during migration: projection snapshots plus canonical event tail
- Remove the need for:
  - `apps/www/src/lib/message-stream.ts`
  - thread-level replay of raw message batches
- Fold `token_stream_event` into the canonical replay story:
  - either keep it as a specialized projection fed from canonical events
  - or absorb token chunks into canonical transcript events

Exit criteria:

- reconnect logic uses one replay endpoint and one cursor model
- no UI path needs both `fromSeq` and `fromDeltaSeq`

### 6. Build First-Class Projections

- Define explicit projections for:
  - transcript
  - run graph
  - activity/tool lifecycle
  - artifacts
  - meta chips
- Each projection should be reconstructible from canonical history.
- Remove projection logic that depends on mutating legacy `DBMessage[]` as the hidden source of truth.
- Keep transcript as one projection among peers, not the root domain model.

Exit criteria:

- run graph, artifacts, and activity can be rebuilt without `handleDaemonEvent` message mutation logic
- transcript rendering no longer owns side channels like tool lifecycle or run state implicitly

### 7. Move the Client to Projection-First Reads

- Update `apps/www/src/components/chat/chat-ui.tsx` and related hooks to consume projection data rather than legacy thread-chat semantics.
- Shrink `useDeltaAccumulator` and thread patch logic so they merge into canonical replay/projection state rather than patching raw message assumptions.
- Keep PartySocket/broadcast as transport only; it should carry projection deltas or canonical event notifications, not act as the source of truth.

Exit criteria:

- client reconnect/bootstrap reads the same projection model as live updates
- UI no longer depends on message-batch replay plus separate token replay to become consistent

### 8. Convert Legacy `threadChat` State Into Compatibility Data

- Audit every read/write still centered on:
  - `threadChat.messages`
  - `primaryThreadChat`
  - message-sequence assumptions
- Decide which fields survive as durable UX state versus compatibility-only mirrors.
- Migrate remaining consumers in:
  - thread shell queries
  - thread chat queries
  - chat UI
  - server actions that assume message-backed transcript ownership

Exit criteria:

- `threadChat.messages` is no longer the canonical runtime history
- `primaryThreadChat` becomes a UI convenience pointer, not an event authority

### 9. Remove the Legacy Path

- Delete or freeze:
  - `apps/www/src/server-lib/handle-daemon-event.ts` as a runtime authority
  - `apps/www/src/lib/message-stream.ts`
  - legacy replay code in `apps/www/src/app/api/thread-replay/route.ts`
  - legacy-only daemon message flush assumptions
- Keep a temporary compatibility adapter only if older deployed daemons still need it.

Exit criteria:

- daemon-event route is canonical-first
- replay is canonical-first
- legacy message ingestion is either removed or explicitly version-gated

## Recommended Order of Operations

1. Add canonical ingress contract and daemon normalization.
2. Land durable canonical event log with strict append semantics.
3. Make `/api/daemon-event` persist canonical events before any legacy handling.
4. Unify replay around canonical history and remove `message-stream` dependence.
5. Build deterministic projections for transcript, run graph, activity, artifacts, and meta.
6. Move the React client to projection-first reads.
7. Delete the legacy authority path.

## What Not To Do

- Do not treat token-stream durability as proof that AG UI cutover is complete.
- Do not add another ad hoc replay endpoint beside `daemon-event` and `thread-replay`.
- Do not let React read one model on initial load and a different model after realtime patches.
- Do not keep transcript/message mutations as the hidden source of truth while calling the system "AG UI".

## Ship Criteria For Full Cutover

We can say "we are fully using AG UI now" only when all of the following are true:

- daemon emits canonical events as the authoritative runtime payload
- server persists canonical events durably with sequence and idempotency guarantees
- replay/bootstrap comes from canonical history or canonical projections
- transcript, run graph, activity, artifacts, and meta are deterministic projections
- legacy message ingestion is no longer the authority path
- `threadChat.messages` is a compatibility view or removed entirely
