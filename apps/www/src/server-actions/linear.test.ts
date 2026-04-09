import { describe, it, vi, beforeEach, expect } from "vitest";
import { eq } from "drizzle-orm";
import {
  getLinearAccountConnectUrl as getLinearAccountConnectUrlAction,
  uninstallLinearWorkspace as uninstallLinearWorkspaceAction,
} from "./linear";
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
import { decryptValue } from "@terragon/utils/encryption";
import { env } from "@terragon/env/apps-www";

// Helper to call the action and unwrap
const uninstallLinearWorkspace = async (args: { organizationId: string }) => {
  return unwrapResult(await uninstallLinearWorkspaceAction(args));
};

const getLinearAccountConnectUrl = async () => {
  return unwrapResult(await getLinearAccountConnectUrlAction());
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

describe("getLinearAccountConnectUrl", () => {
  let user: User;
  let session: Session;

  beforeEach(async () => {
    vi.clearAllMocks();
    const result = await createTestUser({ db });
    user = result.user;
    session = result.session;
  });

  it("returns a Linear OAuth URL with scope=read, no actor=app, and decryptable account_link state", async () => {
    await enableLinearFeatureFlag(user.id);
    await mockLoggedInUser(session);

    const urlString = await getLinearAccountConnectUrl();
    const url = new URL(urlString);

    // Base URL check
    expect(url.origin + url.pathname).toBe(
      "https://linear.app/oauth/authorize",
    );

    // OAuth params
    expect(url.searchParams.get("client_id")).toBe("LINEAR_CLIENT_ID_TEST");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("read");
    // Critical: this is the per-user identity flow — NO actor=app here.
    // If we regress and pass actor=app, the returned token would be
    // app-scoped and viewer() would return the app instead of the user.
    expect(url.searchParams.get("actor")).toBeNull();
    expect(url.searchParams.get("redirect_uri")).toContain(
      "/api/auth/linear/callback",
    );

    // State must decrypt to an account_link payload for the current user
    const rawState = url.searchParams.get("state");
    expect(rawState).not.toBeNull();
    const decrypted = decryptValue(rawState!, env.ENCRYPTION_MASTER_KEY);
    const parsed = JSON.parse(decrypted) as {
      userId: string;
      timestamp: number;
      type: string;
    };
    expect(parsed.userId).toBe(user.id);
    expect(parsed.type).toBe("account_link");
    // Timestamp should be recent (within the last minute)
    const age = Date.now() - parsed.timestamp;
    expect(age).toBeGreaterThanOrEqual(0);
    expect(age).toBeLessThan(60_000);
  });

  it("throws when the linearIntegration feature flag is disabled", async () => {
    // Do NOT enable the feature flag for this user
    await upsertFeatureFlag({
      db,
      name: "linearIntegration",
      updates: { defaultValue: false },
    });
    await mockLoggedInUser(session);

    await expect(getLinearAccountConnectUrl()).rejects.toThrow(
      "Linear integration is not enabled",
    );
  });

  it("throws when the user is not authenticated", async () => {
    await mockLoggedOutUser();

    await expect(getLinearAccountConnectUrl()).rejects.toThrow("Unauthorized");
  });
});
