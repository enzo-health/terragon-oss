import { describe, expect, it } from "vitest";
import { env } from "@terragon/env/pkg-shared";
import { eq } from "drizzle-orm";
import { createDb } from "../db";
import * as schema from "../db/schema";
import {
  createGithubSurfaceBinding,
  getGithubSurfaceBindingBySurface,
  resolveGithubSurfaceBinding,
  upsertGithubSurfaceBinding,
} from "./github-surface-bindings";
import {
  upsertGithubInstallationProjection,
  upsertGithubPrProjection,
  upsertGithubRepoProjection,
} from "./github-projections";
import { upsertGithubPrWorkspace } from "./github-workspaces";

const db = createDb(env.DATABASE_URL!);

let nextGithubIdValue = 3_000_000_000;

function nextGithubId(): number {
  nextGithubIdValue += 1;
  return nextGithubIdValue;
}

async function createWorkspace(params?: {
  prNumber?: number;
  headSha?: string;
}) {
  const installationId = nextGithubId();
  const repoId = nextGithubId();
  const prNodeId = `PR_${repoId}`;
  const prNumber = params?.prNumber ?? 17;
  const headSha = params?.headSha ?? `sha-${repoId}`;

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
      number: prNumber,
      status: "open",
      baseRef: "main",
      headRef: `feature/${repoId}`,
      headSha,
    },
  });

  const workspace = await upsertGithubPrWorkspace({
    db,
    installationId,
    repoId,
    prNodeId,
  });

  return {
    installationId,
    repoId,
    prNodeId,
    workspace,
  };
}

describe("github surface binding helpers", () => {
  it("creates and resolves a bound surface to one workspace deterministically", async () => {
    const { workspace } = await createWorkspace();

    const binding = await createGithubSurfaceBinding({
      db,
      workspaceId: workspace.id,
      surfaceKind: "review_thread",
      surfaceGitHubId: "RT_123",
      fields: {
        lane: "review_response",
        routingReason: "existing-thread",
        boundHeadSha: workspace.headSha!,
      },
    });

    const lookedUpBinding = await getGithubSurfaceBindingBySurface({
      db,
      surfaceKind: "review_thread",
      surfaceGitHubId: "RT_123",
    });
    const resolution = await resolveGithubSurfaceBinding({
      db,
      surfaceKind: "review_thread",
      surfaceGitHubId: "RT_123",
    });

    expect(lookedUpBinding?.id).toBe(binding.id);
    expect(resolution?.binding.id).toBe(binding.id);
    expect(resolution?.workspace.id).toBe(workspace.id);
    expect(resolution?.headSha).toBe(workspace.headSha);
    expect(resolution?.binding.lane).toBe("review_response");
    expect(resolution?.binding.routingReason).toBe("existing-thread");
    expect(resolution?.binding.boundHeadSha).toBe(workspace.headSha);
  });

  it("upserts one stable surface binding row while refreshing lane, reason, and head sha", async () => {
    const { workspace } = await createWorkspace();

    const initialBinding = await upsertGithubSurfaceBinding({
      db,
      workspaceId: workspace.id,
      surfaceKind: "check_run",
      surfaceGitHubId: "CR_456",
      fields: {
        lane: "ci_repair",
        routingReason: "github-pr-thread-id",
        boundHeadSha: workspace.headSha!,
      },
    });

    const updatedBinding = await upsertGithubSurfaceBinding({
      db,
      workspaceId: workspace.id,
      surfaceKind: "check_run",
      surfaceGitHubId: "CR_456",
      fields: {
        lane: "automation",
        routingReason: "existing-unarchived-thread",
        boundHeadSha: workspace.headSha!,
      },
    });

    const persistedBindings = await db.query.githubSurfaceBinding.findMany({
      where: eq(schema.githubSurfaceBinding.workspaceId, workspace.id),
    });

    expect(updatedBinding.id).toBe(initialBinding.id);
    expect(updatedBinding.lane).toBe("automation");
    expect(updatedBinding.routingReason).toBe("existing-unarchived-thread");
    expect(updatedBinding.boundHeadSha).toBe(workspace.headSha);
    expect(persistedBindings).toHaveLength(1);
  });

  it("rejects rebinding a GitHub surface to a different workspace", async () => {
    const firstWorkspace = await createWorkspace({
      prNumber: 18,
      headSha: "sha-one",
    });
    const secondWorkspace = await createWorkspace({
      prNumber: 19,
      headSha: "sha-two",
    });

    const initialBinding = await upsertGithubSurfaceBinding({
      db,
      workspaceId: firstWorkspace.workspace.id,
      surfaceKind: "review_comment",
      surfaceGitHubId: "RC_789",
      fields: {
        lane: "review_response",
        routingReason: "existing-thread",
        boundHeadSha: firstWorkspace.workspace.headSha!,
      },
    });

    await expect(
      upsertGithubSurfaceBinding({
        db,
        workspaceId: secondWorkspace.workspace.id,
        surfaceKind: "review_comment",
        surfaceGitHubId: "RC_789",
        fields: {
          lane: "review_response",
          routingReason: "existing-thread",
          boundHeadSha: "sha-two",
        },
      }),
    ).rejects.toThrow("identity mismatch");

    const resolution = await resolveGithubSurfaceBinding({
      db,
      surfaceKind: "review_comment",
      surfaceGitHubId: "RC_789",
    });

    expect(resolution?.binding.id).toBe(initialBinding.id);
    expect(resolution?.workspace.id).toBe(firstWorkspace.workspace.id);
    expect(resolution?.binding.boundHeadSha).toBe(
      firstWorkspace.workspace.headSha,
    );
  });

  it("persists PR-backed issue comment mention metadata", async () => {
    const { workspace } = await createWorkspace({
      prNumber: 20,
      headSha: "sha-three",
    });

    const binding = await upsertGithubSurfaceBinding({
      db,
      workspaceId: workspace.id,
      surfaceKind: "issue_comment_mention",
      surfaceGitHubId: "98765",
      fields: {
        lane: "mention_follow_up",
        routingReason: "input-user-id",
        boundHeadSha: workspace.headSha!,
        surfaceMetadata: {
          issueOrPrType: "issue",
        },
      },
    });

    expect(binding.surfaceMetadata).toEqual({
      issueOrPrType: "issue",
    });
  });

  it("rejects a surface binding when the workspace head sha disagrees", async () => {
    const { workspace } = await createWorkspace({
      prNumber: 21,
      headSha: "sha-four",
    });

    await expect(
      createGithubSurfaceBinding({
        db,
        workspaceId: workspace.id,
        surfaceKind: "review_thread",
        surfaceGitHubId: "RT_999",
        fields: {
          lane: "review_response",
          routingReason: "existing-thread",
          boundHeadSha: "mismatched-sha",
        },
      }),
    ).rejects.toThrow("head SHA mismatch");
  });
});
