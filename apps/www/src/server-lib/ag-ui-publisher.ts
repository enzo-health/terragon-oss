import {
  EventType,
  type BaseEvent,
  type ReasoningMessageEndEvent,
  type ReasoningMessageStartEvent,
  type TextMessageEndEvent,
  type TextMessageStartEvent,
} from "@ag-ui/core";
import {
  dbAgentMessagePartsToAgUi,
  mapCanonicalEventToAgui,
  mapDaemonDeltaToAgui,
  mapMetaEventToAgui,
  mapRunErrorToAgui,
  mapRunFinishedToAgui,
  serializeAgUiEvent,
} from "@terragon/agent/ag-ui-mapper";
import type { DBAgentMessagePart } from "@terragon/shared";
import type { CanonicalEvent } from "@terragon/agent/canonical-events";
import type { DaemonEventAPIBody } from "@terragon/daemon/shared";
import {
  agUiStreamKey,
  appendAgUiEventRow,
  peekNextThreadChatSeqLocked,
} from "@terragon/shared/model/agent-event-log";
import type { DB } from "@terragon/shared/db";
import { publicBroadcastUrl } from "@terragon/env/next-public";
import { env } from "@terragon/env/apps-www";
import { redis } from "@/lib/redis";

/**
 * Shape of a single AG-UI event to be persisted + streamed.
 *
 * `eventId` is the row-level idempotency key on (runId, eventId). Different
 * AG-UI events derived from the same canonical event must have distinct
 * eventIds — callers append both the AG-UI event type AND a 0-based
 * expansion index (see `buildAgUiEventId`) so two events of the same type
 * from the same source (e.g. progressive TOOL_CALL_ARGS chunks) never
 * collide on insert.
 */
type AgUiPublishRow = {
  event: BaseEvent;
  eventId: string;
  timestamp: Date;
};

export type PersistAndPublishResult = {
  inserted: number;
  skipped: number;
  /**
   * eventIds of rows that were freshly inserted (skipped duplicates are NOT
   * included). Callers that need to backfill `thread_chat_message_seq` use
   * this list — it's the authoritative record from the persist layer and
   * never drifts from the mapper output.
   */
  insertedEventIds: string[];
};

function getPartyKitPublishUrl(): string | null {
  if (process.env.NODE_ENV === "test") return null;
  const raw = publicBroadcastUrl();
  if (!raw) return null;
  const url = new URL(raw);
  if (url.protocol === "ws:") url.protocol = "http:";
  else if (url.protocol === "wss:") url.protocol = "https:";
  return url.toString().replace(/\/$/, "");
}

async function publishAgUiToPartyKit(
  threadChatId: string,
  events: BaseEvent[],
): Promise<void> {
  if (events.length === 0) return;
  const baseUrl = getPartyKitPublishUrl();
  if (!baseUrl) return;
  try {
    await fetch(`${baseUrl}/parties/agui/${threadChatId}`, {
      method: "POST",
      body: JSON.stringify(events),
      headers: { "X-Terragon-Secret": env.INTERNAL_SHARED_SECRET },
    });
  } catch (err) {
    console.warn("[ag-ui-publisher] PartyKit publish failed", {
      threadChatId,
      eventCount: events.length,
      error: err,
    });
  }
}

/**
 * Persist each AG-UI row to `agent_event_log` and publish to
 * `agui:thread:{threadChatId}` in the order provided.
 *
 * ## Contract
 * - Seq is assigned per-thread-chat under a transaction-scoped advisory lock
 *   (see `peekNextThreadChatSeqLocked`).
 * - Duplicates are skipped silently (idempotency key: runId + eventId).
 * - XADD publishing happens AFTER tx commit so readers never see a stream
 *   event before the corresponding DB row.
 *
 * ## XADD failure policy (see C2 in Task 2C code review)
 * The DB is the source of truth; Redis is a live-tail optimization. On the
 * first XADD failure we log at error severity and STOP publishing remaining
 * events in the batch — out-of-order stream arrival is worse than a gap,
 * because the SSE reader's `XREAD $` cursor would advance past missing
 * entries. Clients recover the gap via replay-from-seq on reconnect using
 * the DB as source of truth.
 */
export async function persistAndPublishAgUiEvents(params: {
  db: DB;
  runId: string;
  threadId: string;
  threadChatId: string;
  rows: AgUiPublishRow[];
}): Promise<PersistAndPublishResult> {
  const { db, runId, threadId, threadChatId, rows } = params;
  if (rows.length === 0) {
    return { inserted: 0, skipped: 0, insertedEventIds: [] };
  }

  let inserted = 0;
  let skipped = 0;
  const insertedEventIds: string[] = [];
  const persistedEvents: BaseEvent[] = [];

  await db.transaction(async (tx) => {
    const startSeq = await peekNextThreadChatSeqLocked({
      tx,
      threadChatId,
      count: rows.length,
    });

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      const seq = startSeq + i;
      const result = await appendAgUiEventRow({
        tx,
        row: {
          eventId: row.eventId,
          runId,
          threadId,
          threadChatId,
          seq,
          eventType: String(row.event.type),
          // AG-UI BaseEvent has no explicit category; reuse event type as a
          // stable proxy. Readers project via readAgUiPayload anyway.
          category: String(row.event.type),
          payload: row.event,
          idempotencyKey: `${runId}:${row.eventId}`,
          timestamp: row.timestamp,
        },
      });
      if (result.inserted) {
        inserted += 1;
        insertedEventIds.push(row.eventId);
        persistedEvents.push(row.event);
      } else {
        skipped += 1;
      }
    }
  });

  // Publish after commit. See "XADD failure policy" in the function header:
  // first failure halts the remaining publishes.
  const streamKey = agUiStreamKey(threadChatId);
  for (let i = 0; i < persistedEvents.length; i++) {
    const event = persistedEvents[i]!;
    try {
      await redis.xadd(streamKey, "*", {
        event: serializeAgUiEvent(event),
      });
    } catch (err) {
      console.error(
        "[ag-ui-publisher] XADD failed — halting live-tail publish for this batch; clients will recover via SSE replay-from-seq",
        {
          threadChatId,
          streamKey,
          eventType: String(event.type),
          publishedCount: i,
          remainingCount: persistedEvents.length - i,
          insertedEventIdRange:
            insertedEventIds.length > 0
              ? {
                  first: insertedEventIds[0],
                  last: insertedEventIds[insertedEventIds.length - 1],
                }
              : null,
          error: err,
        },
      );
      break;
    }
  }

  // Dual-write: also publish to PartyKit for WebSocket clients.
  // Fire-and-forget — PartyKit is a live-tail optimization, not source of truth.
  void publishAgUiToPartyKit(threadChatId, persistedEvents);

  return { inserted, skipped, insertedEventIds };
}

/**
 * Fire-and-forget XADD for a single AG-UI event (no DB write). Used for
 * meta events (CUSTOM) and terminal run markers (RUN_FINISHED/RUN_ERROR)
 * that are ephemeral by design.
 */
export async function broadcastAgUiEventEphemeral(params: {
  threadChatId: string;
  event: BaseEvent;
}): Promise<void> {
  const streamKey = agUiStreamKey(params.threadChatId);
  try {
    await redis.xadd(streamKey, "*", {
      event: serializeAgUiEvent(params.event),
    });
  } catch (err) {
    console.error("[ag-ui-publisher] ephemeral XADD failed", {
      threadChatId: params.threadChatId,
      streamKey,
      eventType: String(params.event.type),
      error: err,
    });
  }
  void publishAgUiToPartyKit(params.threadChatId, [params.event]);
}

// ---------------------------------------------------------------------------
// Mapping helpers — turn daemon-event inputs into persist-ready rows
// ---------------------------------------------------------------------------

/**
 * Expand canonical events to AG-UI rows. Each canonical event may produce
 * 1..3 AG-UI rows (e.g. assistant-message → START + CONTENT + END;
 * tool-call-start → START + ARGS + END).
 *
 * Each row gets a stable `eventId` combining the source canonical eventId,
 * the AG-UI event type, and a 0-based expansion index. The index is
 * essential: if a canonical event ever expands to two rows of the same type
 * (progressive TOOL_CALL_ARGS chunks, split content events, etc.), dedupe
 * on (runId, eventId) must still distinguish them.
 */
export function canonicalEventsToAgUiRows(
  events: CanonicalEvent[],
): AgUiPublishRow[] {
  const rows: AgUiPublishRow[] = [];
  for (const event of events) {
    const expanded = mapCanonicalEventToAgui(event);
    const ts = new Date(event.timestamp);
    for (let i = 0; i < expanded.length; i++) {
      const agUi = expanded[i]!;
      rows.push({
        event: agUi,
        eventId: buildAgUiEventId(event.eventId, String(agUi.type), i),
        timestamp: ts,
      });
    }
  }
  return rows;
}

/**
 * Convert a batch of daemon deltas to AG-UI content rows. Each delta becomes
 * one TEXT_MESSAGE_CONTENT or REASONING_MESSAGE_CONTENT row. We synthesize a
 * per-delta eventId from the composite (runId:messageId:partIndex:deltaSeq)
 * so retries from the daemon dedupe on (runId, eventId).
 *
 * AG-UI's strict lifecycle requires every CONTENT event to be bracketed by a
 * matching _START and _END. The daemon delta channel only carries content
 * chunks, so this helper synthesizes a per-(messageId, kind) START event on
 * the FIRST delta seen for that pair within the batch and prepends it to the
 * output. Duplicate STARTs across batches are cheap and client-tolerant (the
 * reducer treats a repeated START for an already-active message as a no-op),
 * so we intentionally skip a DB roundtrip to check for prior STARTs. END
 * events are emitted at run-terminal time in the route handler (see
 * `findOpenAgUiMessagesForRun` in `agent-event-log`).
 */
export function daemonDeltasToAgUiRows(params: {
  runId: string;
  deltas: NonNullable<DaemonEventAPIBody["deltas"]>;
}): AgUiPublishRow[] {
  const { runId, deltas } = params;
  const rows: AgUiPublishRow[] = [];
  const now = new Date();
  // Track (messageId, kind) pairs for which we've already emitted a START in
  // THIS batch. Key format: `${kind}:${messageId}` to keep text vs thinking
  // lifecycles distinct even when the daemon re-uses the same messageId.
  const startedPairs = new Set<string>();
  for (const delta of deltas) {
    const kind = delta.kind === "thinking" ? "thinking" : "text";
    const pairKey = `${kind}:${delta.messageId}`;
    if (!startedPairs.has(pairKey)) {
      const startEvent: BaseEvent =
        kind === "thinking"
          ? ({
              type: EventType.REASONING_MESSAGE_START,
              timestamp: now.getTime(),
              messageId: delta.messageId,
              role: "reasoning",
            } as ReasoningMessageStartEvent)
          : ({
              type: EventType.TEXT_MESSAGE_START,
              timestamp: now.getTime(),
              messageId: delta.messageId,
              role: "assistant",
            } as TextMessageStartEvent);
      // Unique eventId for the synthetic START. Keyed on runId, messageId,
      // and kind so that retried batches re-attempt an insert that dedupes
      // on (runId, eventId) — the first writer wins and all further attempts
      // become no-ops in the persist layer.
      const startEventId = `delta-start:${runId}:${delta.messageId}:${kind}`;
      rows.push({ event: startEvent, eventId: startEventId, timestamp: now });
      startedPairs.add(pairKey);
    }

    const agUi = mapDaemonDeltaToAgui({
      messageId: delta.messageId,
      partIndex: delta.partIndex,
      deltaSeq: delta.deltaSeq,
      kind,
      text: delta.text,
    });
    const eventId = `delta:${runId}:${delta.messageId}:${delta.partIndex}:${kind}:${delta.deltaSeq}`;
    rows.push({ event: agUi, eventId, timestamp: now });
  }
  return rows;
}

/**
 * Build synthetic END rows for (messageId, kind) pairs that were opened by
 * delta STARTs earlier in the run but never closed. Called from the
 * daemon-event route at run-terminal time after scanning the event log via
 * `findOpenAgUiMessagesForRun`.
 *
 * Each END row has a deterministic eventId so retried terminal events dedupe
 * on (runId, eventId).
 */
export function buildDeltaRunEndRows(params: {
  runId: string;
  openMessages: ReadonlyArray<{
    messageId: string;
    kind: "text" | "thinking";
  }>;
  timestamp?: Date;
}): AgUiPublishRow[] {
  const { runId, openMessages } = params;
  const ts = params.timestamp ?? new Date();
  const rows: AgUiPublishRow[] = [];
  for (const { messageId, kind } of openMessages) {
    const endEvent: BaseEvent =
      kind === "thinking"
        ? ({
            type: EventType.REASONING_MESSAGE_END,
            timestamp: ts.getTime(),
            messageId,
          } as ReasoningMessageEndEvent)
        : ({
            type: EventType.TEXT_MESSAGE_END,
            timestamp: ts.getTime(),
            messageId,
          } as TextMessageEndEvent);
    const endEventId = `delta-end:${runId}:${messageId}:${kind}`;
    rows.push({ event: endEvent, eventId: endEventId, timestamp: ts });
  }
  return rows;
}

/**
 * Inputs describing one persisted assistant DBMessage whose `parts` array
 * may contain rich, non-canonical variants (thinking, terminal, diff, image,
 * ...). The route ensures `messageId` is stable across daemon retries — it
 * is a deterministic function of (envelope eventId, message index) — so the
 * resulting `eventId`s also dedupe correctly on (runId, eventId).
 */
export type AssistantMessagePartsInput = {
  messageId: string;
  parts: readonly DBAgentMessagePart[];
};

/**
 * Turn one or more persisted assistant DBMessages into AG-UI publish rows for
 * the rich parts that canonical events don't cover (thinking / terminal /
 * diff / image / audio / pdf / text-file / resource-link / auto-approval-
 * review / plan / plan-structured / server-tool-use / web-search-result /
 * rich-text). Text, tool-use, and tool-result parts are intentionally
 * skipped — the canonical-events pipeline already emits AG-UI events for
 * them, and duplicating here would cause double-render on the client.
 *
 * Each row's `eventId` combines the stable `messageId` with the AG-UI event
 * type and a per-message expansion index, keeping the collision-safety
 * invariant that `persistAndPublishAgUiEvents` relies on (dedupe key is
 * `(runId, eventId)`).
 */
export function dbAgentMessagePartsToAgUiRows(
  messages: readonly AssistantMessagePartsInput[],
  timestamp: Date = new Date(),
): AgUiPublishRow[] {
  const rows: AgUiPublishRow[] = [];
  for (const message of messages) {
    const expanded = dbAgentMessagePartsToAgUi(
      message.messageId,
      message.parts,
      timestamp.getTime(),
    );
    for (let i = 0; i < expanded.length; i++) {
      const agUi = expanded[i]!;
      rows.push({
        event: agUi,
        eventId: buildAgUiEventId(
          `msg:${message.messageId}`,
          String(agUi.type),
          i,
        ),
        timestamp,
      });
    }
  }
  return rows;
}

/**
 * Convert meta events to AG-UI CUSTOM events. Meta events are
 * fire-and-forget — they are not persisted, only broadcast.
 */
export function metaEventsToAgUiEvents(
  metaEvents: NonNullable<DaemonEventAPIBody["metaEvents"]>,
): BaseEvent[] {
  return metaEvents.map((meta) => mapMetaEventToAgui(meta));
}

/**
 * Build a run-finished / run-error AG-UI event for the terminal ack step.
 * These are ephemeral; Phase 4 will decide whether they deserve persistence.
 */
export function buildRunTerminalAgUi(params: {
  threadId: string;
  runId: string;
  daemonRunStatus: "completed" | "failed" | "stopped";
  errorMessage: string | null;
  errorCode?: string | null;
}): BaseEvent {
  if (params.daemonRunStatus === "completed") {
    return mapRunFinishedToAgui(params.threadId, params.runId, false);
  }
  if (params.daemonRunStatus === "stopped") {
    return mapRunFinishedToAgui(params.threadId, params.runId, true);
  }
  return mapRunErrorToAgui(
    params.errorMessage ?? "Run failed",
    params.errorCode ?? undefined,
  );
}

/**
 * Build a stable, collision-safe eventId for an AG-UI row expanded from a
 * canonical source event. Exported so tests can reason about the scheme.
 */
export function buildAgUiEventId(
  canonicalEventId: string,
  agUiEventType: string,
  expansionIndex: number,
): string {
  return `${canonicalEventId}:${agUiEventType}:${expansionIndex}`;
}
