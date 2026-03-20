"use server";

import { cache } from "react";
import { db } from "@/lib/db";
import { userOnlyAction } from "@/lib/auth-server";
import { UserFacingError } from "@/lib/server-actions";
import { ThreadPageDiff } from "@terragon/shared/db/types";
import {
  getThreadPageDiffWithPermissions,
  getThreadPageShellWithPermissions,
} from "@terragon/shared/model/thread-page";
import { getHasRepoPermissionsForUser } from "./get-thread";
import { getOctokitForUserOrThrow, parseRepoFullName } from "@/lib/github";
import { parseGitDiffStats } from "@terragon/shared/utils/git-diff";

const MAX_GITHUB_PR_DIFF_CHARS = 250_000;

async function maybeLoadGithubPrDiff({
  userId,
  shell,
}: {
  userId: string;
  shell: Awaited<ReturnType<typeof getThreadPageShellWithPermissions>>;
}): Promise<{ gitDiff: string; gitDiffStats: ThreadPageDiff["gitDiffStats"] }> {
  if (!shell?.githubPRNumber) {
    throw new Error("No PR linked to thread");
  }

  const [owner, repo] = parseRepoFullName(shell.githubRepoFullName);
  const octokit = await getOctokitForUserOrThrow({ userId });
  const response = await octokit.request(
    "GET /repos/{owner}/{repo}/pulls/{pull_number}",
    {
      owner,
      repo,
      pull_number: shell.githubPRNumber,
      headers: {
        accept: "application/vnd.github.v3.diff",
      },
    },
  );
  const rawDiffData = response.data as unknown;
  const rawDiff =
    typeof rawDiffData === "string" ? rawDiffData.trim() : undefined;
  if (!rawDiff) {
    throw new Error("PR diff response was empty");
  }

  const gitDiff =
    rawDiff.length >= MAX_GITHUB_PR_DIFF_CHARS ? "too-large" : rawDiff;
  const gitDiffStats =
    gitDiff === "too-large"
      ? (shell.gitDiffStats ?? null)
      : parseGitDiffStats(gitDiff);
  return { gitDiff, gitDiffStats };
}

export const getThreadPageDiffAction = cache(
  userOnlyAction(
    async function getThreadPageDiffAction(
      userId: string,
      threadId: string,
    ): Promise<ThreadPageDiff> {
      const threadDiff = await getThreadPageDiffWithPermissions({
        db,
        threadId,
        userId,
        allowAdmin: false,
        getHasRepoPermissions: async (repoFullName) =>
          getHasRepoPermissionsForUser({ userId, repoFullName }),
      });

      if (!threadDiff) {
        throw new UserFacingError("Unauthorized");
      }
      const shell = await getThreadPageShellWithPermissions({
        db,
        threadId,
        userId,
        allowAdmin: false,
        getHasRepoPermissions: async (repoFullName) =>
          getHasRepoPermissionsForUser({ userId, repoFullName }),
      });

      // Defensive fallback:
      // if thread-level diff was not persisted but a PR exists, fetch PR diff
      // directly from GitHub so the review panel can still render deterministically.
      const diffValue = threadDiff.gitDiff;
      const hasLiveShellDiffSignal = Boolean(
        shell?.hasGitDiff || (shell?.gitDiffStats?.files ?? 0) > 0,
      );
      const isDiffMissing =
        diffValue == null ||
        (typeof diffValue === "string" &&
          diffValue !== "too-large" &&
          diffValue.trim().length === 0);
      if (isDiffMissing && hasLiveShellDiffSignal) {
        try {
          const prDiff = await maybeLoadGithubPrDiff({ userId, shell });
          return {
            gitDiff: prDiff.gitDiff,
            gitDiffStats: prDiff.gitDiffStats,
            hasGitDiff: true,
          };
        } catch (error) {
          console.warn("[getThreadPageDiffAction] PR diff fallback failed", {
            threadId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      return threadDiff;
    },
    { defaultErrorMessage: "Failed to get task diff" },
  ),
);
