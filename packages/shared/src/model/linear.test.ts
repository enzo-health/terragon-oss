import { beforeEach, describe, expect, it } from "vitest";
import { createTestUser } from "./test-helpers";
import { env } from "@terragon/env/pkg-shared";
import { createDb } from "../db";
import { User } from "../db/types";
import * as schema from "../db/schema";
import {
  getLinearAccountForLinearUserId,
  getLinearAccounts,
  getLinearAccountsWithSettings,
  upsertLinearAccount,
  deleteLinearAccount,
  disconnectLinearAccountAndSettings,
  getLinearSettingsForUserAndOrg,
  upsertLinearSettings,
  deleteLinearSettings,
  getLinearInstallationForOrg,
  upsertLinearInstallation,
  deactivateLinearInstallation,
  updateLinearInstallationTokens,
} from "./linear";
import {
  getThreadByLinearAgentSessionId,
  getThreadByLinearDeliveryId,
} from "./threads";
import type { ThreadSourceMetadata } from "../db/types";

type LinearMentionMetadata = Extract<
  ThreadSourceMetadata,
  { type: "linear-mention" }
>;
import { nanoid } from "nanoid/non-secure";

const db = createDb(env.DATABASE_URL!);

describe("linear", () => {
  let user: User;
  let otherUser: User;
  const organizationId = nanoid(10);
  const otherOrganizationId = nanoid(10);
  const linearUserId = nanoid(10);
  const otherLinearUserId = nanoid(10);

  beforeEach(async () => {
    // Clean up linear tables
    await db.delete(schema.linearSettings);
    await db.delete(schema.linearAccount);

    // Create test users
    const testUserAndAccount = await createTestUser({ db });
    user = testUserAndAccount.user;

    const otherTestUserAndAccount = await createTestUser({ db });
    otherUser = otherTestUserAndAccount.user;
  });

  describe("getLinearAccounts", () => {
    it("should return empty array when user has no linear accounts", async () => {
      const accounts = await getLinearAccounts({ db, userId: user.id });
      expect(accounts).toEqual([]);
    });

    it("should return linear accounts for user", async () => {
      await db.insert(schema.linearAccount).values({
        userId: user.id,
        linearUserId,
        linearUserName: "Test User",
        linearUserEmail: "test@example.com",
        organizationId,
      });

      const accounts = await getLinearAccounts({ db, userId: user.id });

      expect(accounts).toHaveLength(1);
      expect(accounts[0]).toMatchObject({
        userId: user.id,
        linearUserId,
        linearUserName: "Test User",
        linearUserEmail: "test@example.com",
        organizationId,
      });
    });

    it("should only return accounts for the specified user", async () => {
      await db.insert(schema.linearAccount).values({
        userId: user.id,
        linearUserId,
        linearUserName: "User",
        linearUserEmail: "user@example.com",
        organizationId,
      });

      await db.insert(schema.linearAccount).values({
        userId: otherUser.id,
        linearUserId: otherLinearUserId,
        linearUserName: "Other User",
        linearUserEmail: "other@example.com",
        organizationId: otherOrganizationId,
      });

      const accounts = await getLinearAccounts({ db, userId: user.id });

      expect(accounts).toHaveLength(1);
      expect(accounts[0]?.organizationId).toBe(organizationId);
    });
  });

  describe("getLinearAccountForLinearUserId", () => {
    it("should return null when account doesn't exist", async () => {
      const account = await getLinearAccountForLinearUserId({
        db,
        organizationId,
        linearUserId,
      });
      expect(account).toBeNull();
    });

    it("should return the correct linear account", async () => {
      await db.insert(schema.linearAccount).values({
        userId: user.id,
        linearUserId,
        linearUserName: "Test User",
        linearUserEmail: "test@example.com",
        organizationId,
      });

      const account = await getLinearAccountForLinearUserId({
        db,
        organizationId,
        linearUserId,
      });

      expect(account).toMatchObject({
        userId: user.id,
        linearUserId,
        linearUserName: "Test User",
        linearUserEmail: "test@example.com",
        organizationId,
      });
    });

    it("should return correct account for specific organization", async () => {
      const linearUserId1 = nanoid(10);
      const linearUserId2 = nanoid(10);

      await db.insert(schema.linearAccount).values({
        userId: user.id,
        linearUserId: linearUserId1,
        linearUserName: "User 1",
        linearUserEmail: "user1@example.com",
        organizationId,
      });

      await db.insert(schema.linearAccount).values({
        userId: otherUser.id,
        linearUserId: linearUserId2,
        linearUserName: "User 2",
        linearUserEmail: "user2@example.com",
        organizationId,
      });

      const account = await getLinearAccountForLinearUserId({
        db,
        organizationId,
        linearUserId: linearUserId1,
      });

      expect(account?.userId).toBe(user.id);
    });
  });

  describe("upsertLinearAccount", () => {
    it("should create a new linear account", async () => {
      await upsertLinearAccount({
        db,
        userId: user.id,
        organizationId,
        account: {
          linearUserId,
          linearUserName: "New User",
          linearUserEmail: "new@example.com",
        },
      });

      const accounts = await getLinearAccounts({ db, userId: user.id });

      expect(accounts).toHaveLength(1);
      expect(accounts[0]).toMatchObject({
        userId: user.id,
        organizationId,
        linearUserId,
        linearUserName: "New User",
        linearUserEmail: "new@example.com",
      });
    });

    it("should update an existing linear account", async () => {
      await db.insert(schema.linearAccount).values({
        userId: user.id,
        linearUserId,
        linearUserName: "Old Name",
        linearUserEmail: "old@example.com",
        organizationId,
      });

      await upsertLinearAccount({
        db,
        userId: user.id,
        organizationId,
        account: {
          linearUserId: nanoid(10),
          linearUserName: "Updated Name",
          linearUserEmail: "updated@example.com",
        },
      });

      const accounts = await getLinearAccounts({ db, userId: user.id });

      expect(accounts).toHaveLength(1);
      expect(accounts[0]?.linearUserName).toBe("Updated Name");
      expect(accounts[0]?.linearUserEmail).toBe("updated@example.com");
    });
  });

  describe("deleteLinearAccount", () => {
    it("should delete an existing linear account", async () => {
      await db.insert(schema.linearAccount).values({
        userId: user.id,
        linearUserId,
        linearUserName: "Test User",
        linearUserEmail: "test@example.com",
        organizationId,
      });

      let accounts = await getLinearAccounts({ db, userId: user.id });
      expect(accounts).toHaveLength(1);

      await deleteLinearAccount({
        db,
        userId: user.id,
        organizationId,
      });

      accounts = await getLinearAccounts({ db, userId: user.id });
      expect(accounts).toHaveLength(0);
    });

    it("should not affect other users' accounts", async () => {
      await db.insert(schema.linearAccount).values({
        userId: user.id,
        linearUserId,
        linearUserName: "User",
        linearUserEmail: "user@example.com",
        organizationId,
      });

      await db.insert(schema.linearAccount).values({
        userId: otherUser.id,
        linearUserId: otherLinearUserId,
        linearUserName: "Other",
        linearUserEmail: "other@example.com",
        organizationId,
      });

      await deleteLinearAccount({
        db,
        userId: user.id,
        organizationId,
      });

      const otherAccounts = await getLinearAccounts({
        db,
        userId: otherUser.id,
      });
      expect(otherAccounts).toHaveLength(1);
    });
  });

  describe("getLinearSettingsForUserAndOrg", () => {
    it("should return null when settings don't exist", async () => {
      const settings = await getLinearSettingsForUserAndOrg({
        db,
        userId: user.id,
        organizationId,
      });
      expect(settings).toBeNull();
    });

    it("should return the correct linear settings", async () => {
      await db.insert(schema.linearSettings).values({
        userId: user.id,
        organizationId,
        defaultRepoFullName: "test/repo",
        defaultModel: "sonnet",
      });

      const settings = await getLinearSettingsForUserAndOrg({
        db,
        userId: user.id,
        organizationId,
      });

      expect(settings).toMatchObject({
        userId: user.id,
        organizationId,
        defaultRepoFullName: "test/repo",
        defaultModel: "sonnet",
      });
    });

    it("should only return settings for the specified user", async () => {
      await db.insert(schema.linearSettings).values({
        userId: otherUser.id,
        organizationId,
        defaultRepoFullName: "other/repo",
        defaultModel: "opus",
      });

      const settings = await getLinearSettingsForUserAndOrg({
        db,
        userId: user.id,
        organizationId,
      });

      expect(settings).toBeNull();
    });
  });

  describe("upsertLinearSettings", () => {
    it("should create new linear settings", async () => {
      await upsertLinearSettings({
        db,
        userId: user.id,
        organizationId,
        settings: {
          defaultRepoFullName: "test/repo",
          defaultModel: "sonnet",
        },
      });

      const settings = await getLinearSettingsForUserAndOrg({
        db,
        userId: user.id,
        organizationId,
      });

      expect(settings).toMatchObject({
        userId: user.id,
        organizationId,
        defaultRepoFullName: "test/repo",
        defaultModel: "sonnet",
      });
    });

    it("should update existing linear settings", async () => {
      await db.insert(schema.linearSettings).values({
        userId: user.id,
        organizationId,
        defaultRepoFullName: "old/repo",
        defaultModel: "opus",
      });

      await upsertLinearSettings({
        db,
        userId: user.id,
        organizationId,
        settings: {
          defaultRepoFullName: "new/repo",
          defaultModel: "sonnet",
        },
      });

      const settings = await getLinearSettingsForUserAndOrg({
        db,
        userId: user.id,
        organizationId,
      });

      expect(settings?.defaultRepoFullName).toBe("new/repo");
      expect(settings?.defaultModel).toBe("sonnet");
    });

    it("should handle settings with null values", async () => {
      await upsertLinearSettings({
        db,
        userId: user.id,
        organizationId,
        settings: {
          defaultRepoFullName: null,
          defaultModel: "opus",
        },
      });

      const settings = await getLinearSettingsForUserAndOrg({
        db,
        userId: user.id,
        organizationId,
      });

      expect(settings?.defaultRepoFullName).toBeNull();
      expect(settings?.defaultModel).toBe("opus");
    });
  });

  describe("deleteLinearSettings", () => {
    it("should delete existing linear settings", async () => {
      await db.insert(schema.linearSettings).values({
        userId: user.id,
        organizationId,
        defaultRepoFullName: "test/repo",
        defaultModel: "sonnet",
      });

      let settings = await getLinearSettingsForUserAndOrg({
        db,
        userId: user.id,
        organizationId,
      });
      expect(settings).not.toBeNull();

      await deleteLinearSettings({
        db,
        userId: user.id,
        organizationId,
      });

      settings = await getLinearSettingsForUserAndOrg({
        db,
        userId: user.id,
        organizationId,
      });
      expect(settings).toBeNull();
    });

    it("should not affect other users' settings", async () => {
      await db.insert(schema.linearSettings).values({
        userId: user.id,
        organizationId,
        defaultRepoFullName: "user/repo",
        defaultModel: "sonnet",
      });

      await db.insert(schema.linearSettings).values({
        userId: otherUser.id,
        organizationId,
        defaultRepoFullName: "other/repo",
        defaultModel: "opus",
      });

      await deleteLinearSettings({
        db,
        userId: user.id,
        organizationId,
      });

      const otherSettings = await getLinearSettingsForUserAndOrg({
        db,
        userId: otherUser.id,
        organizationId,
      });
      expect(otherSettings).not.toBeNull();
    });
  });

  describe("getLinearAccountsWithSettings", () => {
    it("should return empty array when user has no accounts", async () => {
      const accounts = await getLinearAccountsWithSettings({
        db,
        userId: user.id,
      });
      expect(accounts).toEqual([]);
    });

    it("should return account with null settings when no settings exist", async () => {
      await db.insert(schema.linearAccount).values({
        userId: user.id,
        linearUserId,
        linearUserName: "Test User",
        linearUserEmail: "test@example.com",
        organizationId,
      });

      const accounts = await getLinearAccountsWithSettings({
        db,
        userId: user.id,
      });

      expect(accounts).toHaveLength(1);
      expect(accounts[0]).toMatchObject({
        userId: user.id,
        linearUserId,
        linearUserName: "Test User",
        linearUserEmail: "test@example.com",
        organizationId,
      });
      expect(accounts[0]?.settings).toBeNull();
    });

    it("should return account with joined settings", async () => {
      await db.insert(schema.linearAccount).values({
        userId: user.id,
        linearUserId,
        linearUserName: "Test User",
        linearUserEmail: "test@example.com",
        organizationId,
      });

      await db.insert(schema.linearSettings).values({
        userId: user.id,
        organizationId,
        defaultRepoFullName: "test/repo",
        defaultModel: "sonnet",
      });

      const accounts = await getLinearAccountsWithSettings({
        db,
        userId: user.id,
      });

      expect(accounts).toHaveLength(1);
      expect(accounts[0]?.settings).toMatchObject({
        userId: user.id,
        organizationId,
        defaultRepoFullName: "test/repo",
        defaultModel: "sonnet",
      });
    });

    it("should only return accounts for the specified user", async () => {
      await db.insert(schema.linearAccount).values({
        userId: user.id,
        linearUserId,
        linearUserName: "User",
        linearUserEmail: "user@example.com",
        organizationId,
      });

      await db.insert(schema.linearAccount).values({
        userId: otherUser.id,
        linearUserId: otherLinearUserId,
        linearUserName: "Other",
        linearUserEmail: "other@example.com",
        organizationId: otherOrganizationId,
      });

      const accounts = await getLinearAccountsWithSettings({
        db,
        userId: user.id,
      });

      expect(accounts).toHaveLength(1);
      expect(accounts[0]?.userId).toBe(user.id);
    });
  });

  describe("disconnectLinearAccountAndSettings", () => {
    it("should delete both account and settings in a single transaction", async () => {
      await db.insert(schema.linearAccount).values({
        userId: user.id,
        linearUserId,
        linearUserName: "Test User",
        linearUserEmail: "test@example.com",
        organizationId,
      });

      await db.insert(schema.linearSettings).values({
        userId: user.id,
        organizationId,
        defaultRepoFullName: "test/repo",
        defaultModel: "sonnet",
      });

      await disconnectLinearAccountAndSettings({
        db,
        userId: user.id,
        organizationId,
      });

      const accounts = await getLinearAccounts({ db, userId: user.id });
      expect(accounts).toHaveLength(0);

      const settings = await getLinearSettingsForUserAndOrg({
        db,
        userId: user.id,
        organizationId,
      });
      expect(settings).toBeNull();
    });

    it("should succeed even when no settings exist", async () => {
      await db.insert(schema.linearAccount).values({
        userId: user.id,
        linearUserId,
        linearUserName: "Test User",
        linearUserEmail: "test@example.com",
        organizationId,
      });

      await disconnectLinearAccountAndSettings({
        db,
        userId: user.id,
        organizationId,
      });

      const accounts = await getLinearAccounts({ db, userId: user.id });
      expect(accounts).toHaveLength(0);
    });

    it("should not affect other users' accounts and settings", async () => {
      await db.insert(schema.linearAccount).values({
        userId: user.id,
        linearUserId,
        linearUserName: "User",
        linearUserEmail: "user@example.com",
        organizationId,
      });

      await db.insert(schema.linearAccount).values({
        userId: otherUser.id,
        linearUserId: otherLinearUserId,
        linearUserName: "Other",
        linearUserEmail: "other@example.com",
        organizationId,
      });

      await db.insert(schema.linearSettings).values({
        userId: otherUser.id,
        organizationId,
        defaultRepoFullName: "other/repo",
        defaultModel: "opus",
      });

      await disconnectLinearAccountAndSettings({
        db,
        userId: user.id,
        organizationId,
      });

      const otherAccounts = await getLinearAccounts({
        db,
        userId: otherUser.id,
      });
      expect(otherAccounts).toHaveLength(1);

      const otherSettings = await getLinearSettingsForUserAndOrg({
        db,
        userId: otherUser.id,
        organizationId,
      });
      expect(otherSettings).not.toBeNull();
    });
  });
});

// ── LinearInstallation tests ─────────────────────────────────────────────────

describe("linearInstallation", () => {
  let user: User;
  const orgId = `org_${nanoid(8)}`;
  const otherOrgId = `org_${nanoid(8)}`;

  beforeEach(async () => {
    await db.delete(schema.linearInstallation);
    const { user: u } = await createTestUser({ db });
    user = u;
  });

  describe("upsertLinearInstallation", () => {
    it("inserts a new installation", async () => {
      const installation = await upsertLinearInstallation({
        db,
        installation: {
          organizationId: orgId,
          organizationName: "Acme Corp",
          accessTokenEncrypted: "enc-access-token",
          refreshTokenEncrypted: "enc-refresh-token",
          tokenExpiresAt: new Date("2099-01-01"),
          scope: "read,write",
          installerUserId: user.id,
        },
      });

      expect(installation.organizationId).toBe(orgId);
      expect(installation.organizationName).toBe("Acme Corp");
      expect(installation.isActive).toBe(true);
    });

    it("upserts on conflict (same organizationId)", async () => {
      await upsertLinearInstallation({
        db,
        installation: {
          organizationId: orgId,
          organizationName: "Old Name",
          accessTokenEncrypted: "old-token",
          scope: "read",
        },
      });

      const updated = await upsertLinearInstallation({
        db,
        installation: {
          organizationId: orgId,
          organizationName: "New Name",
          accessTokenEncrypted: "new-token",
          scope: "read,write",
        },
      });

      expect(updated.organizationName).toBe("New Name");
      expect(updated.accessTokenEncrypted).toBe("new-token");
    });

    it("allows null refreshTokenEncrypted", async () => {
      const installation = await upsertLinearInstallation({
        db,
        installation: {
          organizationId: orgId,
          organizationName: "Acme Corp",
          accessTokenEncrypted: "enc-access-token",
          refreshTokenEncrypted: null,
          scope: "read",
        },
      });

      expect(installation.refreshTokenEncrypted).toBeNull();
    });
  });

  describe("getLinearInstallationForOrg", () => {
    it("returns null when not found", async () => {
      const result = await getLinearInstallationForOrg({
        db,
        organizationId: "nonexistent",
      });
      expect(result).toBeNull();
    });

    it("returns the installation for the org", async () => {
      await upsertLinearInstallation({
        db,
        installation: {
          organizationId: orgId,
          organizationName: "Acme Corp",
          accessTokenEncrypted: "token",
          scope: "read",
        },
      });

      const result = await getLinearInstallationForOrg({
        db,
        organizationId: orgId,
      });

      expect(result).not.toBeNull();
      expect(result!.organizationId).toBe(orgId);
    });

    it("does not return installation for another org", async () => {
      await upsertLinearInstallation({
        db,
        installation: {
          organizationId: orgId,
          organizationName: "Acme Corp",
          accessTokenEncrypted: "token",
          scope: "read",
        },
      });

      const result = await getLinearInstallationForOrg({
        db,
        organizationId: otherOrgId,
      });
      expect(result).toBeNull();
    });
  });

  describe("deactivateLinearInstallation", () => {
    it("sets isActive to false", async () => {
      await upsertLinearInstallation({
        db,
        installation: {
          organizationId: orgId,
          organizationName: "Acme Corp",
          accessTokenEncrypted: "token",
          scope: "read",
        },
      });

      await deactivateLinearInstallation({ db, organizationId: orgId });

      const result = await getLinearInstallationForOrg({
        db,
        organizationId: orgId,
      });
      expect(result!.isActive).toBe(false);
    });
  });

  describe("updateLinearInstallationTokens", () => {
    it("updates tokens when CAS condition matches", async () => {
      const expiresAt = new Date("2099-01-01T00:00:00Z");
      await upsertLinearInstallation({
        db,
        installation: {
          organizationId: orgId,
          organizationName: "Acme Corp",
          accessTokenEncrypted: "old-token",
          tokenExpiresAt: expiresAt,
          scope: "read",
        },
      });

      const { updated } = await updateLinearInstallationTokens({
        db,
        organizationId: orgId,
        accessTokenEncrypted: "new-token",
        tokenExpiresAt: new Date("2099-02-01T00:00:00Z"),
        previousTokenExpiresAt: expiresAt,
      });

      expect(updated).toBe(true);
      const result = await getLinearInstallationForOrg({
        db,
        organizationId: orgId,
      });
      expect(result!.accessTokenEncrypted).toBe("new-token");
    });

    it("does not update when CAS condition does not match (concurrent refresh)", async () => {
      const expiresAt = new Date("2099-01-01T00:00:00Z");
      const differentExpiresAt = new Date("2099-01-02T00:00:00Z");
      await upsertLinearInstallation({
        db,
        installation: {
          organizationId: orgId,
          organizationName: "Acme Corp",
          accessTokenEncrypted: "current-token",
          tokenExpiresAt: expiresAt,
          scope: "read",
        },
      });

      const { updated } = await updateLinearInstallationTokens({
        db,
        organizationId: orgId,
        accessTokenEncrypted: "stale-token",
        tokenExpiresAt: new Date("2099-03-01T00:00:00Z"),
        previousTokenExpiresAt: differentExpiresAt, // doesn't match current
      });

      expect(updated).toBe(false);
      const result = await getLinearInstallationForOrg({
        db,
        organizationId: orgId,
      });
      expect(result!.accessTokenEncrypted).toBe("current-token");
    });

    it("updates without CAS guard when previousTokenExpiresAt is omitted", async () => {
      await upsertLinearInstallation({
        db,
        installation: {
          organizationId: orgId,
          organizationName: "Acme Corp",
          accessTokenEncrypted: "old-token",
          scope: "read",
        },
      });

      const { updated } = await updateLinearInstallationTokens({
        db,
        organizationId: orgId,
        accessTokenEncrypted: "new-token",
        tokenExpiresAt: new Date("2099-01-01T00:00:00Z"),
      });

      expect(updated).toBe(true);
    });
  });
});

// ── Thread JSONB query helpers ───────────────────────────────────────────────

describe("getThreadByLinearAgentSessionId / getThreadByLinearDeliveryId", () => {
  let user: User;

  beforeEach(async () => {
    await db.delete(schema.thread);
    const { user: u } = await createTestUser({ db });
    user = u;
  });

  it("returns null when no thread has the agentSessionId", async () => {
    const result = await getThreadByLinearAgentSessionId({
      db,
      agentSessionId: "session-xyz",
    });
    expect(result).toBeNull();
  });

  it("finds a thread by agentSessionId", async () => {
    const agentSessionId = `session-${nanoid(8)}`;
    await db.insert(schema.thread).values({
      userId: user.id,
      name: "Linear thread",
      githubRepoFullName: "acme/repo",
      repoBaseBranchName: "main",
      sourceType: "linear-mention",
      sourceMetadata: {
        type: "linear-mention",
        agentSessionId,
        organizationId: "org-123",
        issueId: "issue-1",
        issueIdentifier: "ENG-1",
        issueUrl: "https://linear.app/acme/issue/ENG-1",
      },
    });

    const result = await getThreadByLinearAgentSessionId({
      db,
      agentSessionId,
    });
    expect(result).not.toBeNull();
    const meta = result!.sourceMetadata as LinearMentionMetadata;
    expect(meta.agentSessionId).toBe(agentSessionId);
  });

  it("scopes lookup by organizationId when provided", async () => {
    const agentSessionId = `session-${nanoid(8)}`;
    await db.insert(schema.thread).values({
      userId: user.id,
      name: "Linear thread",
      githubRepoFullName: "acme/repo",
      repoBaseBranchName: "main",
      sourceType: "linear-mention",
      sourceMetadata: {
        type: "linear-mention",
        agentSessionId,
        organizationId: "org-correct",
        issueId: "issue-1",
        issueIdentifier: "ENG-1",
        issueUrl: "https://linear.app/acme/issue/ENG-1",
      },
    });

    const found = await getThreadByLinearAgentSessionId({
      db,
      agentSessionId,
      organizationId: "org-correct",
    });
    expect(found).not.toBeNull();

    const notFound = await getThreadByLinearAgentSessionId({
      db,
      agentSessionId,
      organizationId: "org-wrong",
    });
    expect(notFound).toBeNull();
  });

  it("returns null when no thread has the deliveryId", async () => {
    const result = await getThreadByLinearDeliveryId({
      db,
      deliveryId: "delivery-xyz",
    });
    expect(result).toBeNull();
  });

  it("finds a thread by linearDeliveryId", async () => {
    const linearDeliveryId = `delivery-${nanoid(8)}`;
    await db.insert(schema.thread).values({
      userId: user.id,
      name: "Linear thread",
      githubRepoFullName: "acme/repo",
      repoBaseBranchName: "main",
      sourceType: "linear-mention",
      sourceMetadata: {
        type: "linear-mention",
        linearDeliveryId,
        organizationId: "org-123",
        issueId: "issue-1",
        issueIdentifier: "ENG-1",
        issueUrl: "https://linear.app/acme/issue/ENG-1",
      },
    });

    const result = await getThreadByLinearDeliveryId({
      db,
      deliveryId: linearDeliveryId,
    });
    expect(result).not.toBeNull();
    const meta = result!.sourceMetadata as LinearMentionMetadata;
    expect(meta.linearDeliveryId).toBe(linearDeliveryId);
  });
});
