import type { DaemonEventAPIBody } from "@terragon/daemon/shared";
import {
  EventType,
  type BaseEvent,
  type ToolCallArgsEvent,
  type ToolCallEndEvent,
  type ToolCallResultEvent,
  type ToolCallStartEvent,
} from "@ag-ui/core";
import type { DBMessage, DBToolCall } from "@terragon/shared";
import type { DB } from "@terragon/shared/db";
import { toDBMessage } from "@/agent/msg/toDBMessage";
import { recordAgentTraceSpan } from "@/lib/agent-trace";
import {
  type AgUiPublishRow,
  type AssistantMessagePartsInput,
  canonicalEventsToAgUiRows,
  buildAgUiEventId,
  daemonDeltasToAgUiRows,
  dbAgentMessagePartsToAgUiRows,
  persistAgUiEvents,
  persistAndPublishAgUiEvents,
  type PersistAgUiEventsResult,
  publishPersistedAgUiEvents,
} from "@/server-lib/ag-ui-publisher";

export type DaemonEventEnvelopeV2 = {
  payloadVersion: 2;
  eventId: string;
  runId: string;
  seq: number;
};

export type CanonicalEventsPayload = NonNullable<
  DaemonEventAPIBody["canonicalEvents"]
>;

export type DaemonDeltasPayload = NonNullable<DaemonEventAPIBody["deltas"]>;

export type CanonicalPersistenceSummary = {
  attempted: number;
  inserted: number;
  deduplicated: number;
  insertedEventIds: string[];
  persistedEvents: PersistAgUiEventsResult["persistedEvents"];
  persistedEnvelopes: PersistAgUiEventsResult["persistedEnvelopes"];
};

export type CanonicalRunTerminalEvent = {
  eventId: string;
  seq: number;
  status: "completed" | "failed" | "stopped";
  errorMessage: string | null;
  errorCode: string | null;
  headShaAtCompletion: string | null;
};

export type CanonicalEventContextMismatch = {
  eventId: string;
  reason: "payloadVersion" | "runId" | "threadId" | "threadChatId";
};

export type PreLegacyAgUiCommitPlan = {
  canonicalRows: AgUiPublishRow[];
  deltaRows: AgUiPublishRow[];
  richPartRows: AgUiPublishRow[];
  mergedRows: AgUiPublishRow[];
  requiresPersistence: boolean;
};

export type TerminalAgUiCommitPlan = {
  terminalCanonicalRows: AgUiPublishRow[];
  terminalMergedRows: AgUiPublishRow[];
};

export type DaemonEventCommitFailure = {
  ok: false;
  status: 500 | 503;
  body: {
    success: false;
    error:
      | "daemon_event_canonical_persistence_unavailable"
      | "daemon_event_canonical_event_persist_failed";
    code?: "database_error";
    detail?: string;
  };
};

export type DaemonEventCommitSuccess = {
  ok: true;
  summary: CanonicalPersistenceSummary;
};

export type DaemonTerminalCommitSuccess = {
  ok: true;
  summary: CanonicalPersistenceSummary | null;
};

export function emptyCanonicalPersistenceSummary(): CanonicalPersistenceSummary {
  return {
    attempted: 0,
    inserted: 0,
    deduplicated: 0,
    insertedEventIds: [],
    persistedEvents: [],
    persistedEnvelopes: [],
  };
}

export function filterCanonicalEventsForDeltaCoexistence(params: {
  canonicalEvents: CanonicalEventsPayload | null;
  deltas: DaemonDeltasPayload | null | undefined;
}): CanonicalEventsPayload | null {
  const { canonicalEvents, deltas } = params;
  if (!canonicalEvents || canonicalEvents.length === 0) {
    return canonicalEvents;
  }
  if (!deltas || deltas.length === 0) {
    return canonicalEvents;
  }

  return canonicalEvents.filter((event) => event.type !== "assistant-message");
}

export function findCanonicalEventContextMismatch(params: {
  canonicalEvents: CanonicalEventsPayload;
  runId: string;
  threadId: string;
  threadChatId: string;
}): CanonicalEventContextMismatch | null {
  for (const event of params.canonicalEvents) {
    if (event.payloadVersion !== 2) {
      return { eventId: event.eventId, reason: "payloadVersion" };
    }
    if (event.runId !== params.runId) {
      return { eventId: event.eventId, reason: "runId" };
    }
    if (event.threadId !== params.threadId) {
      return { eventId: event.eventId, reason: "threadId" };
    }
    if (event.threadChatId !== params.threadChatId) {
      return { eventId: event.eventId, reason: "threadChatId" };
    }
  }

  return null;
}

export function findCanonicalRunTerminalEvent(
  canonicalEvents: CanonicalEventsPayload,
): CanonicalRunTerminalEvent | null {
  for (const event of canonicalEvents) {
    if (event.category !== "operational") continue;
    if (event.type !== "run-terminal") continue;
    return {
      eventId: event.eventId,
      seq: event.seq,
      status: event.status,
      errorMessage: event.errorMessage ?? null,
      errorCode: event.errorCode ?? null,
      headShaAtCompletion: event.headShaAtCompletion ?? null,
    };
  }
  return null;
}

export function splitCanonicalEventsForCommit(
  canonicalEvents: CanonicalEventsPayload | null,
): {
  canonicalEventsForPersistence: CanonicalEventsPayload | null;
  terminalCanonicalEventsForPersistence: CanonicalEventsPayload | null;
} {
  const terminalCanonicalEvents =
    canonicalEvents?.filter((event) => event.type === "run-terminal") ?? [];
  const canonicalEventsForPersistence =
    canonicalEvents?.filter((event) => event.type !== "run-terminal") ?? [];

  return {
    canonicalEventsForPersistence:
      canonicalEventsForPersistence.length > 0
        ? canonicalEventsForPersistence
        : null,
    terminalCanonicalEventsForPersistence:
      terminalCanonicalEvents.length > 0 ? terminalCanonicalEvents : null,
  };
}

export function buildPreLegacyAgUiCommitPlan(params: {
  canPersistCanonicalEvents: boolean;
  envelopeV2: DaemonEventEnvelopeV2 | null;
  messages: DaemonEventAPIBody["messages"];
  canonicalEventsForPersistence: CanonicalEventsPayload | null;
  deltas: DaemonDeltasPayload | null | undefined;
  runId: string;
}): PreLegacyAgUiCommitPlan {
  const canonicalRows = params.canonicalEventsForPersistence
    ? canonicalEventsToAgUiRows(params.canonicalEventsForPersistence)
    : [];
  const deltaRows =
    params.deltas && params.deltas.length > 0
      ? daemonDeltasToAgUiRows({ runId: params.runId, deltas: params.deltas })
      : [];
  const richPartRows =
    params.canPersistCanonicalEvents && params.envelopeV2
      ? buildRichPartRows({
          envelopeV2: params.envelopeV2,
          messages: params.messages,
        })
      : [];
  const mergedRows = [...canonicalRows, ...deltaRows, ...richPartRows];

  return {
    canonicalRows,
    deltaRows,
    richPartRows,
    mergedRows,
    requiresPersistence:
      canonicalRows.length > 0 ||
      (params.deltas != null && params.deltas.length > 0) ||
      richPartRows.length > 0,
  };
}

export function buildTerminalAgUiCommitPlan(params: {
  terminalCanonicalEventsForPersistence: CanonicalEventsPayload | null;
  deltaEndRows: AgUiPublishRow[];
}): TerminalAgUiCommitPlan {
  const terminalCanonicalRows = params.terminalCanonicalEventsForPersistence
    ? canonicalEventsToAgUiRows(params.terminalCanonicalEventsForPersistence)
    : [];
  return {
    terminalCanonicalRows,
    terminalMergedRows: [...params.deltaEndRows, ...terminalCanonicalRows],
  };
}

export async function commitPreLegacyAgUiEvents(params: {
  db: DB;
  canPersistCanonicalEvents: boolean;
  runId: string;
  threadId: string;
  threadChatId: string;
  plan: PreLegacyAgUiCommitPlan;
  canonicalEventsAttempted: number;
}): Promise<DaemonEventCommitSuccess | DaemonEventCommitFailure> {
  if (!params.canPersistCanonicalEvents && params.plan.requiresPersistence) {
    return {
      ok: false,
      status: 503,
      body: {
        success: false,
        error: "daemon_event_canonical_persistence_unavailable",
      },
    };
  }

  if (!params.plan.requiresPersistence) {
    return {
      ok: true,
      summary: emptyCanonicalPersistenceSummary(),
    };
  }

  try {
    const mergedResult = await persistAndPublishAgUiEvents({
      db: params.db,
      runId: params.runId,
      threadId: params.threadId,
      threadChatId: params.threadChatId,
      rows: params.plan.mergedRows,
    });
    recordAgentTraceSpan({
      traceId: params.runId,
      name: "server.daemon_event.merged.persisted",
      attributes: {
        threadId: params.threadId,
        threadChatId: params.threadChatId,
        runId: params.runId,
        canonicalRowCount: params.plan.canonicalRows.length,
        deltaRowCount: params.plan.deltaRows.length,
        richPartRowCount: params.plan.richPartRows.length,
        totalRows: params.plan.mergedRows.length,
        inserted: mergedResult.inserted,
        deduplicated: mergedResult.skipped,
      },
    });
    return {
      ok: true,
      summary: {
        attempted: params.canonicalEventsAttempted,
        inserted: mergedResult.inserted,
        deduplicated: mergedResult.skipped,
        insertedEventIds: mergedResult.insertedEventIds,
        persistedEvents: [],
        persistedEnvelopes: [],
      },
    };
  } catch (error) {
    console.error("[daemon-event] AG-UI merged persistence failed", {
      runId: params.runId,
      threadId: params.threadId,
      threadChatId: params.threadChatId,
      error,
    });
    return {
      ok: false,
      status: 500,
      body: {
        success: false,
        error: "daemon_event_canonical_event_persist_failed",
        code: "database_error",
        detail: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

export async function commitTerminalAgUiEvents(params: {
  db: DB;
  canPersistCanonicalEvents: boolean;
  runId: string;
  threadId: string;
  threadChatId: string;
  terminalCanonicalEventsForPersistence: CanonicalEventsPayload | null;
  deltaEndRows: AgUiPublishRow[];
}): Promise<DaemonTerminalCommitSuccess | DaemonEventCommitFailure> {
  const { terminalMergedRows } = buildTerminalAgUiCommitPlan({
    terminalCanonicalEventsForPersistence:
      params.terminalCanonicalEventsForPersistence,
    deltaEndRows: params.deltaEndRows,
  });

  if (terminalMergedRows.length === 0) {
    return {
      ok: true,
      summary: null,
    };
  }

  if (!params.canPersistCanonicalEvents) {
    return {
      ok: false,
      status: 503,
      body: {
        success: false,
        error: "daemon_event_canonical_persistence_unavailable",
      },
    };
  }

  let summary: CanonicalPersistenceSummary;
  try {
    const terminalPersistResult = await persistAgUiEvents({
      db: params.db,
      runId: params.runId,
      threadId: params.threadId,
      threadChatId: params.threadChatId,
      rows: terminalMergedRows,
    });
    summary = {
      attempted:
        (params.terminalCanonicalEventsForPersistence?.length ?? 0) +
        params.deltaEndRows.length,
      inserted: terminalPersistResult.inserted,
      deduplicated: terminalPersistResult.skipped,
      insertedEventIds: terminalPersistResult.insertedEventIds,
      persistedEvents: terminalPersistResult.persistedEvents,
      persistedEnvelopes: terminalPersistResult.persistedEnvelopes,
    };
  } catch (error) {
    console.error("[daemon-event] AG-UI terminal persistence failed", {
      runId: params.runId,
      threadId: params.threadId,
      threadChatId: params.threadChatId,
      error,
    });
    return {
      ok: false,
      status: 500,
      body: {
        success: false,
        error: "daemon_event_canonical_event_persist_failed",
        code: "database_error",
        detail: error instanceof Error ? error.message : String(error),
      },
    };
  }

  if (summary.persistedEvents.length > 0) {
    await publishPersistedAgUiEvents({
      threadChatId: params.threadChatId,
      persistedEvents: summary.persistedEvents,
      insertedEventIds: summary.insertedEventIds,
      persistedEnvelopes: summary.persistedEnvelopes,
    });
  }

  return {
    ok: true,
    summary,
  };
}

function buildRichPartRows(params: {
  envelopeV2: DaemonEventEnvelopeV2;
  messages: DaemonEventAPIBody["messages"];
}): AgUiPublishRow[] {
  const richPartRows: AgUiPublishRow[] = [];
  const richPartInputs: AssistantMessagePartsInput[] = [];
  const timestamp = new Date();
  let messageIndex = 0;
  for (const claudeMessage of params.messages) {
    const isCodexDeltaStreamed =
      claudeMessage.type === "assistant" &&
      claudeMessage._codexItemId !== undefined;
    const claudeStreamedBlockSet = new Set<number>(
      claudeMessage.type === "assistant"
        ? (claudeMessage._claudeStreamedBlockIndices ?? [])
        : [],
    );
    const dbMsgs: DBMessage[] = toDBMessage(claudeMessage);
    for (const dbMsg of dbMsgs) {
      const currentIndex = messageIndex;
      messageIndex++;
      if (dbMsg.type === "tool-call") {
        richPartRows.push(
          ...dbToolCallToAgUiRows({
            messageId: `${params.envelopeV2.eventId}:msg:${currentIndex}`,
            toolCall: dbMsg,
            timestamp,
          }),
        );
        continue;
      }
      if (dbMsg.type !== "agent") continue;
      if (isCodexDeltaStreamed) continue;
      const filteredParts =
        claudeStreamedBlockSet.size > 0
          ? dbMsg.parts.filter(
              (part, idx) =>
                !(
                  (part.type === "text" || part.type === "thinking") &&
                  claudeStreamedBlockSet.has(idx)
                ),
            )
          : dbMsg.parts;
      const hasRichParts = filteredParts.some((part) => part.type !== "text");
      if (!hasRichParts) continue;
      richPartInputs.push({
        messageId: `${params.envelopeV2.eventId}:msg:${currentIndex}`,
        parts: filteredParts,
      });
    }
  }
  if (richPartInputs.length > 0) {
    richPartRows.push(...dbAgentMessagePartsToAgUiRows(richPartInputs));
  }
  return richPartRows;
}

function dbToolCallToAgUiRows(params: {
  messageId: string;
  toolCall: DBToolCall;
  timestamp: Date;
}): AgUiPublishRow[] {
  const timestampMs = params.timestamp.getTime();
  const startEvent = {
    type: EventType.TOOL_CALL_START,
    timestamp: timestampMs,
    toolCallId: params.toolCall.id,
    toolCallName: params.toolCall.name,
  } satisfies ToolCallStartEvent;
  const argsEvent = {
    type: EventType.TOOL_CALL_ARGS,
    timestamp: timestampMs,
    toolCallId: params.toolCall.id,
    delta: JSON.stringify(params.toolCall.parameters ?? {}),
  } satisfies ToolCallArgsEvent;
  const endEvent = {
    type: EventType.TOOL_CALL_END,
    timestamp: timestampMs,
    toolCallId: params.toolCall.id,
  } satisfies ToolCallEndEvent;
  const events: BaseEvent[] = [startEvent, argsEvent, endEvent];
  const resultContent = dbToolCallResultContent(params.toolCall);
  if (resultContent !== null) {
    const resultEvent: ToolCallResultEvent =
      params.toolCall.status === "failed"
        ? {
            type: EventType.TOOL_CALL_RESULT,
            timestamp: timestampMs,
            messageId: params.toolCall.id,
            toolCallId: params.toolCall.id,
            content: resultContent,
            role: "tool",
            isError: true,
          }
        : {
            type: EventType.TOOL_CALL_RESULT,
            timestamp: timestampMs,
            messageId: params.toolCall.id,
            toolCallId: params.toolCall.id,
            content: resultContent,
          };
    events.push(resultEvent);
  }

  return events.map((event, index) => ({
    event,
    eventId: buildAgUiEventId(
      `msg:${params.messageId}`,
      String(event.type),
      index,
    ),
    timestamp: params.timestamp,
  }));
}

function dbToolCallResultContent(toolCall: DBToolCall): string | null {
  const rawOutput = Reflect.get(toolCall.parameters, "rawOutput");
  if (typeof rawOutput === "string" && rawOutput.length > 0) {
    return rawOutput;
  }
  if (toolCall.progressChunks && toolCall.progressChunks.length > 0) {
    return toolCall.progressChunks.map((chunk) => chunk.text).join("\n");
  }
  return null;
}
