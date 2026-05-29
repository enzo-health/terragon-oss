"use server";

import { userOnlyAction } from "@/lib/auth-server";
import { db } from "@/lib/db";
import {
  deleteEnvironmentById,
  getEnvironment,
} from "@terragon/shared/model/environments";
import { requireResult } from "@/lib/server-actions";

export const deleteEnvironment = userOnlyAction(
  async function deleteEnvironment(
    userId: string,
    { environmentId }: { environmentId: string },
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

    await deleteEnvironmentById({
      db,
      userId,
      environmentId,
    });

    return { success: true };
  },
  { defaultErrorMessage: "Failed to delete environment" },
);
