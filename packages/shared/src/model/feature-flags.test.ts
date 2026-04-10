import { vi, beforeEach, describe, expect, it } from "vitest";
import * as schema from "../db/schema";
import { createDb } from "../db";
import { env } from "@leo/env/pkg-shared";
import { eq } from "drizzle-orm";
import {
  getFeatureFlag,
  getFeatureFlags,
  deleteFeatureFlag,
  getFeatureFlagsForUser,
  getFeatureFlagForUser,
  getUserFeatureFlagOverrides,
  removeUserFeatureFlagOverride,
  setUserFeatureFlagOverride,
  upsertFeatureFlag,
} from "./feature-flags";
import { createTestUser } from "./test-helpers";

const db = createDb(env.DATABASE_URL!);

vi.mock("./feature-flags-definitions", () => ({
  featureFlagsDefinitions: {
    enabledForPreviewFeature: {
      defaultValue: false,
      enabledForPreview: true,
      description: "Test preview feature",
    },
  },
}));

describe("feature-flags", () => {
  beforeEach(async () => {
    // Clean up any existing feature flags
    await db.delete(schema.userFeatureFlags);
    await db.delete(schema.featureFlags);
  });

  describe("getFeatureFlags", () => {
    it("should return empty array when no flags exist", async () => {
      const flags = await getFeatureFlags({ db: db });
      expect(flags).toEqual([]);
    });

    it("should return all feature flags", async () => {
      await db.insert(schema.featureFlags).values([
        { name: "feature-a", defaultValue: false },
        { name: "feature-b", defaultValue: true },
        { name: "feature-c", defaultValue: true },
      ]);

      const flags = await getFeatureFlags({ db: db });
      expect(flags).toHaveLength(3);
      expect(flags[0]!.name).toBe("feature-a");
      expect(flags[1]!.name).toBe("feature-b");
      expect(flags[2]!.name).toBe("feature-c");
    });
  });

  describe("getFeatureFlag", () => {
    it("should return undefined for non-existent flag", async () => {
      // @ts-expect-error - ignore in tests
      const flag = await getFeatureFlag({ db: db, name: "non-existent" });
      expect(flag).toBeUndefined();
    });

    it("should return the feature flag by name", async () => {
      const created = await upsertFeatureFlag({
        db: db,
        name: "test-feature",
        updates: { defaultValue: true },
      });
      // @ts-expect-error - ignore in tests
      const flag = await getFeatureFlag({ db: db, name: "test-feature" });
      expect(flag).toBeDefined();
      expect(flag?.id).toBe(created!.id);
      expect(flag?.name).toBe("test-feature");
      expect(flag?.defaultValue).toBe(true);
      expect(flag?.globalOverride).toBeNull();
    });
  });

  describe("upsertFeatureFlag", () => {
    it("should create a new feature flag", async () => {
      const flag = await upsertFeatureFlag({
        db: db,
        name: "new-feature",
        updates: { defaultValue: true },
      });

      expect(flag.name).toBe("new-feature");
      expect(flag.defaultValue).toBe(true);
      expect(flag.globalOverride).toBeNull();

      // Verify it was created
      // @ts-expect-error - ignore in tests
      const retrieved = await getFeatureFlag({ db: db, name: "new-feature" });
      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(flag.id);
    });

    it("should update an existing feature flag", async () => {
      // Create initial flag
      const initial = await upsertFeatureFlag({
        db: db,
        name: "update-test",
        updates: { defaultValue: false },
      });

      // Update it
      const updated = await upsertFeatureFlag({
        db: db,
        name: "update-test",
        updates: { defaultValue: true, globalOverride: true },
      });

      expect(updated.id).toBe(initial.id);
      expect(updated.defaultValue).toBe(true);
      expect(updated.globalOverride).toBe(true);
    });
  });

  describe("deleteFeatureFlag", () => {
    it("should delete a feature flag", async () => {
      const flag1 = await upsertFeatureFlag({
        db: db,
        name: "to-delete",
        updates: { defaultValue: true },
      });
      await deleteFeatureFlag({ db: db, flagId: flag1.id });
      // @ts-expect-error - ignore in tests
      const flag2 = await getFeatureFlag({ db: db, name: "to-delete" });
      expect(flag2).toBeUndefined();
    });
  });

  describe("getUserFeatureFlagOverrides", () => {
    it("should return empty array for user with no overrides", async () => {
      const { user } = await createTestUser({
        db,
        skipBillingFeatureFlag: true,
      });
      const flags = await getUserFeatureFlagOverrides({
        db: db,
        userId: user.id,
      });
      expect(flags).toEqual([]);
    });

    it("should return user's feature flag overrides", async () => {
      const { user } = await createTestUser({
        db,
        skipBillingFeatureFlag: true,
      });
      const flag1 = await upsertFeatureFlag({
        db: db,
        name: "flag1",
        updates: { defaultValue: true },
      });
      const flag2 = await upsertFeatureFlag({
        db: db,
        name: "flag2",
        updates: { defaultValue: false },
      });

      await db.insert(schema.userFeatureFlags).values([
        {
          userId: user.id,
          featureFlagId: flag1.id,
          value: true,
        },
        {
          userId: user.id,
          featureFlagId: flag2.id,
          value: false,
        },
      ]);

      const userFlags = await getUserFeatureFlagOverrides({
        db: db,
        userId: user.id,
      });
      expect(userFlags).toHaveLength(2);
      expect(userFlags.find((f) => f.featureFlagId === flag1.id)?.value).toBe(
        true,
      );
      expect(userFlags.find((f) => f.featureFlagId === flag2.id)?.value).toBe(
        false,
      );
    });
  });

  describe("setUserFeatureFlagOverride", () => {
    it("should throw if feature flag doesn't exist", async () => {
      const { user } = await createTestUser({
        db,
        skipBillingFeatureFlag: true,
      });
      await expect(
        setUserFeatureFlagOverride({
          db: db,
          userId: user.id,
          name: "non-existent",
          value: true,
        }),
      ).rejects.toThrow('Feature flag "non-existent" does not exist');
    });

    it("should create a new user override", async () => {
      const { user } = await createTestUser({
        db,
        skipBillingFeatureFlag: true,
      });
      const flag = await upsertFeatureFlag({
        db: db,
        name: "user-override",
        updates: { defaultValue: true },
      });

      await setUserFeatureFlagOverride({
        db: db,
        userId: user.id,
        name: "user-override",
        value: true,
      });

      // Verify it was created
      const userFlags = await getUserFeatureFlagOverrides({
        db: db,
        userId: user.id,
      });
      const userFlag = userFlags.find((f) => f.featureFlagId === flag.id);
      expect(userFlag).toBeDefined();
      expect(userFlag?.userId).toBe(user.id);
      expect(userFlag?.featureFlagId).toBe(flag.id);
      expect(userFlag?.value).toBe(true);
    });

    it("should update an existing user override", async () => {
      const { user } = await createTestUser({
        db,
        skipBillingFeatureFlag: true,
      });
      const flag = await upsertFeatureFlag({
        db: db,
        name: "update-override",
        updates: { defaultValue: true },
      });

      // Create initial override
      await setUserFeatureFlagOverride({
        db: db,
        userId: user.id,
        name: "update-override",
        value: false,
      });

      // Get the initial state
      let userFlags = await getUserFeatureFlagOverrides({
        db: db,
        userId: user.id,
      });
      const initial = userFlags.find((f) => f.featureFlagId === flag.id);
      expect(initial?.value).toBe(false);

      // Update it
      await setUserFeatureFlagOverride({
        db: db,
        userId: user.id,
        name: "update-override",
        value: true,
      });

      // Verify it was updated
      userFlags = await getUserFeatureFlagOverrides({
        db: db,
        userId: user.id,
      });
      const updated = userFlags.find((f) => f.featureFlagId === flag.id);
      expect(updated?.id).toBe(initial?.id);
      expect(updated?.value).toBe(true);
    });
  });

  describe("removeUserFeatureFlagOverride", () => {
    it("should not throw if flag doesn't exist", async () => {
      const { user } = await createTestUser({
        db,
        skipBillingFeatureFlag: true,
      });
      await expect(
        removeUserFeatureFlagOverride({
          db: db,
          userId: user.id,
          name: "non-existent",
        }),
      ).resolves.not.toThrow();
    });

    it("should remove user override", async () => {
      const { user } = await createTestUser({
        db,
        skipBillingFeatureFlag: true,
      });
      const flag = await upsertFeatureFlag({
        db: db,
        name: "remove-test",
        updates: { defaultValue: true },
      });

      // Create override
      await setUserFeatureFlagOverride({
        db: db,
        userId: user.id,
        name: "remove-test",
        value: false,
      });

      // Verify it exists
      let userFlags = await getUserFeatureFlagOverrides({
        db: db,
        userId: user.id,
      });
      expect(userFlags.find((f) => f.featureFlagId === flag.id)?.value).toBe(
        false,
      );

      // Remove it
      await removeUserFeatureFlagOverride({
        db: db,
        userId: user.id,
        name: "remove-test",
      });

      // Should be removed
      userFlags = await getUserFeatureFlagOverrides({
        db: db,
        userId: user.id,
      });
      expect(
        userFlags.find((f) => f.featureFlagId === flag.id),
      ).toBeUndefined();
    });
  });

  describe("getFeatureFlagsForUser", () => {
    it("should return empty object when no flags exist", async () => {
      const { user } = await createTestUser({
        db,
        skipBillingFeatureFlag: true,
      });
      const flags = await getFeatureFlagsForUser({
        db: db,
        userId: user.id,
      });
      expect(flags).toEqual({});
    });

    it("should enable preview features when user opts in", async () => {
      const { user } = await createTestUser({
        db,
        skipBillingFeatureFlag: true,
      });
      // Create a flag with enabledForPreview
      await upsertFeatureFlag({
        db: db,
        name: "enabledForPreviewFeature",
        updates: {
          defaultValue: false,
          description: "Test preview feature",
        },
      });
      // Create a regular flag without enabledForPreview
      await upsertFeatureFlag({
        db: db,
        name: "regularFeature",
        updates: {
          defaultValue: false,
          description: "Regular feature",
        },
      });

      // Initially, both should be false (user hasn't opted into preview)
      let flags = await getFeatureFlagsForUser({
        db: db,
        userId: user.id,
      });
      // @ts-expect-error - ignore in tests
      expect(flags.enabledForPreviewFeature).toBe(false);
      // @ts-expect-error - ignore in tests
      expect(flags.regularFeature).toBe(false);

      // Enable preview features opt-in for the user
      await db
        .insert(schema.userSettings)
        .values({
          userId: user.id,
          previewFeaturesOptIn: true,
        })
        .onConflictDoUpdate({
          target: [schema.userSettings.userId],
          set: { previewFeaturesOptIn: true },
        });

      // Now enabledForPreviewFeature should be true, regularFeature should still be false
      flags = await getFeatureFlagsForUser({
        db: db,
        userId: user.id,
      });
      // @ts-expect-error - ignore in tests
      expect(flags.enabledForPreviewFeature).toBe(true);
      // @ts-expect-error - ignore in tests
      expect(flags.regularFeature).toBe(false);
    });

    it("should respect user overrides over preview defaults", async () => {
      const { user } = await createTestUser({
        db,
        skipBillingFeatureFlag: true,
      });

      // Create a preview feature flag
      await upsertFeatureFlag({
        db: db,
        name: "enabledForPreviewFeature",
        updates: {
          defaultValue: false,
          description: "Test preview feature",
        },
      });

      // Enable preview features opt-in
      await db.insert(schema.userSettings).values({
        userId: user.id,
        previewFeaturesOptIn: true,
      });

      // Verify preview feature is enabled
      let flags = await getFeatureFlagsForUser({
        db: db,
        userId: user.id,
      });
      // @ts-expect-error - ignore in tests
      expect(flags.enabledForPreviewFeature).toBe(true);

      // Override the preview feature to false for this user
      await setUserFeatureFlagOverride({
        db: db,
        userId: user.id,
        name: "enabledForPreviewFeature",
        value: false,
      });

      // User override should take precedence over preview default
      flags = await getFeatureFlagsForUser({
        db: db,
        userId: user.id,
      });
      // @ts-expect-error - ignore in tests
      expect(flags.enabledForPreviewFeature).toBe(false);
    });

    it("should respect global override over preview defaults", async () => {
      const { user } = await createTestUser({
        db,
        skipBillingFeatureFlag: true,
      });

      // Create a preview feature flag with global override
      await upsertFeatureFlag({
        db: db,
        name: "enabledForPreviewFeature",
        updates: {
          defaultValue: false,
          globalOverride: false,
          description: "Test preview feature",
        },
      });

      // Enable preview features opt-in
      await db.insert(schema.userSettings).values({
        userId: user.id,
        previewFeaturesOptIn: true,
      });

      // Global override should take precedence over preview default
      const flags = await getFeatureFlagsForUser({
        db: db,
        userId: user.id,
      });
      // @ts-expect-error - ignore in tests
      expect(flags.enabledForPreviewFeature).toBe(false);
    });

    it("should disable preview features when user opts out", async () => {
      const { user } = await createTestUser({
        db,
        skipBillingFeatureFlag: true,
      });

      // Create a preview feature flag
      await upsertFeatureFlag({
        db: db,
        name: "enabledForPreviewFeature",
        updates: {
          defaultValue: false,
          description: "Test preview feature",
        },
      });

      // Initially enable preview features
      await db.insert(schema.userSettings).values({
        userId: user.id,
        previewFeaturesOptIn: true,
      });

      // Verify preview feature is enabled
      let flags = await getFeatureFlagsForUser({
        db: db,
        userId: user.id,
      });
      // @ts-expect-error - ignore in tests
      expect(flags.enabledForPreviewFeature).toBe(true);

      // Disable preview features opt-in
      await db
        .update(schema.userSettings)
        .set({ previewFeaturesOptIn: false })
        .where(eq(schema.userSettings.userId, user.id));

      // Preview feature should now be disabled
      flags = await getFeatureFlagsForUser({
        db: db,
        userId: user.id,
      });
      // @ts-expect-error - ignore in tests
      expect(flags.enabledForPreviewFeature).toBe(false);
    });

    it("should combine global flags with user overrides", async () => {
      const { user } = await createTestUser({
        db,
        skipBillingFeatureFlag: true,
      });

      // Create global flags
      await upsertFeatureFlag({
        db: db,
        name: "feature1",
        updates: { defaultValue: true },
      });
      await upsertFeatureFlag({
        db: db,
        name: "feature2",
        updates: { defaultValue: false },
      });
      await upsertFeatureFlag({
        db: db,
        name: "feature3",
        updates: { defaultValue: true },
      });

      // Override flag2 for user
      await setUserFeatureFlagOverride({
        db: db,
        userId: user.id,
        name: "feature2",
        value: true,
      });

      const effectiveFlags = await getFeatureFlagsForUser({
        db: db,
        userId: user.id,
      });

      expect(effectiveFlags).toEqual({
        feature1: true,
        feature2: true, // User override
        feature3: true,
      });
    });

    it("should handle multiple users independently", async () => {
      const { user: user1 } = await createTestUser({
        db,
        skipBillingFeatureFlag: true,
      });
      const { user: user2 } = await createTestUser({
        db,
        skipBillingFeatureFlag: true,
      });

      await upsertFeatureFlag({
        db: db,
        name: "shared-flag",
        updates: { defaultValue: false },
      });

      await setUserFeatureFlagOverride({
        db: db,
        userId: user1.id,
        name: "shared-flag",
        value: true,
      });

      await setUserFeatureFlagOverride({
        db: db,
        userId: user2.id,
        name: "shared-flag",
        value: false,
      });

      const flags1 = await getFeatureFlagsForUser({
        db: db,
        userId: user1.id,
      });
      const flags2 = await getFeatureFlagsForUser({
        db: db,
        userId: user2.id,
      });
      // @ts-expect-error - ignore in tests
      expect(flags1["shared-flag"]).toBe(true);
      // @ts-expect-error - ignore in tests
      expect(flags2["shared-flag"]).toBe(false);
    });
  });

  describe("getFeatureFlagForUser", () => {
    it("should enable preview feature when user opts in", async () => {
      const { user } = await createTestUser({
        db,
        skipBillingFeatureFlag: true,
      });

      // Create a preview feature flag
      await upsertFeatureFlag({
        db: db,
        name: "enabledForPreviewFeature",
        updates: {
          defaultValue: false,
          description: "Test preview feature",
        },
      });

      // Initially should be false (user hasn't opted into preview)
      let flag = await getFeatureFlagForUser({
        db: db,
        userId: user.id,
        // @ts-expect-error - ignore in tests
        flagName: "enabledForPreviewFeature",
      });
      expect(flag).toBe(false);

      // Enable preview features opt-in for the user
      await db
        .insert(schema.userSettings)
        .values({
          userId: user.id,
          previewFeaturesOptIn: true,
        })
        .onConflictDoUpdate({
          target: [schema.userSettings.userId],
          set: { previewFeaturesOptIn: true },
        });

      // Now should be true
      flag = await getFeatureFlagForUser({
        db: db,
        userId: user.id,
        // @ts-expect-error - ignore in tests
        flagName: "enabledForPreviewFeature",
      });
      expect(flag).toBe(true);
    });

    it("should respect priority: user override > global override > preview default > default", async () => {
      const { user } = await createTestUser({
        db,
        skipBillingFeatureFlag: true,
      });

      // Create a preview feature flag
      await upsertFeatureFlag({
        db: db,
        name: "enabledForPreviewFeature",
        updates: {
          defaultValue: false,
          description: "Test preview feature",
        },
      });

      // Enable preview features - flag should be true
      await db.insert(schema.userSettings).values({
        userId: user.id,
        previewFeaturesOptIn: true,
      });
      let flag = await getFeatureFlagForUser({
        db: db,
        userId: user.id,
        // @ts-expect-error - ignore in tests
        flagName: "enabledForPreviewFeature",
      });
      expect(flag).toBe(true);

      // Set global override to false - should override preview
      await upsertFeatureFlag({
        db: db,
        name: "enabledForPreviewFeature",
        updates: {
          globalOverride: false,
        },
      });
      flag = await getFeatureFlagForUser({
        db: db,
        userId: user.id,
        // @ts-expect-error - ignore in tests
        flagName: "enabledForPreviewFeature",
      });
      expect(flag).toBe(false);

      // Set user override to true - should override global
      await setUserFeatureFlagOverride({
        db: db,
        userId: user.id,
        name: "enabledForPreviewFeature",
        value: true,
      });
      flag = await getFeatureFlagForUser({
        db: db,
        userId: user.id,
        // @ts-expect-error - ignore in tests
        flagName: "enabledForPreviewFeature",
      });
      expect(flag).toBe(true);
    });
  });
});
