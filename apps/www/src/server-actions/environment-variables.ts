"use server";

import { userOnlyAction } from "@/lib/auth-server";
import { db } from "@/lib/db";

import {
  getEnvironments,
  getEnvironment,
  updateEnvironment,
  markSnapshotsStale,
} from "@terragon/shared/model/environments";
import { scheduleEnvironmentSnapshotBuild } from "@/server-lib/environment-snapshot-scheduler";
import { encryptValue } from "@terragon/utils/encryption";
import { env } from "@terragon/env/apps-www";
import { requireResult } from "@/lib/server-actions";
import {
  EnvironmentVariable,
  validateEnvironmentVariables,
} from "@/server-lib/environment-variables";

export const updateEnvironmentVariables = userOnlyAction(
  async function updateEnvironmentVariables(
    userId: string,
    {
      environmentId,
      variables,
    }: {
      environmentId: string;
      variables: EnvironmentVariable[];
    },
  ) {
    // Verify the user owns this environment
    const environment = await requireResult(
      () =>
        getEnvironment({
          db,
          environmentId,
          userId,
        }),
      "Environment not found",
    );
    await validateEnvironmentVariables(variables);
    // Update the environment with the new variables
    await updateEnvironment({
      db,
      userId,
      environmentId,
      updates: {
        environmentVariables: variables.map((variable) => ({
          key: variable.key,
          valueEncrypted: encryptValue(
            variable.value,
            env.ENCRYPTION_MASTER_KEY,
          ),
        })),
      },
    });
    if (environment.isGlobal) {
      const environments = await getEnvironments({
        db,
        userId,
        includeGlobal: false,
      });
      await Promise.all(
        environments.map((repoEnvironment) =>
          markSnapshotsStale({
            db,
            userId,
            environmentId: repoEnvironment.id,
          }),
        ),
      );
    } else {
      await scheduleEnvironmentSnapshotBuild({
        db,
        userId,
        environmentId,
        reason: "environment-config-changed",
      });
    }
    return { success: true };
  },
  { defaultErrorMessage: "Failed to update environment variables" },
);
