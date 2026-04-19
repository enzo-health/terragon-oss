import { env } from "@terragon/env/apps-www";
import { createDb } from "@terragon/shared/db";
import { getActiveWorkflowForThread } from "@terragon/shared/delivery-loop/store/workflow-store";
import { getGithubSurfaceBindingBySurface } from "@terragon/shared/model/github-surface-bindings";
import {
  getGithubPrWorkspaceByCanonicalId,
  listGithubWorkspaceRunsForWorkspace,
} from "@terragon/shared/model/github-workspaces";
import {
  upsertGithubInstallationProjection,
  upsertGithubPrProjection,
  upsertGithubRepoProjection,
} from "@terragon/shared/model/github-projections";
import {
  createTestThread,
  createTestUser,
} from "@terragon/shared/model/test-helpers";
import * as schema from "@terragon/shared/db/schema";
import { describe, expect, it, vi } from "vitest";
import { createGitHubWorkspaceBootstrapClient } from "./github-workspace-bootstrap";

const db = createDb(env.DATABASE_URL);

let nextGithubIdValue = 5_000_000_000;

function nextGithubId(): number {
  nextGithubIdValue += 1;
  return nextGithubIdValue;
}

async function createProjectionChain(params?: {
  prNumber?: number;
  headSha?: string;
}) {
  const installationId = nextGithubId();
  const repoId = nextGithubId();
  const prNumber = params?.prNumber ?? 71;
  const prNodeId = `PR_${repoId}_${prNumber}`;
  const headSha = params?.headSha ?? `sha-${prNumber}`;

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
      currentSlug: `terragon/test-repo-${repoId}`,
    },
  });
  const prProjection = await upsertGithubPrProjection({
    db,
    prNodeId,
    repoId,
    fields: {
      number: prNumber,
      status: "open",
      baseRef: "main",
      headRef: "feature/bootstrap",
      headSha,
    },
  });

  return {
    installationProjection,
    repoProjection,
    prProjection,
  };
}

describe("github workspace bootstrap", () => {
  it("bootstraps the canonical workspace, binding, and authoring run for a thread", async () => {
    const projections = await createProjectionChain({
      prNumber: 81,
      headSha: "live-sha-81",
    });
    const { user } = await createTestUser({ db });
    const { threadId } = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        githubRepoFullName: projections.repoProjection.currentSlug,
      },
    });
    await db.insert(schema.deliveryWorkflow).values({
      threadId,
      generation: 1,
      kind: "github_shadow_write",
      stateJson: {},
      userId: user.id,
    });
    const bootstrapClient = createGitHubWorkspaceBootstrapClient({
      db,
      refreshPrProjection: vi.fn().mockResolvedValue(projections),
    });

    const result = await bootstrapClient.bootstrapThreadGithubWorkspace({
      repoFullName: projections.repoProjection.currentSlug,
      prNumber: projections.prProjection.number,
      threadId,
      pullRequestIdentity: {
        prNodeId: projections.prProjection.prNodeId,
        headSha: "actual-head-sha",
      },
    });

    const workflow = await getActiveWorkflowForThread({ db, threadId });
    const persistedWorkspace = await getGithubPrWorkspaceByCanonicalId({
      db,
      installationId: projections.installationProjection.installationId,
      repoId: projections.repoProjection.repoId,
      prNodeId: projections.prProjection.prNodeId,
    });
    const persistedBinding = await getGithubSurfaceBindingBySurface({
      db,
      surfaceKind: "pull_request",
      surfaceGitHubId: projections.prProjection.prNodeId,
    });
    const persistedRuns = await listGithubWorkspaceRunsForWorkspace({
      db,
      workspaceId: result.workspace.id,
    });

    expect(result.workspace.headSha).toBe("actual-head-sha");
    expect(result.binding.workspaceId).toBe(result.workspace.id);
    expect(result.binding.boundHeadSha).toBe("actual-head-sha");
    expect(result.run.workflowId).toBe(workflow?.id);
    expect(result.run.status).toBe("running");
    expect(result.run.threadId).toBe(threadId);
    expect(persistedWorkspace?.id).toBe(result.workspace.id);
    expect(persistedBinding?.id).toBe(result.binding.id);
    expect(persistedRuns).toHaveLength(1);
  });

  it("reuses the workspace for the same PR and allocates a new authoring attempt per thread at one head sha", async () => {
    const projections = await createProjectionChain({
      prNumber: 82,
      headSha: "live-sha-82",
    });
    const { user: firstUser } = await createTestUser({ db });
    const { user: secondUser } = await createTestUser({ db });
    const firstThread = await createTestThread({
      db,
      userId: firstUser.id,
      overrides: {
        githubRepoFullName: projections.repoProjection.currentSlug,
      },
    });
    const secondThread = await createTestThread({
      db,
      userId: secondUser.id,
      overrides: {
        githubRepoFullName: projections.repoProjection.currentSlug,
      },
    });
    const bootstrapClient = createGitHubWorkspaceBootstrapClient({
      db,
      refreshPrProjection: vi.fn().mockResolvedValue(projections),
    });

    const firstResult = await bootstrapClient.bootstrapThreadGithubWorkspace({
      repoFullName: projections.repoProjection.currentSlug,
      prNumber: projections.prProjection.number,
      threadId: firstThread.threadId,
      pullRequestIdentity: {
        prNodeId: projections.prProjection.prNodeId,
        headSha: projections.prProjection.headSha ?? "live-sha-82",
      },
    });
    const secondResult = await bootstrapClient.bootstrapThreadGithubWorkspace({
      repoFullName: projections.repoProjection.currentSlug,
      prNumber: projections.prProjection.number,
      threadId: secondThread.threadId,
      pullRequestIdentity: {
        prNodeId: projections.prProjection.prNodeId,
        headSha: projections.prProjection.headSha ?? "live-sha-82",
      },
    });

    const persistedRuns = await listGithubWorkspaceRunsForWorkspace({
      db,
      workspaceId: firstResult.workspace.id,
    });

    expect(secondResult.workspace.id).toBe(firstResult.workspace.id);
    expect(firstResult.run.attempt).toBe(1);
    expect(secondResult.run.attempt).toBe(2);
    expect(persistedRuns).toHaveLength(2);
    expect(persistedRuns.map((run) => run.threadId)).toEqual(
      expect.arrayContaining([firstThread.threadId, secondThread.threadId]),
    );
  });

  it("rejects a caller-supplied PR node id that disagrees with the refreshed projection", async () => {
    const projections = await createProjectionChain({
      prNumber: 83,
      headSha: "live-sha-83",
    });
    const { user } = await createTestUser({ db });
    const { threadId } = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        githubRepoFullName: projections.repoProjection.currentSlug,
      },
    });
    const bootstrapClient = createGitHubWorkspaceBootstrapClient({
      db,
      refreshPrProjection: vi.fn().mockResolvedValue(projections),
    });

    await expect(
      bootstrapClient.bootstrapThreadGithubWorkspace({
        repoFullName: projections.repoProjection.currentSlug,
        prNumber: projections.prProjection.number,
        threadId,
        pullRequestIdentity: {
          prNodeId: "PR_wrong_83",
          headSha: projections.prProjection.headSha ?? "live-sha-83",
        },
      }),
    ).rejects.toThrow("identity mismatch");
  });
});
