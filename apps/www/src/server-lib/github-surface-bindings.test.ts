import { env } from "@terragon/env/apps-www";
import { createDb } from "@terragon/shared/db";
import {
  getGithubSurfaceBindingBySurface,
  resolveGithubSurfaceBinding,
} from "@terragon/shared/model/github-surface-bindings";
import {
  upsertGithubInstallationProjection,
  upsertGithubPrProjection,
  upsertGithubRepoProjection,
} from "@terragon/shared/model/github-projections";
import { getGithubPrWorkspaceByCanonicalId } from "@terragon/shared/model/github-workspaces";
import { describe, expect, it } from "vitest";
import { createGitHubSurfaceBindingCoordinator } from "./github-surface-bindings";

const db = createDb(env.DATABASE_URL);

let nextGithubIdValue = 4_000_000_000;

function nextGithubId(): number {
  nextGithubIdValue += 1;
  return nextGithubIdValue;
}

async function createProjectionChain(params?: { projectionHeadSha?: string }) {
  const installationId = nextGithubId();
  const repoId = nextGithubId();
  const prNodeId = `PR_${repoId}`;
  const projectionHeadSha = params?.projectionHeadSha ?? "projection-sha";

  await upsertGithubInstallationProjection({
    db,
    installationId,
    fields: {
      targetAccountLogin: `terragon-${installationId}`,
      targetAccountType: "Organization",
    },
  });

  await upsertGithubRepoProjection({
    db,
    installationId,
    repoId,
    fields: {
      currentSlug: `terragon/test-repo-${repoId}`,
    },
  });

  await upsertGithubPrProjection({
    db,
    prNodeId,
    repoId,
    fields: {
      number: 42,
      status: "open",
      baseRef: "main",
      headRef: "feature/head-sha-refresh",
      headSha: projectionHeadSha,
    },
  });

  return {
    installationId,
    repoId,
    prNodeId,
  };
}

describe("github surface binding coordinator", () => {
  it("does not let a non-canonical surface overwrite the workspace head sha", async () => {
    const { installationId, repoId, prNodeId } = await createProjectionChain({
      projectionHeadSha: "projection-sha",
    });
    const coordinator = createGitHubSurfaceBindingCoordinator({ db });

    const result = await coordinator.upsertBindingForWorkspace({
      installationId,
      repoId,
      prNodeId,
      surfaceKind: "check_run",
      surfaceGitHubId: "12345",
      lane: "ci_repair",
      routingReason: "github-pr-thread-id",
      boundHeadSha: "projection-sha",
    });

    expect(result.workspace.headSha).toBe("projection-sha");
    expect(result.binding.boundHeadSha).toBe("projection-sha");

    const persistedWorkspace = await getGithubPrWorkspaceByCanonicalId({
      db,
      installationId,
      repoId,
      prNodeId,
    });
    const persistedBinding = await getGithubSurfaceBindingBySurface({
      db,
      surfaceKind: "check_run",
      surfaceGitHubId: "12345",
    });
    const resolution = await resolveGithubSurfaceBinding({
      db,
      surfaceKind: "check_run",
      surfaceGitHubId: "12345",
    });

    expect(persistedWorkspace?.headSha).toBe("projection-sha");
    expect(persistedBinding?.boundHeadSha).toBe("projection-sha");
    expect(resolution?.headSha).toBe("projection-sha");
  });
});
