"use client";

import type { AgentSubscriber } from "@ag-ui/client";
import { EventType, type AGUIEvent, type BaseEvent } from "@ag-ui/core";
import type { TerragonRunEvent } from "./terragon-run-aggregator";

type Dispatch = (event: TerragonRunEvent) => void;

function isOwnedAgUiEvent(event: BaseEvent): event is AGUIEvent {
  switch (event.type) {
    case EventType.RUN_ERROR:
    case EventType.TEXT_MESSAGE_START:
    case EventType.TEXT_MESSAGE_CONTENT:
    case EventType.TEXT_MESSAGE_CHUNK:
    case EventType.TEXT_MESSAGE_END:
    case EventType.TOOL_CALL_START:
    case EventType.TOOL_CALL_ARGS:
    case EventType.TOOL_CALL_CHUNK:
    case EventType.TOOL_CALL_END:
    case EventType.TOOL_CALL_RESULT:
    case EventType.STATE_SNAPSHOT:
    case EventType.STATE_DELTA:
    case EventType.MESSAGES_SNAPSHOT:
    case EventType.CUSTOM:
    case EventType.RAW:
    case EventType.THINKING_START:
    case EventType.THINKING_TEXT_MESSAGE_START:
    case EventType.THINKING_TEXT_MESSAGE_CONTENT:
    case EventType.THINKING_TEXT_MESSAGE_END:
    case EventType.THINKING_END:
    case EventType.REASONING_START:
    case EventType.REASONING_MESSAGE_START:
    case EventType.REASONING_MESSAGE_CONTENT:
    case EventType.REASONING_MESSAGE_CHUNK:
    case EventType.REASONING_MESSAGE_END:
    case EventType.REASONING_END:
      return true;
    default:
      return false;
  }
}

function dispatchEvent(
  dispatch: Dispatch,
  event: BaseEvent,
): { stopPropagation: true } | undefined {
  if (
    event.type === EventType.RUN_STARTED ||
    event.type === EventType.RUN_FINISHED
  ) {
    return { stopPropagation: true };
  }
  if (!isOwnedAgUiEvent(event)) {
    return undefined;
  }
  dispatch(event);
  return { stopPropagation: true };
}

function dispatchLegacyEvent(dispatch: Dispatch, event: AGUIEvent): void {
  dispatch(event);
}

type SubscriberOptions = {
  dispatch: Dispatch;
  runId: string;
  onRunFailed?: (error: Error) => void;
};

export function createTerragonAgUiSubscriber(
  options: SubscriberOptions,
): AgentSubscriber {
  const { dispatch, runId, onRunFailed } = options;
  return {
    onEvent: ({ event }) => dispatchEvent(dispatch, event),
    onTextMessageStartEvent: ({ event }) =>
      dispatchLegacyEvent(dispatch, event),
    onTextMessageContentEvent: ({ event }) =>
      dispatchLegacyEvent(dispatch, event),
    onTextMessageEndEvent: ({ event }) => dispatchLegacyEvent(dispatch, event),
    onToolCallStartEvent: ({ event }) => dispatchLegacyEvent(dispatch, event),
    onToolCallArgsEvent: ({ event }) => dispatchLegacyEvent(dispatch, event),
    onToolCallEndEvent: ({ event }) => dispatchLegacyEvent(dispatch, event),
    onToolCallResultEvent: ({ event }) => dispatchLegacyEvent(dispatch, event),
    onStateSnapshotEvent: ({ event }) => dispatchLegacyEvent(dispatch, event),
    onStateDeltaEvent: ({ event }) => dispatchLegacyEvent(dispatch, event),
    onMessagesSnapshotEvent: ({ event }) =>
      dispatchLegacyEvent(dispatch, event),
    onCustomEvent: ({ event }) => dispatchLegacyEvent(dispatch, event),
    onRawEvent: ({ event }) => dispatchLegacyEvent(dispatch, event),
    onReasoningStartEvent: ({ event }) => dispatchLegacyEvent(dispatch, event),
    onReasoningMessageStartEvent: ({ event }) =>
      dispatchLegacyEvent(dispatch, event),
    onReasoningMessageContentEvent: ({ event }) =>
      dispatchLegacyEvent(dispatch, event),
    onReasoningMessageEndEvent: ({ event }) =>
      dispatchLegacyEvent(dispatch, event),
    onReasoningEndEvent: ({ event }) => dispatchLegacyEvent(dispatch, event),
    onRunFinalized: () => dispatch({ type: EventType.RUN_FINISHED, runId }),
    onRunFailed: ({ error }) => {
      onRunFailed?.(error);
      const codeCandidate =
        typeof error === "object" && error !== null && "code" in error
          ? (error as Record<string, unknown>)["code"]
          : undefined;
      dispatch({
        type: "RUN_ERROR",
        message: error.message || "Run failed",
        ...(typeof codeCandidate === "string" ? { code: codeCandidate } : {}),
      });
    },
  };
}
