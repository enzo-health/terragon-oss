import { and, asc, eq } from "drizzle-orm";
import type { DB } from "../db";
import * as schema from "../db/schema";
import type {
  GithubPrProjection,
  GithubPrWorkspace,
  GithubPrWorkspaceInsert,
  GithubRepoProjection,
  GithubWorkspaceRun,
  GithubWorkspaceRunInsert,
} from "../db/types";
import {
  getGithubInstallationProjectionByInstallationId,
  getGithubPrProjectionByPrNodeId,
  getGithubRepoProjectionByRepoId,
} from "./github-projections";

type GithubPrWorkspaceUpsertFields = Partial<
  Pick<GithubPrWorkspaceInsert, "status" | "headSha">
>;

type GithubWorkspaceRunUpsertFields = Partial<
  Pick<GithubWorkspaceRunInsert, "status" | "workflowId">
>;

async function requireGithubPrWorkspaceById({
  db,
  workspaceId,
}: {
  db: DB;
  workspaceId: string;
}): Promise<GithubPrWorkspace> {
  const workspace = await getGithubPrWorkspaceById({ db, workspaceId });

  if (!workspace) {
    throw new Error(`GitHub PR workspace not found for ${workspaceId}`);
  }

  return workspace;
}

async function resolveGithubPrWorkspaceParents({
  db,
  installationId,
  repoId,
  prNodeId,
}: {
  db: DB;
  installationId: number;
  repoId: number;
  prNodeId: string;
}): Promise<{
  repoProjection: GithubRepoProjection;
  prProjection: GithubPrProjection;
  installationProjectionId: string;
}> {
  const [installationProjection, repoProjection, prProjection] =
    await Promise.all([
      getGithubInstallationProjectionByInstallationId({ db, installationId }),
      getGithubRepoProjectionByRepoId({ db, repoId }),
      getGithubPrProjectionByPrNodeId({ db, prNodeId }),
    ]);

  if (!installationProjection) {
    throw new Error(
      `GitHub installation projection not found for installation ${installationId}`,
    );
  }

  if (!repoProjection) {
    throw new Error(`GitHub repo projection not found for repo ${repoId}`);
  }

  if (repoProjection.installationId !== installationId) {
    throw new Error(
      `GitHub repo projection identity mismatch for repo ${repoId}: expected installation ${installationId}, found ${repoProjection.installationId}`,
    );
  }

  if (!prProjection) {
    throw new Error(`GitHub PR projection not found for ${prNodeId}`);
  }

  if (prProjection.repoId !== repoId) {
    throw new Error(
      `GitHub PR projection identity mismatch for ${prNodeId}: expected repo ${repoId}, found ${prProjection.repoId}`,
    );
  }

  return {
    installationProjectionId: installationProjection.id,
    repoProjection,
    prProjection,
  };
}

export async function getGithubPrWorkspaceById({
  db,
  workspaceId,
}: {
  db: DB;
  workspaceId: string;
}): Promise<GithubPrWorkspace | null> {
  const workspace = await db.query.githubPrWorkspace.findFirst({
    where: eq(schema.githubPrWorkspace.id, workspaceId),
  });

  return workspace ?? null;
}

export async function getGithubPrWorkspaceByCanonicalId({
  db,
  installationId,
  repoId,
  prNodeId,
}: {
  db: DB;
  installationId: number;
  repoId: number;
  prNodeId: string;
}): Promise<GithubPrWorkspace | null> {
  const workspace = await db.query.githubPrWorkspace.findFirst({
    where: and(
      eq(schema.githubPrWorkspace.installationId, installationId),
      eq(schema.githubPrWorkspace.repoId, repoId),
      eq(schema.githubPrWorkspace.prNodeId, prNodeId),
    ),
  });

  return workspace ?? null;
}

export async function upsertGithubPrWorkspace({
  db,
  installationId,
  repoId,
  prNodeId,
  fields,
}: {
  db: DB;
  installationId: number;
  repoId: number;
  prNodeId: string;
  fields?: GithubPrWorkspaceUpsertFields;
}): Promise<GithubPrWorkspace> {
  const { installationProjectionId, repoProjection, prProjection } =
    await resolveGithubPrWorkspaceParents({
      db,
      installationId,
      repoId,
      prNodeId,
    });

  const status = fields?.status ?? prProjection.status;
  const headSha =
    fields?.headSha !== undefined ? fields.headSha : prProjection.headSha;

  const [workspace] = await db
    .insert(schema.githubPrWorkspace)
    .values({
      installationProjectionId,
      installationId,
      repoProjectionId: repoProjection.id,
      repoId,
      prProjectionId: prProjection.id,
      prNodeId,
      prNumber: prProjection.number,
      status,
      headSha,
    })
    .onConflictDoUpdate({
      target: [
        schema.githubPrWorkspace.installationId,
        schema.githubPrWorkspace.repoId,
        schema.githubPrWorkspace.prNodeId,
      ],
      set: {
        installationProjectionId,
        repoProjectionId: repoProjection.id,
        prProjectionId: prProjection.id,
        prNumber: prProjection.number,
        status,
        headSha,
        updatedAt: new Date(),
      },
    })
    .returning();

  if (!workspace) {
    throw new Error(
      `GitHub PR workspace upsert returned no rows for installation ${installationId}, repo ${repoId}, PR ${prNodeId}`,
    );
  }

  return workspace;
}

export async function getGithubWorkspaceRun({
  db,
  workspaceId,
  lane,
  headSha,
  attempt,
}: {
  db: DB;
  workspaceId: string;
  lane: GithubWorkspaceRun["lane"];
  headSha: string;
  attempt: number;
}): Promise<GithubWorkspaceRun | null> {
  const run = await db.query.githubWorkspaceRun.findFirst({
    where: and(
      eq(schema.githubWorkspaceRun.workspaceId, workspaceId),
      eq(schema.githubWorkspaceRun.lane, lane),
      eq(schema.githubWorkspaceRun.headSha, headSha),
      eq(schema.githubWorkspaceRun.attempt, attempt),
    ),
  });

  return run ?? null;
}

export async function listGithubWorkspaceRunsForWorkspace({
  db,
  workspaceId,
}: {
  db: DB;
  workspaceId: string;
}): Promise<GithubWorkspaceRun[]> {
  return await db.query.githubWorkspaceRun.findMany({
    where: eq(schema.githubWorkspaceRun.workspaceId, workspaceId),
    orderBy: [
      asc(schema.githubWorkspaceRun.lane),
      asc(schema.githubWorkspaceRun.headSha),
      asc(schema.githubWorkspaceRun.attempt),
    ],
  });
}

export async function upsertGithubWorkspaceRun({
  db,
  workspaceId,
  lane,
  headSha,
  attempt,
  threadId,
  fields,
}: {
  db: DB;
  workspaceId: string;
  lane: GithubWorkspaceRun["lane"];
  headSha: string;
  attempt: number;
  threadId: string;
  fields?: GithubWorkspaceRunUpsertFields;
}): Promise<GithubWorkspaceRun> {
  await requireGithubPrWorkspaceById({ db, workspaceId });

  const [run] = await db
    .insert(schema.githubWorkspaceRun)
    .values({
      workspaceId,
      lane,
      headSha,
      attempt,
      threadId,
      ...(fields?.status !== undefined ? { status: fields.status } : {}),
      ...(fields?.workflowId !== undefined
        ? { workflowId: fields.workflowId }
        : {}),
    })
    .onConflictDoUpdate({
      target: [
        schema.githubWorkspaceRun.workspaceId,
        schema.githubWorkspaceRun.lane,
        schema.githubWorkspaceRun.headSha,
        schema.githubWorkspaceRun.attempt,
      ],
      set: {
        threadId,
        ...(fields?.status !== undefined ? { status: fields.status } : {}),
        ...(fields?.workflowId !== undefined
          ? { workflowId: fields.workflowId }
          : {}),
        updatedAt: new Date(),
      },
    })
    .returning();

  if (!run) {
    throw new Error(
      `GitHub workspace run upsert returned no rows for workspace ${workspaceId}, lane ${lane}, head ${headSha}, attempt ${attempt}`,
    );
  }

  return run;
}
