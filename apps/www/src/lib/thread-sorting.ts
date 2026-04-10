import { ThreadInfo } from "@leo/shared/db/types";
import { isAgentWorking } from "@/agent/thread-status";

export type MinimalThreadInfoForSorting = Pick<
  ThreadInfo,
  "updatedAt" | "createdAt"
> & {
  threadChats: Pick<ThreadInfo["threadChats"][number], "status">[];
};

/**
 * Sorts threads with stable ordering to prevent UI jumping
 *
 * Sorting logic:
 * 1. If both threads are working and within 1 minute of each other: sort by created time (older first)
 * 2. For all other cases: sort by updated time (newer first)
 */
export function sortThreadsUpdatedAt<T extends MinimalThreadInfoForSorting>(
  threads: T[],
): T[] {
  return [...threads].sort((a, b) => {
    // If both threads have the same working state (both working or both not working),
    // and they are working, sort by createdAt so that tasks don't jump around.
    const aWorking = a.threadChats.some((chat) => isAgentWorking(chat.status));
    const bWorking = b.threadChats.some((chat) => isAgentWorking(chat.status));
    const updatedAtDiff =
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    if (
      aWorking === bWorking &&
      aWorking &&
      Math.abs(updatedAtDiff) < 60 * 1000
    ) {
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    }
    // For all other cases, sort by updatedAt (newer first)
    return updatedAtDiff;
  });
}
