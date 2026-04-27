import { DBThreadContextMessage } from "@terragon/shared";
import { DB } from "@terragon/shared/db/index";
import { updateThreadChat } from "@terragon/shared/model/threads";
import { generateSessionSummary } from "./generate-session-summary";

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
  const messagesToAppend = [
    {
      type: "thread-context-result" as const,
      summary: threadContextSummary,
    },
    {
      type: "user" as const,
      model: null,
      parts: [
        {
          type: "text" as const,
          text: `\n\n---\n\nContext from previous task:\n\n${threadContextSummary}`,
        },
      ],
    },
  ];
  await updateThreadChat({
    db,
    userId,
    threadId,
    threadChatId,
    updates: {
      appendMessages: messagesToAppend,
    },
  });
}
