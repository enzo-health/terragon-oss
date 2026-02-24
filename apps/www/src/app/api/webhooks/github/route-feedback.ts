import { DBUserMessage, ThreadSource } from "@terragon/shared";
import { db } from "@/lib/db";
import {
  getGithubPR,
  getThreadForGithubPRAndUser,
  getThreadsForGithubPR,
} from "@terragon/shared/model/github";
import { getPrimaryThreadChat } from "@terragon/shared/utils/thread-utils";
import { queueFollowUpInternal } from "@/server-lib/follow-up";
import { maybeBatchThreads } from "@/lib/batch-threads";
import { newThreadInternal } from "@/server-lib/new-thread-internal";
import { getUserIdByGitHubAccountId } from "@terragon/shared/model/user";
import { getOctokitForApp, parseRepoFullName } from "@/lib/github";
import { getPostHogServer } from "@/lib/posthog-server";

export type FeedbackRoutingMode = "reused_existing" | "spawned_new";

export type FeedbackRoutingResult = {
  threadId: string;
  threadChatId: string;
  mode: FeedbackRoutingMode;
  reason?: string;
};

type GithubFeedbackSourceType = Extract<
  ThreadSource,
  "automation" | "github-mention"
>;

export type GithubFeedbackInput = {
  repoFullName: string;
  prNumber: number;
  userId?: string;
  eventType: string;
  reviewBody?: string;
  checkSummary?: string;
  failureDetails?: string;
  commentId?: number;
  checkRunId?: number;
  sourceType?: GithubFeedbackSourceType;
  authorGitHubAccountId?: number;
  baseBranchName?: string;
  headBranchName?: string;
};

type PullRequestContext = {
  baseBranchName: string;
  headBranchName: string;
  authorGitHubAccountId: number | null;
};

function buildFeedbackMessage({
  repoFullName,
  prNumber,
  eventType,
  reviewBody,
  checkSummary,
  failureDetails,
}: GithubFeedbackInput): DBUserMessage {
  const sections = [
    `The "${eventType}" event was triggered for PR #${prNumber} in ${repoFullName}.`,
  ];

  if (reviewBody?.trim()) {
    sections.push(`Review feedback:\n${reviewBody.trim()}`);
  }
  if (checkSummary?.trim()) {
    sections.push(`Check summary:\n${checkSummary.trim()}`);
  }
  if (failureDetails?.trim()) {
    sections.push(`Failure details:\n${failureDetails.trim()}`);
  }

  sections.push(
    "Please address this feedback in the PR branch, run relevant checks, and push updates.",
  );

  return {
    type: "user",
    model: null,
    timestamp: new Date().toISOString(),
    parts: [{ type: "text", text: sections.join("\n\n") }],
  };
}

async function fetchPullRequestContext({
  repoFullName,
  prNumber,
}: {
  repoFullName: string;
  prNumber: number;
}): Promise<PullRequestContext> {
  const [owner, repo] = parseRepoFullName(repoFullName);
  const octokit = await getOctokitForApp({ owner, repo });
  const pullRequest = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
  });

  return {
    baseBranchName: pullRequest.data.base.ref,
    headBranchName: pullRequest.data.head.ref,
    authorGitHubAccountId: pullRequest.data.user?.id ?? null,
  };
}

async function resolveOwnerUserId({
  input,
  pullRequestContextOrNull,
  fetchPullRequestContextForFallback,
}: {
  input: GithubFeedbackInput;
  pullRequestContextOrNull: PullRequestContext | null;
  fetchPullRequestContextForFallback: () => Promise<PullRequestContext | null>;
}): Promise<{ userId: string | null; reason: string }> {
  if (input.userId) {
    return { userId: input.userId, reason: "input-user-id" };
  }

  const [githubPR, threads] = await Promise.all([
    getGithubPR({
      db,
      repoFullName: input.repoFullName,
      prNumber: input.prNumber,
    }),
    getThreadsForGithubPR({
      db,
      repoFullName: input.repoFullName,
      prNumber: input.prNumber,
    }),
  ]);

  if (githubPR?.threadId) {
    const matchingThread = threads.find(
      (thread) => thread.id === githubPR.threadId,
    );
    if (matchingThread?.userId) {
      return { userId: matchingThread.userId, reason: "github-pr-thread-id" };
    }
  }

  const unarchivedThread = threads.find((thread) => !thread.archived);
  if (unarchivedThread?.userId) {
    return {
      userId: unarchivedThread.userId,
      reason: "existing-unarchived-thread",
    };
  }

  const fallbackThread = threads[0];
  if (fallbackThread?.userId) {
    return { userId: fallbackThread.userId, reason: "existing-thread" };
  }

  let authorGitHubAccountId =
    pullRequestContextOrNull?.authorGitHubAccountId ?? null;
  if (!authorGitHubAccountId) {
    const fetchedPullRequestContext =
      await fetchPullRequestContextForFallback();
    authorGitHubAccountId =
      fetchedPullRequestContext?.authorGitHubAccountId ?? null;
  }

  if (authorGitHubAccountId) {
    const prAuthorUserId = await getUserIdByGitHubAccountId({
      db,
      accountId: String(authorGitHubAccountId),
    });
    if (prAuthorUserId) {
      return { userId: prAuthorUserId, reason: "pr-author-fallback" };
    }
  }

  return { userId: null, reason: "no-owner-found" };
}

function getSourceMetadataForFeedback({
  sourceType,
  repoFullName,
  prNumber,
  commentId,
}: {
  sourceType: GithubFeedbackSourceType;
  repoFullName: string;
  prNumber: number;
  commentId?: number;
}) {
  if (sourceType !== "github-mention") {
    return undefined;
  }

  return {
    type: "github-mention" as const,
    repoFullName,
    issueOrPrNumber: prNumber,
    commentId,
  };
}

function captureFeedbackRouting({
  userId,
  input,
  mode,
  reason,
  threadId,
}: {
  userId: string;
  input: GithubFeedbackInput;
  mode: FeedbackRoutingMode;
  reason?: string;
  threadId: string;
}) {
  getPostHogServer().capture({
    distinctId: userId,
    event: "github_feedback_routed",
    properties: {
      mode,
      reason: reason ?? null,
      eventType: input.eventType,
      repoFullName: input.repoFullName,
      prNumber: input.prNumber,
      threadId,
      sourceType: input.sourceType ?? "automation",
      checkRunId: input.checkRunId ?? null,
    },
  });
}

function captureFeedbackRoutingFailure({
  userIdOrNull,
  input,
  reason,
  errorMessage,
}: {
  userIdOrNull: string | null;
  input: GithubFeedbackInput;
  reason: string;
  errorMessage: string;
}) {
  if (!userIdOrNull) {
    return;
  }
  getPostHogServer().capture({
    distinctId: userIdOrNull,
    event: "github_feedback_routing_failed",
    properties: {
      reason,
      errorMessage,
      eventType: input.eventType,
      repoFullName: input.repoFullName,
      prNumber: input.prNumber,
      sourceType: input.sourceType ?? "automation",
      checkRunId: input.checkRunId ?? null,
    },
  });
}

export async function routeGithubFeedbackOrSpawnThread(
  input: GithubFeedbackInput,
): Promise<FeedbackRoutingResult> {
  const feedbackMessage = buildFeedbackMessage(input);
  const sourceType = input.sourceType ?? "automation";

  let pullRequestContextOrNull: PullRequestContext | null =
    input.baseBranchName && input.headBranchName
      ? {
          baseBranchName: input.baseBranchName,
          headBranchName: input.headBranchName,
          authorGitHubAccountId: input.authorGitHubAccountId ?? null,
        }
      : null;

  let fetchedPullRequestContextOrNull: PullRequestContext | null = null;
  let didFetchPullRequestContextFail = false;

  const fetchPullRequestContextForFallback =
    async (): Promise<PullRequestContext | null> => {
      if (fetchedPullRequestContextOrNull) {
        return fetchedPullRequestContextOrNull;
      }
      if (didFetchPullRequestContextFail) {
        return null;
      }
      try {
        fetchedPullRequestContextOrNull = await fetchPullRequestContext({
          repoFullName: input.repoFullName,
          prNumber: input.prNumber,
        });
        pullRequestContextOrNull = {
          baseBranchName:
            pullRequestContextOrNull?.baseBranchName ??
            fetchedPullRequestContextOrNull.baseBranchName,
          headBranchName:
            pullRequestContextOrNull?.headBranchName ??
            fetchedPullRequestContextOrNull.headBranchName,
          authorGitHubAccountId:
            pullRequestContextOrNull?.authorGitHubAccountId ??
            fetchedPullRequestContextOrNull.authorGitHubAccountId,
        };
        return pullRequestContextOrNull;
      } catch (error) {
        didFetchPullRequestContextFail = true;
        console.warn("[github feedback routing] failed to fetch PR context", {
          repoFullName: input.repoFullName,
          prNumber: input.prNumber,
          error,
        });
        return null;
      }
    };

  const ownerResolution = await resolveOwnerUserId({
    input,
    pullRequestContextOrNull,
    fetchPullRequestContextForFallback,
  });

  if (!ownerResolution.userId) {
    const message = `Unable to resolve a Terragon user for ${input.repoFullName}#${input.prNumber}`;
    console.error("[github feedback routing] owner resolution failed", {
      ...input,
      reason: ownerResolution.reason,
    });
    throw new Error(message);
  }

  const userId = ownerResolution.userId;

  const existingThread = await getThreadForGithubPRAndUser({
    db,
    repoFullName: input.repoFullName,
    prNumber: input.prNumber,
    userId,
  });

  if (existingThread) {
    try {
      const threadChat = getPrimaryThreadChat(existingThread);
      await queueFollowUpInternal({
        userId,
        threadId: existingThread.id,
        threadChatId: threadChat.id,
        messages: [feedbackMessage],
        appendOrReplace: "append",
        source: "github",
      });
      captureFeedbackRouting({
        userId,
        input,
        mode: "reused_existing",
        reason: ownerResolution.reason,
        threadId: existingThread.id,
      });
      return {
        threadId: existingThread.id,
        threadChatId: threadChat.id,
        mode: "reused_existing",
        reason: ownerResolution.reason,
      };
    } catch (error) {
      console.warn("[github feedback routing] queue existing thread failed", {
        threadId: existingThread.id,
        userId,
        repoFullName: input.repoFullName,
        prNumber: input.prNumber,
        error,
      });
    }
  }

  try {
    const pullRequestContextForSpawn =
      pullRequestContextOrNull ?? (await fetchPullRequestContextForFallback());

    const { threadId, threadChatId, didCreateNewThread } =
      await maybeBatchThreads({
        userId,
        batchKey: `github-feedback:${input.repoFullName}:${input.prNumber}`,
        expiresSecs: 60,
        maxWaitTimeMs: 5000,
        createNewThread: async () =>
          newThreadInternal({
            userId,
            message: feedbackMessage,
            githubRepoFullName: input.repoFullName,
            baseBranchName: pullRequestContextForSpawn?.baseBranchName,
            headBranchName: pullRequestContextForSpawn?.headBranchName,
            githubPRNumber: input.prNumber,
            sourceType,
            sourceMetadata: getSourceMetadataForFeedback({
              sourceType,
              repoFullName: input.repoFullName,
              prNumber: input.prNumber,
              commentId: input.commentId,
            }),
          }),
      });
    const mode: FeedbackRoutingMode = didCreateNewThread
      ? "spawned_new"
      : "reused_existing";
    const reason = didCreateNewThread
      ? ownerResolution.reason
      : "batched-existing-thread";
    captureFeedbackRouting({
      userId,
      input,
      mode,
      reason,
      threadId,
    });
    return {
      threadId,
      threadChatId,
      mode,
      reason,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown routing failure";
    console.error("[github feedback routing] spawn fallback failed", {
      userId,
      repoFullName: input.repoFullName,
      prNumber: input.prNumber,
      eventType: input.eventType,
      error,
    });
    captureFeedbackRoutingFailure({
      userIdOrNull: userId,
      input,
      reason: "spawn-failed",
      errorMessage: message,
    });
    throw new Error(
      `Failed to route GitHub feedback for ${input.repoFullName}#${input.prNumber}: ${message}`,
    );
  }
}
