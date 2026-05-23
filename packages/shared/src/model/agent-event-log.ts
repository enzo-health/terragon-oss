import { type BaseEvent, EventType, type Message } from "@ag-ui/core";
import { mapCanonicalEventToAgui } from "@terragon/agent/ag-ui-mapper";
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
import { AIModelSchema } from "@terragon/agent/types";
import { and, asc, eq, gt, gte, inArray, isNotNull, sql } from "drizzle-orm";
import type { DB } from "../db";
import type { DBMessage } from "../db/db-message";
import * as schema from "../db/schema";
import type {
  AgentEventLog as AgentEventLogRow,
  AgentRunStatus,
} from "../db/types";

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

type AgUiEventEnvelopeIdentity = {
  eventId: string;
  threadId: string;
  timestamp: string;
  idempotencyKey: string;
};

export type AgUiTraceMetadata = {
  daemonEventId: string | null;
  daemonEventReceivedAtMs: number;
};

export type AgUiEventEnvelope<
  TEvent extends BaseEvent = BaseEvent,
  TIdentity extends "legacy" | "full" = "legacy",
> = (TIdentity extends "full"
  ? AgUiEventEnvelopeIdentity
  : Partial<AgUiEventEnvelopeIdentity>) & {
  seq: number;
  projectionIndex?: number;
  projectionCount?: number;
  runId: string;
  threadChatId: string;
  trace?: AgUiTraceMetadata;
  payload: TEvent;
};

type AgUiReadableRow = Pick<
  AgentEventLogRow,
  | "eventId"
  | "runId"
  | "threadId"
  | "threadChatId"
  | "seq"
  | "eventType"
  | "payloadJson"
  | "idempotencyKey"
  | "timestamp"
>;

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

const MAX_QUARANTINE_REDACTED_PAYLOAD_BYTES = 8 * 1024;

function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

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

  if (
    result.data.type === "unknown-provider-event" &&
    jsonByteLength(result.data.redactedPayload) >
      MAX_QUARANTINE_REDACTED_PAYLOAD_BYTES
  ) {
    return {
      valid: false,
      error: `Invalid canonical event: unknown-provider-event redactedPayload exceeds ${MAX_QUARANTINE_REDACTED_PAYLOAD_BYTES} bytes`,
    };
  }

  return { valid: true, event: result.data };
}

const AG_UI_EVENT_TYPES: ReadonlySet<unknown> = new Set(
  Object.values(EventType),
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
export function readAgUiPayload(row: AgUiReadableRow): BaseEvent | null {
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

function toAgUiEventEnvelope({
  row,
  payload,
  projectionIndex,
  projectionCount,
}: {
  row: Pick<
    AgentEventLogRow,
    | "eventId"
    | "seq"
    | "runId"
    | "threadId"
    | "threadChatId"
    | "idempotencyKey"
    | "timestamp"
  >;
  payload: BaseEvent;
  projectionIndex?: number;
  projectionCount?: number;
}): AgUiEventEnvelope<BaseEvent, "full"> {
  return {
    eventId: row.eventId,
    seq: row.seq,
    projectionIndex,
    projectionCount,
    runId: row.runId,
    threadId: row.threadId,
    threadChatId: row.threadChatId,
    timestamp: row.timestamp.toISOString(),
    idempotencyKey: row.idempotencyKey,
    payload,
  };
}

export function readAgUiEnvelope(
  row: AgUiReadableRow,
): AgUiEventEnvelope<BaseEvent, "full"> | null {
  const payload = readAgUiPayload(row);
  if (payload === null) {
    return null;
  }
  return toAgUiEventEnvelope({
    row,
    payload,
    projectionIndex: 0,
    projectionCount: 1,
  });
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
export function readAllAgUiPayloads(
  row: Pick<AgentEventLogRow, "payloadJson">,
): BaseEvent[] {
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

export function readAllAgUiEnvelopes(
  row: Pick<
    AgentEventLogRow,
    | "eventId"
    | "seq"
    | "runId"
    | "threadId"
    | "threadChatId"
    | "idempotencyKey"
    | "timestamp"
    | "payloadJson"
  >,
): Array<AgUiEventEnvelope<BaseEvent, "full">> {
  const payloads = readAllAgUiPayloads(row);
  return payloads.map((payload, projectionIndex) =>
    toAgUiEventEnvelope({
      row,
      payload,
      projectionIndex,
      projectionCount: payloads.length,
    }),
  );
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

async function appendCanonicalEventCore(
  tx: AppendDb,
  payload: unknown,
  options: AppendEventOptions = {},
): Promise<AppendEventResult> {
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

    if (expectedPrevSeq !== undefined && currentMaxSeq !== expectedPrevSeq) {
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
}

export async function appendCanonicalEvent({
  db,
  event,
  options = {},
}: {
  db: AppendDb;
  event: unknown;
  options?: AppendEventOptions;
}): Promise<AppendEventResult> {
  try {
    return await db.transaction(async (tx) => {
      return appendCanonicalEventCore(tx, event, options);
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
        const result = await appendCanonicalEventCore(tx, event, options);
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
        inArray(schema.agentEventLog.eventType, [
          EventType.MESSAGES_SNAPSHOT,
          "assistant-message",
          "tool-call-start",
          "tool-call-result",
        ]),
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
    case "run-terminal":
    case "tool-call-progress":
    case "reasoning-message":
    case "permission-request":
    case "permission-response":
    case "artifact-reference":
    case "meta":
    case "unknown-provider-event":
      return null;
    default: {
      const _exhaustiveCheck: never = event;
      return _exhaustiveCheck;
    }
  }
}

function messageContentToReplayText(content: Message["content"]): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      if (
        part !== null &&
        typeof part === "object" &&
        "text" in part &&
        typeof part.text === "string"
      ) {
        return part.text;
      }
      return "";
    })
    .filter((text) => text.length > 0)
    .join("\n")
    .trim();
}

function systemMessageTypeFromAgUiId(
  messageIdValue: string,
): Extract<DBMessage, { type: "system" }>["message_type"] | null {
  const prefix = "side-effect-system:";
  if (!messageIdValue.startsWith(prefix)) {
    return null;
  }
  const withoutPrefix = messageIdValue.slice(prefix.length);
  const match = /^(?<messageType>.+)-\d+-[a-f0-9]{12}$/.exec(withoutPrefix);
  const messageType = match?.groups?.messageType;
  switch (messageType) {
    case "cancel-schedule":
    case "fix-github-checks":
    case "retry-git-commit-and-push":
    case "generic-retry":
    case "invalid-token-retry":
    case "clear-context":
    case "compact-result":
    case "agent-error-retry":
    case "follow-up-retry-failed":
      return messageType;
    default:
      const _exhaustiveCheck = messageType satisfies string | undefined;
      void _exhaustiveCheck;
      return null;
  }
}

function userMetadataFromAgUiName(
  name: string | undefined,
): Pick<Extract<DBMessage, { type: "user" }>, "model" | "permissionMode"> {
  if (!name?.startsWith("terragon-user:")) {
    return { model: null, permissionMode: undefined };
  }
  const metadata = new URLSearchParams(name.slice("terragon-user:".length));
  const modelResult = AIModelSchema.safeParse(metadata.get("model"));
  const permissionMode = metadata.get("permissionMode");
  return {
    model: modelResult.success ? modelResult.data : null,
    permissionMode:
      permissionMode === "allowAll" || permissionMode === "plan"
        ? permissionMode
        : undefined,
  };
}

function agUiMessageToReplayMessage(message: Message): DBMessage | null {
  const content = messageContentToReplayText(message.content);
  if (message.role === "user" && content.length > 0) {
    const metadata = userMetadataFromAgUiName(message.name);
    return {
      type: "user",
      model: metadata.model,
      ...(metadata.permissionMode
        ? { permissionMode: metadata.permissionMode }
        : {}),
      parts: [{ type: "text", text: content }],
    };
  }
  if (message.role !== "system") {
    return null;
  }
  const messageType = systemMessageTypeFromAgUiId(message.id);
  if (!messageType) {
    return null;
  }
  return {
    type: "system",
    message_type: messageType,
    parts: content.length > 0 ? [{ type: "text", text: content }] : [],
  };
}

function isAgUiMessage(value: unknown): value is Message {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const role = Reflect.get(value, "role");
  const id = Reflect.get(value, "id");
  const content = Reflect.get(value, "content");
  return (
    (role === "user" || role === "system" || role === "assistant") &&
    typeof id === "string" &&
    (content === null || typeof content === "string" || Array.isArray(content))
  );
}

function agUiSnapshotToReplayMessages(payload: unknown): DBMessage[] {
  if (
    payload === null ||
    typeof payload !== "object" ||
    !("type" in payload) ||
    payload.type !== EventType.MESSAGES_SNAPSHOT ||
    !("messages" in payload) ||
    !Array.isArray(payload.messages)
  ) {
    return [];
  }
  return payload.messages.flatMap((message) => {
    if (!isAgUiMessage(message)) {
      return [];
    }
    const replayMessage = agUiMessageToReplayMessage(message);
    return replayMessage ? [replayMessage] : [];
  });
}

function isContextResetReplayMessage(message: DBMessage): boolean {
  return message.type === "system" && message.message_type === "compact-result";
}

function applyContextResetToReplayEntries(
  entries: ThreadReplayEntry[],
): ThreadReplayEntry[] {
  const resetEntries: ThreadReplayEntry[] = [];

  for (const entry of entries) {
    let messagesForEntry: DBMessage[] = [];
    for (const message of entry.messages) {
      if (isContextResetReplayMessage(message)) {
        resetEntries.length = 0;
        messagesForEntry = [];
      }
      messagesForEntry.push(message);
    }
    if (messagesForEntry.length > 0) {
      resetEntries.push({ seq: entry.seq, messages: messagesForEntry });
    }
  }

  return resetEntries;
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
    if (parsedEvent.success) {
      const replayMessage = canonicalEventToReplayMessage(parsedEvent.data);
      if (replayMessage) {
        activeMessages.push(replayMessage);
      }
      continue;
    }
    activeMessages.push(...agUiSnapshotToReplayMessages(payload));
  }

  if (activeSeq !== null && activeMessages.length > 0) {
    entries.push({ seq: activeSeq, messages: activeMessages });
  }

  const mergedEntries = entries
    .sort((left, right) => left.seq - right.seq)
    .reduce<ThreadReplayEntry[]>((merged, entry) => {
      const previous = merged.at(-1);
      if (previous && previous.seq === entry.seq) {
        previous.messages.push(...entry.messages);
        return merged;
      }
      merged.push({ seq: entry.seq, messages: [...entry.messages] });
      return merged;
    }, [])
    .map((entry) => ({
      ...entry,
      messages: [...entry.messages].sort((left, right) => {
        if (left.type === "user" && right.type !== "user") {
          return -1;
        }
        if (left.type !== "user" && right.type === "user") {
          return 1;
        }
        return 0;
      }),
    }));

  return applyContextResetToReplayEntries(mergedEntries);
}

/**
 * Fetch every AG-UI BaseEvent for a single run, ordered by seq ascending.
 *
 * Workhorse for the "Replay from Run Start" reconnect path: the caller passes
 * the client's known `runId` and the response is guaranteed to start with the
 * real `RUN_STARTED` event that opened the run — no synthesis required.
 *
 * Rows that cannot be mapped to an AG-UI event (e.g. operational canonical
 * events with no user-facing projection, or unknown payload shapes) are
 * silently skipped — readAgUiPayload already warns on truly unrecognized
 * payloads.
 */
export async function getAgUiEventEnvelopesForRun({
  db,
  runId,
  threadChatId,
}: {
  db: Pick<DB, "query">;
  runId: RunId;
  threadChatId?: string;
}): Promise<AgUiEventEnvelope[]> {
  let rows: AgentEventLogRow[];
  try {
    rows = await db.query.agentEventLog.findMany({
      where: threadChatId
        ? and(
            eq(schema.agentEventLog.runId, runId),
            eq(schema.agentEventLog.threadChatId, threadChatId),
          )
        : eq(schema.agentEventLog.runId, runId),
      orderBy: [asc(schema.agentEventLog.seq)],
    });
  } catch (error) {
    if (isMissingAgentEventLogSchemaError(error)) {
      return [];
    }
    throw error;
  }

  const events: AgUiEventEnvelope[] = [];
  for (const row of rows) {
    // Canonical rows expand to multiple events (START + CONTENT + END); use
    // the full-expansion helper so callers get a faithful event sequence,
    // not just the head of each row.
    for (const envelope of readAllAgUiEnvelopes(row)) {
      events.push(envelope);
    }
  }
  return events;
}

export async function getAgUiEventEnvelopesForThreadChat({
  db,
  threadChatId,
  afterSeq,
}: {
  db: Pick<DB, "query">;
  threadChatId: string;
  afterSeq?: number;
}): Promise<AgUiEventEnvelope[]> {
  let rows: AgentEventLogRow[];
  try {
    rows = await db.query.agentEventLog.findMany({
      where: and(
        eq(schema.agentEventLog.threadChatId, threadChatId),
        ...(afterSeq === undefined
          ? []
          : [gt(schema.agentEventLog.seq, afterSeq)]),
      ),
      orderBy: [asc(schema.agentEventLog.seq)],
    });
  } catch (error) {
    if (isMissingAgentEventLogSchemaError(error)) {
      return [];
    }
    throw error;
  }

  const events: AgUiEventEnvelope[] = [];
  for (const row of rows) {
    for (const envelope of readAllAgUiEnvelopes(row)) {
      events.push(envelope);
    }
  }
  return events;
}

export async function getAgUiEventsForRun({
  db,
  runId,
  threadChatId,
}: {
  db: Pick<DB, "query">;
  runId: RunId;
  threadChatId?: string;
}): Promise<BaseEvent[]> {
  const envelopes = await getAgUiEventEnvelopesForRun({
    db,
    runId,
    threadChatId,
  });
  return envelopes.map((entry) => entry.payload);
}

/**
 * Return the runId of the most recent **well-formed** run for a thread chat,
 * or null if the thread chat has no eligible runs. "Well-formed" means the
 * run has a `RUN_STARTED` event. Some runtime transports can persist the
 * start marker shortly after the first text delta; the SSE route repairs that
 * order during replay, so those runs are still eligible. Legacy runs with no
 * `RUN_STARTED` marker are intentionally skipped.
 *
 * Ordering: among eligible runs, pick the one with the greatest max(seq) in
 * the thread chat, matching the previous "latest by seq" semantic.
 *
 * Runs with a single `RUN_STARTED` row (START but nothing after) still
 * qualify — their min_seq == max_seq == START, which is a valid (if empty)
 * run projection.
 *
 * Used by the AG-UI SSE endpoint as the default "latest run" semantic when a
 * client connects without an explicit `?runId=X` cursor. Null return engages
 * the live-tail path (keepalive + Redis subscribe), which is correct both
 * for brand-new thread chats and for thread chats where every prior run is
 * legacy-shaped.
 */
export async function getLatestRunIdForThreadChat({
  db,
  threadChatId,
}: {
  db: Pick<DB, "query" | "execute">;
  threadChatId: string;
}): Promise<RunId | null> {
  try {
    // Find each run's max(seq) within the thread chat, then keep only runs
    // that contain a start marker. This accepts both AG-UI native rows
    // (`RUN_STARTED`) and canonical rows (`run-started`), including runs where
    // the marker was persisted after early text deltas.
    const result = await db.execute<{ run_id: string }>(sql`
      WITH run_bounds AS (
        SELECT
          ${schema.agentEventLog.runId} AS run_id,
          MAX(${schema.agentEventLog.seq}) AS max_seq
        FROM ${schema.agentEventLog}
        WHERE ${schema.agentEventLog.threadChatId} = ${threadChatId}
        GROUP BY ${schema.agentEventLog.runId}
      ),
      started_runs AS (
        SELECT DISTINCT ${schema.agentEventLog.runId} AS run_id
        FROM ${schema.agentEventLog}
        WHERE
          ${schema.agentEventLog.threadChatId} = ${threadChatId}
          AND ${schema.agentEventLog.eventType} IN ('RUN_STARTED', 'run-started')
      )
      SELECT rb.run_id
      FROM run_bounds rb
      JOIN started_runs sr ON sr.run_id = rb.run_id
      ORDER BY rb.max_seq DESC
      LIMIT 1
    `);

    const first = result.rows[0];
    return first ? first.run_id : null;
  } catch (error) {
    if (isMissingAgentEventLogSchemaError(error)) {
      return null;
    }
    throw error;
  }
}

const TERMINAL_AGENT_RUN_STATUSES: ReadonlySet<AgentRunStatus> = new Set([
  "completed",
  "failed",
  "stopped",
]);

export function isTerminalAgentRunStatus(
  status: AgentRunStatus,
): status is Extract<AgentRunStatus, "completed" | "failed" | "stopped"> {
  return TERMINAL_AGENT_RUN_STATUSES.has(status);
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

export type OpenAgUiToolCall = {
  toolCallId: string;
  parentToolUseId: string | null;
};

function getAgUiMessageId(event: BaseEvent): string | null {
  if (!("messageId" in event)) {
    return null;
  }
  return typeof event.messageId === "string" ? event.messageId : null;
}

function getAgUiToolCallId(event: BaseEvent): string | null {
  if (!("toolCallId" in event)) {
    return null;
  }
  return typeof event.toolCallId === "string" ? event.toolCallId : null;
}

function getAgUiParentToolUseId(event: BaseEvent): string | null {
  if (!("parentMessageId" in event)) {
    return null;
  }
  return typeof event.parentMessageId === "string"
    ? event.parentMessageId
    : null;
}

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
      const eventType = event.type;

      switch (eventType) {
        case EventType.TEXT_MESSAGE_START: {
          const messageId = getAgUiMessageId(event);
          if (messageId !== null) {
            openText.set(messageId, true);
          }
          break;
        }
        case EventType.TEXT_MESSAGE_END: {
          const messageId = getAgUiMessageId(event);
          if (messageId !== null) {
            openText.delete(messageId);
          }
          break;
        }
        case EventType.REASONING_MESSAGE_START: {
          const messageId = getAgUiMessageId(event);
          if (messageId !== null) {
            openThinking.set(messageId, true);
          }
          break;
        }
        case EventType.REASONING_MESSAGE_END: {
          const messageId = getAgUiMessageId(event);
          if (messageId !== null) {
            openThinking.delete(messageId);
          }
          break;
        }
        case EventType.TEXT_MESSAGE_CONTENT:
        case EventType.TEXT_MESSAGE_CHUNK:
        case EventType.TOOL_CALL_START:
        case EventType.TOOL_CALL_ARGS:
        case EventType.TOOL_CALL_END:
        case EventType.TOOL_CALL_CHUNK:
        case EventType.TOOL_CALL_RESULT:
        case EventType.THINKING_START:
        case EventType.THINKING_END:
        case EventType.THINKING_TEXT_MESSAGE_START:
        case EventType.THINKING_TEXT_MESSAGE_CONTENT:
        case EventType.THINKING_TEXT_MESSAGE_END:
        case EventType.STATE_SNAPSHOT:
        case EventType.STATE_DELTA:
        case EventType.MESSAGES_SNAPSHOT:
        case EventType.ACTIVITY_SNAPSHOT:
        case EventType.ACTIVITY_DELTA:
        case EventType.RAW:
        case EventType.CUSTOM:
        case EventType.RUN_STARTED:
        case EventType.RUN_FINISHED:
        case EventType.RUN_ERROR:
        case EventType.STEP_STARTED:
        case EventType.STEP_FINISHED:
        case EventType.REASONING_START:
        case EventType.REASONING_MESSAGE_CONTENT:
        case EventType.REASONING_MESSAGE_CHUNK:
        case EventType.REASONING_END:
        case EventType.REASONING_ENCRYPTED_VALUE:
          break;
        default:
          const _exhaustiveCheck: never = eventType;
          void _exhaustiveCheck;
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

export async function findOpenAgUiToolCallsForRun({
  db,
  runId,
}: {
  db: Pick<DB, "query">;
  runId: RunId;
}): Promise<OpenAgUiToolCall[]> {
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

  const openToolCalls = new Map<string, { parentToolUseId: string | null }>();
  for (const row of rows) {
    const events = readAllAgUiPayloads(row);
    for (const event of events) {
      const eventType = event.type;

      switch (eventType) {
        case EventType.TOOL_CALL_START: {
          const toolCallId = getAgUiToolCallId(event);
          if (toolCallId !== null) {
            openToolCalls.set(toolCallId, {
              parentToolUseId: getAgUiParentToolUseId(event),
            });
          }
          break;
        }
        case EventType.TOOL_CALL_RESULT: {
          const toolCallId = getAgUiToolCallId(event);
          if (toolCallId !== null) {
            openToolCalls.delete(toolCallId);
          }
          break;
        }
        case EventType.TEXT_MESSAGE_START:
        case EventType.TEXT_MESSAGE_CONTENT:
        case EventType.TEXT_MESSAGE_CHUNK:
        case EventType.TEXT_MESSAGE_END:
        case EventType.TOOL_CALL_ARGS:
        case EventType.TOOL_CALL_END:
        case EventType.TOOL_CALL_CHUNK:
        case EventType.THINKING_START:
        case EventType.THINKING_END:
        case EventType.THINKING_TEXT_MESSAGE_START:
        case EventType.THINKING_TEXT_MESSAGE_CONTENT:
        case EventType.THINKING_TEXT_MESSAGE_END:
        case EventType.STATE_SNAPSHOT:
        case EventType.STATE_DELTA:
        case EventType.MESSAGES_SNAPSHOT:
        case EventType.ACTIVITY_SNAPSHOT:
        case EventType.ACTIVITY_DELTA:
        case EventType.RAW:
        case EventType.CUSTOM:
        case EventType.RUN_STARTED:
        case EventType.RUN_FINISHED:
        case EventType.RUN_ERROR:
        case EventType.STEP_STARTED:
        case EventType.STEP_FINISHED:
        case EventType.REASONING_START:
        case EventType.REASONING_MESSAGE_START:
        case EventType.REASONING_MESSAGE_CONTENT:
        case EventType.REASONING_MESSAGE_CHUNK:
        case EventType.REASONING_MESSAGE_END:
        case EventType.REASONING_END:
        case EventType.REASONING_ENCRYPTED_VALUE:
          break;
        default:
          const _exhaustiveCheck: never = eventType;
          void _exhaustiveCheck;
          break;
      }
    }
  }

  return [...openToolCalls.entries()].map(([toolCallId, value]) => ({
    toolCallId,
    parentToolUseId: value.parentToolUseId,
  }));
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

type AppendAgUiEventRowLegacy = {
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
  threadChatMessageSeq?: number;
};

type AppendAgUiEventRowWithEnvelope = Omit<
  AppendAgUiEventRowLegacy,
  "runId" | "threadChatId" | "seq" | "payload"
> & {
  envelope: Pick<
    AgUiEventEnvelope,
    "runId" | "threadChatId" | "seq" | "payload"
  >;
};

type AppendAgUiEventRow =
  | AppendAgUiEventRowLegacy
  | AppendAgUiEventRowWithEnvelope;

function normalizeAppendAgUiEventRow(
  row: AppendAgUiEventRow,
): AppendAgUiEventRowLegacy {
  if ("envelope" in row) {
    return {
      eventId: row.eventId,
      runId: row.envelope.runId,
      threadId: row.threadId,
      threadChatId: row.envelope.threadChatId,
      seq: row.envelope.seq,
      eventType: row.eventType,
      category: row.category,
      payload: row.envelope.payload,
      idempotencyKey: row.idempotencyKey,
      timestamp: row.timestamp,
      threadChatMessageSeq: row.threadChatMessageSeq,
    };
  }
  return row;
}

/**
 * Convert an AG-UI BaseEvent to the jsonb column payload shape.
 *
 * The agent_event_log.payloadJson column is typed `Record<string, unknown>`
 * (see schema.ts), while BaseEvent is a discriminated union with required
 * literal tag types. Shallow-spread widens the union safely at the
 * persistence boundary without a load-bearing `as unknown as` double cast.
 */
function toPayloadJson(event: BaseEvent): Record<string, unknown> {
  return Object.fromEntries(Object.entries(event));
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
  const normalizedRow = normalizeAppendAgUiEventRow(row);
  const inserted = await tx
    .insert(schema.agentEventLog)
    .values({
      eventId: normalizedRow.eventId,
      runId: normalizedRow.runId,
      threadId: normalizedRow.threadId,
      threadChatId: normalizedRow.threadChatId,
      seq: normalizedRow.seq,
      eventType: normalizedRow.eventType,
      category: normalizedRow.category,
      payloadJson: toPayloadJson(normalizedRow.payload),
      idempotencyKey: normalizedRow.idempotencyKey,
      timestamp: normalizedRow.timestamp,
      threadChatMessageSeq: normalizedRow.threadChatMessageSeq,
    })
    .onConflictDoNothing({
      target: [schema.agentEventLog.runId, schema.agentEventLog.eventId],
    })
    .returning({ eventId: schema.agentEventLog.eventId });

  return { inserted: inserted.length > 0 };
}

export async function appendAgUiEventRows({
  tx,
  rows,
}: {
  tx: Pick<DB, "insert">;
  rows: AppendAgUiEventRow[];
}): Promise<{ insertedEventIds: string[] }> {
  if (rows.length === 0) {
    return { insertedEventIds: [] };
  }

  const inserted = await tx
    .insert(schema.agentEventLog)
    .values(
      rows.map((row) => {
        const normalizedRow = normalizeAppendAgUiEventRow(row);
        return {
          eventId: normalizedRow.eventId,
          runId: normalizedRow.runId,
          threadId: normalizedRow.threadId,
          threadChatId: normalizedRow.threadChatId,
          seq: normalizedRow.seq,
          eventType: normalizedRow.eventType,
          category: normalizedRow.category,
          payloadJson: toPayloadJson(normalizedRow.payload),
          idempotencyKey: normalizedRow.idempotencyKey,
          timestamp: normalizedRow.timestamp,
          threadChatMessageSeq: normalizedRow.threadChatMessageSeq,
        };
      }),
    )
    .onConflictDoNothing({
      target: [schema.agentEventLog.runId, schema.agentEventLog.eventId],
    })
    .returning({ eventId: schema.agentEventLog.eventId });

  return {
    insertedEventIds: inserted.map((row) => row.eventId),
  };
}
