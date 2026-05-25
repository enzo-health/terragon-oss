"use server";

import { userOnlyAction } from "@/lib/auth-server";
import { db } from "@/lib/db";
import {
  getGitHubUserAccessToken,
  getDefaultBranchForRepo,
} from "@/lib/github";
import { UserFacingError } from "@/lib/server-actions";
import { getSetupScriptFromRepo } from "@/server-lib/environment";
import { buildAndStoreEnvironmentSnapshot } from "@/server-lib/environment-snapshot-build";
import { env } from "@terragon/env/apps-www";
import {
  getEnvironment,
  getDecryptedEnvironmentVariables,
  getDecryptedMcpConfig,
  updateEnvironment,
  getReadySnapshot,
} from "@terragon/shared/model/environments";
import type { EnvironmentSnapshot } from "@terragon/shared/db/schema";
import type { SandboxSize } from "@terragon/types/sandbox";
import { deleteRepoSnapshot } from "@terragon/sandbox/snapshot-builder";

export const buildEnvironmentSnapshot = userOnlyAction(
  async function buildEnvironmentSnapshot(
    userId: string,
    {
      environmentId,
      size,
    }: {
      environmentId: string;
      size: SandboxSize;
    },
  ) {
    const environment = await getEnvironment({ db, environmentId, userId });
    if (!environment) {
      throw new UserFacingError("Environment not found");
    }
    if (!environment.repoFullName) {
      throw new UserFacingError("Cannot build snapshot for global environment");
    }
    const githubAccessToken = await getGitHubUserAccessToken({ userId });
    if (!githubAccessToken) {
      throw new UserFacingError("No GitHub access token found");
    }

    const setupScript =
      environment.setupScript ??
      (await getSetupScriptFromRepo({ db, userId, environmentId }));
    const [repositoryEnvironmentVariables, resolvedMcpConfig] =
      await Promise.all([
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
      ]);
    const defaultBranch = await getDefaultBranchForRepo({
      userId,
      repoFullName: environment.repoFullName,
    });

    await buildAndStoreEnvironmentSnapshot({
      db,
      userId,
      environmentId,
      repoFullName: environment.repoFullName,
      baseBranch: defaultBranch,
      githubAccessToken,
      setupScript,
      size,
      environmentVariables: repositoryEnvironmentVariables,
      mcpConfig: resolvedMcpConfig,
    });
  },
  { defaultErrorMessage: "Failed to build environment snapshot" },
);

export const deleteEnvironmentSnapshot = userOnlyAction(
  async function deleteEnvironmentSnapshot(
    userId: string,
    {
      environmentId,
      size,
    }: {
      environmentId: string;
      size: SandboxSize;
    },
  ) {
    const environment = await getEnvironment({ db, environmentId, userId });
    if (!environment) {
      throw new UserFacingError("Environment not found");
    }

    const snapshot = getReadySnapshot(environment, "daytona", size);
    if (snapshot?.snapshotName) {
      try {
        await deleteRepoSnapshot(snapshot.snapshotName);
      } catch (error) {
        console.error(
          `[snapshot-delete] Failed to delete from Daytona:`,
          error,
        );
        // Continue to remove from DB even if Daytona deletion fails
      }
    }

    // Remove the snapshot entry from the array
    const existing = environment.snapshots ?? [];
    const updated = existing.filter(
      (s) => !(s.provider === "daytona" && s.size === size),
    );
    await updateEnvironment({
      db,
      userId,
      environmentId,
      updates: { snapshots: updated },
    });
  },
  { defaultErrorMessage: "Failed to delete environment snapshot" },
);

export const getSnapshotStatus = userOnlyAction(
  async function getSnapshotStatus(
    userId: string,
    {
      environmentId,
      size,
    }: {
      environmentId: string;
      size: SandboxSize;
    },
  ): Promise<EnvironmentSnapshot | null> {
    const environment = await getEnvironment({ db, environmentId, userId });
    if (!environment) {
      throw new UserFacingError("Environment not found");
    }
    return (
      environment.snapshots?.find(
        (s) => s.provider === "daytona" && s.size === size,
      ) ?? null
    );
  },
  { defaultErrorMessage: "Failed to get snapshot status" },
);
