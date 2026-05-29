import { db } from "@/lib/db";
import {
  updateThread,
  getThread,
  hasOtherUnarchivedThreadsWithSamePR,
} from "@terragon/shared/model/threads";
import { markThreadAsRead } from "@terragon/shared/model/thread-read-status";
import { stopThread } from "./stop-thread";
import { isAgentWorking } from "@/agent/thread-status";
import { upsertGithubPR } from "@terragon/shared/model/github";
import { getUserSettings } from "@terragon/shared/model/user";
import {
  getOctokitForApp,
  getIsPRAuthor,
  parseRepoFullName,
} from "@/lib/github";

export async function archiveAndStopThread({
  userId,
  threadId,
}: {
  userId: string;
  threadId: string;
}) {
  console.log("archiveAndStopThread", threadId);
  // Get the thread to check its current status
  const thread = await getThread({ db, userId, threadId });
  if (!thread) {
    throw new Error("Thread not found");
  }
  await Promise.all(
    thread.threadChats.map(async (threadChat) => {
      if (isAgentWorking(threadChat.status)) {
        await stopThread({
          userId,
          threadId,
          threadChatId: threadChat.id,
        });
      }
    }),
  );

  let isPRAuthor = false;
  let hasOtherThreads = false;

  // Get user settings to check if we should close draft PRs on archive
  const userSettings = await getUserSettings({ db, userId });

  // Close the PR if it exists and is a draft, and user setting is enabled
  if (
    !thread.automationId &&
    thread.githubPRNumber &&
    thread.githubRepoFullName &&
    userSettings.autoClosePRsOnArchive
  ) {
    try {
      const [owner, repo] = parseRepoFullName(thread.githubRepoFullName);
      [hasOtherThreads, isPRAuthor] = await Promise.all([
        hasOtherUnarchivedThreadsWithSamePR({
          db,
          threadId,
          githubRepoFullName: thread.githubRepoFullName,
          githubPRNumber: thread.githubPRNumber,
        }),
        getIsPRAuthor({
          userId,
          repoFullName: thread.githubRepoFullName,
          prNumber: thread.githubPRNumber,
        }),
      ]);
      if (!isPRAuthor) {
        console.log(
          `Not closing PR #${thread.githubPRNumber} in ${thread.githubRepoFullName} because it was not created by the archiving user ${userId}`,
        );
      } else if (hasOtherThreads) {
        console.log(
          `Not closing PR #${thread.githubPRNumber} in ${thread.githubRepoFullName} because there are other unarchived threads using it`,
        );
      } else {
        const octokit = await getOctokitForApp({ owner, repo });
        // Get the PR details
        const { data: pr } = await octokit.rest.pulls.get({
          owner,
          repo,
          pull_number: thread.githubPRNumber,
        });
        if (pr.state === "open") {
          await octokit.rest.pulls.update({
            owner,
            repo,
            pull_number: thread.githubPRNumber,
            state: "closed",
          });
          // Update the PR status in our database
          await upsertGithubPR({
            db,
            repoFullName: thread.githubRepoFullName,
            number: thread.githubPRNumber,
            updates: {
              status: "closed",
            },
          });
          console.log(
            `Closed PR #${thread.githubPRNumber} in ${thread.githubRepoFullName} created by user ${userId} for archived thread ${threadId}`,
          );
        }
      }
    } catch (error) {
      console.error(`Failed to close PR for thread ${threadId}:`, error);
      // Don't throw - we still want to archive the thread even if PR closing fails
    }
  }
  // Track the event
  await markThreadAsRead({
    db,
    userId,
    threadId,
    shouldPublishRealtimeEvent: true,
  });
  await updateThread({
    db,
    userId,
    threadId,
    updates: {
      archived: true,
      updatedAt: new Date(),
    },
  });
}
