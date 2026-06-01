"use server";

import { waitUntil } from "@vercel/functions";
import { userOnlyAction } from "@/lib/auth-server";
import { db } from "@/lib/db";
import { getOrCreateEnvironment } from "@terragon/shared/model/environments";
import { scheduleEnvironmentSnapshotBuild } from "@/server-lib/environment-snapshot-scheduler";

export const createEnvironment = userOnlyAction(
  async function createEnvironment(
    userId: string,
    { repoFullName }: { repoFullName: string },
  ) {
    const environment = await getOrCreateEnvironment({
      db,
      userId,
      repoFullName,
    });
    // Warm a snapshot eagerly so the first task on this repo skips clone+install.
    waitUntil(
      scheduleEnvironmentSnapshotBuild({
        db,
        userId,
        environmentId: environment.id,
        reason: "environment-created",
      }),
    );
    return environment;
  },
  { defaultErrorMessage: "Failed to create environment" },
);
