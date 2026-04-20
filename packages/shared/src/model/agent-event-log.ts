import { and, asc, eq, gt, gte, inArray, isNotNull, sql } from "drizzle-orm";
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
import type { DB } from "../db";
import type { DBMessage } from "../db/db-message";
import type { AgentEventLog as AgentEventLogRow } from "../db/types";
import * as schema from "../db/schema";

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
          eq(schema.agentEventLog.runId, envelope.runId),
          eq(schema.agentEventLog.seq, envelope.seq),
        ),
        columns: {
          eventId: true,
        },
      });

      if (collidingEvent) {
        return {
          success: false,
          error: `Sequence collision: seq ${envelope.seq} already exists in run ${envelope.runId} with event ${collidingEvent.eventId}`,
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
  const rows = await db.query.agentEventLog.findMany({
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
