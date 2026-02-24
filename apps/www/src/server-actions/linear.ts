"use server";

import { userOnlyAction } from "@/lib/auth-server";
import { db } from "@/lib/db";
import {
  upsertLinearAccount,
  disconnectLinearAccountAndSettings,
  upsertLinearSettings,
} from "@terragon/shared/model/linear";
import { LinearSettingsInsert } from "@terragon/shared/db/types";

export const connectLinearAccount = userOnlyAction(
  async function connectLinearAccount(
    userId: string,
    {
      organizationId,
      linearUserId,
      linearUserName,
      linearUserEmail,
    }: {
      organizationId: string;
      linearUserId: string;
      linearUserName: string;
      linearUserEmail: string;
    },
  ): Promise<void> {
    await upsertLinearAccount({
      db,
      userId,
      organizationId,
      account: {
        linearUserId,
        linearUserName,
        linearUserEmail,
      },
    });
  },
  { defaultErrorMessage: "Failed to connect Linear account" },
);

export const disconnectLinearAccount = userOnlyAction(
  async function disconnectLinearAccount(
    userId: string,
    { organizationId }: { organizationId: string },
  ): Promise<void> {
    await disconnectLinearAccountAndSettings({ db, userId, organizationId });
  },
  { defaultErrorMessage: "Failed to disconnect Linear account" },
);

export const updateLinearSettings = userOnlyAction(
  async function updateLinearSettings(
    userId: string,
    {
      organizationId,
      settings,
    }: {
      organizationId: string;
      settings: Omit<LinearSettingsInsert, "userId" | "organizationId">;
    },
  ): Promise<void> {
    await upsertLinearSettings({ db, userId, organizationId, settings });
  },
  { defaultErrorMessage: "Failed to update Linear settings" },
);
