import type { DaemonEventAPIBody } from "@terragon/daemon/shared";
import type { DBMessage } from "@terragon/shared";
import { toDBMessage } from "@/agent/msg/toDBMessage";
import {
  type AgUiPublishRow,
  type AssistantMessagePartsInput,
  canonicalEventsToAgUiRows,
  daemonDeltasToAgUiRows,
  dbAgentMessagePartsToAgUiRows,
  type PersistAgUiEventsResult,
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

export function buildCanonicalRunTerminalEvent(params: {
  envelope: DaemonEventEnvelopeV2;
  threadId: string;
  threadChatId: string;
  status: "completed" | "failed" | "stopped";
  errorMessage: string | null;
  errorCode: string | null;
  headShaAtCompletion: string | null;
}): CanonicalEventsPayload[number] {
  return {
    payloadVersion: 2,
    eventId: params.envelope.eventId,
    runId: params.envelope.runId,
    threadId: params.threadId,
    threadChatId: params.threadChatId,
    seq: params.envelope.seq,
    timestamp: new Date().toISOString(),
    category: "operational",
    type: "run-terminal",
    status: params.status,
    errorMessage: params.errorMessage,
    errorCode: params.errorCode,
    headShaAtCompletion: params.headShaAtCompletion,
  };
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

function buildRichPartRows(params: {
  envelopeV2: DaemonEventEnvelopeV2;
  messages: DaemonEventAPIBody["messages"];
}): AgUiPublishRow[] {
  const richPartInputs: AssistantMessagePartsInput[] = [];
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
  return richPartInputs.length > 0
    ? dbAgentMessagePartsToAgUiRows(richPartInputs)
    : [];
}
