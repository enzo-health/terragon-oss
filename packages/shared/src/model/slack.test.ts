import { beforeEach, describe, expect, it } from "vitest";
import { createTestUser } from "./test-helpers";
import { env } from "@terragon/env/pkg-shared";
import { createDb } from "../db";
import { User } from "../db/types";
import * as schema from "../db/schema";
import {
  getSlackAccounts,
  getSlackAccountForSlackUserId,
  getSlackAccountForTeam,
  getSlackSettingsForTeam,
  upsertSlackAccount,
  deleteSlackAccount,
  getSlackInstallationForTeam,
  upsertSlackInstallation,
  upsertSlackSettings,
  claimSlackTaskDelivery,
  completeSlackTaskDelivery,
  markSlackTaskDeliveryFailed,
} from "./slack";
import { nanoid } from "nanoid/non-secure";

const db = createDb(env.DATABASE_URL!);

describe("slack", () => {
  let user: User;
  let otherUser: User;
  const teamId = `T${nanoid(10)}`;
  const otherTeamId = `T${nanoid(10)}`;
  const slackUserId = `U${nanoid(10)}`;
  const otherSlackUserId = `U${nanoid(10)}`;

  beforeEach(async () => {
    // Clean up slack tables
    await db.delete(schema.slackTaskDeliveries);
    await db.delete(schema.slackSettings);
    await db.delete(schema.slackAccount);
    await db.delete(schema.slackInstallation);

    // Create test users
    const testUserAndAccount = await createTestUser({ db });
    user = testUserAndAccount.user;

    const otherTestUserAndAccount = await createTestUser({ db });
    otherUser = otherTestUserAndAccount.user;
  });

  async function insertSlackAccount({
    targetUser = user,
    targetTeamId = teamId,
    targetSlackUserId = slackUserId,
  }: {
    targetUser?: User;
    targetTeamId?: string;
    targetSlackUserId?: string;
  } = {}) {
    await db.insert(schema.slackAccount).values({
      userId: targetUser.id,
      teamId: targetTeamId,
      slackUserId: targetSlackUserId,
      slackTeamName: "Test Team",
      slackTeamDomain: "test-team",
      accessTokenEncrypted: "encrypted-token",
    });
  }

  describe("getSlackAccounts", () => {
    it("should return empty array when user has no slack accounts", async () => {
      const accounts = await getSlackAccounts({ db, userId: user.id });
      expect(accounts).toEqual([]);
    });

    it("should return slack accounts with installation and settings", async () => {
      // Create slack account
      await db.insert(schema.slackAccount).values({
        userId: user.id,
        teamId,
        slackUserId,
        slackTeamName: "Test Team",
        slackTeamDomain: "test-team",
        accessTokenEncrypted: "encrypted-token",
      });

      // Create slack installation
      await db.insert(schema.slackInstallation).values({
        teamId,
        teamName: "Test Team",
        botUserId: "B123",
        botAccessTokenEncrypted: "encrypted-xoxb-123",
        scope: "app_mentions:read,chat:write",
        appId: "A123",
      });

      // Create slack settings
      await db.insert(schema.slackSettings).values({
        userId: user.id,
        teamId,
        defaultRepoFullName: "test/repo",
        defaultModel: "sonnet",
      });

      const accounts = await getSlackAccounts({ db, userId: user.id });

      expect(accounts).toHaveLength(1);
      expect(accounts[0]).toMatchObject({
        userId: user.id,
        teamId,
        slackUserId,
        slackTeamName: "Test Team",
        slackTeamDomain: "test-team",
        installation: expect.objectContaining({
          teamId,
          botUserId: "B123",
        }),
        settings: expect.objectContaining({
          userId: user.id,
          teamId,
          defaultRepoFullName: "test/repo",
          defaultModel: "sonnet",
        }),
      });
      expect(accounts[0]).not.toHaveProperty("accessTokenEncrypted");
      expect(accounts[0]?.installation).not.toHaveProperty(
        "botAccessTokenEncrypted",
      );
      expect(accounts[0]?.installation).not.toHaveProperty("installerUserId");
    });

    it("should only return accounts for the specified user", async () => {
      // Create account for user
      await db.insert(schema.slackAccount).values({
        userId: user.id,
        teamId,
        slackUserId,
        slackTeamName: "User Team",
        slackTeamDomain: "user-team",
        accessTokenEncrypted: "encrypted-token",
      });

      // Create account for other user
      await db.insert(schema.slackAccount).values({
        userId: otherUser.id,
        teamId: otherTeamId,
        slackUserId: otherSlackUserId,
        slackTeamName: "Other Team",
        slackTeamDomain: "other-team",
        accessTokenEncrypted: "encrypted-token",
      });

      const accounts = await getSlackAccounts({ db, userId: user.id });

      expect(accounts).toHaveLength(1);
      expect(accounts[0]?.teamId).toBe(teamId);
    });
  });

  describe("getSlackAccountForSlackUserId", () => {
    it("should return null when account doesn't exist", async () => {
      const account = await getSlackAccountForSlackUserId({
        db,
        teamId,
        slackUserId,
      });
      expect(account).toBeNull();
    });

    it("should return the correct slack account", async () => {
      await db.insert(schema.slackAccount).values({
        userId: user.id,
        teamId,
        slackUserId,
        slackTeamName: "Test Team",
        slackTeamDomain: "test-team",
        accessTokenEncrypted: "encrypted-token",
      });

      const account = await getSlackAccountForSlackUserId({
        db,
        teamId,
        slackUserId,
      });

      expect(account).toMatchObject({
        userId: user.id,
        teamId,
        slackUserId,
        slackTeamName: "Test Team",
        slackTeamDomain: "test-team",
        accessTokenEncrypted: "encrypted-token",
      });
    });

    it("should return correct account for specific team", async () => {
      // Create accounts for different slack users in same team
      const slackUserId1 = `U${nanoid(10)}`;
      const slackUserId2 = `U${nanoid(10)}`;

      await db.insert(schema.slackAccount).values({
        userId: user.id,
        teamId,
        slackUserId: slackUserId1,
        slackTeamName: "Team 1",
        slackTeamDomain: "team-1",
        accessTokenEncrypted: "encrypted-token",
      });

      await db.insert(schema.slackAccount).values({
        userId: otherUser.id,
        teamId,
        slackUserId: slackUserId2,
        slackTeamName: "Team 1",
        slackTeamDomain: "team-1",
        accessTokenEncrypted: "encrypted-token-2",
      });

      const account = await getSlackAccountForSlackUserId({
        db,
        teamId,
        slackUserId: slackUserId1,
      });

      expect(account?.userId).toBe(user.id);
      expect(account?.slackTeamName).toBe("Team 1");
    });
  });

  describe("getSlackAccountForTeam", () => {
    it("should return null when account doesn't exist", async () => {
      const account = await getSlackAccountForTeam({
        db,
        userId: user.id,
        teamId,
      });
      expect(account).toBeNull();
    });

    it("should return the correct slack account for user and team", async () => {
      await db.insert(schema.slackAccount).values({
        userId: user.id,
        teamId,
        slackUserId,
        slackTeamName: "Test Team",
        slackTeamDomain: "test-team",
        accessTokenEncrypted: "encrypted-token",
      });

      const account = await getSlackAccountForTeam({
        db,
        userId: user.id,
        teamId,
      });

      expect(account).toMatchObject({
        userId: user.id,
        teamId,
        slackUserId,
        slackTeamName: "Test Team",
        slackTeamDomain: "test-team",
        accessTokenEncrypted: "encrypted-token",
      });
    });

    it("should only return account for the specified user", async () => {
      // Create account for different user, same team
      await db.insert(schema.slackAccount).values({
        userId: otherUser.id,
        teamId,
        slackUserId: otherSlackUserId,
        slackTeamName: "Test Team",
        slackTeamDomain: "test-team",
        accessTokenEncrypted: "encrypted-token",
      });

      const account = await getSlackAccountForTeam({
        db,
        userId: user.id,
        teamId,
      });

      expect(account).toBeNull();
    });
  });

  describe("getSlackSettingsForTeam", () => {
    it("should return null when settings don't exist", async () => {
      const settings = await getSlackSettingsForTeam({
        db,
        userId: user.id,
        teamId,
      });
      expect(settings).toBeNull();
    });

    it("should return the correct slack settings", async () => {
      await db.insert(schema.slackSettings).values({
        userId: user.id,
        teamId,
        defaultRepoFullName: "test/repo",
        defaultModel: "sonnet",
      });

      const settings = await getSlackSettingsForTeam({
        db,
        userId: user.id,
        teamId,
      });

      expect(settings).toMatchObject({
        userId: user.id,
        teamId,
        defaultRepoFullName: "test/repo",
        defaultModel: "sonnet",
      });
    });

    it("should only return settings for the specified user", async () => {
      // Create settings for different user, same team
      await db.insert(schema.slackSettings).values({
        userId: otherUser.id,
        teamId,
        defaultRepoFullName: "other/repo",
        defaultModel: "opus",
      });

      const settings = await getSlackSettingsForTeam({
        db,
        userId: user.id,
        teamId,
      });

      expect(settings).toBeNull();
    });
  });

  describe("upsertSlackAccount", () => {
    it("should create a new slack account", async () => {
      await upsertSlackAccount({
        db,
        userId: user.id,
        teamId,
        account: {
          slackUserId,
          slackTeamName: "New Team",
          slackTeamDomain: "new-team",
          accessTokenEncrypted: "encrypted-token",
        },
      });

      const account = await getSlackAccountForTeam({
        db,
        userId: user.id,
        teamId,
      });

      expect(account).toMatchObject({
        userId: user.id,
        teamId,
        slackUserId,
        slackTeamName: "New Team",
        slackTeamDomain: "new-team",
        accessTokenEncrypted: "encrypted-token",
      });
    });

    it("should update an existing slack account", async () => {
      // Create initial account
      await db.insert(schema.slackAccount).values({
        userId: user.id,
        teamId,
        slackUserId,
        slackTeamName: "Old Team",
        slackTeamDomain: "old-team",
        accessTokenEncrypted: "encrypted-token",
      });

      // Update the account
      await upsertSlackAccount({
        db,
        userId: user.id,
        teamId,
        account: {
          slackUserId: `U${nanoid(10)}`,
          slackTeamName: "Updated Team",
          slackTeamDomain: "updated-team",
          accessTokenEncrypted: "encrypted-updated-token",
        },
      });

      const account = await getSlackAccountForTeam({
        db,
        userId: user.id,
        teamId,
      });

      expect(account?.slackTeamName).toBe("Updated Team");
      expect(account?.slackTeamDomain).toBe("updated-team");
      expect(account?.accessTokenEncrypted).toBe("encrypted-updated-token");
    });

    it("should allow the same Slack user id in different teams", async () => {
      await upsertSlackAccount({
        db,
        userId: user.id,
        teamId,
        account: {
          slackUserId,
          slackTeamName: "First Team",
          slackTeamDomain: "first-team",
          accessTokenEncrypted: "encrypted-token",
        },
      });
      await upsertSlackAccount({
        db,
        userId: otherUser.id,
        teamId: otherTeamId,
        account: {
          slackUserId,
          slackTeamName: "Second Team",
          slackTeamDomain: "second-team",
          accessTokenEncrypted: "encrypted-token-2",
        },
      });

      const firstAccount = await getSlackAccountForSlackUserId({
        db,
        teamId,
        slackUserId,
      });
      const secondAccount = await getSlackAccountForSlackUserId({
        db,
        teamId: otherTeamId,
        slackUserId,
      });

      expect(firstAccount?.userId).toBe(user.id);
      expect(secondAccount?.userId).toBe(otherUser.id);
    });
  });

  describe("deleteSlackAccount", () => {
    it("should delete an existing slack account", async () => {
      // Create account
      await db.insert(schema.slackAccount).values({
        userId: user.id,
        teamId,
        slackUserId,
        slackTeamName: "Test Team",
        slackTeamDomain: "test-team",
        accessTokenEncrypted: "encrypted-token",
      });

      // Verify it exists
      let account = await getSlackAccountForTeam({
        db,
        userId: user.id,
        teamId,
      });
      expect(account).not.toBeNull();

      // Delete the account
      await deleteSlackAccount({
        db,
        userId: user.id,
        teamId,
      });

      // Verify it's deleted
      account = await getSlackAccountForTeam({
        db,
        userId: user.id,
        teamId,
      });
      expect(account).toBeNull();
    });

    it("should delete settings for the disconnected account", async () => {
      await insertSlackAccount();
      await db.insert(schema.slackSettings).values({
        userId: user.id,
        teamId,
        defaultRepoFullName: "test/repo",
        defaultModel: "sonnet",
      });

      await deleteSlackAccount({
        db,
        userId: user.id,
        teamId,
      });

      const settings = await getSlackSettingsForTeam({
        db,
        userId: user.id,
        teamId,
      });
      expect(settings).toBeNull();
    });

    it("should not affect other users' accounts", async () => {
      // Create accounts for both users
      await db.insert(schema.slackAccount).values({
        userId: user.id,
        teamId,
        slackUserId,
        slackTeamName: "User Team",
        slackTeamDomain: "user-team",
        accessTokenEncrypted: "encrypted-token",
      });

      await db.insert(schema.slackAccount).values({
        userId: otherUser.id,
        teamId,
        slackUserId: otherSlackUserId,
        slackTeamName: "Other User Team",
        slackTeamDomain: "other-user-team",
        accessTokenEncrypted: "encrypted-token",
      });

      // Delete first user's account
      await deleteSlackAccount({
        db,
        userId: user.id,
        teamId,
      });

      // Other user's account should still exist
      const otherAccount = await getSlackAccountForTeam({
        db,
        userId: otherUser.id,
        teamId,
      });
      expect(otherAccount).not.toBeNull();
    });
  });

  describe("getSlackInstallationForTeam", () => {
    it("should return null when installation doesn't exist", async () => {
      const installation = await getSlackInstallationForTeam({
        db,
        teamId,
      });
      expect(installation).toBeNull();
    });

    it("should return the correct slack installation", async () => {
      await db.insert(schema.slackInstallation).values({
        teamId,
        teamName: "Test Team",
        botUserId: "B123",
        botAccessTokenEncrypted: "encrypted-xoxb-123",
        scope: "app_mentions:read,chat:write",
        appId: "A123",
      });

      const installation = await getSlackInstallationForTeam({
        db,
        teamId,
      });

      expect(installation).toMatchObject({
        teamId,
        teamName: "Test Team",
        botUserId: "B123",
        botAccessTokenEncrypted: "encrypted-xoxb-123",
        scope: "app_mentions:read,chat:write",
        appId: "A123",
      });
    });
  });

  describe("upsertSlackInstallation", () => {
    it("should throw error if user is not part of the team", async () => {
      await expect(
        upsertSlackInstallation({
          db,
          userId: user.id,
          teamId,
          installation: {
            teamName: "Test Team",
            botUserId: "B123",
            botAccessTokenEncrypted: "encrypted-xoxb-123",
            scope: "app_mentions:read,chat:write",
            appId: "A123",
          },
        }),
      ).rejects.toThrow("User is not part of this team");
    });

    it("should create a new slack installation", async () => {
      // First create a slack account for the user
      await db.insert(schema.slackAccount).values({
        userId: user.id,
        teamId,
        slackUserId,
        slackTeamName: "Test Team",
        slackTeamDomain: "test-team",
        accessTokenEncrypted: "encrypted-token",
      });

      // Now create installation
      await upsertSlackInstallation({
        db,
        userId: user.id,
        teamId,
        installation: {
          teamName: "Test Team",
          botUserId: "B123",
          botAccessTokenEncrypted: "encrypted-xoxb-123",
          scope: "app_mentions:read,chat:write",
          appId: "A123",
        },
      });

      const installation = await getSlackInstallationForTeam({
        db,
        teamId,
      });

      expect(installation).toMatchObject({
        teamId,
        teamName: "Test Team",
        botUserId: "B123",
        botAccessTokenEncrypted: "encrypted-xoxb-123",
        scope: "app_mentions:read,chat:write",
        appId: "A123",
      });
    });

    it("should update an existing slack installation", async () => {
      // Create slack account
      await db.insert(schema.slackAccount).values({
        userId: user.id,
        teamId,
        slackUserId,
        slackTeamName: "Test Team",
        slackTeamDomain: "test-team",
        accessTokenEncrypted: "encrypted-token",
      });

      // Create initial installation
      await db.insert(schema.slackInstallation).values({
        teamId,
        teamName: "Old Team",
        botUserId: "B123",
        botAccessTokenEncrypted: "encrypted-xoxb-old",
        scope: "app_mentions:read",
        appId: "A123",
      });

      // Update the installation
      await upsertSlackInstallation({
        db,
        userId: user.id,
        teamId,
        installation: {
          teamName: "Updated Team",
          botUserId: "B456",
          botAccessTokenEncrypted: "encrypted-xoxb-new",
          scope: "app_mentions:read,chat:write,users:read",
          appId: "A456",
        },
      });

      const installation = await getSlackInstallationForTeam({
        db,
        teamId,
      });

      expect(installation?.teamName).toBe("Updated Team");
      expect(installation?.botUserId).toBe("B456");
      expect(installation?.botAccessTokenEncrypted).toBe("encrypted-xoxb-new");
    });
  });

  describe("upsertSlackSettings", () => {
    it("should create new slack settings", async () => {
      await insertSlackAccount();

      await upsertSlackSettings({
        db,
        userId: user.id,
        teamId,
        settings: {
          defaultRepoFullName: "test/repo",
          defaultModel: "sonnet",
        },
      });

      const settings = await getSlackSettingsForTeam({
        db,
        userId: user.id,
        teamId,
      });

      expect(settings).toMatchObject({
        userId: user.id,
        teamId,
        defaultRepoFullName: "test/repo",
        defaultModel: "sonnet",
      });
    });

    it("should update existing slack settings", async () => {
      await insertSlackAccount();

      // Create initial settings
      await db.insert(schema.slackSettings).values({
        userId: user.id,
        teamId,
        defaultRepoFullName: "old/repo",
        defaultModel: "opus",
      });

      // Update the settings
      await upsertSlackSettings({
        db,
        userId: user.id,
        teamId,
        settings: {
          defaultRepoFullName: "new/repo",
          defaultModel: "sonnet",
        },
      });

      const settings = await getSlackSettingsForTeam({
        db,
        userId: user.id,
        teamId,
      });

      expect(settings?.defaultRepoFullName).toBe("new/repo");
      expect(settings?.defaultModel).toBe("sonnet");
    });

    it("should handle settings with null values", async () => {
      await insertSlackAccount();

      await upsertSlackSettings({
        db,
        userId: user.id,
        teamId,
        settings: {
          defaultRepoFullName: null,
          defaultModel: "opus",
        },
      });

      const settings = await getSlackSettingsForTeam({
        db,
        userId: user.id,
        teamId,
      });

      expect(settings?.defaultRepoFullName).toBeNull();
      expect(settings?.defaultModel).toBe("opus");
    });

    it("should reject settings for a Slack team the user has not linked", async () => {
      await expect(
        upsertSlackSettings({
          db,
          userId: user.id,
          teamId,
          settings: {
            defaultRepoFullName: "test/repo",
            defaultModel: "sonnet",
          },
        }),
      ).rejects.toThrow("Slack account is not linked");
    });
  });

  describe("Slack task delivery claims", () => {
    it("should claim a Slack message once and then reject duplicates", async () => {
      const firstClaim = await claimSlackTaskDelivery({
        db,
        teamId,
        channel: "C123",
        messageTs: "1234567890.123456",
        slackEventId: "Ev123",
      });
      const duplicateClaim = await claimSlackTaskDelivery({
        db,
        teamId,
        channel: "C123",
        messageTs: "1234567890.123456",
        slackEventId: "Ev456",
      });

      expect(firstClaim.claimed).toBe(true);
      expect(firstClaim.claimantToken).toEqual(expect.any(String));
      expect(firstClaim.deliveryKey).toBe(`${teamId}:C123:1234567890.123456`);
      expect(duplicateClaim.claimed).toBe(false);
    });

    it("should keep completed Slack deliveries closed to retries", async () => {
      await claimSlackTaskDelivery({
        db,
        teamId,
        channel: "C123",
        messageTs: "1234567890.123456",
        slackEventId: "Ev123",
      });
      await completeSlackTaskDelivery({
        db,
        teamId,
        channel: "C123",
        messageTs: "1234567890.123456",
        threadId: "thread-123",
      });

      const retryClaim = await claimSlackTaskDelivery({
        db,
        teamId,
        channel: "C123",
        messageTs: "1234567890.123456",
        slackEventId: "Ev456",
      });

      expect(retryClaim.claimed).toBe(false);
      const delivery = await db.query.slackTaskDeliveries.findFirst({
        where: (table, { eq }) =>
          eq(table.deliveryKey, `${teamId}:C123:1234567890.123456`),
      });
      expect(delivery?.threadId).toBe("thread-123");
      expect(delivery?.completedAt).toBeInstanceOf(Date);
    });

    it("should complete action-keyed deliveries using the claimed key", async () => {
      const claim = await claimSlackTaskDelivery({
        db,
        teamId,
        channel: "C123",
        messageTs: "1234567890.123456",
        slackEventId: "Ev123",
        action: "command",
        actionId: "mute",
        actorSlackUserId: slackUserId,
        actionTs: "1234567890.123456",
      });

      await completeSlackTaskDelivery({
        db,
        teamId,
        channel: "C123",
        messageTs: "1234567890.123456",
        deliveryKey: claim.deliveryKey,
        claimantToken: claim.claimantToken,
        threadId: "thread-123",
      });

      const retryClaim = await claimSlackTaskDelivery({
        db,
        teamId,
        channel: "C123",
        messageTs: "1234567890.123456",
        slackEventId: "Ev456",
        action: "command",
        actionId: "mute",
        actorSlackUserId: slackUserId,
        actionTs: "1234567890.123456",
      });
      const baseDelivery = await db.query.slackTaskDeliveries.findFirst({
        where: (table, { eq }) =>
          eq(table.deliveryKey, `${teamId}:C123:1234567890.123456`),
      });
      const actionDelivery = await db.query.slackTaskDeliveries.findFirst({
        where: (table, { eq }) => eq(table.deliveryKey, claim.deliveryKey),
      });

      expect(claim.claimed).toBe(true);
      expect(retryClaim.claimed).toBe(false);
      expect(baseDelivery).toBeUndefined();
      expect(actionDelivery?.status).toBe("completed");
      expect(actionDelivery?.threadId).toBe("thread-123");
    });

    it("should mark claimed Slack deliveries as failed", async () => {
      const claim = await claimSlackTaskDelivery({
        db,
        teamId,
        channel: "C123",
        messageTs: "1234567890.123456",
        slackEventId: "Ev123",
      });

      await markSlackTaskDeliveryFailed({
        db,
        deliveryKey: claim.deliveryKey,
        claimantToken: claim.claimantToken,
        lastError: "slack-attachment-import-failed",
      });

      const retryClaim = await claimSlackTaskDelivery({
        db,
        teamId,
        channel: "C123",
        messageTs: "1234567890.123456",
        slackEventId: "Ev456",
      });
      const delivery = await db.query.slackTaskDeliveries.findFirst({
        where: (table, { eq }) => eq(table.deliveryKey, claim.deliveryKey),
      });

      expect(retryClaim.claimed).toBe(false);
      expect(delivery?.status).toBe("failed");
      expect(delivery?.lastError).toBe("slack-attachment-import-failed");
      expect(delivery?.completedAt).toBeInstanceOf(Date);
    });
  });
});
