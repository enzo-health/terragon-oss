import type { DB } from "@terragon/shared/db";
import type {
  GithubPrWorkspace,
  GithubSurfaceBinding,
} from "@terragon/shared/db/types";
import {
  getGithubSurfaceBindingBySurface,
  resolveGithubSurfaceBinding,
  upsertGithubSurfaceBinding,
} from "@terragon/shared/model/github-surface-bindings";
import { upsertGithubPrWorkspace } from "@terragon/shared/model/github-workspaces";
import { db as defaultDb } from "@/lib/db";

type GitHubSurfaceBindingCoordinatorDependencies = {
  db: DB;
};

export type GitHubSurfaceBindingWorkspaceIdentity = {
  installationId: number;
  repoId: number;
  prNodeId: string;
};

export type UpsertGitHubSurfaceBindingForWorkspaceParams =
  GitHubSurfaceBindingWorkspaceIdentity & {
    surfaceKind: GithubSurfaceBinding["surfaceKind"];
    surfaceGitHubId: string;
    surfaceMetadata?: GithubSurfaceBinding["surfaceMetadata"];
    lane: GithubSurfaceBinding["lane"];
    routingReason: GithubSurfaceBinding["routingReason"];
    boundHeadSha: GithubSurfaceBinding["boundHeadSha"];
  };

export type GitHubSurfaceBindingLookupParams = Pick<
  GithubSurfaceBinding,
  "surfaceKind" | "surfaceGitHubId"
>;

export type GitHubSurfaceBindingCoordinator = {
  getBinding(
    params: GitHubSurfaceBindingLookupParams,
  ): Promise<GithubSurfaceBinding | null>;
  resolveWorkspace(params: GitHubSurfaceBindingLookupParams): Promise<{
    binding: GithubSurfaceBinding;
    workspace: GithubPrWorkspace;
  } | null>;
  upsertBindingForWorkspace(
    params: UpsertGitHubSurfaceBindingForWorkspaceParams,
  ): Promise<{ binding: GithubSurfaceBinding; workspace: GithubPrWorkspace }>;
};

export function createGitHubSurfaceBindingCoordinator(
  dependencies?: Partial<GitHubSurfaceBindingCoordinatorDependencies>,
): GitHubSurfaceBindingCoordinator {
  const resolvedDb = dependencies?.db ?? defaultDb;

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
    async upsertBindingForWorkspace(params) {
      const workspace = await upsertGithubPrWorkspace({
        db: resolvedDb,
        installationId: params.installationId,
        repoId: params.repoId,
        prNodeId: params.prNodeId,
        fields: {
          headSha: params.boundHeadSha,
        },
      });

      const binding = await upsertGithubSurfaceBinding({
        db: resolvedDb,
        workspaceId: workspace.id,
        surfaceKind: params.surfaceKind,
        surfaceGitHubId: params.surfaceGitHubId,
        fields: {
          lane: params.lane,
          routingReason: params.routingReason,
          boundHeadSha: params.boundHeadSha,
          ...(params.surfaceMetadata !== undefined
            ? { surfaceMetadata: params.surfaceMetadata }
            : {}),
        },
      });

      return {
        binding,
        workspace,
      };
    },
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
