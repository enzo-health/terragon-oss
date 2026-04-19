import type { DB } from "@terragon/shared/db";
import type {
  GithubPrWorkspace,
  GithubSurfaceBindingKind,
  GithubSurfaceBindingRecordForKind,
} from "@terragon/shared/db/types";
import {
  type GithubSurfaceBindingMutableFields,
  getGithubSurfaceBindingBySurface,
  resolveGithubSurfaceBinding,
  upsertGithubSurfaceBinding,
} from "@terragon/shared/model/github-surface-bindings";
import { upsertGithubPrWorkspace } from "@terragon/shared/model/github-workspaces";
import { db as defaultDb } from "@/lib/db";

type GitHubSurfaceBindingCoordinatorDependencies = {
  db: Pick<DB, "query" | "insert">;
};
type GithubSurfaceBindingKindWithoutMetadata = Exclude<
  GithubSurfaceBindingKind,
  "issue_comment_mention"
>;

export type GitHubSurfaceBindingWorkspaceIdentity = {
  installationId: number;
  repoId: number;
  prNodeId: string;
};

type UpsertGitHubSurfaceBindingForWorkspaceParamsByKind = {
  [K in GithubSurfaceBindingKind]: GitHubSurfaceBindingWorkspaceIdentity & {
    surfaceKind: K;
    surfaceGitHubId: string;
    workspaceHeadSha?: GithubPrWorkspace["headSha"];
  } & GithubSurfaceBindingMutableFields<K>;
};

export type UpsertGitHubSurfaceBindingForWorkspaceParams<
  K extends GithubSurfaceBindingKind = GithubSurfaceBindingKind,
> = UpsertGitHubSurfaceBindingForWorkspaceParamsByKind[K];

export type GitHubSurfaceBindingLookupParams<
  K extends GithubSurfaceBindingKind = GithubSurfaceBindingKind,
> = {
  surfaceKind: K;
  surfaceGitHubId: string;
};

export type GitHubSurfaceBindingCoordinator = {
  getBinding<K extends GithubSurfaceBindingKind>(
    params: GitHubSurfaceBindingLookupParams<K>,
  ): Promise<GithubSurfaceBindingRecordForKind<K> | null>;
  resolveWorkspace<K extends GithubSurfaceBindingKind>(
    params: GitHubSurfaceBindingLookupParams<K>,
  ): Promise<{
    binding: GithubSurfaceBindingRecordForKind<K>;
    workspace: GithubPrWorkspace;
    headSha: string;
  } | null>;
  upsertBindingForWorkspace<K extends GithubSurfaceBindingKind>(
    params: UpsertGitHubSurfaceBindingForWorkspaceParams<K>,
  ): Promise<{
    binding: GithubSurfaceBindingRecordForKind<K>;
    workspace: GithubPrWorkspace;
  }>;
};

export function createGitHubSurfaceBindingCoordinator(
  dependencies?: Partial<GitHubSurfaceBindingCoordinatorDependencies>,
): GitHubSurfaceBindingCoordinator {
  const resolvedDb = dependencies?.db ?? defaultDb;

  function upsertBindingForWorkspace<
    K extends GithubSurfaceBindingKindWithoutMetadata,
  >(
    params: UpsertGitHubSurfaceBindingForWorkspaceParams<K>,
  ): Promise<{
    binding: GithubSurfaceBindingRecordForKind<K>;
    workspace: GithubPrWorkspace;
  }>;
  function upsertBindingForWorkspace(
    params: UpsertGitHubSurfaceBindingForWorkspaceParams<"issue_comment_mention">,
  ): Promise<{
    binding: GithubSurfaceBindingRecordForKind<"issue_comment_mention">;
    workspace: GithubPrWorkspace;
  }>;
  async function upsertBindingForWorkspace(
    params: UpsertGitHubSurfaceBindingForWorkspaceParams,
  ): Promise<{
    binding: GithubSurfaceBindingRecordForKind<GithubSurfaceBindingKind>;
    workspace: GithubPrWorkspace;
  }> {
    const workspace = await upsertGithubPrWorkspace({
      db: resolvedDb,
      installationId: params.installationId,
      repoId: params.repoId,
      prNodeId: params.prNodeId,
      fields:
        params.workspaceHeadSha !== undefined
          ? {
              headSha: params.workspaceHeadSha,
            }
          : undefined,
    });

    if (params.surfaceKind === "issue_comment_mention") {
      const binding = await upsertGithubSurfaceBinding({
        db: resolvedDb,
        workspaceId: workspace.id,
        surfaceKind: "issue_comment_mention",
        surfaceGitHubId: params.surfaceGitHubId,
        fields: {
          lane: params.lane,
          routingReason: params.routingReason,
          boundHeadSha: params.boundHeadSha,
          surfaceMetadata: params.surfaceMetadata,
        },
      });

      return {
        binding,
        workspace,
      };
    }

    const binding = await upsertGithubSurfaceBinding({
      db: resolvedDb,
      workspaceId: workspace.id,
      surfaceKind: params.surfaceKind,
      surfaceGitHubId: params.surfaceGitHubId,
      fields: {
        lane: params.lane,
        routingReason: params.routingReason,
        boundHeadSha: params.boundHeadSha,
      },
    });

    return {
      binding,
      workspace,
    };
  }

  return {
    async getBinding(params) {
      return await getGithubSurfaceBindingBySurface({
        db: resolvedDb,
        surfaceKind: params.surfaceKind,
        surfaceGitHubId: params.surfaceGitHubId,
      });
    },
    async resolveWorkspace(params) {
      return await resolveGithubSurfaceBinding({
        db: resolvedDb,
        surfaceKind: params.surfaceKind,
        surfaceGitHubId: params.surfaceGitHubId,
      });
    },
    upsertBindingForWorkspace,
  };
}
const defaultGitHubSurfaceBindingCoordinator =
  createGitHubSurfaceBindingCoordinator();

export const getGitHubSurfaceBinding =
  defaultGitHubSurfaceBindingCoordinator.getBinding;
export const resolveGitHubSurfaceWorkspace =
  defaultGitHubSurfaceBindingCoordinator.resolveWorkspace;
export const upsertGitHubSurfaceBindingForWorkspace =
  defaultGitHubSurfaceBindingCoordinator.upsertBindingForWorkspace;
