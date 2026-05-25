"use server";

import { db } from "@/lib/db";
import { userOnlyAction } from "@/lib/auth-server";
import { getThreadPageShellWithPermissions } from "@terragon/shared/model/thread-page";
import { getFeatureFlagForUser } from "@terragon/shared/model/feature-flags";
import { getHasRepoPermissionsForUser } from "./get-thread";
import { getOctokitForUserOrThrow, parseRepoFullName } from "@/lib/github";

/**
 * Opaque error categories. Mirrors get-repo-file-content.ts: only the category
 * (never a path, repo, or ref) may be logged or surfaced, so no PHI leaks
 * through telemetry or the server-action error wrapper.
 */
type RepoTreeErrorCategory =
  | "unauthorized"
  | "feature-disabled"
  | "not-found"
  | "github-error";

export type GetRepoTreeResult =
  | {
      status: "ready";
      /** Repo-relative file (blob) paths, no leading slash. Directories are
       * implied by path segments — the tree library builds them. */
      paths: string[];
      /** The git ref the tree was read from (working branch, else base). */
      ref: string;
      /** GitHub truncates the recursive tree at ~100k entries / 7MB. When true,
       * the listing is partial and the UI shows a notice. */
      truncated: boolean;
    }
  | {
      status: "error";
      category: RepoTreeErrorCategory;
    };

class RepoTreeError extends Error {
  readonly category: RepoTreeErrorCategory;
  constructor(category: RepoTreeErrorCategory) {
    super(category);
    this.name = "RepoTreeError";
    this.category = category;
  }
}

function isHttpStatusError(error: unknown): error is { status: number } {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof (error as { status: unknown }).status === "number"
  );
}

/**
 * Authenticated tree-loading action for the in-repo file tree.
 *
 * Authorization and ref resolution are identical to getRepoFileContentAction
 * (get-repo-file-content.ts): the client supplies only threadId; repoFullName
 * and the ref come from the server-resolved thread, the repoFilePreview flag is
 * re-checked server-side, and the ref cascades from the working `branchName` to
 * `repoBaseBranchName` on a 404 — so read-only/exploration threads whose branch
 * was never pushed still resolve the tree from base.
 *
 * The whole tree is fetched in one recursive call. @pierre/trees has no public
 * lazy-load API, and it virtualizes rows, so a single prepared path list is the
 * supported shape. GitHub truncates very large trees; that flag is surfaced.
 */
async function loadRepoTree(
  userId: string,
  { threadId }: { threadId: string },
): Promise<GetRepoTreeResult> {
  try {
    const shell = await getThreadPageShellWithPermissions({
      db,
      threadId,
      userId,
      allowAdmin: false,
      getHasRepoPermissions: async (repoFullName) =>
        getHasRepoPermissionsForUser({ userId, repoFullName }),
    });
    if (!shell) {
      throw new RepoTreeError("unauthorized");
    }

    const flagEnabled = await getFeatureFlagForUser({
      db,
      userId,
      flagName: "repoFilePreview",
    });
    if (!flagEnabled) {
      throw new RepoTreeError("feature-disabled");
    }

    const refCandidates =
      shell.branchName && shell.branchName !== shell.repoBaseBranchName
        ? [shell.branchName, shell.repoBaseBranchName]
        : [shell.repoBaseBranchName];

    const [owner, repo] = parseRepoFullName(shell.githubRepoFullName);
    const octokit = await getOctokitForUserOrThrow({ userId });

    for (const candidate of refCandidates) {
      try {
        const response = await octokit.rest.git.getTree({
          owner,
          repo,
          tree_sha: candidate,
          recursive: "1",
        });
        const paths = response.data.tree
          .filter(
            (entry) => entry.type === "blob" && typeof entry.path === "string",
          )
          .map((entry) => entry.path as string);
        return {
          status: "ready",
          paths,
          ref: candidate,
          truncated: response.data.truncated === true,
        };
      } catch (error) {
        // 404 means the ref does not exist here; try the next candidate. Any
        // other status is a hard GitHub failure and short-circuits.
        if (isHttpStatusError(error) && error.status === 404) continue;
        throw new RepoTreeError("github-error");
      }
    }
    throw new RepoTreeError("not-found");
  } catch (error) {
    const category: RepoTreeErrorCategory =
      error instanceof RepoTreeError ? error.category : "github-error";
    console.warn("[getRepoTreeAction] load failed", { category });
    return { status: "error", category };
  }
}

export const getRepoTreeAction = userOnlyAction(loadRepoTree, {
  defaultErrorMessage: "Failed to load file tree",
});
