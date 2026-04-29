"use client";

import type { AgentSubscriber } from "@ag-ui/client";
import { EventType, type AGUIEvent } from "@ag-ui/core";
import type { TerragonRunEvent } from "./terragon-run-aggregator";

type Dispatch = (event: TerragonRunEvent) => void;

function dispatchEvent(dispatch: Dispatch, event: AGUIEvent): void {
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
    onTextMessageStartEvent: ({ event }) => dispatchEvent(dispatch, event),
    onTextMessageContentEvent: ({ event }) => dispatchEvent(dispatch, event),
    onTextMessageEndEvent: ({ event }) => dispatchEvent(dispatch, event),
    onToolCallStartEvent: ({ event }) => dispatchEvent(dispatch, event),
    onToolCallArgsEvent: ({ event }) => dispatchEvent(dispatch, event),
    onToolCallEndEvent: ({ event }) => dispatchEvent(dispatch, event),
    onToolCallResultEvent: ({ event }) => dispatchEvent(dispatch, event),
    onStateSnapshotEvent: ({ event }) => dispatchEvent(dispatch, event),
    onStateDeltaEvent: ({ event }) => dispatchEvent(dispatch, event),
    onMessagesSnapshotEvent: ({ event }) => dispatchEvent(dispatch, event),
    onCustomEvent: ({ event }) => dispatchEvent(dispatch, event),
    onRawEvent: ({ event }) => dispatchEvent(dispatch, event),
    onReasoningStartEvent: ({ event }) => dispatchEvent(dispatch, event),
    onReasoningMessageStartEvent: ({ event }) => dispatchEvent(dispatch, event),
    onReasoningMessageContentEvent: ({ event }) =>
      dispatchEvent(dispatch, event),
    onReasoningMessageEndEvent: ({ event }) => dispatchEvent(dispatch, event),
    onReasoningEndEvent: ({ event }) => dispatchEvent(dispatch, event),
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
