import type { DBUserMessage, ThreadStatus } from "@terragon/shared";
import type { ThreadPageChat } from "@terragon/shared/db/types";
import type { ThreadViewEvent } from "./types";

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
