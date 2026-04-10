import { beforeEach, describe, expect, it } from "vitest";
import { createTestUser, createTestThread } from "./test-helpers";
import { env } from "@leo/env/pkg-shared";
import { createDb } from "../db";
import { User } from "../db/types";
import { updateThreadVisibility } from "./thread-visibility";
import * as schema from "../db/schema";
import { eq } from "drizzle-orm";

const db = createDb(env.DATABASE_URL!);

describe("thread-visibility", () => {
  let user: User;
  let otherUser: User;

  beforeEach(async () => {
    const testUserAndAccount = await createTestUser({ db });
    user = testUserAndAccount.user;

    const otherTestUserAndAccount = await createTestUser({ db });
    otherUser = otherTestUserAndAccount.user;
  });

  describe("updateThreadVisibility", () => {
    it("should successfully update thread visibility for thread owner", async () => {
      const { threadId } = await createTestThread({ db, userId: user.id });

      // Update visibility to link
      await updateThreadVisibility({
        db,
        userId: user.id,
        threadId,
        visibility: "link",
      });

      // Verify the visibility was inserted
      const visibilityRecord = await db.query.threadVisibility.findFirst({
        where: eq(schema.threadVisibility.threadId, threadId),
      });

      expect(visibilityRecord).toBeDefined();
      expect(visibilityRecord!.threadId).toBe(threadId);
      expect(visibilityRecord!.visibility).toBe("link");
    });

    it("should throw error when thread does not exist", async () => {
      await expect(
        updateThreadVisibility({
          db,
          userId: user.id,
          threadId: "non-existent-thread-id",
          visibility: "link",
        }),
      ).rejects.toThrow("Thread not found");
    });

    it("should throw error when user is not the owner of the thread", async () => {
      const { threadId } = await createTestThread({ db, userId: user.id });

      await expect(
        updateThreadVisibility({
          db,
          userId: otherUser.id,
          threadId,
          visibility: "link",
        }),
      ).rejects.toThrow("Thread not found");
    });

    it("should insert new visibility record when none exists", async () => {
      const { threadId } = await createTestThread({ db, userId: user.id });

      // Verify no visibility record exists initially
      const initialRecord = await db.query.threadVisibility.findFirst({
        where: eq(schema.threadVisibility.threadId, threadId),
      });
      expect(initialRecord).toBeUndefined();

      // Update visibility
      await updateThreadVisibility({
        db,
        userId: user.id,
        threadId,
        visibility: "private",
      });

      // Verify the record was created
      const newRecord = await db.query.threadVisibility.findFirst({
        where: eq(schema.threadVisibility.threadId, threadId),
      });
      expect(newRecord).toBeDefined();
      expect(newRecord!.visibility).toBe("private");
    });

    it("should update existing visibility record on conflict", async () => {
      const { threadId } = await createTestThread({ db, userId: user.id });

      // First update - insert
      await updateThreadVisibility({
        db,
        userId: user.id,
        threadId,
        visibility: "private",
      });

      // Verify initial visibility
      const initialRecord = await db.query.threadVisibility.findFirst({
        where: eq(schema.threadVisibility.threadId, threadId),
      });
      expect(initialRecord!.visibility).toBe("private");

      // Second update - should update the existing record
      await updateThreadVisibility({
        db,
        userId: user.id,
        threadId,
        visibility: "link",
      });

      // Verify the visibility was updated
      const updatedRecord = await db.query.threadVisibility.findFirst({
        where: eq(schema.threadVisibility.threadId, threadId),
      });
      expect(updatedRecord!.visibility).toBe("link");

      // Verify there's still only one record
      const allRecords = await db.query.threadVisibility.findMany({
        where: eq(schema.threadVisibility.threadId, threadId),
      });
      expect(allRecords.length).toBe(1);
    });

    it("should handle multiple threads with different visibilities", async () => {
      const { threadId: thread1Id } = await createTestThread({
        db,
        userId: user.id,
      });
      const { threadId: thread2Id } = await createTestThread({
        db,
        userId: user.id,
      });
      const { threadId: thread3Id } = await createTestThread({
        db,
        userId: user.id,
      });

      // Set different visibilities
      await updateThreadVisibility({
        db,
        userId: user.id,
        threadId: thread1Id,
        visibility: "link",
      });

      await updateThreadVisibility({
        db,
        userId: user.id,
        threadId: thread2Id,
        visibility: "private",
      });

      await updateThreadVisibility({
        db,
        userId: user.id,
        threadId: thread3Id,
        visibility: "repo",
      });

      // Verify each thread has correct visibility
      const visibility1 = await db.query.threadVisibility.findFirst({
        where: eq(schema.threadVisibility.threadId, thread1Id),
      });
      expect(visibility1!.visibility).toBe("link");

      const visibility2 = await db.query.threadVisibility.findFirst({
        where: eq(schema.threadVisibility.threadId, thread2Id),
      });
      expect(visibility2!.visibility).toBe("private");

      const visibility3 = await db.query.threadVisibility.findFirst({
        where: eq(schema.threadVisibility.threadId, thread3Id),
      });
      expect(visibility3!.visibility).toBe("repo");
    });

    it("should handle sequential updates to the same thread", async () => {
      const { threadId } = await createTestThread({ db, userId: user.id });

      // Sequential updates to avoid race conditions without unique constraint
      await updateThreadVisibility({
        db,
        userId: user.id,
        threadId,
        visibility: "link",
      });

      await updateThreadVisibility({
        db,
        userId: user.id,
        threadId,
        visibility: "private",
      });

      await updateThreadVisibility({
        db,
        userId: user.id,
        threadId,
        visibility: "repo",
      });

      // Verify only one record exists
      const allRecords = await db.query.threadVisibility.findMany({
        where: eq(schema.threadVisibility.threadId, threadId),
      });
      expect(allRecords.length).toBe(1);

      // The final visibility should be the last update
      expect(allRecords[0]!.visibility).toBe("repo");
    });

    it("should only validate ownership, not update non-existent columns", async () => {
      const { threadId } = await createTestThread({ db, userId: user.id });

      // The function only checks userId for ownership validation
      await updateThreadVisibility({
        db,
        userId: user.id,
        threadId,
        visibility: "link",
      });

      // Verify the thread itself wasn't modified
      const threadAfter = await db.query.thread.findFirst({
        where: eq(schema.thread.id, threadId),
      });
      expect(threadAfter!.userId).toBe(user.id);
      expect(threadAfter!.id).toBe(threadId);
    });
  });
});
