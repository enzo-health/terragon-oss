import { ThreadChat, DBThreadContextMessage } from "@leo/shared";
import { DB } from "@leo/shared/db/index";
import { updateThreadChat } from "@leo/shared/model/threads";
import { generateSessionSummary } from "./generate-session-summary";

export function getThreadContextMessageToGenerate({
  threadChat,
}: {
  threadChat: ThreadChat;
}) {
  const messages = threadChat.messages ?? [];
  if (messages[0]?.type !== "thread-context") {
    return null;
  }
  for (let i = 1; i < messages.length; i++) {
    const message = messages[i];
    if (!message) {
      continue;
    }
    if (message.type === "thread-context-result") {
      return null;
    }
  }
  return messages[0];
}

export async function generateThreadContextResult({
  db,
  userId,
  threadId,
  threadChatId,
  threadContextMessage,
}: {
  db: DB;
  userId: string;
  threadId: string;
  threadChatId: string;
  threadContextMessage: DBThreadContextMessage;
}) {
  const threadContextSummary = await generateSessionSummary({
    sessionHistory: threadContextMessage.threadChatHistory,
    nextTask: threadContextMessage.taskDescription,
  });
  if (!threadContextSummary) {
    return;
  }
  await updateThreadChat({
    db,
    userId,
    threadId,
    threadChatId,
    updates: {
      appendMessages: [
        {
          type: "thread-context-result",
          summary: threadContextSummary,
        },
        {
          type: "user",
          model: null,
          parts: [
            {
              type: "text",
              text: `\n\n---\n\nContext from previous task:\n\n${threadContextSummary}`,
            },
          ],
        },
      ],
    },
  });
}
