import { db } from "@/lib/db";
import { getGithubPRStatus } from "@terragon/shared/github-api/helpers";
import { upsertGithubPR } from "@terragon/shared/model/github";
import { updateThread, getThread } from "@terragon/shared/model/threads";
import {
  gitCommitAndPushBranch,
  getCurrentBranchName,
  getGitDefaultBranch,
  getGitDiffMaybeCutoff,
} from "@terragon/sandbox/commands";
import { ThreadError } from "./error";
import { env } from "@terragon/env/apps-www";
import { publicAppUrl } from "@terragon/env/next-public";
import { getPostHogServer } from "@/lib/posthog-server";
import {
  generatePRContent,
  updatePRContent,
} from "@/server-lib/generate-pr-content";
import { generateCommitMessage } from "@/server-lib/generate-commit-message";
import { markPullRequestReadyForReview } from "@/server-lib/github-pr";
import {
  getOctokitForUserOrThrow,
  parseRepoFullName,
  getExistingPRForBranch,
} from "@/lib/github";
import {
  convertToDraftOnceForUiGuard,
  withUiReadyGuard,
} from "@/server-lib/preview-validation";
import { Octokit } from "octokit";
import { ISandboxSession } from "@terragon/sandbox/types";

export async function openPullRequestForThread({
  threadId,
  userId,
  skipCommitAndPush,
  prType,
  session,
}: {
  threadId: string;
  userId: string;
  skipCommitAndPush: boolean;
  prType: "draft" | "ready";
  session: ISandboxSession;
}) {
  console.log("openPullRequestForThread", {
    threadId,
    userId,
    prType,
    skipCommitAndPush,
  });
  getPostHogServer().capture({
    distinctId: userId,
    event: "open_pull_request",
    properties: {
      threadId,
      prType: prType,
    },
  });
  const thread = await getThread({ db, threadId, userId });
  if (!thread) {
    throw new ThreadError("unknown-error", "Thread not found", null);
  }
  let effectivePrType: "draft" | "ready" = prType;
  if (prType === "ready") {
    // UI_READY_GUARD:openPullRequestForThread
    effectivePrType = await withUiReadyGuard<"draft" | "ready">({
      entrypoint: "openPullRequestForThread",
      threadId,
      action: async () => "ready" as const,
      onBlocked: async (decision) => {
        if (thread.githubPRNumber && decision.runId && decision.threadChatId) {
          const octokitForDowngrade = await getOctokitForUserOrThrow({
            userId,
          });
          await convertToDraftOnceForUiGuard({
            threadId,
            runId: decision.runId,
            threadChatId: decision.threadChatId,
            repoFullName: thread.githubRepoFullName,
            prNumber: thread.githubPRNumber,
            octokit: octokitForDowngrade,
          });
        }
        return "draft" as const;
      },
    });
  }
  const [currentBranch, defaultBranch] = await Promise.all([
    getCurrentBranchName(session),
    getGitDefaultBranch(session),
  ]);
  // Make sure we're not on the main branch
  if (currentBranch === defaultBranch) {
    throw new ThreadError(
      "git-checkpoint-push-failed",
      `Cannot open pull request on default branch ${defaultBranch}`,
      null,
    );
  }
  // If the base branch is the same as the current branch, use the default branch for the PR.
  const baseBranch =
    thread.repoBaseBranchName === currentBranch
      ? defaultBranch
      : thread.repoBaseBranchName;
  let gitDiffMaybeCutOff = thread.gitDiff;
  if (!skipCommitAndPush) {
    await gitCommitAndPushBranch({
      session,
      args: {
        githubAppName: env.NEXT_PUBLIC_GITHUB_APP_NAME,
        baseBranch,
        generateCommitMessage,
      },
      enableIntegrityChecks: true,
    });
  }
  if (!skipCommitAndPush || thread.gitDiff === "too-large") {
    gitDiffMaybeCutOff = await getGitDiffMaybeCutoff({
      session,
      baseBranch: thread.repoBaseBranchName,
      allowCutoff: true,
    });
  }
  if (!gitDiffMaybeCutOff) {
    if (thread.githubPRNumber) {
      return;
    }
    throw new Error("No changes to PR");
  }
  // Get GitHub App installation token
  const [owner, repo] = parseRepoFullName(thread.githubRepoFullName);
  // Check if there's an existing PR for this branch if so we're good to go.
  const [octokitToCreatePR, existingPr] = await Promise.all([
    getOctokitForUserOrThrow({ userId }),
    getExistingPRForBranch({
      repoFullName: thread.githubRepoFullName,
      headBranchName: currentBranch,
      baseBranchName: baseBranch,
    }),
  ]);
  if (existingPr) {
    await Promise.all([
      updateThread({
        db,
        userId,
        threadId,
        updates: {
          branchName: currentBranch,
          githubPRNumber: existingPr.number,
        },
      }),
      upsertGithubPR({
        db,
        repoFullName: thread.githubRepoFullName,
        number: existingPr.number,
        updates: {
          status: getGithubPRStatus(existingPr),
        },
      }),
    ]);
    await updatePullRequestForThread({
      threadId,
      userId,
      octokit: octokitToCreatePR,
    });
    if (effectivePrType === "ready") {
      // UI_READY_GUARD:reopenAfterPush
      await withUiReadyGuard({
        entrypoint: "reopenAfterPush",
        threadId,
        action: async () => {
          await markPullRequestReadyForReview({
            octokit: octokitToCreatePR,
            owner,
            repo,
            prNumber: existingPr.number,
          });
        },
        onBlocked: async (decision) => {
          if (decision.runId && decision.threadChatId) {
            await convertToDraftOnceForUiGuard({
              threadId,
              runId: decision.runId,
              threadChatId: decision.threadChatId,
              repoFullName: thread.githubRepoFullName,
              prNumber: existingPr.number,
              octokit: octokitToCreatePR,
            });
          }
        },
      });
      await upsertGithubPR({
        db,
        repoFullName: thread.githubRepoFullName,
        number: existingPr.number,
        updates: {
          status: "open",
        },
      });
    }
    return;
  }

  // Otherwise, generate a new PR.
  let prTitle = "Update code changes";
  let prBody = "Updates made to the codebase.";
  try {
    const generatedPRContent = await generatePRContent({
      gitDiff: gitDiffMaybeCutOff,
      branchName: currentBranch,
      repoName: thread.githubRepoFullName,
      taskTitle: thread.name ?? "Untitled Task",
    });
    prTitle = generatedPRContent.title;
    prBody = generatedPRContent.body;
  } catch (error) {
    console.error(
      "Failed to generate PR title and body, using fallbacks:",
      error,
    );
  }

  prBody += [
    "\n\n",
    "🌿 Generated by [Terry](https://www.terragonlabs.com)",
    "\n\n---\n\n",
    "ℹ️ Tag @terragon-labs to ask questions and address PR feedback",
    "\n\n",
    `📎 **Task**: ${publicAppUrl()}/task/${threadId}`,
  ].join("");
  // Add issue reference to PR body if thread was created from an issue
  if (thread.githubIssueNumber) {
    prBody += `\n\n📝 Addresses #${thread.githubIssueNumber}`;
  }

  const pr = await octokitToCreatePR.rest.pulls.create({
    owner,
    repo,
    title: prTitle,
    body: prBody,
    head: currentBranch,
    base: baseBranch,
    draft: effectivePrType === "draft",
  });

  await Promise.all([
    upsertGithubPR({
      db,
      repoFullName: thread.githubRepoFullName,
      number: pr.data.number,
      threadId: threadId,
      updates: {
        status: getGithubPRStatus(pr.data),
      },
    }),
    updateThread({
      db,
      userId,
      threadId,
      updates: {
        branchName: currentBranch,
        githubPRNumber: pr.data.number,
      },
    }),
  ]);
}

async function updatePullRequestForThread({
  threadId,
  userId,
  octokit,
}: {
  threadId: string;
  userId: string;
  octokit: Octokit;
}) {
  const thread = await getThread({ db, threadId, userId });
  if (!thread) {
    throw new Error(`Thread with ID "${threadId}" not found`);
  }
  if (!thread.githubPRNumber) {
    throw new Error(`Thread with ID "${threadId}" has no PR number`);
  }
  console.log("updatePullRequestForThread", {
    threadId,
    userId,
    githubRepoFullName: thread.githubRepoFullName,
    githubPRNumber: thread.githubPRNumber,
  });
  const [owner, repo] = parseRepoFullName(thread.githubRepoFullName);
  // Fetch current PR details
  const currentPR = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: thread.githubPRNumber,
  });
  try {
    if (!thread.gitDiff) {
      console.log("No git diff available, skipping PR update");
      return;
    }
    // Get updated PR content based on current content and new changes
    const updatedContent = await updatePRContent({
      gitDiff: thread.gitDiff,
      branchName: thread.branchName || "",
      repoName: thread.githubRepoFullName,
      currentTitle: currentPR.data.title,
      currentBody: currentPR.data.body || "",
      taskTitle: thread.name ?? "Untitled Task",
    });

    // Only update if the AI determined it's necessary
    if (
      !updatedContent.shouldUpdate ||
      !updatedContent.title ||
      !updatedContent.body
    ) {
      console.log("PR content is up to date, no changes needed");
      return;
    }

    // Ensure the task URL is in the body
    const threadUrl = `${publicAppUrl()}/task/${threadId}`;
    let finalBody = updatedContent.body;
    if (!finalBody.includes(threadUrl)) {
      // Add task URL if it's not already there
      finalBody = `${finalBody}\n\n📎 **Task**: ${threadUrl}`;
    }
    // Ensure issue reference is in the body if thread was created from an issue
    if (thread.githubIssueNumber) {
      const issueRef = `#${thread.githubIssueNumber}`;
      if (!finalBody.includes(issueRef)) {
        finalBody = `${finalBody}\n\nAddresses ${issueRef}`;
      }
    }
    // Update the PR
    await octokit.rest.pulls.update({
      owner,
      repo,
      pull_number: thread.githubPRNumber,
      title: updatedContent.title,
      body: finalBody,
    });
    console.log("Successfully updated PR title and body");
  } catch (error) {
    console.error(
      "Failed to update PR title and body, keeping existing content:",
      error,
    );
  }
}
