import { db } from "./db";
import { auth } from "./auth";
import { env } from "@terragon/env/apps-www";
import {
  getGithubPR,
  getThreadsForGithubPR,
  upsertGithubPR,
} from "@terragon/shared/model/github";
import * as schema from "@terragon/shared/db/schema";
import { Octokit } from "octokit";
import type { Endpoints } from "@octokit/types";
import {
  getGithubPRMergeableState,
  getGithubPRStatus,
  getGithubPRChecksStatus,
} from "@terragon/shared/github-api/helpers";
import { getInstallationToken } from "@terragon/shared/github-app";
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import { and, eq } from "drizzle-orm";
import { decryptTokenWithBackwardsCompatibility } from "@terragon/utils/encryption";
import { getPostHogServer } from "./posthog-server";
import { publishBroadcastUserMessage } from "@terragon/shared/broadcast-server";
import { updateThread } from "@terragon/shared/model/threads";
import {
  getGitHubAccountIdForUser,
  getUserSettings,
} from "@terragon/shared/model/user";
import { UserFacingError } from "./server-actions";
import type { GithubPRStatus } from "@terragon/shared/db/types";

type PullRequestAssociationSource =
  | Endpoints["GET /repos/{owner}/{repo}/pulls"]["response"]["data"][number]
  | Endpoints["POST /repos/{owner}/{repo}/pulls"]["response"]["data"];

type BootstrapThreadGithubWorkspaceFn =
  typeof import("@/server-lib/github-workspace-bootstrap").bootstrapThreadGithubWorkspace;

let bootstrapThreadGithubWorkspaceFnPromise: Promise<BootstrapThreadGithubWorkspaceFn> | null =
  null;

async function getDefaultBootstrapThreadGithubWorkspaceFn(): Promise<BootstrapThreadGithubWorkspaceFn> {
  if (bootstrapThreadGithubWorkspaceFnPromise === null) {
    bootstrapThreadGithubWorkspaceFnPromise = import(
      "@/server-lib/github-workspace-bootstrap"
    ).then((module) => module.bootstrapThreadGithubWorkspace);
  }

  return bootstrapThreadGithubWorkspaceFnPromise;
}

export type PullRequestAssociationIdentity = {
  number: number;
  nodeId: string;
  status: GithubPRStatus;
  headRef: string;
  headSha: string;
};

export function toPullRequestAssociationIdentity(
  pullRequest: PullRequestAssociationSource,
): PullRequestAssociationIdentity {
  return {
    number: pullRequest.number,
    nodeId: pullRequest.node_id,
    status: getGithubPRStatus(pullRequest),
    headRef: pullRequest.head.ref,
    headSha: pullRequest.head.sha,
  };
}

export function parseRepoFullName(repoFullName: string): [string, string] {
  const [owner, repo] = repoFullName.split("/");
  if (!owner || !repo) {
    throw new Error(`Invalid repository full name: ${repoFullName}`);
  }
  return [owner, repo];
}

export async function ensureBranchExists({
  userId,
  repoFullName,
  branchName,
}: {
  userId: string;
  repoFullName: string;
  branchName: string;
}) {
  const [owner, repoName] = parseRepoFullName(repoFullName);
  const octokit = await getOctokitForUserOrThrow({ userId });
  try {
    const branch = await octokit.rest.repos.getBranch({
      owner,
      repo: repoName,
      branch: branchName,
    });
    if (!branch || branch.data.name !== branchName) {
      throw new BranchDoesNotExistError({ repoFullName, branchName });
    }
  } catch (error: unknown) {
    // If we get a 404, check if the repo has no branches at all
    if (
      typeof error === "object" &&
      error !== null &&
      "status" in error &&
      (error as { status?: unknown }).status === 404
    ) {
      try {
        // Check if the repository exists and has any branches
        const { data: branches } = await octokit.rest.repos.listBranches({
          owner,
          repo: repoName,
          per_page: 1,
        });

        if (branches.length === 0) {
          // Repository has no branches, create an initial branch
          console.log(
            `Repository ${repoFullName} has no branches. Creating initial branch: ${branchName}`,
          );

          // Create a README file to initialize the branch
          const readmeContent = `# ${repoName}\n\nThis repository was initialized by Terragon.`;

          await octokit.rest.repos.createOrUpdateFileContents({
            owner,
            repo: repoName,
            path: "README.md",
            message: "Initial commit",
            content: Buffer.from(readmeContent).toString("base64"),
            branch: branchName,
          });

          console.log(
            `Successfully created initial branch ${branchName} in ${repoFullName}`,
          );
          return;
        }
      } catch (innerError) {
        console.error("Error checking/creating branches:", innerError);
      }
    }

    // Re-throw the original error if it's not a case we can handle
    throw new BranchDoesNotExistError({ repoFullName, branchName });
  }
}

export class BranchDoesNotExistError extends UserFacingError {
  constructor({
    repoFullName,
    branchName,
  }: {
    repoFullName: string;
    branchName: string;
  }) {
    super(
      `Branch ${branchName} does not exist in ${repoFullName}. Please try a different branch.`,
    );
  }
}

export async function updateGitHubPR({
  repoFullName,
  prNumber,
  createIfNotFound,
}: {
  repoFullName: string;
  prNumber: number;
  createIfNotFound: boolean;
}) {
  const [owner, repoName] = parseRepoFullName(repoFullName);
  const octokit = await getOctokitForApp({ owner, repo: repoName });
  const existingPR = await getGithubPR({
    db,
    repoFullName,
    prNumber,
  });
  if (!existingPR && !createIfNotFound) {
    return;
  }
  const pr = await octokit.rest.pulls.get({
    owner,
    repo: repoName,
    pull_number: prNumber,
  });

  const baseRef = pr.data.base.ref;
  const mergeableState = getGithubPRMergeableState(pr.data);
  const status = getGithubPRStatus(pr.data);

  // Also fetch check status
  const checkRuns = await octokit.rest.checks.listForRef({
    owner,
    repo: repoName,
    ref: pr.data.head.sha,
  });

  // Calculate overall check status
  const checksStatus = getGithubPRChecksStatus(checkRuns.data);
  const shouldUpdate =
    !existingPR ||
    existingPR.status !== status ||
    existingPR.baseRef !== baseRef ||
    existingPR.mergeableState !== mergeableState ||
    existingPR.checksStatus !== checksStatus;
  if (!shouldUpdate) {
    return;
  }
  await upsertGithubPR({
    db,
    repoFullName,
    number: prNumber,
    updates: {
      status,
      baseRef,
      mergeableState,
      checksStatus,
    },
  });
  const threads = await getThreadsForGithubPR({
    db,
    repoFullName,
    prNumber,
  });
  // Capture posthog event for each thread where the PR status changed
  for (const thread of threads) {
    getPostHogServer().capture({
      distinctId: thread.userId,
      event: "github_pr_status_changed",
      properties: {
        repoFullName,
        prNumber,
        status,
      },
    });
  }
  // Auto-archive threads for merged or closed PRs if user setting is enabled
  if (status === "merged" || status === "closed") {
    await Promise.all(
      threads.map(async (thread) => {
        if (!thread.archived) {
          const userSettings = await getUserSettings({
            db,
            userId: thread.userId,
          });
          if (userSettings?.autoArchiveMergedPRs) {
            await updateThread({
              db,
              userId: thread.userId,
              threadId: thread.id,
              updates: {
                archived: true,
                updatedAt: new Date(),
              },
            });
          }
        }
      }),
    );
  }
  // Publish realtime message for each thread where the PR status changed
  const threadIdsByUserId: Record<string, string[]> = {};
  for (const thread of threads) {
    if (!threadIdsByUserId[thread.userId]) {
      threadIdsByUserId[thread.userId] = [];
    }
    threadIdsByUserId[thread.userId]!.push(thread.id);
  }
  await Promise.all(
    Object.entries(threadIdsByUserId).map(async ([userId, threadIds]) => {
      await publishBroadcastUserMessage({
        type: "user",
        id: userId,
        data: {
          threadPatches: threadIds.map((threadId) => ({
            threadId,
            op: "refetch",
            refetch: ["shell", "list"],
          })),
        },
      });
    }),
  );
}

export async function getOctokitForApp({
  owner,
  repo,
}: {
  owner: string;
  repo: string;
}): Promise<Octokit> {
  const githubAccessToken = await getInstallationToken(owner, repo);
  return new Octokit({ auth: githubAccessToken });
}

const GITHUB_OAUTH_TOKEN_REGEX =
  /^(gh[oprsu]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)$/;

function isLikelyGitHubOAuthToken(token: string): boolean {
  return GITHUB_OAUTH_TOKEN_REGEX.test(token);
}

async function tryDecryptBetterAuthToken({
  token,
  key,
}: {
  token: string;
  key: string;
}): Promise<string | null> {
  if (!key || key.trim().length === 0) {
    return null;
  }
  try {
    return await symmetricDecrypt({
      key,
      data: token,
    });
  } catch {
    return null;
  }
}

async function decodeGitHubOAuthToken(
  rawToken: string,
): Promise<string | null> {
  if (isLikelyGitHubOAuthToken(rawToken)) {
    return rawToken;
  }

  const legacyToken = decryptTokenWithBackwardsCompatibility(
    rawToken,
    env.ENCRYPTION_MASTER_KEY,
  );
  if (isLikelyGitHubOAuthToken(legacyToken)) {
    return legacyToken;
  }

  const betterAuthToken = await tryDecryptBetterAuthToken({
    token: rawToken,
    key: env.BETTER_AUTH_SECRET,
  });
  if (betterAuthToken && isLikelyGitHubOAuthToken(betterAuthToken)) {
    return betterAuthToken;
  }

  return null;
}

async function getDirectGitHubAccessTokenFromAccount(params: {
  userId: string;
}): Promise<string | null> {
  const githubAccount = await db.query.account.findFirst({
    where: and(
      eq(schema.account.userId, params.userId),
      eq(schema.account.providerId, "github"),
    ),
    columns: {
      accessToken: true,
    },
  });
  const rawToken = githubAccount?.accessToken;
  if (!rawToken) {
    return null;
  }
  return await decodeGitHubOAuthToken(rawToken);
}

async function tryMigrateLegacyGitHubOAuthTokens({
  userId,
}: {
  userId: string;
}): Promise<boolean> {
  const githubAccount = await db.query.account.findFirst({
    where: and(
      eq(schema.account.userId, userId),
      eq(schema.account.providerId, "github"),
    ),
    columns: {
      id: true,
      accessToken: true,
      refreshToken: true,
    },
  });
  if (!githubAccount?.accessToken) {
    return false;
  }

  const decryptedAccessToken = decryptTokenWithBackwardsCompatibility(
    githubAccount.accessToken,
    env.ENCRYPTION_MASTER_KEY,
  );
  if (!isLikelyGitHubOAuthToken(decryptedAccessToken)) {
    return false;
  }

  const decryptedRefreshToken = githubAccount.refreshToken
    ? decryptTokenWithBackwardsCompatibility(
        githubAccount.refreshToken,
        env.ENCRYPTION_MASTER_KEY,
      )
    : null;
  if (
    decryptedRefreshToken &&
    !isLikelyGitHubOAuthToken(decryptedRefreshToken)
  ) {
    return false;
  }

  const [encryptedAccessToken, encryptedRefreshToken] = await Promise.all([
    symmetricEncrypt({
      key: env.BETTER_AUTH_SECRET,
      data: decryptedAccessToken,
    }),
    decryptedRefreshToken
      ? symmetricEncrypt({
          key: env.BETTER_AUTH_SECRET,
          data: decryptedRefreshToken,
        })
      : Promise.resolve<string | null>(null),
  ]);

  await db
    .update(schema.account)
    .set({
      accessToken: encryptedAccessToken,
      refreshToken: encryptedRefreshToken,
      updatedAt: new Date(),
    })
    .where(eq(schema.account.id, githubAccount.id));

  console.info(
    `[github-oauth] Migrated legacy encrypted tokens for user ${userId}`,
  );
  return true;
}

export async function getGitHubUserAccessToken({
  userId,
}: {
  userId: string;
}): Promise<string | null> {
  try {
    const result = await auth.api.getAccessToken({
      body: { providerId: "github", userId },
    });
    if (result?.accessToken) {
      return result.accessToken;
    }
    return await getDirectGitHubAccessTokenFromAccount({ userId });
  } catch (error) {
    console.error(
      `[github-oauth] Failed to get/refresh GitHub access token for user ${userId}`,
      error,
    );
    try {
      const migratedLegacyTokens = await tryMigrateLegacyGitHubOAuthTokens({
        userId,
      });
      if (!migratedLegacyTokens) {
        return await getDirectGitHubAccessTokenFromAccount({ userId });
      }
      const retryResult = await auth.api.getAccessToken({
        body: { providerId: "github", userId },
      });
      if (retryResult?.accessToken) {
        return retryResult.accessToken;
      }
      return await getDirectGitHubAccessTokenFromAccount({ userId });
    } catch (migrationError) {
      console.error(
        `[github-oauth] Failed to recover GitHub OAuth tokens for user ${userId}`,
        migrationError,
      );
      return await getDirectGitHubAccessTokenFromAccount({ userId });
    }
  }
}

type GitHubMembershipResponse = {
  state?: string;
};

export async function isGitHubOrgMember({
  userId,
  org,
}: {
  userId: string;
  org: string;
}): Promise<boolean> {
  const normalizedOrg = org.trim().toLowerCase();
  if (!normalizedOrg) {
    return true;
  }

  const token = await getGitHubUserAccessToken({ userId });
  if (!token) {
    return false;
  }

  const response = await fetch(
    `https://api.github.com/user/memberships/orgs/${encodeURIComponent(normalizedOrg)}`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "Terragon",
      },
      cache: "no-store",
    },
  );

  if (!response.ok) {
    return false;
  }

  const membership: GitHubMembershipResponse =
    (await response.json()) as GitHubMembershipResponse;
  return membership.state === "active";
}

export async function getOctokitForUser({
  userId,
}: {
  userId: string;
}): Promise<Octokit | null> {
  const token = await getGitHubUserAccessToken({ userId });
  if (!token) return null;
  return new Octokit({ auth: token });
}

export async function getOctokitForUserOrThrow({
  userId,
}: {
  userId: string;
}): Promise<Octokit> {
  const octokit = await getOctokitForUser({ userId });
  if (!octokit) {
    throw new Error("No github access token found");
  }
  return octokit;
}

export async function getIsPRAuthor({
  userId,
  repoFullName,
  prNumber,
}: {
  userId: string;
  repoFullName: string;
  prNumber: number;
}): Promise<boolean> {
  try {
    const [owner, repoName] = parseRepoFullName(repoFullName);
    const [octokit, prAuthorGitHubAccountId] = await Promise.all([
      getOctokitForApp({ owner, repo: repoName }),
      getGitHubAccountIdForUser({
        db,
        userId,
      }),
    ]);
    const pr = await octokit.rest.pulls.get({
      owner,
      repo: repoName,
      pull_number: prNumber,
    });
    return pr.data.user.id + "" === prAuthorGitHubAccountId;
  } catch (error) {
    console.error(
      `Failed to get PR author for ${repoFullName} #${prNumber}:`,
      error,
    );
    return false;
  }
}

export async function getPRAuthorGitHubUsername({
  repoFullName,
  prNumber,
}: {
  repoFullName: string;
  prNumber: number;
}): Promise<string> {
  const [owner, repoName] = parseRepoFullName(repoFullName);
  const octokit = await getOctokitForApp({ owner, repo: repoName });
  const pr = await octokit.rest.pulls.get({
    owner,
    repo: repoName,
    pull_number: prNumber,
  });
  return pr.data.user.login;
}

export async function getIsIssueAuthor({
  userId,
  repoFullName,
  issueNumber,
}: {
  userId: string;
  repoFullName: string;
  issueNumber: number;
}): Promise<boolean> {
  try {
    const [owner, repoName] = parseRepoFullName(repoFullName);
    const [octokit, userGithubAccount] = await Promise.all([
      getOctokitForApp({ owner, repo: repoName }),
      getGitHubAccountIdForUser({
        db,
        userId,
      }),
    ]);
    const { data: issue } = await octokit.rest.issues.get({
      owner,
      repo: repoName,
      issue_number: issueNumber,
    });
    return issue.user?.id + "" === userGithubAccount;
  } catch (error) {
    console.error(
      `Failed to get issue author for ${repoFullName} #${issueNumber}:`,
      error,
    );
    return false;
  }
}

export async function getIssueAuthorGitHubUsername({
  repoFullName,
  issueNumber,
}: {
  repoFullName: string;
  issueNumber: number;
}): Promise<string> {
  const [owner, repoName] = parseRepoFullName(repoFullName);
  const octokit = await getOctokitForApp({ owner, repo: repoName });
  const issue = await octokit.rest.issues.get({
    owner,
    repo: repoName,
    issue_number: issueNumber,
  });
  return issue.data.user?.login || "";
}

export async function getDefaultBranchForRepo({
  userId,
  repoFullName,
}: {
  userId: string;
  repoFullName: string;
}): Promise<string> {
  const octokit = await getOctokitForUserOrThrow({ userId });
  const [owner, repo] = parseRepoFullName(repoFullName);
  try {
    const { data: repoData } = await octokit.rest.repos.get({
      owner,
      repo,
    });
    return repoData.default_branch || "main";
  } catch (error) {
    console.error(`Failed to get default branch for ${repoFullName}:`, error);
    return "main";
  }
}

export async function getExistingPRForBranch({
  repoFullName,
  headBranchName,
  baseBranchName,
  userId,
}: {
  repoFullName: string;
  headBranchName: string;
  baseBranchName: string;
  userId?: string;
}) {
  const [owner, repo] = parseRepoFullName(repoFullName);
  try {
    const userOctokit = userId ? await getOctokitForUser({ userId }) : null;
    const octokit = userOctokit ?? (await getOctokitForApp({ owner, repo }));

    const existingPr = await octokit.rest.pulls.list({
      owner,
      repo,
      state: "open",
      head: `${owner}:${headBranchName}`,
      base: baseBranchName,
    });
    // Filter for exact branch match
    const exactMatchPr = existingPr.data.find(
      (pr) => pr.head.ref === headBranchName.trim(),
    );
    return exactMatchPr || null;
  } catch (error) {
    console.error("Error finding associated PR:", error);
    return null;
  }
}

export async function findAndAssociatePR({
  userId,
  threadId,
  repoFullName,
  headBranchName,
  baseBranchName,
}: {
  userId: string;
  threadId: string;
  repoFullName: string;
  headBranchName: string;
  baseBranchName: string;
}): Promise<number | null> {
  console.log("findAndAssociatePR", {
    userId,
    threadId,
    repoFullName,
    headBranchName,
    baseBranchName,
  });
  const existingPr = await getExistingPRForBranch({
    repoFullName,
    headBranchName,
    baseBranchName,
    userId,
  });
  if (!existingPr) {
    return null;
  }
  return await associateThreadWithPullRequest({
    userId,
    threadId,
    repoFullName,
    pullRequest: toPullRequestAssociationIdentity(existingPr),
  });
}

export async function associateThreadWithPullRequest({
  userId,
  threadId,
  repoFullName,
  pullRequest,
  bootstrapThreadGithubWorkspaceFn,
}: {
  userId: string;
  threadId: string;
  repoFullName: string;
  pullRequest: PullRequestAssociationIdentity;
  bootstrapThreadGithubWorkspaceFn?: BootstrapThreadGithubWorkspaceFn;
}): Promise<number> {
  await Promise.all([
    updateThread({
      db,
      userId,
      threadId,
      updates: {
        githubPRNumber: pullRequest.number,
      },
    }),
    upsertGithubPR({
      db,
      repoFullName,
      number: pullRequest.number,
      updates: {
        status: pullRequest.status,
      },
    }),
  ]);
  const resolvedBootstrapThreadGithubWorkspaceFn =
    bootstrapThreadGithubWorkspaceFn ??
    (await getDefaultBootstrapThreadGithubWorkspaceFn());

  await resolvedBootstrapThreadGithubWorkspaceFn({
    repoFullName,
    prNumber: pullRequest.number,
    threadId,
    pullRequestIdentity: {
      prNodeId: pullRequest.nodeId,
      headSha: pullRequest.headSha,
    },
  });
  return pullRequest.number;
}
