"use server";

import { userOnlyAction } from "@/lib/auth-server";
import {
  RepoAccessError,
  resolveRepoAccess,
  fetchWithRefCascade,
  type RepoAccessErrorCategory,
} from "./repo-access";

/**
 * Opaque error categories. Mirrors get-repo-file-content.ts: only the category
 * (never a path, repo, or ref) may be logged or surfaced, so no PHI leaks
 * through telemetry or the server-action error wrapper.
 */
type RepoTreeErrorCategory = RepoAccessErrorCategory;

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

/**
 * Authenticated tree-loading action for the in-repo file tree.
 *
 * Authorization and ref resolution are identical to getRepoFileContentAction
 * (get-repo-file-content.ts) and live in resolveRepoAccess: the client supplies
 * only threadId; repoFullName and the ref come from the server-resolved thread,
 * the repoFilePreview flag is re-checked server-side, and the ref cascades from
 * the working `branchName` to `repoBaseBranchName` on a 404 — so
 * read-only/exploration threads whose branch was never pushed still resolve the
 * tree from base.
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
    const { octokit, owner, repo, refCandidates } = await resolveRepoAccess(
      userId,
      threadId,
    );

    const { data, ref } = await fetchWithRefCascade(
      refCandidates,
      (candidate) =>
        octokit.rest.git.getTree({
          owner,
          repo,
          tree_sha: candidate,
          recursive: "1",
        }),
    );

    const paths = data.data.tree
      .filter(
        (entry) => entry.type === "blob" && typeof entry.path === "string",
      )
      .map((entry) => entry.path as string);
    return {
      status: "ready",
      paths,
      ref,
      truncated: data.data.truncated === true,
    };
  } catch (error) {
    const category: RepoTreeErrorCategory =
      error instanceof RepoAccessError ? error.category : "github-error";
    console.warn("[getRepoTreeAction] load failed", { category });
    return { status: "error", category };
  }
}

export const getRepoTreeAction = userOnlyAction(loadRepoTree, {
  defaultErrorMessage: "Failed to load file tree",
});
