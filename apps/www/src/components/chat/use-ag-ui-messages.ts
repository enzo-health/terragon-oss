"use client";

import type { HttpAgent } from "@ag-ui/client";
import { EventType } from "@ag-ui/core";
import type { AIAgent } from "@terragon/agent/types";
import type { UIMessage } from "@terragon/shared";
import { useEffect, useMemo, useReducer } from "react";
import {
  collapseHydrationReplayTextDuplicates,
  createInitialThreadViewModelState,
  projectThreadViewModel,
  threadViewModelReducer,
} from "./thread-view-model/reducer";
import { createEmptyThreadViewSnapshot } from "./thread-view-model/legacy-db-message-adapter";
import type {
  ThreadViewEvent,
  ThreadViewModel,
  ThreadViewSnapshot,
} from "./thread-view-model/types";

type UseAgUiMessagesArgs = {
  agent: HttpAgent | null;
  agentKind: AIAgent;
  initialMessages: UIMessage[];
};

type UseThreadViewModelArgs = {
  agent: HttpAgent | null;
  snapshot: ThreadViewSnapshot;
};

type ThreadViewModelController = ThreadViewModel & {
  dispatchThreadViewEvent: (event: ThreadViewEvent) => void;
};

export { collapseHydrationReplayTextDuplicates };

export function createThreadViewEventFromAgUiEvent(
  event: ThreadViewEventForAgUi,
): ThreadViewEvent {
  if (isRuntimeLifecycleEvent(event)) {
    return { type: "runtime.event", event };
  }
  return { type: "ag-ui.event", event };
}

export function useThreadViewModel({
  agent,
  snapshot,
}: UseThreadViewModelArgs): ThreadViewModelController {
  const [state, dispatch] = useReducer(
    threadViewModelReducer,
    snapshot,
    createInitialThreadViewModelState,
  );

  useEffect(() => {
    dispatch({ type: "snapshot.hydrated", snapshot });
  }, [snapshot]);

  useEffect(() => {
    if (!agent) return;

    const subscription = agent.subscribe({
      onEvent: ({ event }) => {
        try {
          dispatch(createThreadViewEventFromAgUiEvent(event));
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

  return useMemo(
    () => ({
      ...projectThreadViewModel(state),
      dispatchThreadViewEvent: dispatch,
    }),
    [state],
  );
}

type ThreadViewEventForAgUi = Parameters<
  NonNullable<Parameters<HttpAgent["subscribe"]>[0]["onEvent"]>
>[0]["event"];

function isRuntimeLifecycleEvent(event: ThreadViewEventForAgUi): boolean {
  return (
    event.type === EventType.RUN_STARTED ||
    event.type === EventType.RUN_FINISHED ||
    event.type === EventType.RUN_ERROR
  );
}

export function useAgUiMessages({
  agent,
  agentKind,
  initialMessages,
}: UseAgUiMessagesArgs): UIMessage[] {
  const snapshot = useMemo<ThreadViewSnapshot>(
    () =>
      createEmptyThreadViewSnapshot({
        agent: agentKind,
        initialMessages,
      }),
    [agentKind, initialMessages],
  );
  return useThreadViewModel({ agent, snapshot }).messages;
}
