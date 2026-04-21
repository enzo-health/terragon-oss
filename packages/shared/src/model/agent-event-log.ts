import {
  and,
  asc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  lte,
  sql,
} from "drizzle-orm";
import { EventType, type BaseEvent } from "@ag-ui/core";
import type {
  BaseEventEnvelope,
  CanonicalEvent,
  EventId,
  RunId,
  Seq,
} from "@terragon/agent/canonical-events";
import {
  BaseEventEnvelopeSchema,
  CanonicalEventSchema,
} from "@terragon/agent/canonical-events";
import { mapCanonicalEventToAgui } from "@terragon/agent/ag-ui-mapper";
import type { DB } from "../db";
import type { DBMessage } from "../db/db-message";
import type { AgentEventLog as AgentEventLogRow } from "../db/types";
import * as schema from "../db/schema";

/**
 * Redis stream key namespace used by the AG-UI writer (/api/daemon-event) and
 * the AG-UI SSE reader (/api/ag-ui/[threadId]). Co-located here so the two
 * sides cannot drift.
 */
export function agUiStreamKey(threadChatId: string): string {
  return `agui:thread:${threadChatId}`;
}

export type AppendEventResult =
  | {
      success: true;
      inserted: true;
      eventId: EventId;
      seq: Seq;
      runId: RunId;
    }
  | {
      success: true;
      inserted: false;
      deduplicated: true;
      reason: "duplicate_event";
      eventId: EventId;
      seq: Seq;
      runId: RunId;
    }
  | {
      success: false;
      error: string;
      code:
        | "invalid_envelope"
        | "invalid_event"
        | "seq_violation"
        | "database_error";
    };

export type AppendEventOptions = {
  validateSequence?: boolean;
  expectedPrevSeq?: number | null;
};

export type ThreadReplayEntry = {
  seq: number;
  messages: DBMessage[];
};

const ENVELOPE_FIELDS = [
  "payloadVersion",
  "eventId",
  "runId",
  "threadId",
  "threadChatId",
  "seq",
  "timestamp",
  "idempotencyKey",
] as const;

function isMissingAgentEventLogSchemaError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return false;
  }

  const code = Reflect.get(error, "code");
  return code === "42P01" || code === "42703";
}

function extractEnvelopePayload(payload: unknown): unknown {
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    return payload;
  }

  const envelope: Record<string, unknown> = {};
  for (const field of ENVELOPE_FIELDS) {
    if (Object.hasOwn(payload, field)) {
      envelope[field] = Reflect.get(payload, field);
    }
  }

  return envelope;
}

export function validateCanonicalEnvelope(
  payload: unknown,
):
  | { valid: true; envelope: BaseEventEnvelope }
  | { valid: false; error: string } {
  const result = BaseEventEnvelopeSchema.safeParse(
    extractEnvelopePayload(payload),
  );
  if (!result.success) {
    return {
      valid: false,
      error: `Invalid canonical envelope: ${result.error.message}`,
    };
  }

  return { valid: true, envelope: result.data };
}

export function validateCanonicalEvent(
  payload: unknown,
): { valid: true; event: CanonicalEvent } | { valid: false; error: string } {
  const result = CanonicalEventSchema.safeParse(payload);
  if (!result.success) {
    return {
      valid: false,
      error: `Invalid canonical event: ${result.error.message}`,
    };
  }

  return { valid: true, event: result.data };
}

const AG_UI_EVENT_TYPES: ReadonlySet<string> = new Set(
  Object.values(EventType) as string[],
);

function isAgUiBaseEvent(payload: unknown): payload is BaseEvent {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }
  const type = Reflect.get(payload, "type");
  return typeof type === "string" && AG_UI_EVENT_TYPES.has(type);
}

/**
 * Read an agent_event_log row's payload as an AG-UI BaseEvent.
 *
 * Forward-compatibility shim for the AG-UI cutover: reads rows written in
 * either shape and returns a single BaseEvent.
 *
 * - Rows written after Task 2C store an AG-UI BaseEvent directly in
 *   payload_json (detected by `type` matching the AG-UI EventType enum).
 * - Legacy rows written before the cutover store a canonical envelope-v2
 *   event. We parse via CanonicalEventSchema and call mapCanonicalEventToAgui
 *   to convert.
 *
 * Note: some canonical events expand to multiple AG-UI events
 * (e.g. assistant-message -> TEXT_MESSAGE_START + TEXT_MESSAGE_CONTENT +
 * TEXT_MESSAGE_END; tool-call-start -> TOOL_CALL_START + TOOL_CALL_ARGS +
 * TOOL_CALL_END). This shim returns only the FIRST expanded event, which is
 * sufficient for callers that just need to know the event shape/kind.
 *
 * Some operational canonical events legitimately map to 0 AG-UI events
 * (they're internal and have no user-facing representation); for those we
 * return null silently — it's a recognized shape, just not renderable.
 *
 * TODO: Callers that need to replay all AG-UI events for a legacy row must
 * iterate the full array from mapCanonicalEventToAgui. When that need arises,
 * expose a sibling function `readAllAgUiPayloads(row)` rather than changing
 * this signature.
 *
 * Returns null and logs a console.warn ONLY when the payload matches neither
 * shape — that's real drift worth surfacing.
 */
export function readAgUiPayload(row: AgentEventLogRow): BaseEvent | null {
  const payload = row.payloadJson;

  if (isAgUiBaseEvent(payload)) {
    return payload;
  }

  const canonical = CanonicalEventSchema.safeParse(payload);
  if (canonical.success) {
    const [first] = mapCanonicalEventToAgui(canonical.data);
    // first is undefined for recognized canonical events that have no AG-UI
    // projection (e.g. internal operational events) — return null silently.
    return first ?? null;
  }

  console.warn(
    "[agent-event-log] readAgUiPayload: unrecognized payload shape",
    {
      eventId: row.eventId,
      runId: row.runId,
      eventType: row.eventType,
    },
  );
  return null;
}

/**
 * Read an agent_event_log row's payload as the full list of AG-UI BaseEvents
 * it expands to. Unlike `readAgUiPayload` (which returns only the first),
 * this surfaces every event in the expansion so callers reconstructing
 * lifecycle state (e.g. active TEXT_MESSAGE / TOOL_CALL IDs) don't miss the
 * END events that close a canonical row.
 *
 * - AG-UI-native rows: returns the single BaseEvent wrapped in an array.
 * - Canonical rows: returns the full `mapCanonicalEventToAgui` expansion,
 *   which is atomic (every START has its matching END in the same row).
 * - Unrecognized rows: returns `[]` (warning already surfaced by
 *   `readAgUiPayload`).
 */
export function readAllAgUiPayloads(row: AgentEventLogRow): BaseEvent[] {
  const payload = row.payloadJson;

  if (isAgUiBaseEvent(payload)) {
    return [payload];
  }

  const canonical = CanonicalEventSchema.safeParse(payload);
  if (canonical.success) {
    return mapCanonicalEventToAgui(canonical.data);
  }

  return [];
}

function toIdempotencyKey(envelope: BaseEventEnvelope): string {
  return envelope.idempotencyKey ?? `${envelope.runId}:${envelope.eventId}`;
}

function toDatabaseError(error: unknown): AppendEventResult {
  return {
    success: false,
    error: `Database error: ${error instanceof Error ? error.message : String(error)}`,
    code: "database_error",
  };
}

type AppendDb = Pick<DB, "query" | "insert" | "select" | "transaction">;

export async function appendCanonicalEvent({
  db,
  event: payload,
  options = {},
}: {
  db: AppendDb;
  event: unknown;
  options?: AppendEventOptions;
}): Promise<AppendEventResult> {
  const envelopeValidation = validateCanonicalEnvelope(payload);
  if (!envelopeValidation.valid) {
    return {
      success: false,
      error: envelopeValidation.error,
      code: "invalid_envelope",
    };
  }

  const eventValidation = validateCanonicalEvent(payload);
  if (!eventValidation.valid) {
    return {
      success: false,
      error: eventValidation.error,
      code: "invalid_event",
    };
  }

  const envelope = envelopeValidation.envelope;
  const event = eventValidation.event;
  const { validateSequence = true, expectedPrevSeq } = options;

  try {
    return await db.transaction(async (tx) => {
      const existing = await tx.query.agentEventLog.findFirst({
        where: and(
          eq(schema.agentEventLog.runId, envelope.runId),
          eq(schema.agentEventLog.eventId, envelope.eventId),
        ),
        columns: {
          eventId: true,
          runId: true,
          seq: true,
        },
      });

      if (existing) {
        return {
          success: true,
          inserted: false,
          deduplicated: true,
          reason: "duplicate_event",
          eventId: existing.eventId,
          seq: existing.seq,
          runId: existing.runId,
        };
      }

      const collidingEvent = await tx.query.agentEventLog.findFirst({
        where: and(
          eq(schema.agentEventLog.threadChatId, envelope.threadChatId),
          eq(schema.agentEventLog.seq, envelope.seq),
        ),
        columns: {
          eventId: true,
        },
      });

      if (collidingEvent) {
        return {
          success: false,
          error: `Sequence collision: seq ${envelope.seq} already exists in threadChat ${envelope.threadChatId} with event ${collidingEvent.eventId}`,
          code: "seq_violation",
        };
      }

      if (validateSequence) {
        const currentMaxSeq = await getRunMaxSeq({
          db: tx,
          runId: envelope.runId,
        });

        if (
          expectedPrevSeq !== undefined &&
          currentMaxSeq !== expectedPrevSeq
        ) {
          return {
            success: false,
            error: `Sequence gap detected: expected prevSeq ${expectedPrevSeq}, found ${currentMaxSeq}`,
            code: "seq_violation",
          };
        }

        if (
          expectedPrevSeq === undefined &&
          currentMaxSeq !== null &&
          envelope.seq <= currentMaxSeq
        ) {
          return {
            success: false,
            error: `Sequence out of order: seq ${envelope.seq} <= current max ${currentMaxSeq}`,
            code: "seq_violation",
          };
        }
      }

      const [inserted] = await tx
        .insert(schema.agentEventLog)
        .values({
          eventId: envelope.eventId,
          runId: envelope.runId,
          threadId: envelope.threadId,
          threadChatId: envelope.threadChatId,
          seq: envelope.seq,
          eventType: event.type,
          category: event.category,
          payloadJson: event,
          idempotencyKey: toIdempotencyKey(envelope),
          timestamp: new Date(envelope.timestamp),
        })
        .returning({
          eventId: schema.agentEventLog.eventId,
          runId: schema.agentEventLog.runId,
          seq: schema.agentEventLog.seq,
        });

      if (!inserted) {
        return {
          success: false,
          error: "Failed to insert event",
          code: "database_error",
        };
      }

      return {
        success: true,
        inserted: true,
        eventId: inserted.eventId,
        seq: inserted.seq,
        runId: inserted.runId,
      };
    });
  } catch (error) {
    return toDatabaseError(error);
  }
}

class BatchAppendError extends Error {
  constructor(readonly result: AppendEventResult) {
    super("agent-event-log batch append failed");
  }
}

export async function appendCanonicalEventsBatch({
  db,
  events,
  options,
}: {
  db: AppendDb;
  events: unknown[];
  options?: AppendEventOptions;
}): Promise<AppendEventResult[]> {
  if (events.length === 0) {
    return [];
  }

  const successes: Extract<AppendEventResult, { success: true }>[] = [];

  try {
    await db.transaction(async (tx) => {
      for (const event of events) {
        const result = await appendCanonicalEvent({ db: tx, event, options });
        if (!result.success) {
          throw new BatchAppendError(result);
        }
        successes.push(result);
      }
    });
  } catch (error) {
    if (error instanceof BatchAppendError) {
      return [error.result];
    }

    return [toDatabaseError(error)];
  }

  return successes;
}

export async function assignThreadChatMessageSeqToCanonicalEvents({
  db,
  eventIds,
  threadChatMessageSeq,
}: {
  db: Pick<DB, "update">;
  eventIds: string[];
  threadChatMessageSeq: number;
}): Promise<number> {
  if (eventIds.length === 0) {
    return 0;
  }

  const updatedRows = await db
    .update(schema.agentEventLog)
    .set({ threadChatMessageSeq })
    .where(inArray(schema.agentEventLog.eventId, eventIds))
    .returning({ eventId: schema.agentEventLog.eventId });

  return updatedRows.length;
}

export async function hasCanonicalReplayProjection({
  db,
  threadId,
  threadChatId,
}: {
  db: Pick<DB, "query">;
  threadId: string;
  threadChatId?: string;
}): Promise<boolean> {
  try {
    const row = await db.query.agentEventLog.findFirst({
      where: and(
        eq(schema.agentEventLog.threadId, threadId),
        isNotNull(schema.agentEventLog.threadChatMessageSeq),
        ...(threadChatId
          ? [eq(schema.agentEventLog.threadChatId, threadChatId)]
          : []),
      ),
      columns: {
        eventId: true,
      },
    });

    return row !== undefined;
  } catch (error) {
    if (isMissingAgentEventLogSchemaError(error)) {
      return false;
    }
    throw error;
  }
}

function canonicalEventToReplayMessage(
  event: CanonicalEvent,
): DBMessage | null {
  switch (event.type) {
    case "assistant-message":
      return {
        type: "agent",
        parent_tool_use_id: event.parentToolUseId ?? null,
        parts: [{ type: "text", text: event.content }],
      };
    case "tool-call-start":
      return {
        type: "tool-call",
        id: event.toolCallId,
        name: event.name,
        parameters: event.parameters,
        parent_tool_use_id: event.parentToolUseId ?? null,
        status: "started",
      };
    case "tool-call-result":
      return {
        type: "tool-result",
        id: event.toolCallId,
        is_error: event.isError,
        parent_tool_use_id: null,
        result: event.result,
      };
    case "run-started":
      return null;
  }
}

export async function getThreadReplayEntriesFromCanonicalEvents({
  db,
  threadId,
  fromThreadChatMessageSeq,
  threadChatId,
}: {
  db: Pick<DB, "query">;
  threadId: string;
  fromThreadChatMessageSeq: number;
  threadChatId?: string;
}): Promise<ThreadReplayEntry[]> {
  let rows: Array<{
    threadChatMessageSeq: number | null;
    payloadJson: Record<string, unknown>;
    seq: number;
  }>;

  try {
    rows = await db.query.agentEventLog.findMany({
      where: and(
        eq(schema.agentEventLog.threadId, threadId),
        gt(schema.agentEventLog.threadChatMessageSeq, fromThreadChatMessageSeq),
        ...(threadChatId
          ? [eq(schema.agentEventLog.threadChatId, threadChatId)]
          : []),
      ),
      orderBy: [
        asc(schema.agentEventLog.threadChatMessageSeq),
        asc(schema.agentEventLog.seq),
      ],
      columns: {
        threadChatMessageSeq: true,
        payloadJson: true,
        seq: true,
      },
    });
  } catch (error) {
    if (isMissingAgentEventLogSchemaError(error)) {
      return [];
    }
    throw error;
  }

  const entries: ThreadReplayEntry[] = [];
  let activeSeq: number | null = null;
  let activeMessages: DBMessage[] = [];

  for (const row of rows) {
    const replaySeq = row.threadChatMessageSeq;
    if (replaySeq == null) {
      continue;
    }
    if (activeSeq !== null && replaySeq !== activeSeq) {
      if (activeMessages.length > 0) {
        entries.push({ seq: activeSeq, messages: activeMessages });
      }
      activeMessages = [];
    }
    activeSeq = replaySeq;

    const payload = row.payloadJson;
    const parsedEvent = CanonicalEventSchema.safeParse(payload);
    if (!parsedEvent.success) {
      continue;
    }
    const replayMessage = canonicalEventToReplayMessage(parsedEvent.data);
    if (replayMessage) {
      activeMessages.push(replayMessage);
    }
  }

  if (activeSeq !== null && activeMessages.length > 0) {
    entries.push({ seq: activeSeq, messages: activeMessages });
  }

  return entries;
}

/**
 * Fetch AG-UI BaseEvents for a thread chat with `seq > fromSeq`, ordered by
 * seq ascending. Used by the AG-UI SSE endpoint for the initial replay burst.
 *
 * Rows that cannot be mapped to an AG-UI event (e.g. operational canonical
 * events with no user-facing projection, or unknown payload shapes) are
 * silently skipped — readAgUiPayload already warns on truly unrecognized
 * payloads.
 */
export async function getAgUiEventsForReplay({
  db,
  threadChatId,
  fromSeq,
}: {
  db: Pick<DB, "query">;
  threadChatId: string;
  fromSeq: number;
}): Promise<BaseEvent[]> {
  let rows: AgentEventLogRow[];
  try {
    rows = await db.query.agentEventLog.findMany({
      where: and(
        eq(schema.agentEventLog.threadChatId, threadChatId),
        gt(schema.agentEventLog.seq, fromSeq),
      ),
      orderBy: [asc(schema.agentEventLog.seq)],
    });
  } catch (error) {
    if (isMissingAgentEventLogSchemaError(error)) {
      return [];
    }
    throw error;
  }

  const events: BaseEvent[] = [];
  for (const row of rows) {
    const mapped = readAgUiPayload(row);
    if (mapped !== null) {
      events.push(mapped);
    }
  }
  return events;
}

/**
 * Describes a text message or tool call that was opened (START emitted) but
 * not yet closed (END not emitted) at or before the given cursor. The AG-UI
 * SSE endpoint uses this to synthesize replay-time START events so that
 * subsequent CONTENT/ARGS events are accepted by the client's reducer.
 */
export type ActiveAgUiLifecycleState = {
  textMessages: Array<{ messageId: string }>;
  toolCalls: Array<{ toolCallId: string; toolCallName: string }>;
};

/**
 * Scan every agent_event_log row for this thread chat with `seq <= fromSeq`
 * and compute which TEXT_MESSAGE / TOOL_CALL lifecycles are still "active"
 * (i.e. the client must treat the id as an open message at replay time).
 *
 * Two cases produce an active id:
 *
 *  1. **START-without-END** — a START was written before or at the cursor
 *     and no matching END followed. Classic mid-stream reconnect case.
 *
 *  2. **Orphan-CONTENT** — a CONTENT event exists for an id that has NO
 *     preceding START and no closing END. This happens for threads whose
 *     event log was written before commit 4e7559a introduced proper
 *     START/END bracketing for daemon delta runs. The log is malformed but
 *     in-flight at fixup time, so we synthesize a START for those ids too
 *     to prevent the client from rejecting CONTENT events for an id its
 *     reducer has never seen.
 *
 * The AG-UI client protocol rejects TEXT_MESSAGE_CONTENT / TOOL_CALL_ARGS /
 * *_END events that reference an unknown message/tool call. On reconnect
 * mid-stream the client has no memory of STARTs that fired before the
 * cursor, so we must re-emit synthetic STARTs for any lifecycle still
 * active at cursor time before feeding the `seq > fromSeq` replay.
 *
 * Canonical-event rows always expand atomically (START + CONTENT/ARGS + END
 * come from the same row), so those can never be "active mid-row". Only
 * AG-UI-native rows, where each event is its own row, can leave a
 * lifecycle open across the cursor boundary — and only the legacy
 * pre-4e7559a writer could leave orphan-CONTENT without a START.
 *
 * Tool calls don't need orphan-ARGS detection: the only writer that emits
 * TOOL_CALL_ARGS without a preceding TOOL_CALL_START would be canonical
 * rows, which expand atomically. The daemon-delta path does not emit
 * tool-call events.
 */
export async function getActiveAgUiLifecycleAt({
  db,
  threadChatId,
  fromSeq,
}: {
  db: Pick<DB, "query">;
  threadChatId: string;
  fromSeq: number;
}): Promise<ActiveAgUiLifecycleState> {
  // Nothing prior can be active at fromSeq = 0.
  if (fromSeq <= 0) {
    return { textMessages: [], toolCalls: [] };
  }

  let rows: AgentEventLogRow[];
  try {
    rows = await db.query.agentEventLog.findMany({
      where: and(
        eq(schema.agentEventLog.threadChatId, threadChatId),
        lte(schema.agentEventLog.seq, fromSeq),
      ),
      orderBy: [asc(schema.agentEventLog.seq)],
    });
  } catch (error) {
    if (isMissingAgentEventLogSchemaError(error)) {
      return { textMessages: [], toolCalls: [] };
    }
    throw error;
  }

  // Track active IDs via Maps so we preserve insertion order for the caller.
  //
  // `activeTextMessages`: ids with a START that has not yet seen its END.
  // `orphanContentTextMessages`: ids seen via CONTENT without a matching
  //   START (and not yet closed by an END). Merged into the final result.
  // `closedTextMessages`: ids that have seen an END at any point. Once
  //   closed, further CONTENT for the same id is treated as malformed-
  //   but-already-terminated (do NOT re-orphan it) — the client would
  //   reject it regardless and this is legacy-data territory.
  const activeTextMessages = new Map<string, true>();
  const orphanContentTextMessages = new Map<string, true>();
  const closedTextMessages = new Set<string>();
  const activeToolCalls = new Map<string, { toolCallName: string }>();

  for (const row of rows) {
    const events = readAllAgUiPayloads(row);
    for (const event of events) {
      switch (event.type) {
        case EventType.TEXT_MESSAGE_START: {
          const messageId = Reflect.get(
            event as unknown as Record<string, unknown>,
            "messageId",
          );
          if (typeof messageId === "string") {
            activeTextMessages.set(messageId, true);
            // A real START supersedes any prior orphan-CONTENT bookkeeping
            // for the same id — drop it from the orphan set so we don't
            // emit two synthetic STARTs for one id.
            orphanContentTextMessages.delete(messageId);
          }
          break;
        }
        case EventType.TEXT_MESSAGE_CONTENT: {
          const messageId = Reflect.get(
            event as unknown as Record<string, unknown>,
            "messageId",
          );
          if (typeof messageId !== "string") {
            break;
          }
          if (activeTextMessages.has(messageId)) {
            // Normal path: CONTENT under an open START. Nothing to do.
            break;
          }
          if (closedTextMessages.has(messageId)) {
            // Malformed legacy data: CONTENT after END. Do not re-open.
            break;
          }
          orphanContentTextMessages.set(messageId, true);
          break;
        }
        case EventType.TEXT_MESSAGE_END: {
          const messageId = Reflect.get(
            event as unknown as Record<string, unknown>,
            "messageId",
          );
          if (typeof messageId === "string") {
            activeTextMessages.delete(messageId);
            orphanContentTextMessages.delete(messageId);
            closedTextMessages.add(messageId);
          }
          break;
        }
        case EventType.TOOL_CALL_START: {
          const toolCallId = Reflect.get(
            event as unknown as Record<string, unknown>,
            "toolCallId",
          );
          const toolCallName = Reflect.get(
            event as unknown as Record<string, unknown>,
            "toolCallName",
          );
          if (
            typeof toolCallId === "string" &&
            typeof toolCallName === "string"
          ) {
            activeToolCalls.set(toolCallId, { toolCallName });
          }
          break;
        }
        case EventType.TOOL_CALL_END: {
          const toolCallId = Reflect.get(
            event as unknown as Record<string, unknown>,
            "toolCallId",
          );
          if (typeof toolCallId === "string") {
            activeToolCalls.delete(toolCallId);
          }
          break;
        }
        default:
          break;
      }
    }
  }

  // Merge active-STARTs with orphan-CONTENT ids. Both need a synthetic
  // START at replay time; the route doesn't need to know which bucket
  // they came from. Iteration order: START-without-END first (insertion
  // order of their STARTs), then orphan-CONTENT (insertion order of the
  // first CONTENT). Map dedupes if an id somehow lands in both — it
  // shouldn't, because a real START removes the orphan entry above.
  const synthesizedTextMessageIds = new Map<string, true>();
  for (const id of activeTextMessages.keys()) {
    synthesizedTextMessageIds.set(id, true);
  }
  for (const id of orphanContentTextMessages.keys()) {
    synthesizedTextMessageIds.set(id, true);
  }

  return {
    textMessages: Array.from(synthesizedTextMessageIds.keys()).map(
      (messageId) => ({ messageId }),
    ),
    toolCalls: Array.from(activeToolCalls.entries()).map(
      ([toolCallId, { toolCallName }]) => ({ toolCallId, toolCallName }),
    ),
  };
}

/**
 * Describes a (messageId, kind) pair that had a TEXT_MESSAGE_START /
 * REASONING_MESSAGE_START written for a given run but does not yet have the
 * matching _END event. Used by the daemon-event route at run-terminal time
 * to emit synthetic ENDs so the AG-UI event log stays protocol-compliant.
 */
export type OpenAgUiMessage = {
  messageId: string;
  kind: "text" | "thinking";
};

/**
 * Scan every agent_event_log row for `runId` and compute which TEXT_MESSAGE
 * and REASONING_MESSAGE lifecycles are still "open" — STARTed but not ENDed.
 *
 * Bounded to a single run so the query only touches rows written by that
 * run. Canonical-event rows always expand atomically (START + CONTENT + END
 * share the same row), so they cannot appear open here — open messages are
 * exclusively those written by the daemon-delta path without their
 * corresponding ENDs.
 */
export async function findOpenAgUiMessagesForRun({
  db,
  runId,
}: {
  db: Pick<DB, "query">;
  runId: RunId;
}): Promise<OpenAgUiMessage[]> {
  let rows: AgentEventLogRow[];
  try {
    rows = await db.query.agentEventLog.findMany({
      where: eq(schema.agentEventLog.runId, runId),
      orderBy: [asc(schema.agentEventLog.seq)],
    });
  } catch (error) {
    if (isMissingAgentEventLogSchemaError(error)) {
      return [];
    }
    throw error;
  }

  // Preserve insertion order for deterministic END emission.
  const openText = new Map<string, true>();
  const openThinking = new Map<string, true>();
  for (const row of rows) {
    const events = readAllAgUiPayloads(row);
    for (const event of events) {
      switch (event.type) {
        case EventType.TEXT_MESSAGE_START: {
          const messageId = Reflect.get(
            event as unknown as Record<string, unknown>,
            "messageId",
          );
          if (typeof messageId === "string") {
            openText.set(messageId, true);
          }
          break;
        }
        case EventType.TEXT_MESSAGE_END: {
          const messageId = Reflect.get(
            event as unknown as Record<string, unknown>,
            "messageId",
          );
          if (typeof messageId === "string") {
            openText.delete(messageId);
          }
          break;
        }
        case EventType.REASONING_MESSAGE_START: {
          const messageId = Reflect.get(
            event as unknown as Record<string, unknown>,
            "messageId",
          );
          if (typeof messageId === "string") {
            openThinking.set(messageId, true);
          }
          break;
        }
        case EventType.REASONING_MESSAGE_END: {
          const messageId = Reflect.get(
            event as unknown as Record<string, unknown>,
            "messageId",
          );
          if (typeof messageId === "string") {
            openThinking.delete(messageId);
          }
          break;
        }
        default:
          break;
      }
    }
  }

  const open: OpenAgUiMessage[] = [];
  for (const messageId of openText.keys()) {
    open.push({ messageId, kind: "text" });
  }
  for (const messageId of openThinking.keys()) {
    open.push({ messageId, kind: "thinking" });
  }
  return open;
}

export async function getRunEvents({
  db,
  runId,
  fromSeq,
  limit,
}: {
  db: Pick<DB, "query">;
  runId: RunId;
  fromSeq?: number;
  limit?: number;
}): Promise<AgentEventLogRow[]> {
  return db.query.agentEventLog.findMany({
    where:
      fromSeq === undefined
        ? eq(schema.agentEventLog.runId, runId)
        : and(
            eq(schema.agentEventLog.runId, runId),
            gte(schema.agentEventLog.seq, fromSeq),
          ),
    orderBy: [asc(schema.agentEventLog.seq)],
    limit,
  });
}

export async function getRunMaxSeq({
  db,
  runId,
}: {
  db: Pick<DB, "select">;
  runId: RunId;
}): Promise<number | null> {
  const [result] = await db
    .select({
      maxSeq: sql<string | null>`MAX(${schema.agentEventLog.seq})`,
    })
    .from(schema.agentEventLog)
    .where(eq(schema.agentEventLog.runId, runId));

  if (!result?.maxSeq) {
    return null;
  }

  return Number(result.maxSeq);
}

// ---------------------------------------------------------------------------
// AG-UI writer path (Task 2C)
// ---------------------------------------------------------------------------

/**
 * Peek the next per-thread-chat `seq` under an advisory lock held for the
 * duration of the caller's transaction. The returned seq values are valid
 * ONLY if the caller inserts the corresponding rows in the SAME transaction.
 *
 * ## Invariants the caller MUST uphold
 * - **MUST be called inside a `db.transaction(async (tx) => { ... })` block.**
 *   The advisory lock is acquired with `pg_advisory_xact_lock`, which
 *   auto-releases at tx commit/rollback. Calling outside a transaction
 *   releases the lock immediately — dangerous.
 * - **Caller MUST insert rows with seqs `[returnedSeq, returnedSeq+count-1]`
 *   inside the same `tx`** (so that the inserts happen while the lock is
 *   still held). Readers outside the lock see the inserted rows only after
 *   tx commit.
 * - **Caller MUST NOT reuse the returned seqs in a different transaction.**
 *   The counter advances only when the caller's inserts commit; a second
 *   call from a new tx re-reads MAX(seq) under a fresh lock.
 *
 * Violating any of the above produces duplicate `seq` values and silent
 * data corruption (caught only at replay time by the (threadChatId, seq)
 * unique constraint — last-line defense, not first-line correctness).
 *
 * Implementation: `pg_advisory_xact_lock(hashtext(key), 0)`, same idiom as
 * `retryGitCommitAndPush` in checkpoint-thread-internal.ts. The 32-bit hash
 * collision risk merely serializes two unrelated thread chats for one tx.
 */
export async function peekNextThreadChatSeqLocked({
  tx,
  threadChatId,
  count,
}: {
  tx: Pick<DB, "execute" | "select">;
  threadChatId: string;
  count: number;
}): Promise<number> {
  if (count <= 0) {
    throw new Error(
      `peekNextThreadChatSeqLocked: count must be >= 1 (got ${count})`,
    );
  }
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`agent_event_log:thread_chat_seq:${threadChatId}`}), 0)`,
  );
  const [row] = await tx
    .select({
      maxSeq: sql<string | null>`MAX(${schema.agentEventLog.seq})`,
    })
    .from(schema.agentEventLog)
    .where(eq(schema.agentEventLog.threadChatId, threadChatId));
  const nextSeq = row?.maxSeq == null ? 0 : Number(row.maxSeq) + 1;
  return nextSeq;
}

type AppendAgUiEventRow = {
  eventId: string;
  runId: string;
  threadId: string;
  threadChatId: string;
  seq: number;
  eventType: string;
  category: string;
  payload: BaseEvent;
  idempotencyKey: string;
  timestamp: Date;
};

/**
 * Convert an AG-UI BaseEvent to the jsonb column payload shape.
 *
 * The agent_event_log.payloadJson column is typed `Record<string, unknown>`
 * (see schema.ts), while BaseEvent is a discriminated union with required
 * literal tag types. Shallow-spread widens the union safely at the
 * persistence boundary without a load-bearing `as unknown as` double cast.
 */
function toPayloadJson(event: BaseEvent): Record<string, unknown> {
  return { ...(event as unknown as Record<string, unknown>) };
}

/**
 * Persist a pre-computed AG-UI BaseEvent row. Caller supplies the seq
 * (peeked via `peekNextThreadChatSeqLocked`) and other envelope fields.
 *
 * Race-safe by construction: uses `INSERT ... ON CONFLICT DO NOTHING
 * RETURNING` keyed on (runId, eventId). The unique index
 * `agent_event_log_run_event_unique` makes this atomic; no find-then-insert
 * race, no reliance on external locking.
 */
export async function appendAgUiEventRow({
  tx,
  row,
}: {
  tx: Pick<DB, "insert">;
  row: AppendAgUiEventRow;
}): Promise<{ inserted: boolean }> {
  const inserted = await tx
    .insert(schema.agentEventLog)
    .values({
      eventId: row.eventId,
      runId: row.runId,
      threadId: row.threadId,
      threadChatId: row.threadChatId,
      seq: row.seq,
      eventType: row.eventType,
      category: row.category,
      payloadJson: toPayloadJson(row.payload),
      idempotencyKey: row.idempotencyKey,
      timestamp: row.timestamp,
    })
    .onConflictDoNothing({
      target: [schema.agentEventLog.runId, schema.agentEventLog.eventId],
    })
    .returning({ eventId: schema.agentEventLog.eventId });

  return { inserted: inserted.length > 0 };
}
