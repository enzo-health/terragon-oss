"use server";

import { db } from "@/lib/db";
import { userOnlyAction } from "@/lib/auth-server";
import { getThreadPageShellWithPermissions } from "@terragon/shared/model/thread-page";
import { getFeatureFlagForUser } from "@terragon/shared/model/feature-flags";
import { classifyRepoFileLink } from "@terragon/shared/utils/repo-file-link";
import type { Octokit } from "octokit";
import { getHasRepoPermissionsForUser } from "./get-thread";
import { getOctokitForUserOrThrow, parseRepoFullName } from "@/lib/github";

/** The `repos.getContent` response body: a file/symlink/submodule object, or a
 * directory's entry array. Derived from the SDK so the directory branch is
 * typed end-to-end rather than re-validated from `unknown`. */
type GetContentData = Awaited<
  ReturnType<Octokit["rest"]["repos"]["getContent"]>
>["data"];
type GetContentDirectory = Extract<GetContentData, unknown[]>;

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
function parseDirectoryListing(
  items: GetContentDirectory,
): RepoDirectoryEntry[] {
  const entries: RepoDirectoryEntry[] = [];
  for (const { name, path, type } of items) {
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
 * present, with a 404 fallback to `repoBaseBranchName` (NOT NULL) — never the
 * repo default branch. The fallback is what makes in-repo links work in
 * read-only/exploration threads, whose `branchName` is assigned but never
 * pushed: getContent 404s against that phantom ref, so we re-read the same path
 * from base where the file actually exists.
 *
 * V1 LIMITATION (R4/R7 scope): blobs are sourced from GitHub getContent, so
 * only files COMMITTED AND PUSHED to the working branch OR present on base are
 * readable. Uncommitted/unpushed working-tree edits — the agent's most common
 * fresh tool-output and diff targets — are NOT readable in v1 (there is no
 * web→sandbox file-read channel today: sendDaemonMessage is fire-and-forget).
 * Clicking a path absent on both refs returns category "not-found", which s5
 * renders as the clean "not yet pushed" unsupported state. That is the
 * documented expected behavior for that case, not a crash. The live-sandbox
 * read channel that lifts this limit is tracked in the slice/PR notes.
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

    // REF-RESOLUTION RULE: try the working branch first, then the base branch
    // (NOT NULL) on a 404. A read-only/exploration thread is assigned a
    // `branchName` that is never pushed (no commits), so getContent 404s against
    // it for every path even though the file exists on base — the cascade
    // resolves those from base. The base candidate is dropped when it equals the
    // working ref so we never fetch the same ref twice. The repo's GitHub
    // default branch is still never used; only the thread's own base branch.
    const refCandidates =
      shell.branchName && shell.branchName !== shell.repoBaseBranchName
        ? [shell.branchName, shell.repoBaseBranchName]
        : [shell.repoBaseBranchName];

    const [owner, repo] = parseRepoFullName(shell.githubRepoFullName);
    const octokit = await getOctokitForUserOrThrow({ userId });

    let data: GetContentData | undefined;
    let resolvedRef: string | undefined;
    for (const candidate of refCandidates) {
      try {
        const response = await octokit.rest.repos.getContent({
          owner,
          repo,
          path: classified.path,
          ref: candidate,
        });
        data = response.data;
        resolvedRef = candidate;
        break;
      } catch (error) {
        // A 404 means the path is absent on this ref; try the next candidate.
        // Any other status is a hard GitHub failure and short-circuits.
        if (isHttpStatusError(error) && error.status === 404) continue;
        throw new RepoFileContentError("github-error");
      }
    }
    if (data === undefined || resolvedRef === undefined) {
      throw new RepoFileContentError("not-found");
    }
    const ref = resolvedRef;

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
