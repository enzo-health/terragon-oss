import { env } from "@terragon/env/apps-www";
import { createDb } from "@terragon/shared/db";
import {
  getGithubInstallationProjectionByInstallationId,
  getGithubPrProjectionByPrNodeId,
  getGithubRepoProjectionByRepoId,
} from "@terragon/shared/model/github-projections";
import { describe, expect, it, vi } from "vitest";
import {
  createGitHubProjectionRefreshClient,
  type GitHubInstallationSnapshot,
  type GitHubProjectionAppClient,
  type GitHubProjectionRepoClient,
  type GitHubPullRequestSnapshot,
  type GitHubRepoSnapshot,
} from "./github-projection-refresh";

const db = createDb(env.DATABASE_URL);

let nextGithubIdValue = 2_000_000_000;

function nextGithubId(): number {
  nextGithubIdValue += 1;
  return nextGithubIdValue;
}

function createInstallationSnapshot({
  installationId,
  suspendedAt = null,
}: {
  installationId: number;
  suspendedAt?: Date | null;
}): GitHubInstallationSnapshot {
  return {
    installationId,
    targetAccountId: installationId + 10,
    targetAccountLogin: `terragon-${installationId}`,
    targetAccountType: "Organization",
    permissions: {
      contents: "write",
      pull_requests: "write",
    },
    suspendedAt,
  };
}

function createRepoSnapshot({
  repoId,
  slug,
}: {
  repoId: number;
  slug: string;
}): GitHubRepoSnapshot {
  return {
    repoId,
    repoNodeId: `R_${repoId}`,
    currentSlug: slug,
    defaultBranch: "main",
    isPrivate: true,
  };
}

function createPullRequestSnapshot({
  prNodeId,
  prNumber,
  isDraft = false,
  isClosed = false,
  isMerged = false,
}: {
  prNodeId: string;
  prNumber: number;
  isDraft?: boolean;
  isClosed?: boolean;
  isMerged?: boolean;
}): GitHubPullRequestSnapshot {
  return {
    prNodeId,
    number: prNumber,
    isDraft,
    isClosed,
    isMerged,
    baseRef: "main",
    headRef: "feature/projection-refresh",
    headSha: `sha-${prNumber}`,
  };
}

describe("github projection refresh client", () => {
  it("refreshes installation metadata and permissions by installation id", async () => {
    const installationId = nextGithubId();
    const getInstallationSnapshot = vi
      .fn<GitHubProjectionAppClient["getInstallationSnapshot"]>()
      .mockResolvedValue(
        createInstallationSnapshot({
          installationId,
          suspendedAt: new Date("2026-04-17T12:00:00.000Z"),
        }),
      );
    const refreshClient = createGitHubProjectionRefreshClient({
      db,
      appClient: {
        getInstallationIdForRepo: vi.fn(),
        getInstallationSnapshot,
      },
      getRepoClient: vi.fn(),
    });

    const result = await refreshClient.refreshInstallationProjection({
      installationId,
    });

    expect(getInstallationSnapshot).toHaveBeenCalledWith({ installationId });
    expect(result.installationProjection.installationId).toBe(installationId);
    expect(result.installationProjection.permissionsJson).toEqual({
      contents: "write",
      pull_requests: "write",
    });
    expect(result.installationProjection.isSuspended).toBe(true);

    const persistedProjection =
      await getGithubInstallationProjectionByInstallationId({
        db,
        installationId,
      });

    expect(persistedProjection?.targetAccountLogin).toBe(
      `terragon-${installationId}`,
    );
    expect(persistedProjection?.suspendedAt?.toISOString()).toBe(
      "2026-04-17T12:00:00.000Z",
    );
  });

  it("refreshes repo metadata and default branch from repoFullName", async () => {
    const installationId = nextGithubId();
    const repoId = nextGithubId();
    const repoFullName = `terragon/test-repo-${repoId}`;
    const getInstallationIdForRepo = vi
      .fn<GitHubProjectionAppClient["getInstallationIdForRepo"]>()
      .mockResolvedValue(installationId);
    const getInstallationSnapshot = vi
      .fn<GitHubProjectionAppClient["getInstallationSnapshot"]>()
      .mockResolvedValue(createInstallationSnapshot({ installationId }));
    const getRepoSnapshot = vi
      .fn<GitHubProjectionRepoClient["getRepoSnapshot"]>()
      .mockResolvedValue(
        createRepoSnapshot({
          repoId,
          slug: repoFullName,
        }),
      );
    const getRepoClient = vi
      .fn<
        (params: {
          owner: string;
          repo: string;
        }) => Promise<GitHubProjectionRepoClient>
      >()
      .mockResolvedValue({
        getRepoSnapshot,
        getPullRequestSnapshot: vi.fn(),
      });
    const refreshClient = createGitHubProjectionRefreshClient({
      db,
      appClient: {
        getInstallationIdForRepo,
        getInstallationSnapshot,
      },
      getRepoClient,
    });

    const result = await refreshClient.refreshRepoProjection({ repoFullName });

    expect(getInstallationIdForRepo).toHaveBeenCalledWith({
      owner: "terragon",
      repo: `test-repo-${repoId}`,
      repoFullName,
    });
    expect(getRepoClient).toHaveBeenCalledWith({
      owner: "terragon",
      repo: `test-repo-${repoId}`,
      repoFullName,
    });
    expect(result.repoProjection.repoId).toBe(repoId);
    expect(result.repoProjection.defaultBranch).toBe("main");
    expect(result.repoProjection.hasWriteAccess).toBe(true);
    expect(result.repoProjection.hasReadAccess).toBe(true);
    expect(result.repoProjection.hasAdminAccess).toBe(false);

    const persistedRepoProjection = await getGithubRepoProjectionByRepoId({
      db,
      repoId,
    });

    expect(persistedRepoProjection?.installationId).toBe(installationId);
    expect(persistedRepoProjection?.currentSlug).toBe(repoFullName);
    expect(persistedRepoProjection?.repoNodeId).toBe(`R_${repoId}`);
  });

  it("refreshes PR metadata including head sha and merged state", async () => {
    const installationId = nextGithubId();
    const repoId = nextGithubId();
    const prNumber = 47;
    const prNodeId = `PR_${repoId}_${prNumber}`;
    const repoFullName = `terragon/test-pr-${repoId}`;
    const getPullRequestSnapshot = vi
      .fn<GitHubProjectionRepoClient["getPullRequestSnapshot"]>()
      .mockResolvedValue(
        createPullRequestSnapshot({
          prNodeId,
          prNumber,
          isClosed: true,
          isMerged: true,
        }),
      );
    const refreshClient = createGitHubProjectionRefreshClient({
      db,
      appClient: {
        getInstallationIdForRepo: vi.fn().mockResolvedValue(installationId),
        getInstallationSnapshot: vi
          .fn()
          .mockResolvedValue(createInstallationSnapshot({ installationId })),
      },
      getRepoClient: vi.fn().mockResolvedValue({
        getRepoSnapshot: vi.fn().mockResolvedValue(
          createRepoSnapshot({
            repoId,
            slug: repoFullName,
          }),
        ),
        getPullRequestSnapshot,
      }),
    });

    const result = await refreshClient.refreshPrProjection({
      repoFullName,
      prNumber,
    });

    expect(getPullRequestSnapshot).toHaveBeenCalledWith({
      owner: "terragon",
      repo: `test-pr-${repoId}`,
      pullNumber: prNumber,
    });
    expect(result.prProjection.status).toBe("merged");
    expect(result.prProjection.headSha).toBe(`sha-${prNumber}`);
    expect(result.prProjection.baseRef).toBe("main");
    expect(result.prProjection.headRef).toBe("feature/projection-refresh");

    const persistedPrProjection = await getGithubPrProjectionByPrNodeId({
      db,
      prNodeId,
    });

    expect(persistedPrProjection?.repoId).toBe(repoId);
    expect(persistedPrProjection?.number).toBe(prNumber);
    expect(persistedPrProjection?.status).toBe("merged");
    expect(persistedPrProjection?.isDraft).toBe(false);
  });

  it("rejects PR refresh when repo and number already belong to a different node id", async () => {
    const installationId = nextGithubId();
    const repoId = nextGithubId();
    const repoFullName = `terragon/test-mismatch-${repoId}`;
    const existingNodeId = `PR_${repoId}_existing`;
    const incomingNodeId = `PR_${repoId}_incoming`;
    const prNumber = 52;
    const refreshClient = createGitHubProjectionRefreshClient({
      db,
      appClient: {
        getInstallationIdForRepo: vi.fn().mockResolvedValue(installationId),
        getInstallationSnapshot: vi
          .fn()
          .mockResolvedValue(createInstallationSnapshot({ installationId })),
      },
      getRepoClient: vi.fn().mockResolvedValue({
        getRepoSnapshot: vi.fn().mockResolvedValue(
          createRepoSnapshot({
            repoId,
            slug: repoFullName,
          }),
        ),
        getPullRequestSnapshot: vi.fn().mockResolvedValue(
          createPullRequestSnapshot({
            prNodeId: existingNodeId,
            prNumber,
          }),
        ),
      }),
    });

    await refreshClient.refreshPrProjection({
      repoFullName,
      prNumber,
    });

    const mismatchedRefreshClient = createGitHubProjectionRefreshClient({
      db,
      appClient: {
        getInstallationIdForRepo: vi.fn().mockResolvedValue(installationId),
        getInstallationSnapshot: vi
          .fn()
          .mockResolvedValue(createInstallationSnapshot({ installationId })),
      },
      getRepoClient: vi.fn().mockResolvedValue({
        getRepoSnapshot: vi.fn().mockResolvedValue(
          createRepoSnapshot({
            repoId,
            slug: repoFullName,
          }),
        ),
        getPullRequestSnapshot: vi.fn().mockResolvedValue(
          createPullRequestSnapshot({
            prNodeId: incomingNodeId,
            prNumber,
          }),
        ),
      }),
    });

    await expect(
      mismatchedRefreshClient.refreshPrProjection({
        repoFullName,
        prNumber,
      }),
    ).rejects.toThrow("identity mismatch");
  });
});
