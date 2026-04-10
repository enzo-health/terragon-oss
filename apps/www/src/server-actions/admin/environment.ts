"use server";

import { db } from "@/lib/db";
import { User } from "@leo/shared";
import { adminOnly } from "@/lib/auth-server";
import { getEnvironmentForAdmin as getEnvironmentForAdminModel } from "@leo/shared/model/environments";
import * as schema from "@leo/shared/db/schema";
import { and, eq } from "drizzle-orm";

export type EnvironmentWithUser = NonNullable<
  Awaited<ReturnType<typeof getEnvironmentForAdmin>>
>;

export const getEnvironmentForAdmin = adminOnly(
  async function getEnvironmentForAdmin(
    adminUser: User,
    environmentId: string,
  ) {
    console.log("getEnvironmentForAdmin", environmentId);
    return await getEnvironmentForAdminModel({ db, environmentId });
  },
);

export const deleteEnvironmentAndThreads = adminOnly(
  async function deleteEnvironmentAndThreads(
    _adminUser: User,
    { environmentId }: { environmentId: string },
  ) {
    // Fetch the environment to get user and repo context
    const environment = await db.query.environment.findFirst({
      where: eq(schema.environment.id, environmentId),
    });
    if (!environment) {
      throw new Error("Environment not found");
    }

    const result = await db.transaction(async (tx) => {
      // Delete threads associated with this environment (by userId + repoFullName)
      const deletedThreads = await tx
        .delete(schema.thread)
        .where(
          and(
            eq(schema.thread.userId, environment.userId),
            eq(schema.thread.githubRepoFullName, environment.repoFullName),
          ),
        )
        .returning({ id: schema.thread.id });

      // Delete the environment itself
      await tx
        .delete(schema.environment)
        .where(eq(schema.environment.id, environmentId));

      return { deletedThreadCount: deletedThreads.length };
    });

    return {
      environmentId,
      deletedThreadCount: result.deletedThreadCount,
    };
  },
);
