import { and, eq } from "drizzle-orm";
import type { DB } from "../db";
import * as schema from "../db/schema";
import type {
  GithubPrWorkspace,
  GithubSurfaceBinding,
  GithubSurfaceBindingInsert,
} from "../db/types";
import { getGithubPrWorkspaceById } from "./github-workspaces";

type GithubSurfaceBindingLookupKey = Pick<
  GithubSurfaceBinding,
  "surfaceKind" | "surfaceGitHubId"
>;

type GithubSurfaceBindingMutableFields = Pick<
  GithubSurfaceBindingInsert,
  "lane" | "routingReason" | "boundHeadSha" | "surfaceMetadata"
>;

export type GithubSurfaceBindingResolution = {
  binding: GithubSurfaceBinding;
  workspace: GithubPrWorkspace;
};

async function requireGithubPrWorkspace({
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

export async function getGithubSurfaceBindingBySurface({
  db,
  surfaceKind,
  surfaceGitHubId,
}: {
  db: DB;
  surfaceKind: GithubSurfaceBinding["surfaceKind"];
  surfaceGitHubId: string;
}): Promise<GithubSurfaceBinding | null> {
  const binding = await db.query.githubSurfaceBinding.findFirst({
    where: and(
      eq(schema.githubSurfaceBinding.surfaceKind, surfaceKind),
      eq(schema.githubSurfaceBinding.surfaceGitHubId, surfaceGitHubId),
    ),
  });

  return binding ?? null;
}

export async function createGithubSurfaceBinding({
  db,
  workspaceId,
  surfaceKind,
  surfaceGitHubId,
  fields,
}: {
  db: DB;
  workspaceId: string;
  surfaceKind: GithubSurfaceBinding["surfaceKind"];
  surfaceGitHubId: string;
  fields: GithubSurfaceBindingMutableFields;
}): Promise<GithubSurfaceBinding> {
  await requireGithubPrWorkspace({ db, workspaceId });

  const [binding] = await db
    .insert(schema.githubSurfaceBinding)
    .values({
      workspaceId,
      surfaceKind,
      surfaceGitHubId,
      ...fields,
    })
    .returning();

  if (!binding) {
    throw new Error(
      `GitHub surface binding create returned no rows for ${surfaceKind}:${surfaceGitHubId}`,
    );
  }

  return binding;
}

export async function upsertGithubSurfaceBinding({
  db,
  workspaceId,
  surfaceKind,
  surfaceGitHubId,
  fields,
}: {
  db: DB;
  workspaceId: string;
  surfaceKind: GithubSurfaceBinding["surfaceKind"];
  surfaceGitHubId: string;
  fields: GithubSurfaceBindingMutableFields;
}): Promise<GithubSurfaceBinding> {
  await requireGithubPrWorkspace({ db, workspaceId });

  const existingBinding = await getGithubSurfaceBindingBySurface({
    db,
    surfaceKind,
    surfaceGitHubId,
  });

  if (existingBinding && existingBinding.workspaceId !== workspaceId) {
    throw new Error(
      `GitHub surface binding identity mismatch for ${surfaceKind}:${surfaceGitHubId}: existing workspace ${existingBinding.workspaceId}, received ${workspaceId}`,
    );
  }

  const [binding] = await db
    .insert(schema.githubSurfaceBinding)
    .values({
      workspaceId,
      surfaceKind,
      surfaceGitHubId,
      ...fields,
    })
    .onConflictDoUpdate({
      target: [
        schema.githubSurfaceBinding.surfaceKind,
        schema.githubSurfaceBinding.surfaceGitHubId,
      ],
      set: {
        lane: fields.lane,
        routingReason: fields.routingReason,
        boundHeadSha: fields.boundHeadSha,
        ...(fields.surfaceMetadata !== undefined
          ? { surfaceMetadata: fields.surfaceMetadata }
          : {}),
        updatedAt: new Date(),
      },
      setWhere: eq(schema.githubSurfaceBinding.workspaceId, workspaceId),
    })
    .returning();

  if (!binding) {
    const conflictedBinding = await getGithubSurfaceBindingBySurface({
      db,
      surfaceKind,
      surfaceGitHubId,
    });

    if (conflictedBinding && conflictedBinding.workspaceId !== workspaceId) {
      throw new Error(
        `GitHub surface binding identity mismatch for ${surfaceKind}:${surfaceGitHubId}: existing workspace ${conflictedBinding.workspaceId}, received ${workspaceId}`,
      );
    }

    throw new Error(
      `GitHub surface binding upsert returned no rows for ${surfaceKind}:${surfaceGitHubId}`,
    );
  }

  return binding;
}

export async function resolveGithubSurfaceBinding({
  db,
  surfaceKind,
  surfaceGitHubId,
}: {
  db: DB;
  surfaceKind: GithubSurfaceBinding["surfaceKind"];
  surfaceGitHubId: string;
}): Promise<GithubSurfaceBindingResolution | null> {
  const binding = await getGithubSurfaceBindingBySurface({
    db,
    surfaceKind,
    surfaceGitHubId,
  });

  if (!binding) {
    return null;
  }

  const workspace = await requireGithubPrWorkspace({
    db,
    workspaceId: binding.workspaceId,
  });

  return {
    binding,
    workspace,
  };
}

export function formatGithubSurfaceBindingId({
  surfaceKind,
  surfaceGitHubId,
}: GithubSurfaceBindingLookupKey): string {
  return `${surfaceKind}:${surfaceGitHubId}`;
}
