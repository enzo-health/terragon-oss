"use server";

import { db } from "@/lib/db";
import { userOnlyAction } from "@/lib/auth-server";
import { getThreadPageShellWithPermissions } from "@terragon/shared/model/thread-page";
import { getFeatureFlagForUser } from "@terragon/shared/model/feature-flags";
import { classifyRepoFileLink } from "@terragon/shared/utils/repo-file-link";
import { getHasRepoPermissionsForUser } from "./get-thread";
import { getOctokitForUserOrThrow, parseRepoFullName } from "@/lib/github";

/**
 * Server-side cap on a previewed repo file. Decoded UTF-8 content larger than
 * this is reported as too-large rather than streamed to the client, mirroring
 * the client-side stream cap in secondary-panel-text-file.tsx.
 */
const MAX_REPO_FILE_CONTENT_BYTES = 512 * 1024;

/**
 * Opaque error categories. These (and only these) may be logged or surfaced.
 * They never contain file contents, file paths, or repo identifiers, so no PHI
 * can leak through telemetry or the server-action error wrapper.
 */
type RepoFileContentErrorCategory =
  | "unauthorized"
  | "feature-disabled"
  | "invalid-path"
  | "not-found"
  | "too-large"
  | "unsupported-content"
  | "github-error";

/**
 * One entry in a directory listing. `path` is repo-relative (as GitHub returns
 * it) so it feeds straight back into the same in-repo open flow when clicked.
 * Only `file`/`dir` entries are surfaced; symlinks and submodules are dropped
 * because they cannot be previewed or browsed in place.
 */
export interface RepoDirectoryEntry {
  name: string;
  path: string;
  type: "file" | "dir";
}

export type GetRepoFileContentResult =
  | {
      status: "ready";
      /** Decoded UTF-8 file contents (size-capped). */
      content: string;
      /** Normalized repo-relative path echoed back for descriptor dedup. */
      path: string;
      /** The git ref the blob was read from (working branch, else base). */
      ref: string;
    }
  | {
      status: "directory";
      /** Normalized repo-relative directory path. */
      path: string;
      /** The git ref the listing was read from (working branch, else base). */
      ref: string;
      /** Child entries, directories first then files, each alphabetical. */
      entries: RepoDirectoryEntry[];
    }
  | {
      status: "error";
      category: RepoFileContentErrorCategory;
    };

/**
 * Internal error carrying only an opaque category. The boundary maps this to a
 * typed result; the category is the only thing allowed to cross into a log.
 */
class RepoFileContentError extends Error {
  readonly category: RepoFileContentErrorCategory;
  constructor(category: RepoFileContentErrorCategory) {
    super(category);
    this.name = "RepoFileContentError";
    this.category = category;
  }
}

/**
 * Map GitHub's directory-listing array into the typed entry list. Items that
 * are not plain file/dir entries (symlinks, submodules, malformed records) are
 * dropped. Sorted directories-first, then files, each case-insensitively
 * alphabetical, so the panel renders a stable, predictable order.
 */
function parseDirectoryListing(items: unknown[]): RepoDirectoryEntry[] {
  const entries: RepoDirectoryEntry[] = [];
  for (const item of items) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    const { name, path, type } = record;
    if (typeof name !== "string" || typeof path !== "string") continue;
    if (type !== "file" && type !== "dir") continue;
    entries.push({ name, path, type });
  }
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
  return entries;
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
 * Authenticated content-loading action for the in-repo file preview.
 *
 * Authorization and content sourcing are entirely server-derived:
 *  - The user is authorized against the thread/repo via
 *    getThreadPageShellWithPermissions (allowAdmin: false), exactly mirroring
 *    get-thread-page-diff.ts. The client supplies only the threadId and the
 *    clicked path — NEVER a repoFullName or ref.
 *  - repoFullName and the git ref are taken from the server-resolved thread.
 *  - The repoFilePreview feature flag is re-checked server-side.
 *  - The path is re-normalized with the shared classifier, rejecting any `..`
 *    traversal so a request can never escape the workspace root.
 *
 * REF-RESOLUTION RULE: the getContent `ref` is the thread's working
 * `branchName` (the pushed branch the user sees in diffs/tool output) when
 * present, falling back to `repoBaseBranchName` (NOT NULL) when `branchName` is
 * null — never the repo default branch.
 *
 * V1 LIMITATION (R4/R7 scope): blobs are sourced from GitHub getContent, so
 * only files COMMITTED AND PUSHED to the working branch (or base) are readable.
 * Uncommitted/unpushed working-tree edits — the agent's most common fresh
 * tool-output and diff targets — are NOT readable in v1 (there is no
 * web→sandbox file-read channel today: sendDaemonMessage is fire-and-forget).
 * Clicking a path that only exists unpushed returns category "not-found", which
 * s5 renders as the clean "not yet pushed" unsupported state. That is the
 * documented expected behavior for that case, not a crash. The expected
 * hit-rate caveat (fresh tool-output/diff paths are often unpushed → error
 * state) and the live-sandbox read channel as the follow-up that lifts this
 * limit are tracked in the slice/PR notes.
 *
 * This deliberately does NOT reuse getGitHubFileContent (github-file-content.ts):
 * that action is authenticated-only, trusts a client-supplied
 * repoFullName/branchName, and performs no thread/repo authz and no path
 * validation.
 */
async function loadRepoFileContent(
  userId: string,
  {
    threadId,
    path: rawPath,
  }: {
    threadId: string;
    path: string;
  },
): Promise<GetRepoFileContentResult> {
  try {
    // Authorize against the thread/repo and resolve repoFullName + ref entirely
    // server-side BEFORE evaluating any thread-scoped state. Mirrors
    // get-thread-page-diff.ts permission checks. Running authz first ensures the
    // feature flag is never evaluated for a threadId the caller cannot access.
    const shell = await getThreadPageShellWithPermissions({
      db,
      threadId,
      userId,
      allowAdmin: false,
      getHasRepoPermissions: async (repoFullName) =>
        getHasRepoPermissionsForUser({ userId, repoFullName }),
    });
    if (!shell) {
      throw new RepoFileContentError("unauthorized");
    }

    const flagEnabled = await getFeatureFlagForUser({
      db,
      userId,
      flagName: "repoFilePreview",
    });
    if (!flagEnabled) {
      throw new RepoFileContentError("feature-disabled");
    }

    // Re-validate + normalize the path SERVER-SIDE. Rejects traversal (`..`),
    // external/dangerous schemes, and empty inputs. We only keep the path; the
    // line anchor is presentation-only and not needed to fetch content.
    const classified = classifyRepoFileLink(rawPath);
    if (!classified) {
      throw new RepoFileContentError("invalid-path");
    }

    // REF-RESOLUTION RULE: working branch when present, else base (NOT NULL).
    const ref = shell.branchName ?? shell.repoBaseBranchName;

    const [owner, repo] = parseRepoFullName(shell.githubRepoFullName);
    const octokit = await getOctokitForUserOrThrow({ userId });

    let data: unknown;
    try {
      const response = await octokit.rest.repos.getContent({
        owner,
        repo,
        path: classified.path,
        ref,
      });
      data = response.data;
    } catch (error) {
      if (isHttpStatusError(error) && error.status === 404) {
        throw new RepoFileContentError("not-found");
      }
      throw new RepoFileContentError("github-error");
    }

    // A directory comes back as an array of entries; return a browsable listing
    // so each child opens through the same in-repo flow when clicked.
    if (Array.isArray(data)) {
      return {
        status: "directory",
        path: classified.path,
        ref,
        entries: parseDirectoryListing(data),
      };
    }

    // A symlink/submodule comes back without a base64 `content` field; treat
    // anything that is not a readable file blob as unsupported rather than
    // guessing.
    if (
      typeof data !== "object" ||
      data === null ||
      !("content" in data) ||
      typeof (data as { content: unknown }).content !== "string" ||
      (data as { encoding?: unknown }).encoding !== "base64"
    ) {
      throw new RepoFileContentError("unsupported-content");
    }

    const decoded = Buffer.from(
      (data as { content: string }).content,
      "base64",
    );
    if (decoded.byteLength > MAX_REPO_FILE_CONTENT_BYTES) {
      throw new RepoFileContentError("too-large");
    }

    return {
      status: "ready",
      content: decoded.toString("utf8"),
      path: classified.path,
      ref,
    };
  } catch (error) {
    const category: RepoFileContentErrorCategory =
      error instanceof RepoFileContentError ? error.category : "github-error";
    // Only the opaque category is logged — never the path, repo, ref, or
    // contents — so no PHI reaches telemetry.
    console.warn("[getRepoFileContentAction] load failed", { category });
    return { status: "error", category };
  }
}

export const getRepoFileContentAction = userOnlyAction(loadRepoFileContent, {
  // The wrapper logs raw thrown errors, so we never throw across it after the
  // initial auth check; loadRepoFileContent returns a typed result instead.
  // A thrown UserFacingError below stays opaque (no PHI) if auth itself fails.
  defaultErrorMessage: "Failed to load file preview",
});
