import type { DB } from "@terragon/shared/db";
import type {
  GithubPrWorkspace,
  GithubSurfaceBinding,
  GithubWorkspaceRun,
} from "@terragon/shared/db/types";
import {
  listGithubWorkspaceRunsForWorkspace,
  upsertGithubWorkspaceRun,
} from "@terragon/shared/model/github-workspaces";
import { db as defaultDb } from "@/lib/db";
import {
  refreshGitHubPrProjection,
  type GitHubPullRequestSnapshot,
} from "./github-projection-refresh";
import { createGitHubSurfaceBindingCoordinator } from "./github-surface-bindings";

type RefreshGithubPrProjectionResult = Awaited<
  ReturnType<typeof refreshGitHubPrProjection>
>;

type GitHubWorkspaceBootstrapDependencies = {
  db: DB;
  refreshPrProjection(params: {
    repoFullName: string;
    prNumber: number;
  }): Promise<RefreshGithubPrProjectionResult>;
};

export type BootstrapThreadGithubWorkspaceParams = {
  repoFullName: string;
  prNumber: number;
  threadId: string;
  pullRequestIdentity?: Pick<GitHubPullRequestSnapshot, "prNodeId" | "headSha">;
};

export type BootstrapThreadGithubWorkspaceResult = {
  workspace: GithubPrWorkspace;
  binding: GithubSurfaceBinding;
  run: GithubWorkspaceRun;
};

function getBoundHeadSha(params: {
  repoFullName: string;
  prNumber: number;
  projectionHeadSha: string | null;
  identityHeadSha?: string | null;
}): string {
  const headSha = params.identityHeadSha ?? params.projectionHeadSha;

  if (!headSha) {
    throw new Error(
      `GitHub PR ${params.repoFullName}#${params.prNumber} is missing a head SHA`,
    );
  }

  return headSha;
}

function getCanonicalPrNodeId(params: {
  repoFullName: string;
  prNumber: number;
  projectionPrNodeId: string;
  identityPrNodeId?: string | null;
}): string {
  if (
    params.identityPrNodeId &&
    params.identityPrNodeId !== params.projectionPrNodeId
  ) {
    throw new Error(
      `GitHub PR ${params.repoFullName}#${params.prNumber} identity mismatch: expected ${params.projectionPrNodeId}, received ${params.identityPrNodeId}`,
    );
  }

  return params.projectionPrNodeId;
}

function selectAuthoringAttempt(params: {
  runs: GithubWorkspaceRun[];
  threadId: string;
  headSha: string;
}): number {
  const candidateRuns = params.runs.filter(
    (run) => run.lane === "authoring" && run.headSha === params.headSha,
  );
  const existingRunForThread = candidateRuns.find(
    (run) => run.threadId === params.threadId,
  );

  if (existingRunForThread) {
    return existingRunForThread.attempt;
  }

  const maxAttempt = candidateRuns.reduce((currentMax, run) => {
    return Math.max(currentMax, run.attempt);
  }, 0);

  return maxAttempt + 1;
}

export function createGitHubWorkspaceBootstrapClient(
  dependencies?: Partial<GitHubWorkspaceBootstrapDependencies>,
): {
  bootstrapThreadGithubWorkspace(
    params: BootstrapThreadGithubWorkspaceParams,
  ): Promise<BootstrapThreadGithubWorkspaceResult>;
} {
  const resolvedDb = dependencies?.db ?? defaultDb;
  const resolvedDependencies: GitHubWorkspaceBootstrapDependencies = {
    db: resolvedDb,
    refreshPrProjection:
      dependencies?.refreshPrProjection ?? refreshGitHubPrProjection,
  };

  return {
    async bootstrapThreadGithubWorkspace(params) {
      const { installationProjection, repoProjection, prProjection } =
        await resolvedDependencies.refreshPrProjection({
          repoFullName: params.repoFullName,
          prNumber: params.prNumber,
        });
      const prNodeId = getCanonicalPrNodeId({
        repoFullName: params.repoFullName,
        prNumber: params.prNumber,
        projectionPrNodeId: prProjection.prNodeId,
        identityPrNodeId: params.pullRequestIdentity?.prNodeId,
      });
      const boundHeadSha = getBoundHeadSha({
        repoFullName: params.repoFullName,
        prNumber: params.prNumber,
        projectionHeadSha: prProjection.headSha,
        identityHeadSha: params.pullRequestIdentity?.headSha,
      });

      return await resolvedDependencies.db.transaction(async (tx) => {
        const transactionalSurfaceBindingCoordinator =
          createGitHubSurfaceBindingCoordinator({
            db: tx,
          });
        const { workspace, binding } =
          await transactionalSurfaceBindingCoordinator.upsertBindingForWorkspace(
            {
              installationId: installationProjection.installationId,
              repoId: repoProjection.repoId,
              prNodeId,
              surfaceKind: "pull_request",
              surfaceGitHubId: prNodeId,
              lane: "authoring",
              routingReason: "input-user-id",
              boundHeadSha,
              workspaceHeadSha: boundHeadSha,
            },
          );
        const existingRuns = await listGithubWorkspaceRunsForWorkspace({
          db: tx,
          workspaceId: workspace.id,
        });
        const attempt = selectAuthoringAttempt({
          runs: existingRuns,
          threadId: params.threadId,
          headSha: boundHeadSha,
        });
        const run = await upsertGithubWorkspaceRun({
          db: tx,
          workspaceId: workspace.id,
          lane: "authoring",
          headSha: boundHeadSha,
          attempt,
          threadId: params.threadId,
          fields: {
            status: "running",
          },
        });

        return {
          workspace,
          binding,
          run,
        };
      });
    },
  };
}

const defaultGitHubWorkspaceBootstrapClient =
  createGitHubWorkspaceBootstrapClient();

export const bootstrapThreadGithubWorkspace =
  defaultGitHubWorkspaceBootstrapClient.bootstrapThreadGithubWorkspace;
