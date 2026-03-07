import type { ThreadInfoFull, ThreadChatInfoFull } from "../db/types";

const activeThreadStatuses: ReadonlySet<ThreadChatInfoFull["status"]> = new Set(
  [
    "queued",
    "queued-blocked",
    "queued-sandbox-creation-rate-limit",
    "queued-tasks-concurrency",
    "queued-agent-rate-limit",
    "booting",
    "working",
    "stopping",
    "working-stopped",
    "working-error",
    "working-done",
    "checkpointing",
  ],
);

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
  const activeChats = threadChats.filter((chat) =>
    activeThreadStatuses.has(chat.status),
  );
  const candidateChats = activeChats.length > 0 ? activeChats : threadChats;
  const threadChat = candidateChats.sort(
    (left, right) =>
      getThreadChatTimestampValue(right) - getThreadChatTimestampValue(left),
  )[0];
  if (!threadChat) {
    throw new Error(`Thread ${thread.id} does not have any thread chats`);
  }
  return threadChat;
}

export const LEGACY_THREAD_CHAT_ID = "legacy-thread-chat-id";
