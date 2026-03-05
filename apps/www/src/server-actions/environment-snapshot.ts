"use server";

import { userOnlyAction } from "@/lib/auth-server";
import { db } from "@/lib/db";
import { getGitHubUserAccessToken } from "@/lib/github";
import { UserFacingError } from "@/lib/server-actions";
import { env } from "@terragon/env/apps-www";
import {
  getEnvironment,
  getDecryptedEnvironmentVariables,
  getDecryptedMcpConfig,
  hashEnvironmentVariables,
  hashSnapshotValue,
  updateEnvironment,
  updateEnvironmentSnapshot,
  getReadySnapshot,
} from "@terragon/shared/model/environments";
import type { EnvironmentSnapshot } from "@terragon/shared/db/schema";
import type { SandboxSize } from "@terragon/types/sandbox";
import {
  buildRepoSnapshot,
  deleteRepoSnapshot,
  getSetupScriptHash,
  getSnapshotBaseTemplateId,
} from "@terragon/sandbox/snapshot-builder";

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

    const setupScriptHash = getSetupScriptHash(environment.setupScript);
    const baseDockerfileHash = getSnapshotBaseTemplateId(size);
    const [repositoryEnvironmentVariables, resolvedMcpConfig] = await Promise.all([
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
    const environmentVariablesHash = hashEnvironmentVariables(
      repositoryEnvironmentVariables,
    );
    const mcpConfigHash = hashSnapshotValue(resolvedMcpConfig);

    // Set status to building immediately
    const buildingEntry: EnvironmentSnapshot = {
      provider: "daytona",
      size,
      snapshotName: "",
      status: "building",
      setupScriptHash,
      baseDockerfileHash,
      environmentVariablesHash,
      mcpConfigHash,
      builtAt: new Date().toISOString(),
    };
    await updateEnvironmentSnapshot({
      db,
      environmentId,
      userId,
      snapshot: buildingEntry,
    });

    // Fire and forget — the build runs in the background
    buildRepoSnapshot({
      repoFullName: environment.repoFullName,
      baseBranch: "main", // Default to main; could be configurable
      githubAccessToken,
      setupScript: environment.setupScript,
      environmentVariables: repositoryEnvironmentVariables,
      size,
      onLogs: (chunk) => console.log(`[snapshot-build] ${chunk}`),
    })
      .then(async ({ snapshotName }) => {
        const readyEntry: EnvironmentSnapshot = {
          provider: "daytona",
          size,
          snapshotName,
          status: "ready",
          setupScriptHash,
          baseDockerfileHash,
          environmentVariablesHash,
          mcpConfigHash,
          builtAt: new Date().toISOString(),
        };
        await updateEnvironmentSnapshot({
          db,
          environmentId,
          userId,
          snapshot: readyEntry,
        });
        console.log(
          `[snapshot-build] Snapshot ready: ${snapshotName} for ${environment.repoFullName}`,
        );
      })
      .catch(async (error) => {
        console.error(`[snapshot-build] Failed:`, error);
        const failedEntry: EnvironmentSnapshot = {
          provider: "daytona",
          size,
          snapshotName: "",
          status: "failed",
          setupScriptHash,
          baseDockerfileHash,
          environmentVariablesHash,
          mcpConfigHash,
          error: error instanceof Error ? error.message : String(error),
          builtAt: new Date().toISOString(),
        };
        await updateEnvironmentSnapshot({
          db,
          environmentId,
          userId,
          snapshot: failedEntry,
        }).catch((e) =>
          console.error("[snapshot-build] Failed to update status:", e),
        );
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
