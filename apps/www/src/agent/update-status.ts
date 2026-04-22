import { db } from "@/lib/db";
import {
  getThreadChat,
  updateThread,
  updateThreadChat,
  updateThreadChatStatusAtomic,
} from "@terragon/shared/model/threads";
import { ThreadError } from "./error";
import { handleTransition, ThreadEvent } from "./machine";
import { ThreadChatInsert, ThreadInsert, ThreadStatus } from "@terragon/shared";
import { markThreadChatAsUnread } from "@terragon/shared/model/thread-read-status";
import { publishBroadcastUserMessage } from "@terragon/shared/broadcast-server";

export async function updateThreadChatWithTransition({
  userId,
  threadId,
  threadChatId,
  eventType,
  markAsUnread,
  rateLimitResetTime,
  updates,
  chatUpdates,
  requireStatusTransitionForChatUpdates = false,
  skipAppendMessagesInBroadcast = false,
  skipBroadcast = false,
}: {
  threadId: string;
  userId: string;
  threadChatId: string;
  eventType: ThreadEvent;
  markAsUnread?: boolean;
  rateLimitResetTime?: number;
  updates?: Partial<ThreadInsert>;
  chatUpdates?: Omit<
    ThreadChatInsert,
    "threadChatId" | "status" | "reattemptQueueAt"
  >;
  requireStatusTransitionForChatUpdates?: boolean;
  skipAppendMessagesInBroadcast?: boolean;
  skipBroadcast?: boolean;
}): Promise<{
  didUpdateStatus: boolean;
  updatedStatus: ThreadStatus | undefined;
  chatSequence?: number;
  broadcastData?: Parameters<typeof publishBroadcastUserMessage>[0];
}> {
  const threadChat = await getThreadChat({
    db,
    threadId,
    threadChatId,
    userId,
  });
  if (!threadChat) {
    throw new ThreadError("unknown-error", "Thread not found", null);
  }
  let didUpdateStatus = false;
  let chatSequence: number | undefined;
  const updatedStatus = handleTransition(threadChat.status, eventType);
  if (updatedStatus) {
    let reattemptQueueAt: Date | null | undefined = undefined;
    // Handle reattemptQueueAt based on status transition
    if (
      updatedStatus === "queued-sandbox-creation-rate-limit" ||
      updatedStatus === "queued-agent-rate-limit"
    ) {
      // Set reattempt time based on rate limit reset time
      if (rateLimitResetTime !== undefined) {
        reattemptQueueAt = new Date(rateLimitResetTime);
      } else if (!threadChat.reattemptQueueAt) {
        // Fallback to 1 hour if no reset time provided
        reattemptQueueAt = new Date(Date.now() + 60 * 60 * 1000);
      }
    }
    const updatedThreadOrUndefined = await updateThreadChatStatusAtomic({
      db,
      userId,
      threadId,
      threadChatId,
      fromStatus: threadChat.status,
      toStatus: updatedStatus,
      reattemptQueueAt,
    });
    if (!!updatedThreadOrUndefined) {
      didUpdateStatus = true;
    }
  }
  if (updates) {
    await updateThread({
      db,
      userId,
      threadId,
      updates,
    });
  }
  let broadcastData:
    | Parameters<typeof publishBroadcastUserMessage>[0]
    | undefined;
  if (
    chatUpdates &&
    (!requireStatusTransitionForChatUpdates || didUpdateStatus)
  ) {
    const chatUpdateResult = await updateThreadChat({
      db,
      userId,
      threadId,
      threadChatId,
      updates: chatUpdates,
      skipAppendMessagesInBroadcast,
      skipBroadcast,
    });
    chatSequence = chatUpdateResult.chatSequence;
    broadcastData = chatUpdateResult.broadcastData;
  }
  if (didUpdateStatus && (updates || chatUpdates)) {
    if (markAsUnread) {
      await markThreadChatAsUnread({
        db,
        userId,
        threadId,
        threadChatIdOrNull: threadChatId,
        shouldPublishRealtimeEvent: true,
      });
    }
  }
  return {
    didUpdateStatus,
    updatedStatus: updatedStatus ?? undefined,
    ...(chatSequence !== undefined ? { chatSequence } : {}),
    ...(broadcastData !== undefined ? { broadcastData } : {}),
  };
}
