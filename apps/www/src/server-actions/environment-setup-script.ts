"use server";

import { waitUntil } from "@vercel/functions";
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
} from "@terragon/shared/model/environments";
import { triggerEnvironmentSnapshotBuild } from "@/server-lib/environment-snapshot-lifecycle";
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
    // Mark any existing snapshots as stale since the setup script changed
    await markSnapshotsStale({ db, environmentId, userId });
    // Rebuild eagerly against the new setup script.
    waitUntil(triggerEnvironmentSnapshotBuild({ db, userId, environmentId }));
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
