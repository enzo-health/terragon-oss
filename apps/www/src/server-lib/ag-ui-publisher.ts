import { type BaseEvent } from "@ag-ui/core";
import {
  dbAgentMessagePartsToAgUi,
  mapMetaEventToAgui,
  mapRunErrorToAgui,
  mapRunFinishedToAgui,
  serializeAgUiEvent,
} from "@terragon/agent/ag-ui-mapper";
import {
  type AgUiEventRow,
  buildAgUiEventId,
  buildDeltaRunEndRows,
  canonicalEventsToAgUiRows,
  daemonDeltasToAgUiRows,
} from "@terragon/agent/ag-ui-rows";
import type { DaemonEventAPIBody } from "@terragon/daemon/shared";

export {
  buildAgUiEventId,
  buildDeltaRunEndRows,
  canonicalEventsToAgUiRows,
  daemonDeltasToAgUiRows,
};
import type { DBAgentMessagePart } from "@terragon/shared";
import type { DB } from "@terragon/shared/db";
import {
  type AgUiEventEnvelope,
  agUiStreamKey,
  appendAgUiEventRows,
  getAgUiEventEnvelopesForRun,
  peekNextThreadChatSeqLocked,
} from "@terragon/shared/model/agent-event-log";
import { recordAgentTraceSpan } from "@/lib/agent-trace";
import { isLocalRedisHttpMode, redis } from "@/lib/redis";
import {
  countViolations,
  emitProtocolValidationDiagnostic,
  foldRows,
  getProtocolValidationMode,
  isHardViolation,
  type PlannedRow,
  PROTOCOL_VALIDATION_LOG_PREFIX,
  type ProtocolRow,
  RunProtocolStateStore,
  validateBatch,
} from "@/server-lib/ag-ui/run-protocol-validator";

// Bound the per-thread-chat Redis stream so live-tail buffers can't grow without
// limit. Trimming is approximate (~) so it stays cheap on the publish hot path;
// a client that falls behind the trimmed window recovers via DB replay-from-seq
// (the authoritative log), so this is a soft cap, not a delivery guarantee.
// EXPIRE-on-publish reclaims streams for thread chats that go idle.
const AGUI_STREAM_MAXLEN = 1000;
const AGUI_STREAM_TTL_SECONDS = 60 * 60;
const AGUI_XADD_TRIM = {
  trim: { type: "MAXLEN", threshold: AGUI_STREAM_MAXLEN, comparison: "~" },
} as const;

const runProtocolStateStore = new RunProtocolStateStore();

function plannedRowsToPublishRows(
  planned: readonly PlannedRow<AgUiPublishRow & ProtocolRow>[],
  fallbackTimestamp: Date,
): AgUiPublishRow[] {
  const out: AgUiPublishRow[] = [];
  let lastTimestamp = fallbackTimestamp;
  for (const entry of planned) {
    if (entry.kind === "keep") {
      lastTimestamp = entry.row.timestamp;
      out.push(entry.row);
    } else {
      out.push({
        event: entry.event,
        eventId: entry.eventId,
        timestamp: lastTimestamp,
      });
    }
  }
  return out;
}

async function validateRowsForPersist(params: {
  db: DB;
  runId: string;
  threadChatId: string;
  rows: AgUiPublishRow[];
}): Promise<AgUiPublishRow[]> {
  const { db, runId, threadChatId, rows } = params;
  const mode = getProtocolValidationMode();
  if (mode === "off") {
    return rows;
  }
  let priorState = runProtocolStateStore.get(runId);
  if (priorState === undefined) {
    const priorEnvelopes = await getAgUiEventEnvelopesForRun({
      db,
      runId,
      threadChatId,
    });
    priorState = foldRows(
      runId,
      priorEnvelopes.flatMap((envelope) =>
        envelope.eventId === undefined
          ? []
          : [{ event: envelope.payload, eventId: envelope.eventId }],
      ),
    );
  }
  const { state, violations, plannedRows } = validateBatch(
    priorState,
    rows as (AgUiPublishRow & ProtocolRow)[],
  );
  runProtocolStateStore.set(runId, state);
  if (violations.length > 0) {
    emitProtocolValidationDiagnostic({
      runId,
      threadChatId,
      mode,
      attempted: rows.length,
      totalViolations: violations.length,
      hardViolations: violations.filter((violation) =>
        isHardViolation(violation.kind),
      ).length,
      counts: countViolations(violations),
    });
  }
  if (mode !== "enforce") {
    return rows;
  }
  return plannedRowsToPublishRows(
    plannedRows,
    rows[0]?.timestamp ?? new Date(),
  );
}

function refreshStreamTtl(streamKey: string): void {
  // Best-effort: a TTL refresh must never break publishing. Guard the call
  // itself (not just the promise) so a missing/throwing client is a no-op.
  try {
    void redis.expire(streamKey, AGUI_STREAM_TTL_SECONDS)?.catch?.(() => {});
  } catch {}
}

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
export type AgUiPublishRow = AgUiEventRow;

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
  persistedEnvelopes: TerragonAgUiTransportEnvelope[];
};

export type PersistAgUiEventsResult = PersistAndPublishResult & {
  persistedEvents: BaseEvent[];
};

export type TerragonAgUiTransportEnvelope<
  TEvent extends BaseEvent = BaseEvent,
> = AgUiEventEnvelope<TEvent, "full">;

export function serializeAgUiTransportEnvelope(
  envelope: TerragonAgUiTransportEnvelope,
): string {
  return JSON.stringify(envelope);
}

export type PublishPersistedAgUiEventsParams = {
  threadChatId: string;
  persistedEvents: readonly BaseEvent[];
  insertedEventIds: readonly string[];
  persistedEnvelopes?: readonly TerragonAgUiTransportEnvelope[];
};

function buildTransportEnvelope(params: {
  event: BaseEvent;
  eventId: string;
  runId: string;
  threadId: string;
  threadChatId: string;
  seq: number;
  timestamp: Date;
}): TerragonAgUiTransportEnvelope {
  return {
    eventId: params.eventId,
    seq: params.seq,
    runId: params.runId,
    threadId: params.threadId,
    threadChatId: params.threadChatId,
    timestamp: params.timestamp.toISOString(),
    idempotencyKey: `${params.runId}:${params.eventId}`,
    payload: params.event,
  };
}

/**
 * Persist each AG-UI row to `agent_event_log` in the order provided.
 *
 * ## Contract
 * - Seq is assigned per-thread-chat under a transaction-scoped advisory lock
 *   (see `peekNextThreadChatSeqLocked`).
 * - Duplicates are skipped silently (idempotency key: runId + eventId).
 * - Callers publish live-tail events after the DB transaction commits, so
 *   readers never see a stream event before the corresponding DB row.
 */
export async function persistAgUiEvents(params: {
  db: DB;
  runId: string;
  threadId: string;
  threadChatId: string;
  rows: AgUiPublishRow[];
}): Promise<PersistAgUiEventsResult> {
  const { db, runId, threadId, threadChatId, rows } = params;
  if (rows.length === 0) {
    return {
      inserted: 0,
      skipped: 0,
      insertedEventIds: [],
      persistedEnvelopes: [],
      persistedEvents: [],
    };
  }

  let effectiveRows = rows;
  try {
    effectiveRows = await validateRowsForPersist({
      db,
      runId,
      threadChatId,
      rows,
    });
  } catch (error) {
    console.warn(`${PROTOCOL_VALIDATION_LOG_PREFIX} degraded`, {
      runId,
      threadChatId,
      error: String(error),
    });
  }

  let inserted = 0;
  let skipped = 0;
  const insertedEventIds: string[] = [];
  const persistedEnvelopes: TerragonAgUiTransportEnvelope[] = [];
  const persistedEvents: BaseEvent[] = [];

  const persistStartedAtMs = Date.now();
  await db.transaction(async (tx) => {
    const startSeq = await peekNextThreadChatSeqLocked({
      tx,
      threadChatId,
      count: effectiveRows.length,
    });

    const candidateRows = effectiveRows.map((row, index) => {
      const seq = startSeq + index;
      return {
        source: row,
        seq,
        envelope: buildTransportEnvelope({
          event: row.event,
          eventId: row.eventId,
          runId,
          threadId,
          threadChatId,
          seq,
          timestamp: row.timestamp,
        }),
      };
    });
    const result = await appendAgUiEventRows({
      tx,
      rows: candidateRows.map(({ source, envelope }) => ({
        eventId: source.eventId,
        threadId,
        eventType: String(source.event.type),
        // AG-UI BaseEvent has no explicit category; reuse event type as a
        // stable proxy. Readers project via readAgUiPayload anyway.
        category: String(source.event.type),
        idempotencyKey: `${runId}:${source.eventId}`,
        timestamp: source.timestamp,
        threadChatMessageSeq: source.threadChatMessageSeq,
        envelope,
      })),
    });
    const insertedEventIdSet = new Set(result.insertedEventIds);

    for (const candidate of candidateRows) {
      if (insertedEventIdSet.has(candidate.source.eventId)) {
        inserted += 1;
        insertedEventIds.push(candidate.source.eventId);
        persistedEnvelopes.push(candidate.envelope);
        persistedEvents.push(candidate.source.event);
      } else {
        skipped += 1;
      }
    }
  });

  const seqs = persistedEnvelopes.map((envelope) => envelope.seq);
  recordAgentTraceSpan({
    traceId: runId,
    name: "server.agui.event_log.persisted",
    startedAtMs: persistStartedAtMs,
    endedAtMs: Date.now(),
    attributes: {
      threadId,
      threadChatId,
      runId,
      attempted: rows.length,
      inserted,
      deduplicated: skipped,
      seqMin: seqs.length > 0 ? Math.min(...seqs) : null,
      seqMax: seqs.length > 0 ? Math.max(...seqs) : null,
    },
  });

  return {
    inserted,
    skipped,
    insertedEventIds,
    persistedEnvelopes,
    persistedEvents,
  };
}

/**
 * Publish already-persisted AG-UI events to `agui:thread:{threadChatId}`.
 *
 * ## XADD failure policy
 * The DB is the source of truth; Redis is a live-tail optimization. Durable
 * batches publish through one Redis pipeline so the hot streaming path pays
 * one round trip per persisted batch while preserving command order. If the
 * pipeline fails, clients recover the gap via replay-from-seq on reconnect.
 */
export async function publishPersistedAgUiEvents(
  params: PublishPersistedAgUiEventsParams,
): Promise<void> {
  const { threadChatId } = params;
  const persistedEnvelopes = params.persistedEnvelopes ?? [];
  const publishEntries = params.persistedEvents.map((event, index) => ({
    event,
    envelope: persistedEnvelopes[index],
    eventId: params.insertedEventIds[index],
    index,
  }));
  publishEntries.sort((left, right) => {
    if (!left.envelope || !right.envelope) {
      return left.index - right.index;
    }
    return left.envelope.seq - right.envelope.seq;
  });
  const insertedEventIds = publishEntries
    .map((entry) => entry.eventId)
    .filter((eventId): eventId is string => eventId !== undefined);

  if (publishEntries.length === 0) {
    return;
  }

  const streamKey = agUiStreamKey(threadChatId);
  const startedAtMs = Date.now();
  const publishPayloads = publishEntries.map(({ event, envelope }) => ({
    event,
    // When an envelope is present, it already contains the full event as its
    // `payload` field. The SSE reader (readEventField) prefers the envelope
    // field over the event field, so the standalone event is redundant.
    // Omitting it cuts Redis memory per event by ~50%.
    data:
      envelope === undefined
        ? { event: serializeAgUiEvent(event) }
        : {
            envelope: serializeAgUiTransportEnvelope(envelope),
          },
  }));
  const publishedCount = await publishAgUiEventsBatch({
    threadChatId,
    streamKey,
    publishPayloads,
    insertedEventIds,
  });
  const runId = publishEntries[0]?.envelope?.runId ?? null;
  recordAgentTraceSpan({
    traceId: runId,
    name: "server.agui.redis.published",
    startedAtMs,
    endedAtMs: Date.now(),
    attributes: {
      threadChatId,
      attempted: publishEntries.length,
      published: publishedCount,
      eventIdFirst: insertedEventIds[0] ?? null,
      eventIdLast: insertedEventIds[insertedEventIds.length - 1] ?? null,
      mode: "pipeline",
    },
  });
}

type AgUiRedisPublishPayload = {
  event: BaseEvent;
  data: {
    event?: string;
    envelope?: string;
  };
};

async function publishAgUiEventsBatch({
  threadChatId,
  streamKey,
  publishPayloads,
  insertedEventIds,
}: {
  threadChatId: string;
  streamKey: string;
  publishPayloads: AgUiRedisPublishPayload[];
  insertedEventIds: readonly string[];
}): Promise<number> {
  if (isLocalRedisHttpMode()) {
    return publishAgUiEventsIndividually({
      threadChatId,
      streamKey,
      publishPayloads,
      insertedEventIds,
    });
  }

  const pipeline = redis.pipeline();
  for (const { data } of publishPayloads) {
    pipeline.xadd(streamKey, "*", data, AGUI_XADD_TRIM);
  }
  pipeline.expire(streamKey, AGUI_STREAM_TTL_SECONDS);
  try {
    const results = await pipeline.exec({ keepErrors: true });
    const xaddResults = Array.isArray(results)
      ? results.slice(0, publishPayloads.length)
      : results;
    const failedResultIndex = findPipelineErrorIndex(xaddResults);
    if (failedResultIndex !== null) {
      logAgUiRedisPublishFailure({
        threadChatId,
        streamKey,
        eventType: String(
          publishPayloads[failedResultIndex]?.event.type ?? "unknown",
        ),
        publishedCount: failedResultIndex,
        remainingCount: publishPayloads.length - failedResultIndex,
        insertedEventIds,
        error: pipelineResultError(results[failedResultIndex]),
      });
      return failedResultIndex;
    }
    return publishPayloads.length;
  } catch (err) {
    logAgUiRedisPublishFailure({
      threadChatId,
      streamKey,
      eventType: String(publishPayloads[0]?.event.type ?? "unknown"),
      publishedCount: 0,
      remainingCount: publishPayloads.length,
      insertedEventIds,
      error: err,
    });
    return 0;
  }
}

async function publishAgUiEventsIndividually({
  threadChatId,
  streamKey,
  publishPayloads,
  insertedEventIds,
}: {
  threadChatId: string;
  streamKey: string;
  publishPayloads: AgUiRedisPublishPayload[];
  insertedEventIds: readonly string[];
}): Promise<number> {
  let publishedCount = 0;
  for (let i = 0; i < publishPayloads.length; i++) {
    const { event, data } = publishPayloads[i]!;
    try {
      await redis.xadd(streamKey, "*", data, AGUI_XADD_TRIM);
      publishedCount += 1;
    } catch (err) {
      logAgUiRedisPublishFailure({
        threadChatId,
        streamKey,
        eventType: String(event.type),
        publishedCount: i,
        remainingCount: publishPayloads.length - i,
        insertedEventIds,
        error: err,
      });
      break;
    }
  }
  if (publishedCount > 0) {
    refreshStreamTtl(streamKey);
  }
  return publishedCount;
}

function findPipelineErrorIndex(results: unknown): number | null {
  if (!Array.isArray(results)) {
    return null;
  }
  const index = results.findIndex((result) => pipelineResultError(result));
  return index === -1 ? null : index;
}

function pipelineResultError(result: unknown): Error | null {
  if (result instanceof Error) {
    return result;
  }
  if (Array.isArray(result) && result[0] instanceof Error) {
    return result[0];
  }
  if (
    typeof result === "object" &&
    result !== null &&
    "error" in result &&
    typeof result.error === "string" &&
    result.error.length > 0
  ) {
    return new Error(result.error);
  }
  return null;
}

function logAgUiRedisPublishFailure({
  threadChatId,
  streamKey,
  eventType,
  publishedCount,
  remainingCount,
  insertedEventIds,
  error,
}: {
  threadChatId: string;
  streamKey: string;
  eventType: string | null;
  publishedCount: number;
  remainingCount: number;
  insertedEventIds: readonly string[];
  error: unknown;
}): void {
  console.error(
    "[ag-ui-publisher] XADD failed — halting live-tail publish for this batch; clients will recover via SSE replay-from-seq",
    {
      threadChatId,
      streamKey,
      eventType,
      publishedCount,
      remainingCount,
      insertedEventIdRange:
        insertedEventIds.length > 0
          ? {
              first: insertedEventIds[0],
              last: insertedEventIds[insertedEventIds.length - 1],
            }
          : null,
      error,
    },
  );
}

/**
 * Persist each AG-UI row to `agent_event_log` and publish to
 * `agui:thread:{threadChatId}` in the order provided.
 */
export async function persistAndPublishAgUiEvents(params: {
  db: DB;
  runId: string;
  threadId: string;
  threadChatId: string;
  rows: AgUiPublishRow[];
}): Promise<PersistAndPublishResult> {
  const result = await persistAgUiEvents(params);
  await publishPersistedAgUiEvents({
    threadChatId: params.threadChatId,
    persistedEvents: result.persistedEvents,
    insertedEventIds: result.insertedEventIds,
    persistedEnvelopes: result.persistedEnvelopes,
  });
  return {
    inserted: result.inserted,
    skipped: result.skipped,
    insertedEventIds: result.insertedEventIds,
    persistedEnvelopes: result.persistedEnvelopes,
  };
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
  const data = { event: serializeAgUiEvent(params.event) };
  try {
    if (isLocalRedisHttpMode()) {
      await redis.xadd(streamKey, "*", data, AGUI_XADD_TRIM);
      refreshStreamTtl(streamKey);
    } else {
      const pipeline = redis.pipeline();
      pipeline.xadd(streamKey, "*", data, AGUI_XADD_TRIM);
      pipeline.expire(streamKey, AGUI_STREAM_TTL_SECONDS);
      await pipeline.exec();
    }
  } catch (err) {
    console.error("[ag-ui-publisher] ephemeral XADD failed", {
      threadChatId: params.threadChatId,
      streamKey,
      eventType: String(params.event.type),
      error: err,
    });
  }
}

// ---------------------------------------------------------------------------
// Mapping helpers — turn daemon-event inputs into persist-ready rows
// ---------------------------------------------------------------------------

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
