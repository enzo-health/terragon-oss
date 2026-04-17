import { and, eq } from "drizzle-orm";
import type { DB } from "../db";
import * as schema from "../db/schema";
import type {
  GithubInstallationProjection,
  GithubInstallationProjectionInsert,
  GithubPrProjection,
  GithubPrProjectionInsert,
  GithubRepoProjection,
  GithubRepoProjectionInsert,
} from "../db/types";

type GithubInstallationProjectionUpsertFields = Omit<
  GithubInstallationProjectionInsert,
  "id" | "installationId" | "createdAt" | "updatedAt"
>;

type GithubRepoProjectionUpsertFields = Omit<
  GithubRepoProjectionInsert,
  "id" | "repoId" | "createdAt" | "updatedAt"
>;

type GithubPrProjectionUpsertFields = Omit<
  GithubPrProjectionInsert,
  "id" | "prNodeId" | "createdAt" | "updatedAt"
>;

export async function getGithubInstallationProjectionByInstallationId({
  db,
  installationId,
}: {
  db: DB;
  installationId: number;
}): Promise<GithubInstallationProjection | null> {
  const projection = await db.query.githubInstallationProjection.findFirst({
    where: eq(schema.githubInstallationProjection.installationId, installationId),
  });

  return projection ?? null;
}

export async function upsertGithubInstallationProjection({
  db,
  installationId,
  fields,
}: {
  db: DB;
  installationId: number;
  fields: GithubInstallationProjectionUpsertFields;
}): Promise<GithubInstallationProjection> {
  const [projection] = await db
    .insert(schema.githubInstallationProjection)
    .values({
      installationId,
      ...fields,
    })
    .onConflictDoUpdate({
      target: schema.githubInstallationProjection.installationId,
      set: {
        ...fields,
        updatedAt: new Date(),
      },
    })
    .returning();

  return projection;
}

export async function getGithubRepoProjectionByRepoId({
  db,
  repoId,
}: {
  db: DB;
  repoId: number;
}): Promise<GithubRepoProjection | null> {
  const projection = await db.query.githubRepoProjection.findFirst({
    where: eq(schema.githubRepoProjection.repoId, repoId),
  });

  return projection ?? null;
}

export async function upsertGithubRepoProjection({
  db,
  repoId,
  fields,
}: {
  db: DB;
  repoId: number;
  fields: GithubRepoProjectionUpsertFields;
}): Promise<GithubRepoProjection> {
  const [projection] = await db
    .insert(schema.githubRepoProjection)
    .values({
      repoId,
      ...fields,
    })
    .onConflictDoUpdate({
      target: schema.githubRepoProjection.repoId,
      set: {
        ...fields,
        updatedAt: new Date(),
      },
    })
    .returning();

  return projection;
}

export async function getGithubPrProjectionByPrNodeId({
  db,
  prNodeId,
}: {
  db: DB;
  prNodeId: string;
}): Promise<GithubPrProjection | null> {
  const projection = await db.query.githubPrProjection.findFirst({
    where: eq(schema.githubPrProjection.prNodeId, prNodeId),
  });

  return projection ?? null;
}

export async function getGithubPrProjectionByRepoProjectionIdAndNumber({
  db,
  repoProjectionId,
  number,
}: {
  db: DB;
  repoProjectionId: string;
  number: number;
}): Promise<GithubPrProjection | null> {
  const projection = await db.query.githubPrProjection.findFirst({
    where: and(
      eq(schema.githubPrProjection.repoProjectionId, repoProjectionId),
      eq(schema.githubPrProjection.number, number),
    ),
  });

  return projection ?? null;
}

export async function upsertGithubPrProjection({
  db,
  prNodeId,
  fields,
}: {
  db: DB;
  prNodeId: string;
  fields: GithubPrProjectionUpsertFields;
}): Promise<GithubPrProjection> {
  const [projection] = await db
    .insert(schema.githubPrProjection)
    .values({
      prNodeId,
      ...fields,
    })
    .onConflictDoUpdate({
      target: schema.githubPrProjection.prNodeId,
      set: {
        ...fields,
        updatedAt: new Date(),
      },
    })
    .returning();

  return projection;
}
