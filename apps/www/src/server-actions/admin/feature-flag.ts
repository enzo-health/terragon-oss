"use server";

import { db } from "@/lib/db";
import { adminOnly } from "@/lib/auth-server";
import { User } from "@leo/shared";
import {
  deleteFeatureFlag,
  setUserFeatureFlagOverride,
  removeUserFeatureFlagOverride,
  upsertFeatureFlag,
  getFeatureFlags,
} from "@leo/shared/model/feature-flags";

export const deleteFeatureFlagAction = adminOnly(
  async function deleteFeatureFlagAction(adminUser: User, flagId: string) {
    await deleteFeatureFlag({ db, flagId });
  },
);

export const setUserFeatureFlagOverrideAction = adminOnly(
  async function setUserFeatureFlagOverrideAction(
    adminUser: User,
    {
      userId,
      flagName,
      value,
    }: {
      userId: string;
      flagName: string;
      value: boolean;
    },
  ) {
    await setUserFeatureFlagOverride({ db, userId, name: flagName, value });
  },
);

export const removeUserFeatureFlagOverrideAction = adminOnly(
  async function removeUserFeatureFlagOverrideAction(
    adminUser: User,
    {
      userId,
      flagName,
    }: {
      userId: string;
      flagName: string;
    },
  ) {
    await removeUserFeatureFlagOverride({ db, userId, name: flagName });
  },
);

export const setGlobalFeatureFlagOverrideAction = adminOnly(
  async function setGlobalFeatureFlagOverrideAction(
    adminUser: User,
    {
      flagName,
      value,
    }: {
      flagName: string;
      value: boolean | null;
    },
  ) {
    await upsertFeatureFlag({
      db,
      name: flagName,
      updates: { globalOverride: value },
    });
  },
);

export const deleteAllUnusedFeatureFlagsAction = adminOnly(
  async function deleteAllUnusedFeatureFlagsAction(adminUser: User) {
    const allFeatureFlags = await getFeatureFlags({ db });
    const unusedFeatureFlags = allFeatureFlags.filter(
      (flag) => !flag.inCodebase,
    );

    const deletedCount = unusedFeatureFlags.length;

    for (const flag of unusedFeatureFlags) {
      await deleteFeatureFlag({ db, flagId: flag.id });
    }

    return {
      deletedCount,
      deletedFlags: unusedFeatureFlags.map((f) => f.name),
    };
  },
);
