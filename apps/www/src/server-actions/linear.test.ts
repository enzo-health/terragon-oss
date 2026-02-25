import { describe, it, vi, beforeEach, expect } from "vitest";
import { eq } from "drizzle-orm";
import { uninstallLinearWorkspace as uninstallLinearWorkspaceAction } from "./linear";
import { db } from "@/lib/db";
import { createTestUser } from "@terragon/shared/model/test-helpers";
import { mockLoggedInUser, mockLoggedOutUser } from "@/test-helpers/mock-next";
import { upsertLinearInstallation } from "@terragon/shared/model/linear";
import {
  setUserFeatureFlagOverride,
  upsertFeatureFlag,
} from "@terragon/shared/model/feature-flags";
import { User, Session } from "@terragon/shared";
import { unwrapResult } from "@/lib/server-actions";
import * as schema from "@terragon/shared/db/schema";

// Helper to call the action and unwrap
const uninstallLinearWorkspace = async (args: { organizationId: string }) => {
  return unwrapResult(await uninstallLinearWorkspaceAction(args));
};

// Helper to create a linear installation for a given installer user
async function createTestLinearInstallation({
  installerUserId,
  organizationId = "test-org-id",
}: {
  installerUserId: string | null;
  organizationId?: string;
}) {
  return upsertLinearInstallation({
    db,
    installation: {
      organizationId,
      organizationName: "Test Org",
      accessTokenEncrypted: "encrypted-access-token",
      refreshTokenEncrypted: "encrypted-refresh-token",
      tokenExpiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24),
      scope: "read,write",
      installerUserId,
      isActive: true,
    },
  });
}

// Helper to enable the linearIntegration feature flag for a user
async function enableLinearFeatureFlag(userId: string) {
  await upsertFeatureFlag({
    db,
    name: "linearIntegration",
    updates: { defaultValue: false },
  });
  await setUserFeatureFlagOverride({
    db,
    userId,
    name: "linearIntegration",
    value: true,
  });
}

describe("uninstallLinearWorkspace", () => {
  let installer: User;
  let installerSession: Session;
  let otherUser: User;
  let otherUserSession: Session;
  const ORG_ID = "test-linear-org";

  beforeEach(async () => {
    vi.clearAllMocks();

    const installerResult = await createTestUser({ db });
    installer = installerResult.user;
    installerSession = installerResult.session;

    const otherResult = await createTestUser({ db });
    otherUser = otherResult.user;
    otherUserSession = otherResult.session;

    // Enable feature flag for both users
    await enableLinearFeatureFlag(installer.id);
    await enableLinearFeatureFlag(otherUser.id);
  });

  it("allows the installer to uninstall", async () => {
    await createTestLinearInstallation({
      installerUserId: installer.id,
      organizationId: ORG_ID,
    });
    await mockLoggedInUser(installerSession);

    await expect(
      uninstallLinearWorkspace({ organizationId: ORG_ID }),
    ).resolves.toBeUndefined();

    // Verify installation is deactivated
    const row = await db.query.linearInstallation.findFirst({
      where: (t, { eq }) => eq(t.organizationId, ORG_ID),
    });
    expect(row?.isActive).toBe(false);
  });

  it("allows an admin to uninstall even when not the installer", async () => {
    await createTestLinearInstallation({
      installerUserId: installer.id,
      organizationId: ORG_ID,
    });

    // Make otherUser an admin
    await db
      .update(schema.user)
      .set({ role: "admin" })
      .where(eq(schema.user.id, otherUser.id));

    await mockLoggedInUser(otherUserSession);

    await expect(
      uninstallLinearWorkspace({ organizationId: ORG_ID }),
    ).resolves.toBeUndefined();

    const row = await db.query.linearInstallation.findFirst({
      where: (t, { eq }) => eq(t.organizationId, ORG_ID),
    });
    expect(row?.isActive).toBe(false);
  });

  it("denies a non-installer non-admin user", async () => {
    await createTestLinearInstallation({
      installerUserId: installer.id,
      organizationId: ORG_ID,
    });
    await mockLoggedInUser(otherUserSession);

    await expect(
      uninstallLinearWorkspace({ organizationId: ORG_ID }),
    ).rejects.toThrow(
      "Only the workspace installer or an admin can uninstall the Linear agent",
    );

    // Installation remains active
    const row = await db.query.linearInstallation.findFirst({
      where: (t, { eq }) => eq(t.organizationId, ORG_ID),
    });
    expect(row?.isActive).toBe(true);
  });

  it("throws when no installation exists", async () => {
    await mockLoggedInUser(installerSession);

    await expect(
      uninstallLinearWorkspace({ organizationId: "nonexistent-org" }),
    ).rejects.toThrow("No active Linear installation found");
  });

  it("throws when user is not authenticated", async () => {
    await mockLoggedOutUser();

    await expect(
      uninstallLinearWorkspace({ organizationId: ORG_ID }),
    ).rejects.toThrow("Unauthorized");
  });
});
