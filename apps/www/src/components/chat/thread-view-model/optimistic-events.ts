import type { DBUserMessage, ThreadStatus } from "@terragon/shared";
import type { ThreadPageChat } from "@terragon/shared/db/types";
import type { RepoFileLineRange } from "@terragon/shared/utils/repo-file-link";
import { restoreThreadStatus, setThreadStatus } from "./status-setter";
import type { ThreadViewEvent, ThreadViewModelState } from "./types";

export function createOptimisticUserSubmittedEvent({
  message,
  optimisticStatus,
  clientSubmissionId,
}: {
  message: DBUserMessage;
  optimisticStatus: ThreadStatus;
  clientSubmissionId: string;
}): ThreadViewEvent {
  return {
    type: "optimistic.user-submitted",
    message: { ...message, clientSubmissionId },
    optimisticStatus,
    clientSubmissionId,
  };
}

export function createOptimisticUserSubmitRejectedEvent({
  clientSubmissionId,
}: {
  clientSubmissionId: string;
}): ThreadViewEvent {
  return {
    type: "optimistic.user-submit-rejected",
    clientSubmissionId,
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
  const priorLifecycle = state.lifecycle;
  return {
    ...setThreadStatus(state, event.optimisticStatus),
    dbMessages: [...state.dbMessages, event.message],
    sidePanel: {
      ...state.sidePanel,
      messages: [...state.sidePanel.messages, event.message],
    },
    optimisticOverlay: {
      ...state.optimisticOverlay,
      userSubmit: {
        clientSubmissionId: event.clientSubmissionId,
        message: event.message,
        priorLifecycle,
      },
    },
  };
}

export function applyOptimisticUserSubmitRejected(
  state: ThreadViewModelState,
  event: Extract<ThreadViewEvent, { type: "optimistic.user-submit-rejected" }>,
): ThreadViewModelState {
  const pending = state.optimisticOverlay.userSubmit;
  if (!pending || pending.clientSubmissionId !== event.clientSubmissionId) {
    return state;
  }
  const restored = restoreThreadStatus(state, pending.priorLifecycle);
  const matchesPending = (m: (typeof state.dbMessages)[number]): boolean =>
    m === pending.message ||
    (m.type === "user" &&
      m.clientSubmissionId !== undefined &&
      m.clientSubmissionId === pending.clientSubmissionId);
  return {
    ...restored,
    dbMessages: state.dbMessages.filter((m) => !matchesPending(m)),
    sidePanel: {
      ...state.sidePanel,
      messages: state.sidePanel.messages.filter((m) => !matchesPending(m)),
    },
    optimisticOverlay: {
      ...state.optimisticOverlay,
      userSubmit: null,
    },
  };
}
