import { db } from "@/lib/db";
import { getThreadPageShellWithPermissions } from "@terragon/shared/model/thread-page";
import { getFeatureFlagForUser } from "@terragon/shared/model/feature-flags";
import type { Octokit } from "octokit";
import { getHasRepoPermissionsForUser } from "./get-thread";
import { getOctokitForUserOrThrow, parseRepoFullName } from "@/lib/github";

/**
 * Opaque error categories. These (and only these) may be logged or surfaced.
 * They never contain file contents, file paths, or repo identifiers, so no PHI
 * can leak through telemetry or the server-action error wrapper.
 */
export type RepoAccessErrorCategory =
  | "unauthorized"
  | "feature-disabled"
  | "not-found"
  | "github-error";

/**
 * Internal error carrying only an opaque category. The action boundary maps
 * this to a typed result; the category is the only thing allowed into a log.
 */
export class RepoAccessError extends Error {
  readonly category: RepoAccessErrorCategory;
  constructor(category: RepoAccessErrorCategory) {
    super(category);
    this.name = "RepoAccessError";
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
 * Authorize a user against a thread/repo and resolve everything needed to read
 * from GitHub server-side. The client supplies only the threadId — never a
 * repoFullName or ref.
 *
 *  - The user is authorized against the thread/repo via
 *    getThreadPageShellWithPermissions (allowAdmin: false). Throws
 *    RepoAccessError("unauthorized") if the caller cannot access the thread.
 *    Running authz first ensures the feature flag is never evaluated for a
 *    threadId the caller cannot access.
 *  - The repoFilePreview feature flag is re-checked server-side; off →
 *    RepoAccessError("feature-disabled").
 *  - repoFullName and the git ref come from the server-resolved thread.
 *
 * REF-RESOLUTION RULE: refCandidates is the thread's working `branchName` (the
 * pushed branch the user sees in diffs/tool output) when present, with the base
 * `repoBaseBranchName` (NOT NULL) appended as a 404 fallback — never the repo
 * default branch. The base candidate is dropped when it equals the working ref
 * so the same ref is never fetched twice. The fallback is what makes in-repo
 * reads work in read-only/exploration threads, whose `branchName` is assigned
 * but never pushed: the working ref 404s, so the same path is re-read from base.
 */
export async function resolveRepoAccess(
  userId: string,
  threadId: string,
): Promise<{
  octokit: Octokit;
  owner: string;
  repo: string;
  refCandidates: string[];
}> {
  const shell = await getThreadPageShellWithPermissions({
    db,
    threadId,
    userId,
    allowAdmin: false,
    getHasRepoPermissions: async (repoFullName) =>
      getHasRepoPermissionsForUser({ userId, repoFullName }),
  });
  if (!shell) {
    throw new RepoAccessError("unauthorized");
  }

  const flagEnabled = await getFeatureFlagForUser({
    db,
    userId,
    flagName: "repoFilePreview",
  });
  if (!flagEnabled) {
    throw new RepoAccessError("feature-disabled");
  }

  const refCandidates =
    shell.branchName && shell.branchName !== shell.repoBaseBranchName
      ? [shell.branchName, shell.repoBaseBranchName]
      : [shell.repoBaseBranchName];

  const [owner, repo] = parseRepoFullName(shell.githubRepoFullName);
  const octokit = await getOctokitForUserOrThrow({ userId });

  return { octokit, owner, repo, refCandidates };
}

/**
 * Try each ref candidate in order, returning the first success with the ref it
 * resolved against. A 404 means the target is absent on that ref, so the next
 * candidate is tried; any other status is a hard GitHub failure that
 * short-circuits to RepoAccessError("github-error"). If every candidate 404s,
 * throws RepoAccessError("not-found").
 */
export async function fetchWithRefCascade<T>(
  refCandidates: string[],
  fetchAt: (ref: string) => Promise<T>,
): Promise<{ data: T; ref: string }> {
  for (const candidate of refCandidates) {
    try {
      const data = await fetchAt(candidate);
      return { data, ref: candidate };
    } catch (error) {
      if (isHttpStatusError(error) && error.status === 404) continue;
      throw new RepoAccessError("github-error");
    }
  }
  throw new RepoAccessError("not-found");
}
