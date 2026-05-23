import type { DBUserMessage } from "@terragon/shared";

export function appendUniqueQueuedMessages(
  baseMessages: DBUserMessage[],
  nextMessages: readonly DBUserMessage[],
): DBUserMessage[] {
  let didAppend = false;
  const out = [...baseMessages];
  for (const message of nextMessages) {
    if (out.some((existing) => isSameQueuedMessage(existing, message))) {
      continue;
    }
    out.push(message);
    didAppend = true;
  }
  return didAppend ? out : baseMessages;
}

export function isSameQueuedMessage(
  left: DBUserMessage,
  right: DBUserMessage,
): boolean {
  return (
    left.parts.length === right.parts.length &&
    left.parts.every(
      (part, index) =>
        JSON.stringify(part) === JSON.stringify(right.parts[index]),
    )
  );
}
