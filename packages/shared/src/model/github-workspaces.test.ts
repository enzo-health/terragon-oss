import { describe, expect, it } from "vitest";
import { env } from "@terragon/env/pkg-shared";
import { eq } from "drizzle-orm";
import { createDb } from "../db";
import * as schema from "../db/schema";
import {
  getGithubPrWorkspaceByCanonicalId,
  getGithubPrWorkspaceById,
  getGithubWorkspaceRun,
  listGithubWorkspaceRunsForWorkspace,
  upsertGithubPrWorkspace,
  upsertGithubWorkspaceRun,
} from "./github-workspaces";
import {
  upsertGithubInstallationProjection,
  upsertGithubPrProjection,
  upsertGithubRepoProjection,
} from "./github-projections";
import { createTestThread, createTestUser } from "./test-helpers";

const db = createDb(env.DATABASE_URL!);

let nextGithubIdValue = 2_000_000_000;

function nextGithubId(): number {
  nextGithubIdValue += 1;
  return nextGithubIdValue;
}

async function createProjectionChain() {
  const installationId = nextGithubId();
  const repoId = nextGithubId();
  const prNodeId = `PR_${repoId}`;

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
      number: 17,
      status: "open",
      baseRef: "main",
      headRef: "feature/shadow-write",
      headSha: "abc123",
    },
  });

  return {
    installationId,
    repoId,
    prNodeId,
    installationProjection,
    repoProjection,
    prProjection,
  };
}

describe("github workspace helpers", () => {
  it("upserts a canonical workspace from projection rows", async () => {
    const {
      installationId,
      repoId,
      prNodeId,
      installationProjection,
      repoProjection,
      prProjection,
    } = await createProjectionChain();

    const workspace = await upsertGithubPrWorkspace({
      db,
      installationId,
      repoId,
      prNodeId,
    });

    expect(workspace.installationProjectionId).toBe(installationProjection.id);
    expect(workspace.repoProjectionId).toBe(repoProjection.id);
    expect(workspace.prProjectionId).toBe(prProjection.id);
    expect(workspace.prNumber).toBe(17);
    expect(workspace.status).toBe("open");
    expect(workspace.headSha).toBe("abc123");

    const updatedWorkspace = await upsertGithubPrWorkspace({
      db,
      installationId,
      repoId,
      prNodeId,
      fields: {
        status: "closed",
        headSha: "def456",
      },
    });

    expect(updatedWorkspace.id).toBe(workspace.id);
    expect(updatedWorkspace.status).toBe("closed");
    expect(updatedWorkspace.headSha).toBe("def456");

    const lookedUpByCanonicalId = await getGithubPrWorkspaceByCanonicalId({
      db,
      installationId,
      repoId,
      prNodeId,
    });
    const lookedUpById = await getGithubPrWorkspaceById({
      db,
      workspaceId: workspace.id,
    });

    expect(lookedUpByCanonicalId?.id).toBe(workspace.id);
    expect(lookedUpById?.id).toBe(workspace.id);
  });

  it("rejects mismatched workspace parent identity", async () => {
    const { installationId, prNodeId } = await createProjectionChain();
    const otherRepoId = nextGithubId();

    await expect(
      upsertGithubPrWorkspace({
        db,
        installationId,
        repoId: otherRepoId,
        prNodeId,
      }),
    ).rejects.toThrow("GitHub repo projection not found");
  });

  it("keeps one canonical workspace row when the repo projection rebinds to a new installation", async () => {
    const {
      installationId,
      repoId,
      prNodeId,
      prProjection,
      repoProjection,
      installationProjection,
    } = await createProjectionChain();

    const workspace = await upsertGithubPrWorkspace({
      db,
      installationId,
      repoId,
      prNodeId,
    });

    const reboundInstallationId = nextGithubId();
    const reboundInstallationProjection =
      await upsertGithubInstallationProjection({
        db,
        installationId: reboundInstallationId,
        fields: {
          targetAccountLogin: `terragon-${reboundInstallationId}`,
          targetAccountType: "Organization",
        },
      });

    const reboundRepoProjection = await upsertGithubRepoProjection({
      db,
      installationId: reboundInstallationId,
      repoId,
      fields: {
        currentSlug: repoProjection.currentSlug,
      },
    });

    const reboundWorkspace = await upsertGithubPrWorkspace({
      db,
      installationId: reboundInstallationId,
      repoId,
      prNodeId,
      fields: {
        status: "closed",
        headSha: "rebased789",
      },
    });

    expect(reboundWorkspace.id).toBe(workspace.id);
    expect(reboundWorkspace.prProjectionId).toBe(prProjection.id);
    expect(reboundWorkspace.installationId).toBe(reboundInstallationId);
    expect(reboundWorkspace.installationProjectionId).toBe(
      reboundInstallationProjection.id,
    );
    expect(reboundWorkspace.repoProjectionId).toBe(reboundRepoProjection.id);
    expect(reboundWorkspace.status).toBe("closed");
    expect(reboundWorkspace.headSha).toBe("rebased789");

    const workspaceRows = await db.query.githubPrWorkspace.findMany({
      where: eq(schema.githubPrWorkspace.prProjectionId, prProjection.id),
    });

    expect(workspaceRows).toHaveLength(1);

    const staleCanonicalLookup = await getGithubPrWorkspaceByCanonicalId({
      db,
      installationId,
      repoId,
      prNodeId,
    });
    const reboundCanonicalLookup = await getGithubPrWorkspaceByCanonicalId({
      db,
      installationId: reboundInstallationId,
      repoId,
      prNodeId,
    });

    expect(staleCanonicalLookup).toBeNull();
    expect(reboundCanonicalLookup?.id).toBe(workspace.id);

    expect(installationProjection.id).not.toBe(
      reboundInstallationProjection.id,
    );
  });

  it("upserts workspace runs with durable thread and workflow ownership", async () => {
    const { installationId, repoId, prNodeId } = await createProjectionChain();
    const workspace = await upsertGithubPrWorkspace({
      db,
      installationId,
      repoId,
      prNodeId,
    });

    const { user } = await createTestUser({ db });
    const { threadId } = await createTestThread({
      db,
      userId: user.id,
    });

    const [workflow] = await db
      .insert(schema.deliveryWorkflow)
      .values({
        threadId,
        generation: 1,
        kind: "github_shadow_write",
        stateJson: {},
        userId: user.id,
      })
      .returning();

    const run = await upsertGithubWorkspaceRun({
      db,
      workspaceId: workspace.id,
      lane: "authoring",
      headSha: "abc123",
      attempt: 1,
      threadId,
      fields: {
        workflowId: workflow?.id,
      },
    });

    expect(run.status).toBe("pending");
    expect(run.threadId).toBe(threadId);
    expect(run.workflowId).toBe(workflow?.id ?? null);

    const updatedRun = await upsertGithubWorkspaceRun({
      db,
      workspaceId: workspace.id,
      lane: "authoring",
      headSha: "abc123",
      attempt: 1,
      threadId,
      fields: {
        status: "running",
        workflowId: workflow?.id,
      },
    });

    expect(updatedRun.id).toBe(run.id);
    expect(updatedRun.status).toBe("running");

    const lookedUpRun = await getGithubWorkspaceRun({
      db,
      workspaceId: workspace.id,
      lane: "authoring",
      headSha: "abc123",
      attempt: 1,
    });
    const workspaceRuns = await listGithubWorkspaceRunsForWorkspace({
      db,
      workspaceId: workspace.id,
    });

    expect(lookedUpRun?.id).toBe(run.id);
    expect(workspaceRuns.map((workspaceRun) => workspaceRun.id)).toContain(
      run.id,
    );
  });

  it("rejects rebinding an existing run key to a different thread", async () => {
    const { installationId, repoId, prNodeId } = await createProjectionChain();
    const workspace = await upsertGithubPrWorkspace({
      db,
      installationId,
      repoId,
      prNodeId,
    });

    const { user } = await createTestUser({ db });
    const firstThread = await createTestThread({
      db,
      userId: user.id,
    });
    const secondThread = await createTestThread({
      db,
      userId: user.id,
    });

    const initialRun = await upsertGithubWorkspaceRun({
      db,
      workspaceId: workspace.id,
      lane: "review_response",
      headSha: "abc123",
      attempt: 2,
      threadId: firstThread.threadId,
      fields: {
        status: "running",
      },
    });

    await expect(
      upsertGithubWorkspaceRun({
        db,
        workspaceId: workspace.id,
        lane: "review_response",
        headSha: "abc123",
        attempt: 2,
        threadId: secondThread.threadId,
        fields: {
          status: "failed",
        },
      }),
    ).rejects.toThrow("identity mismatch");

    const persistedRun = await getGithubWorkspaceRun({
      db,
      workspaceId: workspace.id,
      lane: "review_response",
      headSha: "abc123",
      attempt: 2,
    });

    expect(persistedRun?.id).toBe(initialRun.id);
    expect(persistedRun?.threadId).toBe(firstThread.threadId);
    expect(persistedRun?.status).toBe("running");
  });

  it("enforces workspace and run uniqueness plus workflow-thread consistency", async () => {
    const {
      installationId,
      repoId,
      prNodeId,
      installationProjection,
      repoProjection,
      prProjection,
    } = await createProjectionChain();
    const workspace = await upsertGithubPrWorkspace({
      db,
      installationId,
      repoId,
      prNodeId,
    });

    await expect(
      db.insert(schema.githubPrWorkspace).values({
        installationProjectionId: installationProjection.id,
        installationId,
        repoProjectionId: repoProjection.id,
        repoId,
        prProjectionId: prProjection.id,
        prNodeId,
        prNumber: prProjection.number,
        status: "open",
        headSha: "abc123",
      }),
    ).rejects.toThrow("duplicate key value violates unique constraint");

    const { user } = await createTestUser({ db });
    const firstThread = await createTestThread({
      db,
      userId: user.id,
    });
    const secondThread = await createTestThread({
      db,
      userId: user.id,
    });

    const [workflow] = await db
      .insert(schema.deliveryWorkflow)
      .values({
        threadId: firstThread.threadId,
        generation: 1,
        kind: "github_shadow_write",
        stateJson: {},
        userId: user.id,
      })
      .returning();

    await upsertGithubWorkspaceRun({
      db,
      workspaceId: workspace.id,
      lane: "authoring",
      headSha: "abc123",
      attempt: 1,
      threadId: firstThread.threadId,
      fields: {
        workflowId: workflow?.id,
      },
    });

    await expect(
      db.insert(schema.githubWorkspaceRun).values({
        workspaceId: workspace.id,
        lane: "authoring",
        headSha: "abc123",
        attempt: 1,
        threadId: firstThread.threadId,
      }),
    ).rejects.toThrow("duplicate key value violates unique constraint");

    await expect(
      db.insert(schema.githubWorkspaceRun).values({
        workspaceId: workspace.id,
        lane: "ci_repair",
        headSha: "abc123",
        attempt: 1,
        threadId: secondThread.threadId,
        workflowId: workflow?.id,
      }),
    ).rejects.toThrow("github_workspace_run_workflow_id_thread_id_fk");
  });
});
