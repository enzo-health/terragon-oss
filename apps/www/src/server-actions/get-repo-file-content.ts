"use server";

import { userOnlyAction } from "@/lib/auth-server";
import { classifyRepoFileLink } from "@terragon/shared/utils/repo-file-link";
import type { Octokit } from "octokit";
import {
  RepoAccessError,
  resolveRepoAccess,
  fetchWithRefCascade,
} from "./repo-access";

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

/**
 * Authenticated content-loading action for the in-repo file preview.
 *
 * Authorization and content sourcing are entirely server-derived:
 *  - Authz, the repoFilePreview flag re-check, and repoFullName + ref-candidate
 *    resolution all run in resolveRepoAccess (repo-access.ts). The client
 *    supplies only the threadId and the clicked path — NEVER a repoFullName or
 *    ref.
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
    // Authorize, re-check the flag, and resolve repoFullName + ref candidates
    // entirely server-side. resolveRepoAccess throws RepoAccessError, whose
    // "unauthorized"/"feature-disabled" categories are a subset of ours.
    const { octokit, owner, repo, refCandidates } = await resolveRepoAccess(
      userId,
      threadId,
    );

    // Re-validate + normalize the path SERVER-SIDE. Rejects traversal (`..`),
    // external/dangerous schemes, and empty inputs. We only keep the path; the
    // line anchor is presentation-only and not needed to fetch content.
    const classified = classifyRepoFileLink(rawPath);
    if (!classified) {
      throw new RepoFileContentError("invalid-path");
    }

    const { data, ref } = await fetchWithRefCascade(
      refCandidates,
      async (candidate) =>
        (
          await octokit.rest.repos.getContent({
            owner,
            repo,
            path: classified.path,
            ref: candidate,
          })
        ).data,
    );

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
    // Both error types carry an opaque category; RepoAccessError's categories
    // are a subset of ours, so this is effectively identity.
    const category: RepoFileContentErrorCategory =
      error instanceof RepoFileContentError || error instanceof RepoAccessError
        ? error.category
        : "github-error";
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
