import type { DB } from "@terragon/shared/db";
import type {
  GithubInstallationAccountType,
  GithubInstallationPermissions,
  GithubInstallationProjection,
  GithubPrProjection,
  GithubRepoProjection,
} from "@terragon/shared/db/types";
import { getGitHubApp } from "@terragon/shared/github-app";
import {
  upsertGithubInstallationProjection,
  upsertGithubPrProjection,
  upsertGithubRepoProjection,
} from "@terragon/shared/model/github-projections";
import { db as defaultDb } from "@/lib/db";
import { getOctokitForApp, parseRepoFullName } from "@/lib/github";

export type GitHubInstallationSnapshot = {
  installationId: number;
  targetAccountId: number | null;
  targetAccountLogin: string | null;
  targetAccountType: GithubInstallationAccountType | null;
  permissions: GithubInstallationPermissions | null;
  suspendedAt: Date | null;
};

export type GitHubRepoSnapshot = {
  repoId: number;
  repoNodeId: string | null;
  currentSlug: string;
  defaultBranch: string | null;
  isPrivate: boolean;
};

export type GitHubPullRequestSnapshot = {
  prNodeId: string;
  number: number;
  isDraft: boolean;
  isClosed: boolean;
  isMerged: boolean;
  baseRef: string | null;
  headRef: string | null;
  headSha: string | null;
};

type RepoCoordinates = {
  owner: string;
  repo: string;
  repoFullName: string;
};

type RefreshInstallationProjectionResult = {
  installationProjection: GithubInstallationProjection;
};

type RefreshRepoProjectionResult = RefreshInstallationProjectionResult & {
  repoProjection: GithubRepoProjection;
};

type RefreshPrProjectionResult = RefreshRepoProjectionResult & {
  prProjection: GithubPrProjection;
};

export interface GitHubProjectionAppClient {
  getInstallationIdForRepo(params: RepoCoordinates): Promise<number>;
  getInstallationSnapshot(params: {
    installationId: number;
  }): Promise<GitHubInstallationSnapshot>;
}

export interface GitHubProjectionRepoClient {
  getRepoSnapshot(params: {
    owner: string;
    repo: string;
  }): Promise<GitHubRepoSnapshot>;
  getPullRequestSnapshot(params: {
    owner: string;
    repo: string;
    pullNumber: number;
  }): Promise<GitHubPullRequestSnapshot>;
}

type GitHubProjectionRefreshClientDependencies = {
  db: DB;
  appClient: GitHubProjectionAppClient;
  getRepoClient(params: RepoCoordinates): Promise<GitHubProjectionRepoClient>;
};

function getRepoCoordinates(repoFullName: string): RepoCoordinates {
  const [owner, repo] = parseRepoFullName(repoFullName);
  return { owner, repo, repoFullName };
}

function normalizeInstallationPermissions(
  permissions:
    | Record<string, "read" | "write" | "admin" | undefined>
    | Record<string, "read" | "write" | "admin">
    | null
    | undefined,
): GithubInstallationPermissions | null {
  if (!permissions) {
    return null;
  }

  const normalized = Object.fromEntries(
    Object.entries(permissions).filter(
      (entry): entry is [string, "read" | "write" | "admin"] => {
        return (
          entry[1] === "read" || entry[1] === "write" || entry[1] === "admin"
        );
      },
    ),
  );

  return Object.keys(normalized).length > 0 ? normalized : null;
}

function getInstallationAccountLogin(
  account: { login: string } | { slug: string } | null | undefined,
): string | null {
  if (!account) {
    return null;
  }

  if ("login" in account) {
    return account.login;
  }

  return account.slug;
}

function getInstallationAccountType(
  account: { type?: string | null; slug?: string | null } | null | undefined,
): GithubInstallationAccountType | null {
  if (!account) {
    return null;
  }

  switch (account.type) {
    case "Organization":
      return "Organization";
    case "User":
      return "User";
    case "Enterprise":
      return "Enterprise";
    default:
      return account.slug ? "Enterprise" : null;
  }
}

function getPullRequestStatus(
  snapshot: Pick<
    GitHubPullRequestSnapshot,
    "isDraft" | "isClosed" | "isMerged"
  >,
): "draft" | "open" | "closed" | "merged" {
  if (snapshot.isMerged) {
    return "merged";
  }
  if (snapshot.isClosed) {
    return "closed";
  }
  if (snapshot.isDraft) {
    return "draft";
  }
  return "open";
}

function getRepoAccessFlags(
  permissions: GithubInstallationPermissions | null | undefined,
): {
  hasReadAccess: boolean;
  hasWriteAccess: boolean;
  hasAdminAccess: boolean;
} {
  if (!permissions) {
    return {
      hasReadAccess: false,
      hasWriteAccess: false,
      hasAdminAccess: false,
    };
  }

  const permissionLevels = Object.values(permissions);
  const hasWriteAccess =
    permissionLevels.includes("write") || permissionLevels.includes("admin");

  return {
    hasReadAccess: hasWriteAccess || permissionLevels.includes("read"),
    hasWriteAccess,
    hasAdminAccess:
      permissions.administration === "write" ||
      permissions.administration === "admin",
  };
}

function createDefaultAppClient(): GitHubProjectionAppClient {
  return {
    async getInstallationIdForRepo({ owner, repo }) {
      const app = getGitHubApp();
      const { data } = await app.octokit.request(
        "GET /repos/{owner}/{repo}/installation",
        {
          owner,
          repo,
        },
      );
      return data.id;
    },
    async getInstallationSnapshot({ installationId }) {
      const app = getGitHubApp();
      const { data } = await app.octokit.request(
        "GET /app/installations/{installation_id}",
        {
          installation_id: installationId,
        },
      );

      return {
        installationId: data.id,
        targetAccountId: data.account?.id ?? null,
        targetAccountLogin: getInstallationAccountLogin(data.account),
        targetAccountType: getInstallationAccountType(data.account),
        permissions: normalizeInstallationPermissions(data.permissions),
        suspendedAt: data.suspended_at ? new Date(data.suspended_at) : null,
      };
    },
  };
}

async function createDefaultRepoClient({
  owner,
  repo,
}: {
  owner: string;
  repo: string;
}): Promise<GitHubProjectionRepoClient> {
  const octokit = await getOctokitForApp({ owner, repo });

  return {
    async getRepoSnapshot({ owner: repoOwner, repo: repoName }) {
      const { data } = await octokit.rest.repos.get({
        owner: repoOwner,
        repo: repoName,
      });

      return {
        repoId: data.id,
        repoNodeId: data.node_id ?? null,
        currentSlug: data.full_name,
        defaultBranch: data.default_branch ?? null,
        isPrivate: data.private,
      };
    },
    async getPullRequestSnapshot({
      owner: repoOwner,
      repo: repoName,
      pullNumber,
    }) {
      const { data } = await octokit.rest.pulls.get({
        owner: repoOwner,
        repo: repoName,
        pull_number: pullNumber,
      });

      return {
        prNodeId: data.node_id,
        number: data.number,
        isDraft: data.draft ?? false,
        isClosed: data.closed_at !== null,
        isMerged: data.merged_at !== null,
        baseRef: data.base.ref ?? null,
        headRef: data.head.ref ?? null,
        headSha: data.head.sha ?? null,
      };
    },
  };
}

export function createGitHubProjectionRefreshClient(
  dependencies?: Partial<GitHubProjectionRefreshClientDependencies>,
) {
  const resolvedDependencies: GitHubProjectionRefreshClientDependencies = {
    db: dependencies?.db ?? defaultDb,
    appClient: dependencies?.appClient ?? createDefaultAppClient(),
    getRepoClient: dependencies?.getRepoClient ?? createDefaultRepoClient,
  };

  async function refreshInstallationProjection({
    installationId,
  }: {
    installationId: number;
  }): Promise<RefreshInstallationProjectionResult> {
    const installationSnapshot =
      await resolvedDependencies.appClient.getInstallationSnapshot({
        installationId,
      });

    const installationProjection = await upsertGithubInstallationProjection({
      db: resolvedDependencies.db,
      installationId: installationSnapshot.installationId,
      fields: {
        targetAccountId: installationSnapshot.targetAccountId,
        targetAccountLogin: installationSnapshot.targetAccountLogin,
        targetAccountType: installationSnapshot.targetAccountType,
        permissionsJson: installationSnapshot.permissions,
        isSuspended: installationSnapshot.suspendedAt !== null,
        suspendedAt: installationSnapshot.suspendedAt,
      },
    });

    return { installationProjection };
  }

  async function refreshRepoProjection({
    repoFullName,
  }: {
    repoFullName: string;
  }): Promise<RefreshRepoProjectionResult> {
    return refreshRepoProjectionForCoordinates({
      coordinates: getRepoCoordinates(repoFullName),
    });
  }

  async function refreshRepoProjectionForCoordinates({
    coordinates,
    repoClient,
  }: {
    coordinates: RepoCoordinates;
    repoClient?: GitHubProjectionRepoClient;
  }): Promise<RefreshRepoProjectionResult> {
    const installationId =
      await resolvedDependencies.appClient.getInstallationIdForRepo(
        coordinates,
      );
    const resolvedRepoClientPromise =
      repoClient === undefined
        ? resolvedDependencies.getRepoClient(coordinates)
        : Promise.resolve(repoClient);
    const [{ installationProjection }, resolvedRepoClient] = await Promise.all([
      refreshInstallationProjection({ installationId }),
      resolvedRepoClientPromise,
    ]);
    const repoSnapshot = await resolvedRepoClient.getRepoSnapshot(coordinates);

    const repoProjection = await upsertGithubRepoProjection({
      db: resolvedDependencies.db,
      installationId,
      repoId: repoSnapshot.repoId,
      fields: {
        repoNodeId: repoSnapshot.repoNodeId,
        currentSlug: repoSnapshot.currentSlug,
        defaultBranch: repoSnapshot.defaultBranch,
        isPrivate: repoSnapshot.isPrivate,
        ...getRepoAccessFlags(installationProjection.permissionsJson),
      },
    });

    return {
      installationProjection,
      repoProjection,
    };
  }

  async function refreshPrProjection({
    repoFullName,
    prNumber,
  }: {
    repoFullName: string;
    prNumber: number;
  }): Promise<RefreshPrProjectionResult> {
    const coordinates = getRepoCoordinates(repoFullName);
    const repoClient = await resolvedDependencies.getRepoClient(coordinates);
    const { installationProjection, repoProjection } =
      await refreshRepoProjectionForCoordinates({
        coordinates,
        repoClient,
      });
    const pullRequestSnapshot = await repoClient.getPullRequestSnapshot({
      owner: coordinates.owner,
      repo: coordinates.repo,
      pullNumber: prNumber,
    });

    const prProjection = await upsertGithubPrProjection({
      db: resolvedDependencies.db,
      prNodeId: pullRequestSnapshot.prNodeId,
      repoId: repoProjection.repoId,
      fields: {
        number: pullRequestSnapshot.number,
        status: getPullRequestStatus(pullRequestSnapshot),
        baseRef: pullRequestSnapshot.baseRef,
        headRef: pullRequestSnapshot.headRef,
        headSha: pullRequestSnapshot.headSha,
      },
    });

    return {
      installationProjection,
      repoProjection,
      prProjection,
    };
  }

  return {
    refreshInstallationProjection,
    refreshRepoProjection,
    refreshPrProjection,
  };
}

const defaultProjectionRefreshClient = createGitHubProjectionRefreshClient();

export const refreshGitHubInstallationProjection =
  defaultProjectionRefreshClient.refreshInstallationProjection;
export const refreshGitHubRepoProjection =
  defaultProjectionRefreshClient.refreshRepoProjection;
export const refreshGitHubPrProjection =
  defaultProjectionRefreshClient.refreshPrProjection;
