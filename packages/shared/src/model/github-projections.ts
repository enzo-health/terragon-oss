import { and, eq } from "drizzle-orm";
import type { DB } from "../db";
import * as schema from "../db/schema";
import type {
  GithubInstallationProjection,
  GithubInstallationProjectionInsert,
  GithubPrProjection,
  GithubPrProjectionInsert,
  GithubPRStatus,
  GithubRepoProjection,
  GithubRepoProjectionInsert,
} from "../db/types";

type GithubInstallationProjectionUpsertFields = Omit<
  GithubInstallationProjectionInsert,
  "id" | "installationId" | "createdAt" | "updatedAt"
>;

type GithubRepoProjectionUpsertFields = Omit<
  GithubRepoProjectionInsert,
  | "id"
  | "installationProjectionId"
  | "installationId"
  | "repoId"
  | "createdAt"
  | "updatedAt"
>;

type GithubPrProjectionUpsertFields = Pick<
  GithubPrProjectionInsert,
  "number" | "baseRef" | "headRef" | "headSha"
> & {
  status: GithubPRStatus;
};

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

async function requireGithubInstallationProjection({
  db,
  installationId,
}: {
  db: DB;
  installationId: number;
}): Promise<GithubInstallationProjection> {
  const projection = await getGithubInstallationProjectionByInstallationId({
    db,
    installationId,
  });

  if (!projection) {
    throw new Error(
      `GitHub installation projection not found for installation ${installationId}`,
    );
  }

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
  installationId,
  repoId,
  fields,
}: {
  db: DB;
  installationId: number;
  repoId: number;
  fields: GithubRepoProjectionUpsertFields;
}): Promise<GithubRepoProjection> {
  const installationProjection = await requireGithubInstallationProjection({
    db,
    installationId,
  });

  const [projection] = await db
    .insert(schema.githubRepoProjection)
    .values({
      installationId,
      installationProjectionId: installationProjection.id,
      repoId,
      ...fields,
    })
    .onConflictDoUpdate({
      target: schema.githubRepoProjection.repoId,
      set: {
        installationId,
        installationProjectionId: installationProjection.id,
        ...fields,
        updatedAt: new Date(),
      },
    })
    .returning();

  return projection;
}

async function requireGithubRepoProjection({
  db,
  repoId,
}: {
  db: DB;
  repoId: number;
}): Promise<GithubRepoProjection> {
  const projection = await getGithubRepoProjectionByRepoId({
    db,
    repoId,
  });

  if (!projection) {
    throw new Error(`GitHub repo projection not found for repo ${repoId}`);
  }

  return projection;
}

function getGithubPrIsDraft(status: GithubPRStatus): boolean {
  return status === "draft";
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

export async function getGithubPrProjectionByRepoIdAndNumber({
  db,
  repoId,
  number,
}: {
  db: DB;
  repoId: number;
  number: number;
}): Promise<GithubPrProjection | null> {
  const projection = await db.query.githubPrProjection.findFirst({
    where: and(
      eq(schema.githubPrProjection.repoId, repoId),
      eq(schema.githubPrProjection.number, number),
    ),
  });

  return projection ?? null;
}

export async function upsertGithubPrProjection({
  db,
  prNodeId,
  repoId,
  fields,
}: {
  db: DB;
  prNodeId: string;
  repoId: number;
  fields: GithubPrProjectionUpsertFields;
}): Promise<GithubPrProjection> {
  const repoProjection = await requireGithubRepoProjection({
    db,
    repoId,
  });
  const isDraft = getGithubPrIsDraft(fields.status);

  const [projection] = await db
    .insert(schema.githubPrProjection)
    .values({
      prNodeId,
      repoId,
      repoProjectionId: repoProjection.id,
      ...fields,
      isDraft,
    })
    .onConflictDoUpdate({
      target: schema.githubPrProjection.prNodeId,
      set: {
        repoId,
        repoProjectionId: repoProjection.id,
        ...fields,
        isDraft,
        updatedAt: new Date(),
      },
      setWhere: and(
        eq(schema.githubPrProjection.repoId, repoId),
        eq(schema.githubPrProjection.number, fields.number),
      ),
    })
    .returning();

  if (!projection) {
    const existingProjection = await getGithubPrProjectionByPrNodeId({
      db,
      prNodeId,
    });

    if (!existingProjection) {
      throw new Error(
        `GitHub PR projection upsert returned no rows for ${prNodeId}`,
      );
    }

    throw new Error(
      `GitHub PR projection identity mismatch for ${prNodeId}: existing ${existingProjection.repoId}#${existingProjection.number}, received ${repoId}#${fields.number}`,
    );
  }

  return projection;
}
