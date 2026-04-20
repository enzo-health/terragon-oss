import {
  EventType,
  type BaseEvent,
  type CustomEvent,
  type RunErrorEvent,
  type RunFinishedEvent,
  type RunStartedEvent,
  type TextMessageContentEvent,
  type TextMessageEndEvent,
  type TextMessageStartEvent,
  type ToolCallArgsEvent,
  type ToolCallEndEvent,
  type ToolCallResultEvent,
  type ToolCallStartEvent,
} from "@ag-ui/core";

import type {
  AssistantMessageEvent,
  CanonicalEvent,
  OperationalRunStartedEvent,
  ToolCallResultEvent as CanonicalToolCallResultEvent,
  ToolCallStartEvent as CanonicalToolCallStartEvent,
} from "./canonical-events";

/**
 * Pure mapping functions from Terragon's canonical events / daemon deltas /
 * meta events to the AG-UI protocol (@ag-ui/core BaseEvent union).
 *
 * No I/O. No side effects. Every function is unit-testable in isolation.
 */

// ---------------------------------------------------------------------------
// Canonical event → AG-UI BaseEvent[]
// ---------------------------------------------------------------------------

/** Map one canonical event to the AG-UI event(s) it represents. */
export function mapCanonicalEventToAgui(event: CanonicalEvent): BaseEvent[] {
  const timestamp = Date.parse(event.timestamp);

  switch (event.type) {
    case "run-started":
      return [mapRunStarted(event, timestamp)];
    case "assistant-message":
      return mapAssistantMessage(event, timestamp);
    case "tool-call-start":
      return mapToolCallStart(event, timestamp);
    case "tool-call-result":
      return [mapToolCallResult(event, timestamp)];
  }
}

function mapRunStarted(
  event: OperationalRunStartedEvent,
  timestamp: number,
): RunStartedEvent {
  return {
    type: EventType.RUN_STARTED,
    timestamp,
    threadId: event.threadId,
    runId: event.runId,
  } as RunStartedEvent;
}

function mapAssistantMessage(
  event: AssistantMessageEvent,
  timestamp: number,
): BaseEvent[] {
  const content = typeof event.content === "string" ? event.content : "";

  const start: TextMessageStartEvent = {
    type: EventType.TEXT_MESSAGE_START,
    timestamp,
    messageId: event.messageId,
    role: "assistant",
  } as TextMessageStartEvent;

  const events: BaseEvent[] = [start];

  if (content.length > 0) {
    const contentEvent: TextMessageContentEvent = {
      type: EventType.TEXT_MESSAGE_CONTENT,
      timestamp,
      messageId: event.messageId,
      delta: content,
    } as TextMessageContentEvent;
    events.push(contentEvent);
  }

  const end: TextMessageEndEvent = {
    type: EventType.TEXT_MESSAGE_END,
    timestamp,
    messageId: event.messageId,
  } as TextMessageEndEvent;
  events.push(end);

  return events;
}

function mapToolCallStart(
  event: CanonicalToolCallStartEvent,
  timestamp: number,
): BaseEvent[] {
  const start: ToolCallStartEvent = {
    type: EventType.TOOL_CALL_START,
    timestamp,
    toolCallId: event.toolCallId,
    toolCallName: event.name,
    ...(event.parentToolUseId
      ? { parentMessageId: event.parentToolUseId }
      : {}),
  } as ToolCallStartEvent;

  // Serialize args as a single ARGS chunk. Daemons that support progressive
  // arg streaming can emit multiple ToolCallArgsEvents between START and END.
  const argsJson = JSON.stringify(event.parameters ?? {});
  const args: ToolCallArgsEvent = {
    type: EventType.TOOL_CALL_ARGS,
    timestamp,
    toolCallId: event.toolCallId,
    delta: argsJson,
  } as ToolCallArgsEvent;

  const end: ToolCallEndEvent = {
    type: EventType.TOOL_CALL_END,
    timestamp,
    toolCallId: event.toolCallId,
  } as ToolCallEndEvent;

  return [start, args, end];
}

function mapToolCallResult(
  event: CanonicalToolCallResultEvent,
  timestamp: number,
): ToolCallResultEvent {
  return {
    type: EventType.TOOL_CALL_RESULT,
    timestamp,
    messageId: event.toolCallId,
    toolCallId: event.toolCallId,
    content: event.result,
    ...(event.isError ? { role: "tool" as const } : {}),
  } as ToolCallResultEvent;
}

// ---------------------------------------------------------------------------
// Daemon delta → AG-UI content event
// ---------------------------------------------------------------------------

export type DaemonDeltaInput = {
  messageId: string;
  partIndex: number;
  deltaSeq: number;
  kind?: "text" | "thinking";
  text: string;
};

export function mapDaemonDeltaToAgui(
  delta: DaemonDeltaInput,
  timestamp = Date.now(),
): BaseEvent {
  if (delta.kind === "thinking") {
    return {
      type: EventType.REASONING_MESSAGE_CONTENT,
      timestamp,
      messageId: delta.messageId,
      delta: delta.text,
    } as BaseEvent;
  }
  return {
    type: EventType.TEXT_MESSAGE_CONTENT,
    timestamp,
    messageId: delta.messageId,
    delta: delta.text,
  } as TextMessageContentEvent;
}

// ---------------------------------------------------------------------------
// Meta event → AG-UI CUSTOM event (fire-and-forget, not persisted)
// ---------------------------------------------------------------------------

export type MetaEventInput = { kind: string; [key: string]: unknown };

export function mapMetaEventToAgui(
  meta: MetaEventInput,
  timestamp = Date.now(),
): CustomEvent {
  return {
    type: EventType.CUSTOM,
    timestamp,
    name: meta.kind,
    value: meta,
  } as CustomEvent;
}

// ---------------------------------------------------------------------------
// Run terminal → RUN_FINISHED | RUN_ERROR
// ---------------------------------------------------------------------------

export function mapRunFinishedToAgui(
  threadId: string,
  runId: string,
  stopped = false,
  timestamp = Date.now(),
): RunFinishedEvent {
  return {
    type: EventType.RUN_FINISHED,
    timestamp,
    threadId,
    runId,
    ...(stopped ? { result: { stopped: true } } : {}),
  } as RunFinishedEvent;
}

export function mapRunErrorToAgui(
  message: string,
  code: string | undefined = undefined,
  timestamp = Date.now(),
): RunErrorEvent {
  return {
    type: EventType.RUN_ERROR,
    timestamp,
    message,
    ...(code ? { code } : {}),
  } as RunErrorEvent;
}

// ---------------------------------------------------------------------------
// Convenience: AG-UI event → JSON line for SSE `data:` frames
// ---------------------------------------------------------------------------

export function serializeAgUiEvent(event: BaseEvent): string {
  return JSON.stringify(event);
}
