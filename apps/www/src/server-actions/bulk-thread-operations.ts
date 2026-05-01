"use server";

import { userOnlyAction } from "@/lib/auth-server";
import { db } from "@/lib/db";
import { getPostHogServer } from "@/lib/posthog-server";
import { archiveAndStopThread } from "@/server-lib/archive-thread";
import { deleteThreadById, getThread } from "@terragon/shared/model/threads";
import { isAgentWorking } from "@/agent/thread-status";
import { stopThread } from "@/server-actions/stop-thread";
import { unwrapResult, UserFacingError } from "@/lib/server-actions";

export type BulkOperationResult = {
  succeeded: string[];
  failed: { threadId: string; error: string }[];
};

export const bulkArchiveThreads = userOnlyAction(
  async function bulkArchiveThreads(userId: string, threadIds: string[]) {
    console.log("bulkArchiveThreads", { userId, count: threadIds.length });

    const result: BulkOperationResult = {
      succeeded: [],
      failed: [],
    };

    // Process sequentially to avoid overwhelming the system
    for (const threadId of threadIds) {
      try {
        await archiveAndStopThread({ userId, threadId });
        result.succeeded.push(threadId);
      } catch (error) {
        console.error(`Failed to archive thread ${threadId}:`, error);
        result.failed.push({
          threadId,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }

    getPostHogServer().capture({
      distinctId: userId,
      event: "bulk_archive_threads",
      properties: {
        count: threadIds.length,
        succeeded: result.succeeded.length,
        failed: result.failed.length,
      },
    });

    return result;
  },
  { defaultErrorMessage: "Failed to archive tasks" },
);

export const bulkUnarchiveThreads = userOnlyAction(
  async function bulkUnarchiveThreads(userId: string, threadIds: string[]) {
    console.log("bulkUnarchiveThreads", { userId, count: threadIds.length });

    const { updateThread } = await import("@terragon/shared/model/threads");
    const result: BulkOperationResult = {
      succeeded: [],
      failed: [],
    };

    for (const threadId of threadIds) {
      try {
        await updateThread({
          db,
          userId,
          threadId,
          updates: {
            archived: false,
            updatedAt: new Date(),
          },
        });
        result.succeeded.push(threadId);
      } catch (error) {
        console.error(`Failed to unarchive thread ${threadId}:`, error);
        result.failed.push({
          threadId,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }

    getPostHogServer().capture({
      distinctId: userId,
      event: "bulk_unarchive_threads",
      properties: {
        count: threadIds.length,
        succeeded: result.succeeded.length,
        failed: result.failed.length,
      },
    });

    return result;
  },
  { defaultErrorMessage: "Failed to unarchive tasks" },
);

export const bulkDeleteThreads = userOnlyAction(
  async function bulkDeleteThreads(userId: string, threadIds: string[]) {
    console.log("bulkDeleteThreads", { userId, count: threadIds.length });

    const result: BulkOperationResult = {
      succeeded: [],
      failed: [],
    };

    for (const threadId of threadIds) {
      try {
        const thread = await getThread({
          db,
          userId,
          threadId,
        });

        if (!thread) {
          throw new UserFacingError("Task not found");
        }

        // Stop any active agents
        await Promise.all(
          thread.threadChats.map(async (threadChat) => {
            if (isAgentWorking(threadChat.status)) {
              unwrapResult(
                await stopThread({ threadId, threadChatId: threadChat.id }),
              );
            }
          }),
        );

        await deleteThreadById({ db, threadId, userId });
        result.succeeded.push(threadId);
      } catch (error) {
        console.error(`Failed to delete thread ${threadId}:`, error);
        result.failed.push({
          threadId,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }

    getPostHogServer().capture({
      distinctId: userId,
      event: "bulk_delete_threads",
      properties: {
        count: threadIds.length,
        succeeded: result.succeeded.length,
        failed: result.failed.length,
      },
    });

    return result;
  },
  { defaultErrorMessage: "Failed to delete tasks" },
);
