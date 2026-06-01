import type { DBUserMessage } from "@terragon/shared";
import type { ExternalTaskIntakeSource } from "./types";

const EXTERNAL_TASK_INTAKE_MARKER_PREFIX = "terragon-external-task-intake:";

export function buildExternalTaskIntakeDedupeMarker({
  source,
  idempotencyKey,
}: {
  source: ExternalTaskIntakeSource;
  idempotencyKey: string | undefined;
}): string | null {
  if (!idempotencyKey) {
    return null;
  }
  return `<!-- ${EXTERNAL_TASK_INTAKE_MARKER_PREFIX}${encodeURIComponent(source)}:${encodeURIComponent(idempotencyKey)} -->`;
}

export function appendExternalTaskIntakeDedupeMarker({
  message,
  marker,
}: {
  message: DBUserMessage;
  marker: string | null;
}): DBUserMessage {
  if (!marker || userMessageContainsText(message, marker)) {
    return message;
  }
  return {
    ...message,
    parts: [...message.parts, { type: "text", text: `\n\n${marker}` }],
  };
}

export function userMessageContainsText(
  message: DBUserMessage,
  text: string,
): boolean {
  return message.parts.some(
    (part) => part.type === "text" && part.text.includes(text),
  );
}
