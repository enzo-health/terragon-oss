import { db } from "@/lib/db";
import { dispatchAgentMessage } from "@/agent/msg/startAgentMessage";
import { updateThreadChatWithTransition } from "@/agent/update-status";
import { getPostHogServer } from "@/lib/posthog-server";
import { DBSystemMessage } from "@terragon/shared";
import { waitUntil } from "@vercel/functions";
import { persistSideEffectAgUiMessages } from "./ag-ui-side-effect-messages";

export async function sendSystemMessage({
  userId,
  threadId,
  threadChatId,
  message,
}: {
  userId: string;
  threadId: string;
  threadChatId: string;
  message: DBSystemMessage;
}) {
  console.log("sendSystemMessage", threadId, message);
  getPostHogServer().capture({
    distinctId: userId,
    event: "system_message",
    properties: {
      threadId,
      messageType: message.message_type,
    },
  });
  const { didUpdateStatus, updatedStatus, chatSequence } =
    await updateThreadChatWithTransition({
      userId,
      threadId,
      threadChatId,
      eventType: "system.message",
      chatUpdates: {
        errorMessage: null,
        errorMessageInfo: null,
        appendMessages: [message],
      },
    });
  if (!didUpdateStatus) {
    throw new Error("Failed to update thread");
  }
  await persistSideEffectAgUiMessages({
    db,
    threadId,
    threadChatId,
    messages: [message],
    source: `system-message:${message.message_type}`,
    chatSequence,
    runId: `pre-run:${threadChatId}:system-message:${message.message_type}:${
      chatSequence ?? "unknown"
    }`,
  });
  if (updatedStatus === "working" || updatedStatus === "queued") {
    waitUntil(
      dispatchAgentMessage({
        db,
        message: null,
        userId,
        threadId,
        threadChatId,
        isNewThread: false,
      }),
    );
  }
}
