import { env } from "@terragon/env/apps-www";
import { createDb } from "@terragon/shared/db";
import {
  upsertGithubInstallationProjection,
  upsertGithubPrProjection,
  upsertGithubRepoProjection,
} from "@terragon/shared/model/github-projections";
import { getGithubSurfaceBindingBySurface } from "@terragon/shared/model/github-surface-bindings";
import { getGithubPrWorkspaceByCanonicalId } from "@terragon/shared/model/github-workspaces";
import {
  createTestThread,
  createTestUser,
} from "@terragon/shared/model/test-helpers";
import { describe, expect, it, vi } from "vitest";
import { createGitHubWorkspaceBootstrapClient } from "@/server-lib/github-workspace-bootstrap";
import { associateThreadWithPullRequest } from "./github";

const db = createDb(env.DATABASE_URL);

let nextGithubIdValue = 7_000_000_000;

function nextGithubId(): number {
  nextGithubIdValue += 1;
  return nextGithubIdValue;
}

async function createProjectionChain(params: {
  repoFullName: string;
  prNumber: number;
  headSha: string;
}) {
  const installationId = nextGithubId();
  const repoId = nextGithubId();
  const prNodeId = `PR_${repoId}_${params.prNumber}`;

  const installationProjection = await upsertGithubInstallationProjection({
    db,
    installationId,
    fields: {
      targetAccountLogin: `terragon-${installationId}`,
      targetAccountType: "Organization",
    },
  });
  const repoProjection = await upsertGithubRepoProjection({
    db,
    installationId,
    repoId,
    fields: {
      currentSlug: params.repoFullName,
    },
  });
  const prProjection = await upsertGithubPrProjection({
    db,
    prNodeId,
    repoId,
    fields: {
      number: params.prNumber,
      status: "open",
      baseRef: "main",
      headRef: "feature/bootstrap-associate",
      headSha: params.headSha,
    },
  });

  return {
    installationProjection,
    repoProjection,
    prProjection,
  };
}

describe("associateThreadWithPullRequest", () => {
  it("links a freshly created PR payload into the canonical workspace", async () => {
    const repoFullName = `terragon/test-created-pr-${nextGithubId()}`;
    const prNumber = 102;
    const liveHeadSha = "created-head-sha";
    const projections = await createProjectionChain({
      repoFullName,
      prNumber,
      headSha: "projection-created-head-sha",
    });
    const { user } = await createTestUser({ db });
    const { threadId } = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        githubRepoFullName: repoFullName,
      },
    });
    const bootstrapThreadGithubWorkspaceFn =
      createGitHubWorkspaceBootstrapClient({
        db,
        refreshPrProjection: vi.fn().mockResolvedValue(projections),
      }).bootstrapThreadGithubWorkspace;

    const associatedPrNumber = await associateThreadWithPullRequest({
      userId: user.id,
      threadId,
      repoFullName,
      pullRequest: {
        number: prNumber,
        nodeId: projections.prProjection.prNodeId,
        status: "open",
        headRef: "feature/bootstrap-created",
        headSha: liveHeadSha,
      },
      bootstrapThreadGithubWorkspaceFn,
    });

    const workspace = await getGithubPrWorkspaceByCanonicalId({
      db,
      installationId: projections.installationProjection.installationId,
      repoId: projections.repoProjection.repoId,
      prNodeId: projections.prProjection.prNodeId,
    });
    const binding = await getGithubSurfaceBindingBySurface({
      db,
      surfaceKind: "pull_request",
      surfaceGitHubId: projections.prProjection.prNodeId,
    });
    const runs = workspace
      ? await db.query.githubWorkspaceRun.findMany({
          where: (githubWorkspaceRun, { eq }) =>
            eq(githubWorkspaceRun.workspaceId, workspace.id),
        })
      : [];

    expect(associatedPrNumber).toBe(prNumber);
    expect(workspace?.headSha).toBe(liveHeadSha);
    expect(binding?.boundHeadSha).toBe(liveHeadSha);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.threadId).toBe(threadId);
  });

  it("links an existing associated PR payload into the canonical workspace", async () => {
    const repoFullName = `terragon/test-associated-pr-${nextGithubId()}`;
    const prNumber = 103;
    const liveHeadSha = "associated-head-sha";
    const projections = await createProjectionChain({
      repoFullName,
      prNumber,
      headSha: "projection-associated-head-sha",
    });
    const { user } = await createTestUser({ db });
    const { threadId } = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        githubRepoFullName: repoFullName,
      },
    });
    const bootstrapThreadGithubWorkspaceFn =
      createGitHubWorkspaceBootstrapClient({
        db,
        refreshPrProjection: vi.fn().mockResolvedValue(projections),
      }).bootstrapThreadGithubWorkspace;

    const associatedPrNumber = await associateThreadWithPullRequest({
      userId: user.id,
      threadId,
      repoFullName,
      pullRequest: {
        number: prNumber,
        nodeId: projections.prProjection.prNodeId,
        status: "open",
        headRef: "feature/bootstrap-associated",
        headSha: liveHeadSha,
      },
      bootstrapThreadGithubWorkspaceFn,
    });

    const workspace = await getGithubPrWorkspaceByCanonicalId({
      db,
      installationId: projections.installationProjection.installationId,
      repoId: projections.repoProjection.repoId,
      prNodeId: projections.prProjection.prNodeId,
    });
    const binding = await getGithubSurfaceBindingBySurface({
      db,
      surfaceKind: "pull_request",
      surfaceGitHubId: projections.prProjection.prNodeId,
    });
    const runs = workspace
      ? await db.query.githubWorkspaceRun.findMany({
          where: (githubWorkspaceRun, { eq }) =>
            eq(githubWorkspaceRun.workspaceId, workspace.id),
        })
      : [];
    const updatedThread = await db.query.thread.findFirst({
      where: (thread, { eq }) => eq(thread.id, threadId),
    });

    expect(associatedPrNumber).toBe(prNumber);
    expect(updatedThread?.githubPRNumber).toBe(prNumber);
    expect(workspace?.headSha).toBe(liveHeadSha);
    expect(binding?.boundHeadSha).toBe(liveHeadSha);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.threadId).toBe(threadId);
  });
});
