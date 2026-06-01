import type { DBUserMessage, ThreadStatus } from "@terragon/shared";
import type { ThreadPageChat } from "@terragon/shared/db/types";
import type { RepoFileLineRange } from "@terragon/shared/utils/repo-file-link";
import type { ThreadViewEvent, ThreadViewModelState } from "./types";

export function createOptimisticUserSubmittedEvent({
  message,
  optimisticStatus,
}: {
  message: DBUserMessage;
  optimisticStatus: ThreadStatus;
}): ThreadViewEvent {
  return {
    type: "optimistic.user-submitted",
    message,
    optimisticStatus,
  };
}

export function createOptimisticQueuedMessagesUpdatedEvent(
  messages: DBUserMessage[],
): ThreadViewEvent {
  return {
    type: "optimistic.queued-messages-updated",
    messages,
  };
}

export function createOptimisticPermissionModeUpdatedEvent(
  permissionMode: ThreadPageChat["permissionMode"],
): ThreadViewEvent {
  return {
    type: "optimistic.permission-mode-updated",
    permissionMode,
  };
}

export function createRepoFileOpenedEvent({
  path,
  ref,
  lineRange,
}: {
  path: string;
  ref?: string;
  lineRange?: RepoFileLineRange;
}): ThreadViewEvent {
  return {
    type: "repo-file.opened",
    path,
    ...(ref ? { ref } : {}),
    ...(lineRange ? { lineRange } : {}),
  };
}

export function createRepoTreeOpenedEvent({
  ref,
}: {
  ref?: string;
}): ThreadViewEvent {
  return {
    type: "repo-tree.opened",
    ...(ref ? { ref } : {}),
  };
}

export function applyOptimisticUserSubmit(
  state: ThreadViewModelState,
  event: Extract<ThreadViewEvent, { type: "optimistic.user-submitted" }>,
): ThreadViewModelState {
  return {
    ...state,
    dbMessages: [...state.dbMessages, event.message],
    sidePanel: {
      ...state.sidePanel,
      messages: [...state.sidePanel.messages, event.message],
    },
    threadStatus: event.optimisticStatus,
    lifecycle: {
      ...state.lifecycle,
      threadStatus: event.optimisticStatus,
      runStarted: event.optimisticStatus !== "complete",
    },
    hasOptimisticUserSubmit: true,
  };
}
