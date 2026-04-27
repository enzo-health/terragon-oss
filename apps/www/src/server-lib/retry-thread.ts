import { db } from "@/lib/db";
import { ThreadChat } from "@terragon/shared";
import { updateThreadChat } from "@terragon/shared/model/threads";
import { hasNativeAgUiUserMessage } from "./ag-ui-side-effect-messages";

export async function ensureThreadChatHasUserMessage({
  threadChat,
}: {
  threadChat: ThreadChat;
}) {
  const hasUserMessage = await hasNativeAgUiUserMessage({
    db,
    threadChatId: threadChat.id,
  });
  if (!hasUserMessage) {
    const retryMessage = {
      type: "system" as const,
      message_type: "generic-retry" as const,
      parts: [{ type: "text" as const, text: "Please try again." }],
      model: null,
    };
    await updateThreadChat({
      db,
      userId: threadChat.userId,
      threadId: threadChat.threadId,
      threadChatId: threadChat.id,
      updates: {
        appendMessages: [retryMessage],
      },
    });
  }
}
