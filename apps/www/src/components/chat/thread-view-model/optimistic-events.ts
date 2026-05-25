import type { DBUserMessage, ThreadStatus, UIMessage } from "@terragon/shared";
import type { ThreadPageChat } from "@terragon/shared/db/types";
import type { ClassifiedRepoFileLink } from "@terragon/shared/utils/repo-file-link";
import { stableSerialize } from "./renderable-part-shape";
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

export function createRepoFileOpenedEvent(
  link: ClassifiedRepoFileLink,
  ref?: string,
): ThreadViewEvent {
  return {
    type: "repo-file.opened",
    path: link.path,
    ...(ref ? { ref } : {}),
    ...(link.lineRange ? { lineRange: link.lineRange } : {}),
  };
}

export function applyOptimisticUserSubmit(
  state: ThreadViewModelState,
  event: Extract<ThreadViewEvent, { type: "optimistic.user-submitted" }>,
): ThreadViewModelState {
  const uiMessage = dbUserMessageToUiMessage({
    message: event.message,
    id: `user-optimistic-${state.threadChatId}-${state.dbMessages.length}`,
  });
  const duplicate = state.transcript.messages.some((message) =>
    isSameUserMessage(message, uiMessage),
  );
  const transcript = duplicate
    ? state.transcript
    : {
        ...state.transcript,
        messages: [...state.transcript.messages, uiMessage],
      };

  return {
    ...state,
    transcript,
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
    hasOptimisticTranscriptEvents: true,
  };
}

function dbUserMessageToUiMessage({
  message,
  id,
}: {
  message: DBUserMessage;
  id: string;
}): Extract<UIMessage, { role: "user" }> {
  return {
    id,
    role: "user",
    parts: message.parts,
    timestamp: message.timestamp,
    model: message.model,
  };
}

function isSameUserMessage(left: UIMessage, right: UIMessage): boolean {
  if (left.role !== "user" || right.role !== "user") {
    return false;
  }
  if (left.timestamp && right.timestamp && left.timestamp === right.timestamp) {
    return true;
  }
  return stableSerialize(left.parts) === stableSerialize(right.parts);
}
