"use server";

import { userOnlyAction } from "@/lib/auth-server";
import { db } from "@/lib/db";
import { UserFacingError } from "@/lib/server-actions";
import {
  buildEnvironmentSnapshotNow,
  deleteEnvironmentSnapshotForSize,
} from "@/server-lib/environment-snapshot-lifecycle";
import { getEnvironment } from "@terragon/shared/model/environments";
import type { EnvironmentSnapshot } from "@terragon/shared/db/schema";
import type { SandboxSize } from "@terragon/types/sandbox";

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
    const result = await buildEnvironmentSnapshotNow({
      db,
      userId,
      environmentId,
      size,
    });
    if (result.ok) {
      return;
    }
    if (result.failure === "environment-not-found") {
      throw new UserFacingError("Environment not found");
    }
    if (result.failure === "not-repo-environment") {
      throw new UserFacingError("Cannot build snapshot for global environment");
    }
    throw new UserFacingError("No GitHub access token found");
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
    const result = await deleteEnvironmentSnapshotForSize({
      db,
      userId,
      environmentId,
      size,
    });
    if (result === "environment-not-found") {
      throw new UserFacingError("Environment not found");
    }
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
