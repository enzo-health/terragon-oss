import type { ThreadInfoFull, ThreadChatInfoFull } from "../db/types";
import { isPrimaryChatLiveThreadStatus } from "../model/thread-lifecycle-policy";

function getThreadChatTimestampValue(chat: ThreadChatInfoFull): number {
  const updatedAtTime = chat.updatedAt.getTime();
  if (Number.isFinite(updatedAtTime)) {
    return updatedAtTime;
  }
  const createdAtTime = chat.createdAt.getTime();
  if (Number.isFinite(createdAtTime)) {
    return createdAtTime;
  }
  return 0;
}

export function getPrimaryThreadChat(
  thread: ThreadInfoFull,
): ThreadChatInfoFull {
  const threadChats = [...thread.threadChats];
  const liveChats = threadChats.filter((chat) =>
    isPrimaryChatLiveThreadStatus(chat.status),
  );
  const candidateChats = liveChats.length > 0 ? liveChats : threadChats;
  const threadChat = candidateChats.sort(
    (left, right) =>
      getThreadChatTimestampValue(right) - getThreadChatTimestampValue(left),
  )[0];
  if (!threadChat) {
    throw new Error(`Thread ${thread.id} does not have any thread chats`);
  }
  return threadChat;
}
