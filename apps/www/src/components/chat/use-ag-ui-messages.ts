"use client";

import type { HttpAgent } from "@ag-ui/client";
import { EventType } from "@ag-ui/core";
import { useEffect, useMemo, useReducer } from "react";
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
  agent: HttpAgent | null;
  snapshot: ThreadViewSnapshot;
  projectEvent?: (
    event: ThreadViewEventForAgUi,
  ) => ThreadViewEventForAgUi | null;
  includeTranscriptMessages?: boolean;
};

export type ThreadViewModelController = ThreadViewModel & {
  dispatchThreadViewEvent: (event: ThreadViewEvent) => void;
};

export function createThreadViewEventFromAgUiEvent(
  event: ThreadViewEventForAgUi,
  options?: { projectTranscript?: boolean },
): ThreadViewEvent {
  const projectTranscript = options?.projectTranscript;
  if (isRuntimeLifecycleEvent(event)) {
    return {
      type: "runtime.event",
      event,
      ...(projectTranscript !== undefined ? { projectTranscript } : {}),
    };
  }
  return {
    type: "ag-ui.event",
    event,
    ...(projectTranscript !== undefined ? { projectTranscript } : {}),
  };
}

export function useThreadViewModel({
  agent,
  snapshot,
  projectEvent,
  includeTranscriptMessages = true,
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
        const projectedEvent = projectEvent ? projectEvent(event) : event;
        if (!projectedEvent) {
          return;
        }
        try {
          dispatch(
            createThreadViewEventFromAgUiEvent(projectedEvent, {
              projectTranscript: includeTranscriptMessages,
            }),
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
  }, [agent, includeTranscriptMessages, projectEvent]);

  return useMemo(
    () => ({
      ...projectThreadViewModel(state, { includeTranscriptMessages }),
      dispatchThreadViewEvent: dispatch,
    }),
    [includeTranscriptMessages, state],
  );
}

export type ThreadViewEventForAgUi = Parameters<
  NonNullable<Parameters<HttpAgent["subscribe"]>[0]["onEvent"]>
>[0]["event"];

type ThreadViewSidecarEventProjectorOptions = {
  includeTranscriptEvents?: boolean;
};

export function createThreadViewSidecarEventProjector(
  options: ThreadViewSidecarEventProjectorOptions = {},
): (event: ThreadViewEventForAgUi) => ThreadViewEventForAgUi | null {
  const includeTranscriptEvents = options.includeTranscriptEvents ?? true;
  const planCandidateMessageIds = new Set<string>();
  let activeAssistantMessageId: string | null = null;

  return (event) => {
    switch (event.type) {
      case EventType.RUN_STARTED:
        activeAssistantMessageId = null;
        planCandidateMessageIds.clear();
        return event;
      case EventType.RUN_FINISHED:
      case EventType.RUN_ERROR:
        activeAssistantMessageId = null;
        planCandidateMessageIds.clear();
        return event;
      case EventType.TEXT_MESSAGE_START: {
        activeAssistantMessageId = getStringEventField(event, "messageId");
        return null;
      }
      case EventType.TEXT_MESSAGE_CONTENT:
      case EventType.TEXT_MESSAGE_CHUNK: {
        if (!includeTranscriptEvents) {
          return null;
        }
        const messageId = getStringEventField(event, "messageId");
        if (messageId && planCandidateMessageIds.has(messageId)) {
          if (
            getStringEventField(event, "delta")?.includes("</proposed_plan")
          ) {
            planCandidateMessageIds.delete(messageId);
          }
          return event;
        }
        const delta = getStringEventField(event, "delta");
        const shouldTrackPlan =
          delta?.includes("<") === true ||
          delta?.includes("proposed_plan") === true;
        if (messageId && shouldTrackPlan) {
          planCandidateMessageIds.add(messageId);
        }
        return shouldTrackPlan ? event : null;
      }
      case EventType.TEXT_MESSAGE_END: {
        if (!includeTranscriptEvents) {
          return null;
        }
        const messageId = getStringEventField(event, "messageId");
        const wasTrackingPlan =
          messageId !== null && planCandidateMessageIds.has(messageId);
        if (messageId) {
          planCandidateMessageIds.delete(messageId);
        }
        return wasTrackingPlan ? event : null;
      }
      case EventType.REASONING_MESSAGE_START:
      case EventType.REASONING_MESSAGE_CONTENT:
      case EventType.REASONING_MESSAGE_END:
      case EventType.REASONING_MESSAGE_CHUNK:
      case EventType.THINKING_TEXT_MESSAGE_START:
      case EventType.THINKING_TEXT_MESSAGE_CONTENT:
      case EventType.THINKING_TEXT_MESSAGE_END:
        return null;
      case EventType.TOOL_CALL_START:
        if (!includeTranscriptEvents) {
          return null;
        }
        if (getStringEventField(event, "parentMessageId")) {
          return event;
        }
        if (!activeAssistantMessageId) {
          return event;
        }
        return {
          ...event,
          parentMessageId: activeAssistantMessageId,
        };
      case EventType.TOOL_CALL_ARGS:
      case EventType.TOOL_CALL_CHUNK:
      case EventType.TOOL_CALL_END:
      case EventType.TOOL_CALL_RESULT:
        return includeTranscriptEvents ? event : null;
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
