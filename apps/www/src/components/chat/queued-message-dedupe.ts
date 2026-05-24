import type { DBUserMessage } from "@terragon/shared";

export type QueuedUserMessage = {
  clientSubmissionId: string;
  message: DBUserMessage;
};

const clientSubmissionIds = new WeakMap<DBUserMessage, string>();

export function appendUniqueQueuedMessages(
  baseMessages: DBUserMessage[],
  nextMessages: readonly QueuedUserMessage[],
): DBUserMessage[] {
  let didAppend = false;
  const out = [...baseMessages];
  for (const incomingMessage of nextMessages) {
    if (
      out.some((existing) => isSameQueuedMessage(existing, incomingMessage))
    ) {
      continue;
    }
    clientSubmissionIds.set(
      incomingMessage.message,
      incomingMessage.clientSubmissionId,
    );
    out.push(incomingMessage.message);
    didAppend = true;
  }
  return didAppend ? out : baseMessages;
}

function isSameQueuedMessage(
  left: DBUserMessage,
  right: QueuedUserMessage,
): boolean {
  if (left === right.message) {
    return true;
  }
  return clientSubmissionIds.get(left) === right.clientSubmissionId;
}
