import { db } from "@/lib/db";
import { wrapError, ThreadError } from "@/agent/error";
import { openPullRequestForThread } from "@/agent/pull-request";
import { setActiveThreadChat } from "@/agent/sandbox-resource";
import { getPostHogServer } from "@/lib/posthog-server";
import { env } from "@terragon/env/apps-www";
import {
  getCurrentBranchName,
  getGitDiffMaybeCutoff,
  gitDiffStats,
  gitCommitAndPushBranch,
} from "@terragon/sandbox/commands";
import { ISandboxSession } from "@terragon/sandbox/types";
import {
  DBMessage,
  DBUserMessage,
  DBSystemMessage,
  GitDiffStats,
  ThreadInsert,
  ThreadChatInsert,
} from "@terragon/shared";
import type {
  CarmackReviewGateOutput,
  DeepReviewGateOutput,
} from "@terragon/shared/model/sdlc-loop";
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
import { queueFollowUpInternal } from "./follow-up";
import { runDeepReviewGate } from "./sdlc-loop/deep-review-gate";
import { runCarmackReviewGate } from "./sdlc-loop/carmack-review-gate";
import { isSdlcLoopEnrollmentAllowedForThread } from "./sdlc-loop/enrollment";

const SDLC_PRE_PR_MAX_FINDINGS_PER_GATE = 5;
const SDLC_PRE_PR_HEAD_SHA_FALLBACK = "unknown-head-sha";

type ExistingThread = NonNullable<Awaited<ReturnType<typeof getThread>>>;

type SdlcPrePrFinding = {
  title: string;
  severity: "critical" | "high" | "medium" | "low";
  category: string;
  detail: string;
  suggestedFix?: string | null;
  isBlocking?: boolean;
};

function getBlockingFindings(
  findings: readonly SdlcPrePrFinding[],
): SdlcPrePrFinding[] {
  return findings.filter((finding) => finding.isBlocking !== false);
}

function formatSdlcPrePrFinding(
  finding: SdlcPrePrFinding,
  index: number,
): string {
  const suggestedFix = finding.suggestedFix?.trim();
  return [
    `${index + 1}. [${finding.severity.toUpperCase()}] ${finding.title}`,
    `Category: ${finding.category}`,
    `Detail: ${finding.detail}`,
    suggestedFix ? `Suggested fix: ${suggestedFix}` : null,
  ]
    .filter((line): line is string => !!line)
    .join("\n");
}

function buildSdlcPrePrReviewSummary({
  repoFullName,
  branchName,
  headSha,
  deepReviewFindings,
  carmackReviewFindings,
  deepReviewReturnedNoFindings,
  carmackReviewReturnedNoFindings,
}: {
  repoFullName: string;
  branchName: string;
  headSha: string;
  deepReviewFindings: readonly SdlcPrePrFinding[];
  carmackReviewFindings: readonly SdlcPrePrFinding[];
  deepReviewReturnedNoFindings: boolean;
  carmackReviewReturnedNoFindings: boolean;
}): string {
  const sections: string[] = [
    "SDLC pre-PR review found blocking issues, so PR creation is paused.",
    "Please fix the findings below and continue. A PR will be opened after these checks pass.",
    `Repository: ${repoFullName}`,
    `Branch: ${branchName}`,
    `Head SHA: ${headSha}`,
  ];

  if (deepReviewFindings.length > 0 || deepReviewReturnedNoFindings) {
    sections.push(
      "Deep review findings:",
      deepReviewFindings.length > 0
        ? deepReviewFindings
            .slice(0, SDLC_PRE_PR_MAX_FINDINGS_PER_GATE)
            .map(formatSdlcPrePrFinding)
            .join("\n\n")
        : "The deep review gate reported failure without structured findings.",
    );
  }

  if (carmackReviewFindings.length > 0 || carmackReviewReturnedNoFindings) {
    sections.push(
      "Carmack review findings:",
      carmackReviewFindings.length > 0
        ? carmackReviewFindings
            .slice(0, SDLC_PRE_PR_MAX_FINDINGS_PER_GATE)
            .map(formatSdlcPrePrFinding)
            .join("\n\n")
        : "The Carmack review gate reported failure without structured findings.",
    );
  }

  return sections.join("\n\n");
}

function buildSdlcPrePrTaskContext({
  thread,
  branchName,
}: {
  thread: ExistingThread;
  branchName: string;
}): string {
  return [
    `Thread ID: ${thread.id}`,
    `Task name: ${thread.name ?? "Untitled task"}`,
    `Branch: ${branchName}`,
  ].join("\n");
}

async function getHeadShaOrNull({
  session,
}: {
  session: ISandboxSession;
}): Promise<string | null> {
  try {
    const headSha = (
      await session.runCommand("git rev-parse HEAD", {
        cwd: session.repoDir,
      })
    ).trim();
    return headSha.length > 0 ? headSha : null;
  } catch (error) {
    console.warn("[checkpoint-thread] failed to resolve head SHA", { error });
    return null;
  }
}

async function queueSdlcPrePrFollowUp({
  userId,
  threadId,
  threadChatId,
  messageText,
}: {
  userId: string;
  threadId: string;
  threadChatId: string;
  messageText: string;
}) {
  const followUpMessage: DBUserMessage = {
    type: "user",
    model: null,
    parts: [{ type: "text", text: messageText }],
    timestamp: new Date().toISOString(),
  };

  await queueFollowUpInternal({
    userId,
    threadId,
    threadChatId,
    messages: [followUpMessage],
    appendOrReplace: "append",
    source: "www",
  });
}

async function maybeRunSdlcPrePrReview({
  thread,
  userId,
  threadChatId,
  session,
  diffOutput,
}: {
  thread: ExistingThread;
  userId: string;
  threadChatId: string;
  session: ISandboxSession;
  diffOutput: string;
}): Promise<boolean> {
  if (thread.githubPRNumber) {
    return true;
  }

  if (thread.sourceType !== "www") {
    return true;
  }

  const enrollmentAllowed = isSdlcLoopEnrollmentAllowedForThread({
    sourceType: thread.sourceType,
    sourceMetadata: thread.sourceMetadata ?? null,
  });
  if (!enrollmentAllowed) {
    return true;
  }

  if (diffOutput === "too-large") {
    await queueSdlcPrePrFollowUp({
      userId,
      threadId: thread.id,
      threadChatId,
      messageText: [
        "SDLC pre-PR review is required before opening a PR, but the current diff is too large to evaluate.",
        "Please reduce the change scope (or split changes) and continue. PR creation is paused until pre-PR review can run.",
      ].join("\n\n"),
    });
    console.warn(
      "[checkpoint-thread] blocked PR creation because SDLC pre-PR review diff is too large",
      {
        userId,
        threadId: thread.id,
        repoFullName: thread.githubRepoFullName,
      },
    );
    return false;
  }

  const branchName =
    (await getCurrentBranchName(session, session.repoDir).catch(() => null)) ??
    thread.branchName ??
    "unknown-branch";
  const headSha =
    (await getHeadShaOrNull({ session })) ?? SDLC_PRE_PR_HEAD_SHA_FALLBACK;
  const taskContext = buildSdlcPrePrTaskContext({ thread, branchName });

  const [deepReviewResult, carmackReviewResult] = await Promise.allSettled([
    runDeepReviewGate({
      repoFullName: thread.githubRepoFullName,
      prNumber: null,
      headSha,
      taskContext,
      gitDiff: diffOutput,
    }),
    runCarmackReviewGate({
      repoFullName: thread.githubRepoFullName,
      prNumber: null,
      headSha,
      taskContext,
      gitDiff: diffOutput,
    }),
  ]);

  const deepReviewOutput: DeepReviewGateOutput | null =
    deepReviewResult.status === "fulfilled" ? deepReviewResult.value : null;
  const carmackReviewOutput: CarmackReviewGateOutput | null =
    carmackReviewResult.status === "fulfilled"
      ? carmackReviewResult.value
      : null;

  const deepReviewFindings = deepReviewOutput
    ? getBlockingFindings(deepReviewOutput.blockingFindings)
    : [];
  const carmackReviewFindings = carmackReviewOutput
    ? getBlockingFindings(carmackReviewOutput.blockingFindings)
    : [];
  const isDeepReviewBlocked = deepReviewOutput
    ? !deepReviewOutput.gatePassed || deepReviewFindings.length > 0
    : false;
  const isCarmackReviewBlocked = carmackReviewOutput
    ? !carmackReviewOutput.gatePassed || carmackReviewFindings.length > 0
    : false;

  if (!isDeepReviewBlocked && !isCarmackReviewBlocked) {
    if (deepReviewResult.status === "rejected") {
      console.warn("[checkpoint-thread] deep review gate failed; proceeding", {
        userId,
        threadId: thread.id,
        repoFullName: thread.githubRepoFullName,
        error: deepReviewResult.reason,
      });
    }
    if (carmackReviewResult.status === "rejected") {
      console.warn(
        "[checkpoint-thread] carmack review gate failed; proceeding",
        {
          userId,
          threadId: thread.id,
          repoFullName: thread.githubRepoFullName,
          error: carmackReviewResult.reason,
        },
      );
    }
    return true;
  }

  await queueSdlcPrePrFollowUp({
    userId,
    threadId: thread.id,
    threadChatId,
    messageText: buildSdlcPrePrReviewSummary({
      repoFullName: thread.githubRepoFullName,
      branchName,
      headSha,
      deepReviewFindings: isDeepReviewBlocked ? deepReviewFindings : [],
      carmackReviewFindings: isCarmackReviewBlocked
        ? carmackReviewFindings
        : [],
      deepReviewReturnedNoFindings:
        isDeepReviewBlocked && deepReviewFindings.length === 0,
      carmackReviewReturnedNoFindings:
        isCarmackReviewBlocked && carmackReviewFindings.length === 0,
    }),
  });

  console.log(
    "[checkpoint-thread] blocked PR creation due to SDLC pre-PR review findings",
    {
      userId,
      threadId: thread.id,
      repoFullName: thread.githubRepoFullName,
      deepReviewFindings: deepReviewFindings.length,
      carmackReviewFindings: carmackReviewFindings.length,
    },
  );

  return false;
}

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
        const shouldCreatePr = await maybeRunSdlcPrePrReview({
          thread,
          userId,
          threadChatId,
          session,
          diffOutput,
        });
        if (!shouldCreatePr) {
          return;
        }
        try {
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
