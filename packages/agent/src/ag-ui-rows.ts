import {
  EventType,
  type BaseEvent,
  type ReasoningMessageEndEvent,
  type ReasoningMessageStartEvent,
  type TextMessageEndEvent,
  type TextMessageStartEvent,
} from "@ag-ui/core";
import type { CanonicalEvent } from "./canonical-events";
import {
  type DaemonDeltaInput,
  mapCanonicalEventToAgui,
  mapDaemonDeltaToAgui,
} from "./ag-ui-mapper";

export type AgUiEventRow = {
  event: BaseEvent;
  eventId: string;
  timestamp: Date;
  threadChatMessageSeq?: number;
};

export type AgUiWireEventRow = {
  event: BaseEvent;
  eventId: string;
  timestampMs: number;
};

export function buildAgUiEventId(
  canonicalEventId: string,
  agUiEventType: string,
  expansionIndex: number,
): string {
  return `${canonicalEventId}:${agUiEventType}:${expansionIndex}`;
}

export function canonicalEventsToAgUiRows(
  events: CanonicalEvent[],
): AgUiEventRow[] {
  const rows: AgUiEventRow[] = [];
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

export function daemonDeltasToAgUiRows(params: {
  runId: string;
  deltas: readonly DaemonDeltaInput[];
  timestamp?: Date;
}): AgUiEventRow[] {
  const { runId, deltas } = params;
  const rows: AgUiEventRow[] = [];
  const now = params.timestamp ?? new Date();
  const startedPairs = new Set<string>();
  for (const delta of deltas) {
    if (delta.kind === "tool-output") {
      const agUi = mapDaemonDeltaToAgui({
        messageId: delta.messageId,
        partIndex: delta.partIndex,
        deltaSeq: delta.deltaSeq,
        kind: "tool-output",
        text: delta.text,
        ...(delta.toolCallId !== undefined
          ? { toolCallId: delta.toolCallId }
          : {}),
        ...(delta.stream !== undefined ? { stream: delta.stream } : {}),
      });
      const eventId = `delta:${runId}:${delta.messageId}:${delta.partIndex}:tool-output:${delta.deltaSeq}`;
      rows.push({ event: agUi, eventId, timestamp: now });
      continue;
    }
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

export function buildDeltaRunEndRows(params: {
  runId: string;
  openMessages: ReadonlyArray<{
    messageId: string;
    kind: "text" | "thinking";
  }>;
  timestamp?: Date;
}): AgUiEventRow[] {
  const { runId, openMessages } = params;
  const ts = params.timestamp ?? new Date();
  const rows: AgUiEventRow[] = [];
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

export function agUiRowsToWire(
  rows: readonly AgUiEventRow[],
): AgUiWireEventRow[] {
  return rows.map((row) => ({
    event: row.event,
    eventId: row.eventId,
    timestampMs: row.timestamp.getTime(),
  }));
}

export function agUiWireRowsToRows(
  rows: readonly AgUiWireEventRow[],
): AgUiEventRow[] {
  return rows.map((row) => ({
    event: row.event,
    eventId: row.eventId,
    timestamp: new Date(row.timestampMs),
  }));
}

export function buildStandardAgUiWireRows(params: {
  runId: string;
  canonicalEvents: readonly CanonicalEvent[];
  deltas: readonly DaemonDeltaInput[];
  timestamp?: Date;
}): AgUiWireEventRow[] {
  const nonTerminal = params.canonicalEvents.filter(
    (event) => event.type !== "run-terminal",
  );
  const contentRows = canonicalEventsToAgUiRows(nonTerminal);
  const deltaRows =
    params.deltas.length > 0
      ? daemonDeltasToAgUiRows({
          runId: params.runId,
          deltas: params.deltas,
          ...(params.timestamp !== undefined
            ? { timestamp: params.timestamp }
            : {}),
        })
      : [];
  return agUiRowsToWire([...contentRows, ...deltaRows]);
}
