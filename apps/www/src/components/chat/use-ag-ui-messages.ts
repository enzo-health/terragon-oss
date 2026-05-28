"use client";

import type { HttpAgent } from "@ag-ui/client";
import { EventType } from "@ag-ui/core";
import { useEffect, useMemo, useReducer, useRef } from "react";
import { recordAgentTraceSpan } from "@/lib/agent-trace";
import {
  createInitialThreadViewModelState,
  projectThreadViewModel,
  threadViewModelReducer,
} from "./thread-view-model/reducer";
import type {
  ThreadViewEvent,
  ThreadViewModel,
  ThreadViewSnapshot,
} from "./thread-view-model/types";

type UseThreadViewModelArgs = {
  snapshot: ThreadViewSnapshot;
  includeTranscriptMessages?: boolean;
};

export type ThreadViewModelController = ThreadViewModel & {
  dispatchThreadViewEvent: (event: ThreadViewEvent) => void;
};

type UseAgUiSidecarRouterArgs = {
  agent: HttpAgent | null;
  dispatchThreadViewEvent: (event: ThreadViewEvent) => void;
  projectEvent?: (
    event: ThreadViewEventForAgUi,
  ) => ThreadViewEventForAgUi | null;
  onStatusOrTerminalEvent?: () => void;
};

export function createProductSidecarThreadViewEvent(
  event: ThreadViewEventForAgUi,
): ThreadViewEvent {
  if (isRuntimeLifecycleEvent(event)) {
    return {
      type: "runtime.event",
      event,
    };
  }
  return {
    type: "ag-ui.event",
    event,
  };
}

export function useAgUiSidecarRouter({
  agent,
  dispatchThreadViewEvent,
  projectEvent,
  onStatusOrTerminalEvent,
}: UseAgUiSidecarRouterArgs): void {
  const dispatchRef = useRef(dispatchThreadViewEvent);
  const projectEventRef = useRef(projectEvent);
  const onStatusOrTerminalEventRef = useRef(onStatusOrTerminalEvent);

  dispatchRef.current = dispatchThreadViewEvent;
  projectEventRef.current = projectEvent;
  onStatusOrTerminalEventRef.current = onStatusOrTerminalEvent;

  useEffect(() => {
    if (!agent) return;

    const subscription = agent.subscribe({
      onEvent: ({ event }) => {
        if (isStatusOrTerminalEvent(event)) {
          onStatusOrTerminalEventRef.current?.();
        }
        recordAgUiEventReceipt(event);
        const projectedEvent = projectEventRef.current
          ? projectEventRef.current(event)
          : event;
        if (!projectedEvent) {
          return;
        }
        try {
          dispatchRef.current(
            createProductSidecarThreadViewEvent(projectedEvent),
          );
        } catch {
          // Malformed projection events are quarantined by the reducer; keep the
          // subscription healthy if a future event shape still slips through.
        }
      },
    });
    return () => {
      subscription.unsubscribe();
    };
  }, [agent]);
}

export function useThreadViewModel({
  snapshot,
  includeTranscriptMessages = true,
}: UseThreadViewModelArgs): ThreadViewModelController {
  const projectedTraceKeysRef = useRef<Set<string>>(new Set());
  const [state, dispatch] = useReducer(
    threadViewModelReducer,
    snapshot,
    createInitialThreadViewModelState,
  );

  useEffect(() => {
    dispatch({ type: "snapshot.hydrated", snapshot });
  }, [snapshot]);

  const viewModel = useMemo(() => {
    const projected = projectThreadViewModel(state, {
      includeTranscriptMessages,
    });
    return {
      ...projected,
      dispatchThreadViewEvent: dispatch,
    };
  }, [includeTranscriptMessages, state]);

  useEffect(() => {
    const runId = viewModel.lifecycle.runId;
    if (!runId || viewModel.lifecycle.runStarted) {
      return;
    }
    const traceKey = `${runId}:${viewModel.lifecycle.threadStatus}`;
    if (projectedTraceKeysRef.current.has(traceKey)) {
      return;
    }
    projectedTraceKeysRef.current.add(traceKey);
    recordAgentTraceSpan({
      traceId: runId,
      name: "client.ui.projected",
      attributes: {
        threadStatus: viewModel.lifecycle.threadStatus,
        messageCount: viewModel.messages.length,
        quarantineCount: viewModel.quarantine.length,
      },
    });
  }, [viewModel]);

  return viewModel;
}

export type ThreadViewEventForAgUi = Parameters<
  NonNullable<Parameters<HttpAgent["subscribe"]>[0]["onEvent"]>
>[0]["event"];

function recordAgUiEventReceipt(event: ThreadViewEventForAgUi): void {
  const messageId = getStringEventField(event, "messageId");
  const traceId = getStringEventField(event, "runId") ?? messageId;
  const eventTimestampMs = getNumberEventField(event, "timestamp");
  recordAgentTraceSpan({
    traceId,
    name: "client.agui.event.received",
    attributes: {
      eventType: String(event.type),
      messageId,
      eventTimestampMs,
    },
  });
}

function getNumberEventField(
  event: ThreadViewEventForAgUi,
  key: string,
): number | null {
  const value = Reflect.get(event, key);
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isStatusOrTerminalEvent(event: ThreadViewEventForAgUi): boolean {
  if (
    event.type === EventType.RUN_FINISHED ||
    event.type === EventType.RUN_ERROR
  ) {
    return true;
  }
  return (
    event.type === EventType.CUSTOM &&
    Reflect.get(event, "name") === "thread.status_changed"
  );
}

export function createThreadViewSidecarEventProjector(): (
  event: ThreadViewEventForAgUi,
) => ThreadViewEventForAgUi | null {
  return (event) => {
    switch (event.type) {
      case EventType.RUN_STARTED:
      case EventType.RUN_FINISHED:
      case EventType.RUN_ERROR:
        return event;
      case EventType.TEXT_MESSAGE_START:
      case EventType.TEXT_MESSAGE_CONTENT:
      case EventType.TEXT_MESSAGE_CHUNK:
      case EventType.TEXT_MESSAGE_END:
      case EventType.REASONING_MESSAGE_START:
      case EventType.REASONING_MESSAGE_CONTENT:
      case EventType.REASONING_MESSAGE_END:
      case EventType.REASONING_MESSAGE_CHUNK:
      case EventType.THINKING_TEXT_MESSAGE_START:
      case EventType.THINKING_TEXT_MESSAGE_CONTENT:
      case EventType.THINKING_TEXT_MESSAGE_END:
      case EventType.TOOL_CALL_START:
      case EventType.TOOL_CALL_ARGS:
      case EventType.TOOL_CALL_CHUNK:
      case EventType.TOOL_CALL_END:
      case EventType.TOOL_CALL_RESULT:
        return null;
      default:
        return event;
    }
  };
}

function isRuntimeLifecycleEvent(event: ThreadViewEventForAgUi): boolean {
  return (
    event.type === EventType.RUN_STARTED ||
    event.type === EventType.RUN_FINISHED ||
    event.type === EventType.RUN_ERROR
  );
}

function getStringEventField(
  event: ThreadViewEventForAgUi,
  field: string,
): string | null {
  const value = Reflect.get(event, field);
  return typeof value === "string" ? value : null;
}
