"use server";

import { userOnlyAction } from "@/lib/auth-server";
import { db } from "@/lib/db";
import {
  deleteEnvironmentById,
  getEnvironment,
} from "@terragon/shared/model/environments";
import { getPostHogServer } from "@/lib/posthog-server";
import { requireResult } from "@/lib/server-actions";

export const deleteEnvironment = userOnlyAction(
  async function deleteEnvironment(
    userId: string,
    { environmentId }: { environmentId: string },
  ) {
    const environment = await requireResult(
      () =>
        getEnvironment({
          db,
          environmentId,
          userId,
        }),
      "Environment not found",
    );

    getPostHogServer().capture({
      distinctId: userId,
      event: "delete_environment",
      properties: {
        environmentId,
        repoFullName: environment.repoFullName,
      },
    });

    await deleteEnvironmentById({
      db,
      userId,
      environmentId,
    });

    return { success: true };
  },
  { defaultErrorMessage: "Failed to delete environment" },
);
