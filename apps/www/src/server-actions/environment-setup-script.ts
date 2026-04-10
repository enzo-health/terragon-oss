"use server";

import { userOnlyAction } from "@/lib/auth-server";
import { db } from "@/lib/db";
import {
  getSetupScriptFromEnvironment,
  getSetupScriptFromRepo,
} from "@/server-lib/environment";
import {
  getEnvironment,
  updateEnvironment,
  markSnapshotsStale,
} from "@leo/shared/model/environments";
import { UserFacingError } from "@/lib/server-actions";

export const updateEnvironmentSetupScript = userOnlyAction(
  async function updateEnvironmentSetupScript(
    userId: string,
    {
      environmentId,
      setupScript,
    }: {
      environmentId: string;
      setupScript: string | null;
    },
  ) {
    const environment = await getEnvironment({
      db,
      environmentId,
      userId,
    });
    if (!environment) {
      throw new UserFacingError("Environment not found");
    }
    await updateEnvironment({
      db,
      userId,
      environmentId,
      updates: {
        setupScript,
      },
    });
    // Mark any existing snapshots as stale since the setup script changed
    await markSnapshotsStale({ db, environmentId, userId });
  },
  { defaultErrorMessage: "Failed to update environment setup script" },
);

export const getEnvironmentSetupScript = userOnlyAction(
  async function getEnvironmentSetupScript(
    userId: string,
    {
      environmentId,
    }: {
      environmentId: string;
    },
  ): Promise<{
    type: "environment" | "repo";
    content: string | null;
  } | null> {
    const scriptFromEnvironment = await getSetupScriptFromEnvironment({
      db,
      userId,
      environmentId,
    });
    if (typeof scriptFromEnvironment === "string") {
      return {
        type: "environment",
        content: scriptFromEnvironment,
      };
    }

    const scriptFromRepo = await getSetupScriptFromRepo({
      db,
      userId,
      environmentId,
    });
    if (typeof scriptFromRepo === "string") {
      return {
        type: "repo",
        content: scriptFromRepo,
      };
    }
    return null;
  },
  { defaultErrorMessage: "Failed to get environment setup script" },
);
