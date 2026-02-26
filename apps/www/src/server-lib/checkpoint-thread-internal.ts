import { db } from "@/lib/db";
import { wrapError, ThreadError } from "@/agent/error";
import { openPullRequestForThread } from "@/agent/pull-request";
import { setActiveThreadChat } from "@/agent/sandbox-resource";
import { getPostHogServer } from "@/lib/posthog-server";
import { env } from "@terragon/env/apps-www";
import {
  getGitDiffMaybeCutoff,
  gitDiffStats,
  gitCommitAndPushBranch,
} from "@terragon/sandbox/commands";
import { ISandboxSession } from "@terragon/sandbox/types";
import {
  DBMessage,
  DBSystemMessage,
  GitDiffStats,
  ThreadInsert,
  ThreadChatInsert,
} from "@terragon/shared";
import {
  getThread,
  getThreadChat,
  getThreadMinimal,
  updateThread,
  updateThreadChat,
} from "@terragon/shared/model/threads";
import { createGitDiffCheckpoint } from "@terragon/shared/utils/git-diff";
import { sanitizeForJson } from "@terragon/shared/utils/sanitize-json";
import { generateCommitMessage } from "./generate-commit-message";
import { sendSystemMessage } from "./send-system-message";

export async function checkpointThreadAndPush({
  threadId,
  threadChatId,
  userId,
  session,
  createPR,
  prType,
}: {
  threadId: string;
  threadChatId: string;
  userId: string;
  session: ISandboxSession;
  createPR: boolean;
  prType: "draft" | "ready";
}) {
  const thread = await getThread({ db, threadId, userId });
  if (!thread) {
    throw new ThreadError("unknown-error", "Thread not found", null);
  }
  const getGitDiffOrThrow = async (): Promise<{
    diffOutput: string | null;
    diffStats: GitDiffStats | null;
  }> => {
    try {
      const diffOutput = await getGitDiffMaybeCutoff({
        session,
        baseBranch: thread.repoBaseBranchName,
        allowCutoff: false,
      });
      const diffStats = await gitDiffStats(session, {
        baseBranch: thread.repoBaseBranchName,
      });
      return { diffOutput: sanitizeForJson(diffOutput), diffStats };
    } catch (error) {
      console.error("Failed to get git diff:", error);
      throw wrapError("git-checkpoint-diff-failed", error);
    }
  };

  // Git integrity checks are now always enabled

  try {
    let commitAndPushError: unknown = null;
    const updates: Partial<ThreadInsert> = {};
    const chatUpdates: Omit<ThreadChatInsert, "threadChatId"> = {};
    try {
      // Commit changes and push
      const { branchName, errorMessage } = await gitCommitAndPushBranch({
        session,
        args: {
          githubAppName: env.NEXT_PUBLIC_GITHUB_APP_NAME,
          baseBranch: thread.repoBaseBranchName,
          generateCommitMessage: generateCommitMessage,
        },
        enableIntegrityChecks: true,
      });
      if (errorMessage) {
        console.error("Failed at gitCommitAndPushBranch:", errorMessage);
        throw new ThreadError("git-checkpoint-push-failed", errorMessage, null);
      }
      if (branchName) {
        updates.branchName = branchName;
      }
    } catch (e) {
      // Keep this error for later, try to checkpoint a git diff anyway.
      commitAndPushError = wrapError("git-checkpoint-push-failed", e);
    }

    // Update git diff stats
    const { diffOutput, diffStats } = await getGitDiffOrThrow();
    updates.gitDiff = diffOutput;
    updates.gitDiffStats = diffStats;

    // Check if git diff has changed. We need to check the diff stats because
    // the diff output might be cutoff or simply "too-large".
    const diffOutputHasChanged =
      diffOutput === "too-large" ||
      diffOutput !== thread.gitDiff ||
      diffStats?.files !== thread.gitDiffStats?.files ||
      diffStats?.additions !== thread.gitDiffStats?.additions ||
      diffStats?.deletions !== thread.gitDiffStats?.deletions;
    if (diffOutput && diffOutputHasChanged) {
      // Create git diff checkpoint message
      const gitDiffMessage = createGitDiffCheckpoint({
        diff: diffOutput,
        diffStats,
      });
      chatUpdates.appendMessages = [gitDiffMessage];

      getPostHogServer().capture({
        distinctId: userId,
        event: "git_diff_changed",
        properties: {
          threadId,
          gitDiffSize: diffOutput.length,
          ...diffStats,
        },
      });
    }

    if (Object.keys(updates).length > 0) {
      await updateThread({
        db,
        userId,
        threadId,
        updates,
      });
    }
    if (Object.keys(chatUpdates).length > 0) {
      await updateThreadChat({
        db,
        userId,
        threadId,
        threadChatId,
        updates: chatUpdates,
      });
    }

    if (commitAndPushError) {
      // If the error is a git commit and push error, we can try to auto-fix it.
      // If we can't auto-fix it, we'll throw the error.
      if (
        await maybeAutoFixGitCommitAndPushError({
          userId,
          threadId,
          threadChatId,
          error: commitAndPushError,
        })
      ) {
        return;
      }
      throw commitAndPushError;
    }

    // Create PR if:
    // 1. Normal case: diffOutput exists and diff has changed
    // 2. After git retry: diffOutput exists but thread doesn't have a PR yet
    //    (handles the case where git push failed after diff was captured)
    if (diffOutput && (diffOutputHasChanged || !thread.githubPRNumber)) {
      if (createPR) {
        try {
          // UI_READY_GUARD:checkpointAutoReady
          await openPullRequestForThread({
            userId,
            threadId,
            prType: prType,
            skipCommitAndPush: true,
            session,
          });
        } catch (e) {
          console.error("Failed to create PR:", e);
        }
      }
    }
  } catch (e) {
    throw wrapError("git-checkpoint-push-failed", e);
  }
}

async function maybeAutoFixGitCommitAndPushError({
  userId,
  threadId,
  threadChatId,
  error,
}: {
  userId: string;
  threadId: string;
  threadChatId: string;
  error: unknown;
}): Promise<boolean> {
  console.log("maybeAutoFixGitCommitAndPushError", {
    userId,
    threadId,
    threadChatId,
    error,
  });
  const threadChat = await getThreadChat({
    db,
    threadId,
    userId,
    threadChatId,
  });
  if (!threadChat || !threadChat.messages) {
    return false;
  }
  // Lets make sure that the most recent user/system message is not a retry message
  let lastSystemOrUserMessage: DBMessage | null = null;
  for (const message of [...threadChat.messages].reverse()) {
    if (message.type === "system" || message.type === "user") {
      lastSystemOrUserMessage = message;
      break;
    }
  }
  if (!lastSystemOrUserMessage) {
    console.error("No system or user message found", {
      userId,
      threadId,
      threadChatId,
    });
    return false;
  }
  if (
    lastSystemOrUserMessage.type === "system" &&
    lastSystemOrUserMessage.message_type === "retry-git-commit-and-push"
  ) {
    console.log("Last system or user message is a retry message, ignoring.");
    return false;
  }
  const systemRetryMessage: DBSystemMessage = {
    type: "system",
    message_type: "retry-git-commit-and-push",
    parts: [
      {
        type: "text",
        text: `Failed to commit and push changes with the following error: ${error}. Can you please try again?`,
      },
    ],
  };

  const thread = await getThreadMinimal({ db, userId, threadId });
  if (!thread) {
    return false;
  }
  // Make sure we keep the sandbox active. We're going to kick off a daemon
  // message to retry the commit and push.
  const sandboxId = thread.codesandboxId!;
  await setActiveThreadChat({ sandboxId, threadChatId, isActive: true });
  await sendSystemMessage({
    userId,
    threadId,
    threadChatId,
    message: systemRetryMessage,
  });
  return true;
}
