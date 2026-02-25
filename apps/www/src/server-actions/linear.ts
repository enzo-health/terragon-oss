"use server";

import { userOnlyAction } from "@/lib/auth-server";
import { db } from "@/lib/db";
import { UserFacingError } from "@/lib/server-actions";
import {
  getLinearAccountForLinearUserId,
  upsertLinearAccount,
  disconnectLinearAccountAndSettings,
  upsertLinearSettings,
} from "@terragon/shared/model/linear";
import { getFeatureFlagForUser } from "@terragon/shared/model/feature-flags";
import { LinearSettingsInsert } from "@terragon/shared/db/types";

async function assertLinearEnabled(userId: string) {
  const enabled = await getFeatureFlagForUser({
    db,
    userId,
    flagName: "linearIntegration",
  });
  if (!enabled) {
    throw new UserFacingError("Linear integration is not enabled");
  }
}

// v1 DESIGN DECISION: Manual account linking without OAuth/ownership proof.
// This is an accepted limitation documented in the epic spec. The
// linearIntegration feature flag gates access to trusted users only.
// The DB unique index on (linearUserId, organizationId) prevents duplicate
// claims. A challenge-based ownership verification flow is planned for v2.
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
    await assertLinearEnabled(userId);

    // Pre-check for friendly error message (non-atomic, see catch below)
    const existing = await getLinearAccountForLinearUserId({
      db,
      organizationId,
      linearUserId,
    });
    if (existing && existing.userId !== userId) {
      throw new UserFacingError(
        "This Linear user ID is already linked to another Terragon account",
      );
    }

    try {
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
    } catch (error: any) {
      // Handle race condition: concurrent claim slipping past pre-check
      if (error?.code === "23505") {
        throw new UserFacingError(
          "This Linear user ID is already linked to another Terragon account",
        );
      }
      throw error;
    }
  },
  { defaultErrorMessage: "Failed to connect Linear account" },
);

export const disconnectLinearAccount = userOnlyAction(
  async function disconnectLinearAccount(
    userId: string,
    { organizationId }: { organizationId: string },
  ): Promise<void> {
    await assertLinearEnabled(userId);
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
    await assertLinearEnabled(userId);
    await upsertLinearSettings({ db, userId, organizationId, settings });
  },
  { defaultErrorMessage: "Failed to update Linear settings" },
);
