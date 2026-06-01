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
} from "@terragon/shared/model/environments";
import { scheduleEnvironmentSnapshotBuild } from "@/server-lib/environment-snapshot-scheduler";
import { requireResult } from "@/lib/server-actions";

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
    await requireResult(
      () =>
        getEnvironment({
          db,
          environmentId,
          userId,
        }),
      "Environment not found",
    );
    await updateEnvironment({
      db,
      userId,
      environmentId,
      updates: {
        setupScript,
      },
    });
    await scheduleEnvironmentSnapshotBuild({
      db,
      environmentId,
      userId,
      reason: "environment-config-changed",
    });
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
