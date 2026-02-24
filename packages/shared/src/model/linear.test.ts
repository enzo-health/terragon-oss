import { beforeEach, describe, expect, it } from "vitest";
import { createTestUser } from "./test-helpers";
import { env } from "@terragon/env/pkg-shared";
import { createDb } from "../db";
import { User } from "../db/types";
import * as schema from "../db/schema";
import {
  getLinearAccountForLinearUserId,
  getLinearAccounts,
  upsertLinearAccount,
  deleteLinearAccount,
  getLinearSettingsForUserAndOrg,
  upsertLinearSettings,
  deleteLinearSettings,
} from "./linear";
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
});
