import type { DB } from "@terragon/shared/db";
import type { EnvironmentSnapshot } from "@terragon/shared/db/schema";
import type { SandboxSize } from "@terragon/types/sandbox";
import { env } from "@terragon/env/apps-www";
import {
  getEnvironment,
  getDecryptedEnvironmentVariables,
  getDecryptedMcpConfig,
} from "@terragon/shared/model/environments";
import {
  getDefaultBranchForRepo,
  getGitHubUserAccessToken,
} from "@/lib/github";
import { getSetupScriptFromRepo } from "@/server-lib/environment";
import { maybeTriggerSnapshotBuildForBoot } from "./environment-snapshot-build";

export type SnapshotBuildInputs = {
  repoFullName: string;
  baseBranch: string;
  githubAccessToken: string;
  setupScript: string | null;
  environmentVariables: Array<{ key: string; value: string }>;
  mcpConfig: unknown;
  snapshots: EnvironmentSnapshot[] | null;
};

/**
 * Assemble everything `buildRepoSnapshot` needs for an environment: GitHub
 * token, base branch, resolved setup script, decrypted env vars, and MCP
 * config. Returns null when the environment can't be snapshotted (global env,
 * no repo, or no GitHub token) so callers can no-op. Shared by the Settings
 * build action and the eager/refresh triggers so the loading logic lives once.
 */
export async function loadSnapshotBuildInputs({
  db,
  userId,
  environmentId,
}: {
  db: DB;
  userId: string;
  environmentId: string;
}): Promise<SnapshotBuildInputs | null> {
  const environment = await getEnvironment({ db, environmentId, userId });
  if (!environment || environment.isGlobal || !environment.repoFullName) {
    return null;
  }

  const githubAccessToken = await getGitHubUserAccessToken({ userId });
  if (!githubAccessToken) {
    return null;
  }

  const setupScript =
    environment.setupScript ??
    (await getSetupScriptFromRepo({ db, userId, environmentId }));

  const [environmentVariables, mcpConfig, baseBranch] = await Promise.all([
    getDecryptedEnvironmentVariables({
      db,
      userId,
      environmentId,
      encryptionMasterKey: env.ENCRYPTION_MASTER_KEY,
    }),
    getDecryptedMcpConfig({
      db,
      userId,
      environmentId,
      encryptionMasterKey: env.ENCRYPTION_MASTER_KEY,
    }),
    getDefaultBranchForRepo({ userId, repoFullName: environment.repoFullName }),
  ]);

  return {
    repoFullName: environment.repoFullName,
    baseBranch,
    githubAccessToken,
    setupScript,
    environmentVariables,
    mcpConfig,
    snapshots: environment.snapshots ?? null,
  };
}

/**
 * Eagerly warm (or refresh) a repo snapshot for an environment. Loads the build
 * inputs, then delegates to the boot-path builder which reaps stale entries and
 * debounces against an in-progress build. `force` rebuilds even when a matching
 * ready snapshot exists (used by the push-refresh path). Fire-and-forget: never
 * throws into the caller.
 */
export async function triggerEnvironmentSnapshotBuild({
  db,
  userId,
  environmentId,
  size = "small",
  force = false,
}: {
  db: DB;
  userId: string;
  environmentId: string;
  size?: SandboxSize;
  force?: boolean;
}): Promise<void> {
  try {
    const inputs = await loadSnapshotBuildInputs({ db, userId, environmentId });
    if (!inputs) {
      return;
    }
    await maybeTriggerSnapshotBuildForBoot({
      db,
      userId,
      environmentId,
      snapshots: inputs.snapshots,
      repoFullName: inputs.repoFullName,
      baseBranch: inputs.baseBranch,
      githubAccessToken: inputs.githubAccessToken,
      setupScript: inputs.setupScript,
      size,
      environmentVariables: inputs.environmentVariables,
      mcpConfig: inputs.mcpConfig,
      force,
    });
  } catch (error) {
    console.warn(
      `[snapshot-build] eager trigger skipped for ${environmentId}:`,
      error,
    );
  }
}
