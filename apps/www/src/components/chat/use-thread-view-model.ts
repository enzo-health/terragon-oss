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
export { createThreadViewSidecarEventProjector } from "./thread-view-model/sidecars";

type UseThreadViewModelArgs = {
  snapshot: ThreadViewSnapshot;
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
}: UseThreadViewModelArgs): ThreadViewModelController {
  const projectedTraceKeysRef = useRef<Set<string>>(new Set());
  const [state, dispatch] = useReducer(
    threadViewModelReducer,
    snapshot,
    createInitialThreadViewModelState,
  );

  useEffect(() => {
    dispatch({ type: "snapshot.hydrated", snapshot, at: Date.now() });
  }, [snapshot]);

  const viewModel = useMemo(() => {
    const projected = projectThreadViewModel(state);
    return {
      ...projected,
      dispatchThreadViewEvent: dispatch,
    };
  }, [state]);

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
        dbMessageCount: viewModel.dbMessages.length,
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
