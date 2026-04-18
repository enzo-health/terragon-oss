import { and, eq } from "drizzle-orm";
import type { DB } from "../db";
import * as schema from "../db/schema";
import type {
  GithubPrWorkspace,
  GithubSurfaceBinding,
  GithubSurfaceBindingInsert,
  GithubSurfaceBindingKind,
  GithubSurfaceBindingMetadataForKind,
  GithubSurfaceBindingRecordForKind,
} from "../db/types";
import { getGithubPrWorkspaceById } from "./github-workspaces";

type GithubSurfaceBindingDb = Pick<DB, "query" | "insert">;

type GithubSurfaceBindingLookupKey<
  K extends GithubSurfaceBindingKind = GithubSurfaceBindingKind,
> = {
  surfaceKind: K;
  surfaceGitHubId: string;
};

type GithubSurfaceBindingMutableFieldsBase = Pick<
  GithubSurfaceBindingInsert,
  "lane" | "routingReason" | "boundHeadSha"
>;

type GithubSurfaceBindingMutableFieldsByKind = {
  [K in GithubSurfaceBindingKind]: GithubSurfaceBindingMutableFieldsBase &
    (GithubSurfaceBindingMetadataForKind<K> extends null
      ? {
          surfaceMetadata?: undefined;
        }
      : {
          surfaceMetadata: GithubSurfaceBindingMetadataForKind<K>;
        });
};

export type GithubSurfaceBindingMutableFields<
  K extends GithubSurfaceBindingKind = GithubSurfaceBindingKind,
> = GithubSurfaceBindingMutableFieldsByKind[K];

export type GithubSurfaceBindingResolution<
  K extends GithubSurfaceBindingKind = GithubSurfaceBindingKind,
> = {
  binding: GithubSurfaceBindingRecordForKind<K>;
  workspace: GithubPrWorkspace & {
    headSha: string;
  };
  headSha: string;
};

type GithubSurfaceBindingRecord = {
  [K in GithubSurfaceBindingKind]: GithubSurfaceBindingRecordForKind<K>;
}[GithubSurfaceBindingKind];
type GithubMetadataFreeSurfaceBindingKind = Exclude<
  GithubSurfaceBindingKind,
  "issue_comment_mention"
>;

async function requireGithubPrWorkspace({
  db,
  workspaceId,
}: {
  db: GithubSurfaceBindingDb;
  workspaceId: string;
}): Promise<GithubPrWorkspace> {
  const workspace = await getGithubPrWorkspaceById({ db, workspaceId });

  if (!workspace) {
    throw new Error(`GitHub PR workspace not found for ${workspaceId}`);
  }

  return workspace;
}

function requireWorkspaceHeadSha(
  workspace: GithubPrWorkspace,
  expectedHeadSha?: string,
): GithubPrWorkspace & { headSha: string } {
  if (!workspace.headSha) {
    throw new Error(
      `GitHub PR workspace ${workspace.id} is missing a head SHA`,
    );
  }

  if (expectedHeadSha !== undefined && workspace.headSha !== expectedHeadSha) {
    throw new Error(
      `GitHub PR workspace ${workspace.id} head SHA mismatch: expected ${expectedHeadSha}, found ${workspace.headSha}`,
    );
  }

  return {
    ...workspace,
    headSha: workspace.headSha,
  };
}

function normalizeGithubSurfaceBinding<K extends GithubSurfaceBindingKind>(
  binding: GithubSurfaceBinding,
  surfaceKind: K,
): GithubSurfaceBindingRecordForKind<K>;
function normalizeGithubSurfaceBinding(
  binding: GithubSurfaceBinding,
  surfaceKind: GithubSurfaceBindingKind,
): GithubSurfaceBindingRecord {
  if (surfaceKind === "issue_comment_mention") {
    return normalizeIssueCommentMentionBinding(binding);
  }

  return normalizeMetadataFreeSurfaceBinding(binding, surfaceKind);
}

function normalizeIssueCommentMentionBinding(
  binding: GithubSurfaceBinding,
): GithubSurfaceBindingRecordForKind<"issue_comment_mention"> {
  if (!binding.surfaceMetadata) {
    throw new Error(
      "GitHub surface binding issue_comment_mention requires issue comment metadata",
    );
  }

  return {
    ...binding,
    surfaceKind: "issue_comment_mention",
    surfaceMetadata: binding.surfaceMetadata,
  };
}

function normalizeMetadataFreeSurfaceBinding<
  K extends GithubMetadataFreeSurfaceBindingKind,
>(
  binding: GithubSurfaceBinding,
  surfaceKind: K,
): GithubSurfaceBindingRecordForKind<K> {
  if (
    binding.surfaceMetadata !== null &&
    binding.surfaceMetadata !== undefined
  ) {
    throw new Error(
      `GitHub surface binding ${surfaceKind} does not accept surface metadata`,
    );
  }

  return {
    ...binding,
    surfaceKind,
    surfaceMetadata: null,
  };
}

export async function getGithubSurfaceBindingBySurface<
  K extends GithubSurfaceBindingKind,
>({
  db,
  surfaceKind,
  surfaceGitHubId,
}: {
  db: GithubSurfaceBindingDb;
  surfaceKind: K;
  surfaceGitHubId: string;
}): Promise<GithubSurfaceBindingRecordForKind<K> | null> {
  const binding = await db.query.githubSurfaceBinding.findFirst({
    where: and(
      eq(schema.githubSurfaceBinding.surfaceKind, surfaceKind),
      eq(schema.githubSurfaceBinding.surfaceGitHubId, surfaceGitHubId),
    ),
  });

  return binding ? normalizeGithubSurfaceBinding(binding, surfaceKind) : null;
}

export async function createGithubSurfaceBinding<
  K extends GithubSurfaceBindingKind,
>({
  db,
  workspaceId,
  surfaceKind,
  surfaceGitHubId,
  fields,
}: GithubSurfaceBindingLookupKey & {
  db: GithubSurfaceBindingDb;
  workspaceId: string;
  surfaceKind: K;
  fields: GithubSurfaceBindingMutableFields<K>;
}): Promise<GithubSurfaceBindingRecordForKind<K>> {
  const workspace = await requireGithubPrWorkspace({ db, workspaceId });
  requireWorkspaceHeadSha(workspace, fields.boundHeadSha);

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

  return normalizeGithubSurfaceBinding(binding, surfaceKind);
}

export async function upsertGithubSurfaceBinding<
  K extends GithubSurfaceBindingKind,
>({
  db,
  workspaceId,
  surfaceKind,
  surfaceGitHubId,
  fields,
}: GithubSurfaceBindingLookupKey & {
  db: GithubSurfaceBindingDb;
  workspaceId: string;
  surfaceKind: K;
  fields: GithubSurfaceBindingMutableFields<K>;
}): Promise<GithubSurfaceBindingRecordForKind<K>> {
  const workspace = await requireGithubPrWorkspace({ db, workspaceId });
  requireWorkspaceHeadSha(workspace, fields.boundHeadSha);

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

  return normalizeGithubSurfaceBinding(binding, surfaceKind);
}

export async function resolveGithubSurfaceBinding<
  K extends GithubSurfaceBindingKind,
>({
  db,
  surfaceKind,
  surfaceGitHubId,
}: {
  db: GithubSurfaceBindingDb;
  surfaceKind: K;
  surfaceGitHubId: string;
}): Promise<GithubSurfaceBindingResolution<K> | null> {
  const binding = await getGithubSurfaceBindingBySurface({
    db,
    surfaceKind,
    surfaceGitHubId,
  });

  if (!binding) {
    return null;
  }

  const workspace = requireWorkspaceHeadSha(
    await requireGithubPrWorkspace({
      db,
      workspaceId: binding.workspaceId,
    }),
    binding.boundHeadSha,
  );

  return {
    binding,
    workspace,
    headSha: workspace.headSha,
  };
}

export function formatGithubSurfaceBindingId({
  surfaceKind,
  surfaceGitHubId,
}: GithubSurfaceBindingLookupKey): string {
  return `${surfaceKind}:${surfaceGitHubId}`;
}
