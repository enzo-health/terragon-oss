"use server";

import { userOnlyAction } from "@/lib/auth-server";
import { db } from "@/lib/db";
import {
  deleteEnvironmentById,
  getEnvironment,
} from "@leo/shared/model/environments";
import { getPostHogServer } from "@/lib/posthog-server";
import { UserFacingError } from "@/lib/server-actions";

export const deleteEnvironment = userOnlyAction(
  async function deleteEnvironment(
    userId: string,
    { environmentId }: { environmentId: string },
  ) {
    const environment = await getEnvironment({
      db,
      environmentId,
      userId,
    });

    if (!environment) {
      throw new UserFacingError("Environment not found");
    }

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
