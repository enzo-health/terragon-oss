import type { BaseEvent } from "@ag-ui/core";
import {
  mapCanonicalEventToAgui,
  mapDaemonDeltaToAgui,
  mapMetaEventToAgui,
  mapRunErrorToAgui,
  mapRunFinishedToAgui,
  serializeAgUiEvent,
} from "@terragon/agent/ag-ui-mapper";
import type { CanonicalEvent } from "@terragon/agent/canonical-events";
import type { DaemonEventAPIBody } from "@terragon/daemon/shared";
import {
  agUiStreamKey,
  appendAgUiEventRow,
  reserveThreadChatSeqs,
} from "@terragon/shared/model/agent-event-log";
import type { DB } from "@terragon/shared/db";
import { redis } from "@/lib/redis";

/**
 * Shape of a single AG-UI event to be persisted + streamed.
 * `eventId` is the row-level idempotency key on (runId, eventId) — different
 * AG-UI events derived from the same canonical event must have distinct
 * eventIds (we append a type suffix).
 */
type AgUiPublishRow = {
  event: BaseEvent;
  eventId: string;
  timestamp: Date;
};

/**
 * Persist each AG-UI row to `agent_event_log` and publish to
 * `agui:thread:{threadChatId}` in the order provided.
 *
 * Seq is assigned per-thread-chat via `reserveThreadChatSeqs` under an
 * advisory lock inside a transaction. Duplicates are skipped silently
 * (idempotency key: runId + eventId).
 */
export async function persistAndPublishAgUiEvents(params: {
  db: DB;
  runId: string;
  threadId: string;
  threadChatId: string;
  rows: AgUiPublishRow[];
}): Promise<{ inserted: number; skipped: number }> {
  const { db, runId, threadId, threadChatId, rows } = params;
  if (rows.length === 0) {
    return { inserted: 0, skipped: 0 };
  }

  let inserted = 0;
  let skipped = 0;
  const persistedEvents: BaseEvent[] = [];

  await db.transaction(async (tx) => {
    const startSeq = await reserveThreadChatSeqs({
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
          // AG-UI BaseEvent has no explicit category; use event type as a
          // stable proxy. Readers project via readAgUiPayload anyway.
          category: String(row.event.type),
          payload: row.event,
          idempotencyKey: `${runId}:${row.eventId}`,
          timestamp: row.timestamp,
        },
      });
      if (result.inserted) {
        inserted += 1;
        persistedEvents.push(row.event);
      } else {
        skipped += 1;
      }
    }
  });

  // XADD after commit so readers never see a stream event before the row.
  // Persisted-only: if the DB rejected as duplicate, the live-tail has
  // likely already seen it (or will get it via replay on next connect).
  for (const event of persistedEvents) {
    try {
      await redis.xadd(agUiStreamKey(threadChatId), "*", {
        event: serializeAgUiEvent(event),
      });
    } catch (err) {
      console.warn("[ag-ui-publisher] XADD failed, continuing", {
        threadChatId,
        err,
      });
    }
  }

  return { inserted, skipped };
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
  try {
    await redis.xadd(agUiStreamKey(params.threadChatId), "*", {
      event: serializeAgUiEvent(params.event),
    });
  } catch (err) {
    console.warn("[ag-ui-publisher] ephemeral XADD failed, continuing", {
      threadChatId: params.threadChatId,
      err,
    });
  }
}

// ---------------------------------------------------------------------------
// Mapping helpers — turn daemon-event inputs into persist-ready rows
// ---------------------------------------------------------------------------

/**
 * Expand canonical events to AG-UI rows. Each canonical event may produce
 * 1..3 AG-UI rows (e.g., assistant-message → START + CONTENT + END).
 *
 * The caller receives ordered rows suitable for direct hand-off to
 * `persistAndPublishAgUiEvents`.
 */
export function canonicalEventsToAgUiRows(
  events: CanonicalEvent[],
): AgUiPublishRow[] {
  const rows: AgUiPublishRow[] = [];
  for (const event of events) {
    const expanded = mapCanonicalEventToAgui(event);
    const ts = new Date(event.timestamp);
    for (const agUi of expanded) {
      rows.push({
        event: agUi,
        eventId: buildAgUiEventId(event.eventId, String(agUi.type)),
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
 */
export function daemonDeltasToAgUiRows(params: {
  runId: string;
  deltas: NonNullable<DaemonEventAPIBody["deltas"]>;
}): AgUiPublishRow[] {
  const { runId, deltas } = params;
  const rows: AgUiPublishRow[] = [];
  const now = new Date();
  for (const delta of deltas) {
    const agUi = mapDaemonDeltaToAgui({
      messageId: delta.messageId,
      partIndex: delta.partIndex,
      deltaSeq: delta.deltaSeq,
      kind: delta.kind === "thinking" ? "thinking" : "text",
      text: delta.text,
    });
    const kind = delta.kind === "thinking" ? "thinking" : "text";
    const eventId = `delta:${runId}:${delta.messageId}:${delta.partIndex}:${kind}:${delta.deltaSeq}`;
    rows.push({ event: agUi, eventId, timestamp: now });
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

function buildAgUiEventId(
  canonicalEventId: string,
  agUiEventType: string,
): string {
  return `${canonicalEventId}:${agUiEventType}`;
}
