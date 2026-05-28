import { type BaseEvent, EventType } from "@ag-ui/core";
import type { AgUiEventEnvelope } from "@terragon/shared/model/agent-event-log";
import { getLatestRunIdForThreadChat } from "@terragon/shared/model/agent-event-log";
import type { AgUiReplayCursor } from "@/lib/ag-ui-replay-cursor";
import { shouldReplayEnvelope } from "@/lib/ag-ui-replay-cursor";
import { db } from "@/lib/db";
import { stableSerialize } from "@/lib/stable-serialize";
import { getStringEventField, type ReplayIdentity } from "./ag-ui-stream-entry";

export type ReplayEntry = {
  seq: number | null;
  event: BaseEvent;
  identity?: ReplayIdentity;
};

const NO_STRUCTURAL_DEDUPE_EVENT_TYPES = new Set<string>([
  EventType.TEXT_MESSAGE_CONTENT,
  EventType.REASONING_MESSAGE_CONTENT,
  EventType.TOOL_CALL_ARGS,
]);

export function isTerminalRunEventType(type: BaseEvent["type"]): boolean {
  return type === EventType.RUN_FINISHED || type === EventType.RUN_ERROR;
}

function getIntegerEventField(event: BaseEvent, field: string): number | null {
  const value = Reflect.get(event, field);
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : null;
}

export function getReplayDedupeKey(
  event: BaseEvent,
  identity?: ReplayIdentity,
): string | null {
  const runId = identity?.runId ?? getStringEventField(event, "runId");
  if (
    runId &&
    (event.type === EventType.RUN_STARTED ||
      event.type === EventType.RUN_FINISHED ||
      event.type === EventType.RUN_ERROR)
  ) {
    return `run-lifecycle:${runId}:${event.type}`;
  }

  const eventId = identity?.eventId ?? getStringEventField(event, "eventId");
  if (runId && eventId) {
    return `run-event:${runId}:${eventId}`;
  }
  if (eventId) {
    return `event:${eventId}`;
  }

  const idempotencyKey =
    identity?.idempotencyKey ?? getStringEventField(event, "idempotencyKey");
  if (runId && idempotencyKey) {
    return `run-idempotency:${runId}:${idempotencyKey}`;
  }
  if (idempotencyKey) {
    return `idempotency:${idempotencyKey}`;
  }

  const seq = identity?.seq ?? getIntegerEventField(event, "seq");
  if (runId && seq !== null) {
    return `run-seq:${runId}:${seq}`;
  }

  const messageId = getStringEventField(event, "messageId");
  const deltaSeq = getIntegerEventField(event, "deltaSeq");
  if (messageId && deltaSeq !== null) {
    return `message-delta:${event.type}:${messageId}:${deltaSeq}`;
  }

  if (NO_STRUCTURAL_DEDUPE_EVENT_TYPES.has(event.type)) {
    return null;
  }
  return `event:${stableSerialize(event)}`;
}

export function toReplayEntries(
  envelopes: AgUiEventEnvelope[],
  cursor: AgUiReplayCursor | null,
): ReplayEntry[] {
  return dropEventsAfterTerminalUntilNextRun(
    repairDelayedRunStartedOrdering(
      envelopes
        .filter((entry) => shouldReplayEnvelope(entry, cursor))
        .map((entry) => ({
          seq: entry.seq,
          event: entry.payload,
          identity: {
            runId: entry.runId,
            eventId: entry.eventId,
            idempotencyKey: entry.idempotencyKey,
            seq: entry.seq,
            projectionIndex: entry.projectionIndex,
            projectionCount: entry.projectionCount,
          },
        })),
    ),
    { keepInterRunUserAndSystemSnapshots: false },
  );
}

export function toReplayEntriesWithoutTerminalFilter(
  envelopes: AgUiEventEnvelope[],
  cursor: AgUiReplayCursor | null,
): ReplayEntry[] {
  return repairDelayedRunStartedOrdering(
    envelopes
      .filter((entry) => shouldReplayEnvelope(entry, cursor))
      .map((entry) => ({
        seq: entry.seq,
        event: entry.payload,
        identity: {
          runId: entry.runId,
          eventId: entry.eventId,
          idempotencyKey: entry.idempotencyKey,
          seq: entry.seq,
          projectionIndex: entry.projectionIndex,
          projectionCount: entry.projectionCount,
        },
      })),
  );
}

export function getReplayEntryRunId(entry: ReplayEntry): string | null {
  return entry.identity?.runId ?? getStringEventField(entry.event, "runId");
}

function repairDelayedRunStartedOrdering(
  entries: ReplayEntry[],
): ReplayEntry[] {
  const repaired: ReplayEntry[] = [];
  let index = 0;

  while (index < entries.length) {
    const runId = getReplayEntryRunId(entries[index]!);
    if (runId === null) {
      repaired.push(entries[index]!);
      index += 1;
      continue;
    }

    const runEntries: ReplayEntry[] = [];
    while (
      index < entries.length &&
      getReplayEntryRunId(entries[index]!) === runId
    ) {
      runEntries.push(entries[index]!);
      index += 1;
    }
    repaired.push(...repairSingleRunStartedOrdering(runEntries));
  }

  return repaired;
}

function repairSingleRunStartedOrdering(entries: ReplayEntry[]): ReplayEntry[] {
  const firstRunStartedIndex = entries.findIndex(
    (entry) => entry.event.type === EventType.RUN_STARTED,
  );
  if (firstRunStartedIndex <= 0) {
    return firstRunStartedIndex === 0
      ? dropDuplicateRunStarted(entries)
      : entries;
  }

  const leadingSnapshots: ReplayEntry[] = [];
  let firstNonSnapshotIndex = 0;
  while (
    firstNonSnapshotIndex < entries.length &&
    entries[firstNonSnapshotIndex]!.event.type === EventType.MESSAGES_SNAPSHOT
  ) {
    leadingSnapshots.push(entries[firstNonSnapshotIndex]!);
    firstNonSnapshotIndex += 1;
  }

  const firstRunStarted = entries[firstRunStartedIndex]!;
  const rest = entries.filter(
    (entry, entryIndex) =>
      entryIndex >= firstNonSnapshotIndex &&
      entry.event.type !== EventType.RUN_STARTED,
  );

  return [...leadingSnapshots, firstRunStarted, ...rest];
}

function dropDuplicateRunStarted(entries: ReplayEntry[]): ReplayEntry[] {
  let hasRunStarted = false;
  return entries.filter((entry) => {
    if (entry.event.type !== EventType.RUN_STARTED) {
      return true;
    }
    if (hasRunStarted) {
      return false;
    }
    hasRunStarted = true;
    return true;
  });
}

export function repairReplayTextMessageLifecycles(
  entries: ReplayEntry[],
): ReplayEntry[] {
  const repaired: ReplayEntry[] = [];
  const activeTextMessageIds = new Set<string>();
  const activeReasoningMessageIds = new Set<string>();

  for (const entry of entries) {
    if (entry.event.type === EventType.RUN_STARTED) {
      activeTextMessageIds.clear();
      activeReasoningMessageIds.clear();
      repaired.push(entry);
      continue;
    }

    if (entry.event.type === EventType.TEXT_MESSAGE_START) {
      const messageId = getStringEventField(entry.event, "messageId");
      if (messageId !== null) {
        activeTextMessageIds.add(messageId);
      }
      repaired.push(entry);
      continue;
    }

    if (
      entry.event.type === EventType.TEXT_MESSAGE_CONTENT ||
      entry.event.type === EventType.TEXT_MESSAGE_CHUNK
    ) {
      const messageId = getStringEventField(entry.event, "messageId");
      if (messageId !== null && !activeTextMessageIds.has(messageId)) {
        repaired.push({
          seq: null,
          event: {
            type: EventType.TEXT_MESSAGE_START,
            messageId,
            role: "assistant",
          },
        });
        activeTextMessageIds.add(messageId);
      }
      repaired.push(entry);
      continue;
    }

    if (entry.event.type === EventType.TEXT_MESSAGE_END) {
      const messageId = getStringEventField(entry.event, "messageId");
      if (messageId === null || !activeTextMessageIds.has(messageId)) {
        continue;
      }
      activeTextMessageIds.delete(messageId);
      repaired.push(entry);
      continue;
    }

    if (entry.event.type === EventType.REASONING_MESSAGE_START) {
      const messageId = getStringEventField(entry.event, "messageId");
      if (messageId !== null) {
        activeReasoningMessageIds.add(messageId);
      }
      repaired.push(entry);
      continue;
    }

    if (
      entry.event.type === EventType.REASONING_MESSAGE_CONTENT ||
      entry.event.type === EventType.REASONING_MESSAGE_CHUNK
    ) {
      const messageId = getStringEventField(entry.event, "messageId");
      if (messageId !== null && !activeReasoningMessageIds.has(messageId)) {
        repaired.push({
          seq: null,
          event: {
            type: EventType.REASONING_MESSAGE_START,
            messageId,
            role: "reasoning",
          },
        });
        activeReasoningMessageIds.add(messageId);
      }
      repaired.push(entry);
      continue;
    }

    if (entry.event.type === EventType.REASONING_MESSAGE_END) {
      const messageId = getStringEventField(entry.event, "messageId");
      if (messageId === null || !activeReasoningMessageIds.has(messageId)) {
        continue;
      }
      activeReasoningMessageIds.delete(messageId);
      repaired.push(entry);
      continue;
    }

    repaired.push(entry);
  }

  return repaired;
}

export function dropEventsAfterTerminalUntilNextRun(
  entries: ReplayEntry[],
  options: { keepInterRunUserAndSystemSnapshots: boolean } = {
    keepInterRunUserAndSystemSnapshots: false,
  },
): ReplayEntry[] {
  const filtered: ReplayEntry[] = [];
  let sawTerminal = false;

  for (const entry of entries) {
    if (entry.event.type === EventType.RUN_STARTED) {
      sawTerminal = false;
      filtered.push(entry);
      continue;
    }
    if (sawTerminal) {
      if (
        options.keepInterRunUserAndSystemSnapshots &&
        isUserOrSystemMessagesSnapshot(entry.event)
      ) {
        filtered.push(entry);
      }
      continue;
    }
    filtered.push(entry);
    if (isTerminalRunEventType(entry.event.type)) {
      sawTerminal = true;
    }
  }

  return filtered;
}

function isUserOrSystemMessagesSnapshot(event: BaseEvent): boolean {
  if (event.type !== EventType.MESSAGES_SNAPSHOT) {
    return false;
  }
  const messages = Reflect.get(event, "messages");
  return (
    Array.isArray(messages) &&
    messages.length > 0 &&
    messages.every(
      (message) =>
        typeof message === "object" &&
        message !== null &&
        (Reflect.get(message, "role") === "user" ||
          Reflect.get(message, "role") === "system"),
    )
  );
}

export function splitHistoryOnlyPrefix(envelopes: AgUiEventEnvelope[]): {
  historyOnlyLastSeq: number | null;
  replayEnvelopes: AgUiEventEnvelope[];
} {
  const firstRunEventIndex = envelopes.findIndex(
    (entry) => entry.payload.type !== EventType.MESSAGES_SNAPSHOT,
  );
  if (firstRunEventIndex <= 0) {
    return { historyOnlyLastSeq: null, replayEnvelopes: envelopes };
  }
  const lastHistoryOnlyEnvelope = envelopes[firstRunEventIndex - 1];
  return {
    historyOnlyLastSeq: lastHistoryOnlyEnvelope?.seq ?? null,
    replayEnvelopes: envelopes.slice(firstRunEventIndex),
  };
}

export function sseIdForReplayEntry(
  seq: number | null,
  identity?: ReplayIdentity,
): string | undefined {
  if (seq === null) {
    return undefined;
  }
  if (identity?.projectionCount !== undefined && identity.projectionCount > 1) {
    return `${seq}:${identity.projectionIndex ?? 0}`;
  }
  return String(seq);
}

export function buildResumeRunStartedEvent({
  threadId,
  runId,
}: {
  threadId: string;
  runId: string;
}): BaseEvent {
  return {
    type: EventType.RUN_STARTED,
    threadId,
    runId,
  };
}

/**
 * Resolve the effective runId for an SSE connection.
 *
 * Resolution order:
 * 1. If the client supplied `?runId=X`, use it verbatim (reconnect path).
 * 2. If the client supplied only a seq cursor, return null — the caller
 *    will replay thread-chat-wide from that cursor.
 * 3. Otherwise the connect is fresh (GET, no cursor); default to the
 *    thread chat's latest run. Empty thread chats get null — the first
 *    RUN_STARTED from a new daemon-event will naturally be the first event.
 */
export async function resolveEffectiveRunId(params: {
  runIdParam: string | null;
  replayCursorSeq: number | null;
  isGetMethod: boolean;
  threadChatId: string;
  threadId: string;
}): Promise<string | null> {
  const { runIdParam, replayCursorSeq, isGetMethod, threadChatId, threadId } =
    params;

  if (runIdParam !== null) {
    return runIdParam;
  }

  if (replayCursorSeq !== null) {
    return null;
  }

  if (!isGetMethod) {
    return null;
  }

  try {
    return await getLatestRunIdForThreadChat({ db, threadChatId });
  } catch (error) {
    console.error(
      "[ag-ui] getLatestRunIdForThreadChat failed; defaulting to live-tail",
      { threadId, threadChatId },
      error,
    );
    return null;
  }
}
