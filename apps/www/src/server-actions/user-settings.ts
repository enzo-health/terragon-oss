"use server";

import { db } from "@/lib/db";
import { UserSettings } from "@terragon/shared";
import {
  getUserSettings,
  updateUserSettings,
} from "@terragon/shared/model/user";
import { userOnlyAction } from "@/lib/auth-server";

export const updateUserSettingsAction = userOnlyAction(
  async function updateUserSettingsAction(
    userId: string,
    updates: Partial<Omit<UserSettings, "id" | "userId">>,
  ) {
    console.log("updateUserSettingsAction", updates);
    await updateUserSettings({ db, userId, updates });
  },
  { defaultErrorMessage: "Failed to update settings" },
);

export const getUserSettingsAction = userOnlyAction(
  async function getUserSettingsAction(
    userId: string,
  ): Promise<UserSettings | null> {
    console.log("getUserSettingsAction");
    return getUserSettings({ db, userId });
  },
  { defaultErrorMessage: "Failed to get settings" },
);
