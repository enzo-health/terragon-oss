"use server";

import { userOnlyAction } from "@/lib/auth-server";
import { db } from "@/lib/db";
import {
  getLinearAccountForLinearUserId,
  upsertLinearAccount,
  disconnectLinearAccountAndSettings,
  upsertLinearSettings,
} from "@terragon/shared/model/linear";
import { LinearSettingsInsert } from "@terragon/shared/db/types";

// v1: Manual account linking (no OAuth). The DB unique index on
// (linearUserId, organizationId) prevents duplicate claims. We add an
// explicit pre-check here to surface a clear error message rather than
// a raw DB constraint violation. A challenge-based ownership proof
// flow is planned for v2.
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
    // Check if this Linear identity is already claimed by another user
    const existing = await getLinearAccountForLinearUserId({
      db,
      organizationId,
      linearUserId,
    });
    if (existing && existing.userId !== userId) {
      throw new Error(
        "This Linear user ID is already linked to another Terragon account",
      );
    }

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
