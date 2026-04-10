"use server";

import { userOnlyAction } from "@/lib/auth-server";
import { db } from "@/lib/db";
import { getEnvironments as getEnvironmentsFromDB } from "@leo/shared/model/environments";

export const getEnvironments = userOnlyAction(
  async function getEnvironments(userId: string) {
    return getEnvironmentsFromDB({ db, userId, includeGlobal: false });
  },
  { defaultErrorMessage: "Failed to get environments" },
);
