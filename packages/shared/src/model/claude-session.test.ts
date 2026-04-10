import { describe, it, expect, beforeEach } from "vitest";
import {
  getClaudeSessionCheckpoint,
  upsertClaudeSessionCheckpoint,
} from "./claude-session";
import { createTestUser, createTestThread } from "./test-helpers";
import { createDb, type DB } from "../db";
import { nanoid } from "nanoid/non-secure";
import { env } from "@leo/env/pkg-shared";

describe("claude-session", () => {
  const db: DB = createDb(env.DATABASE_URL);
  let userId: string;
  let threadId: string;

  beforeEach(async () => {
    const testUserAndAccount = await createTestUser({ db });
    userId = testUserAndAccount.user.id;
    const createTestThreadResult = await createTestThread({ db, userId });
    threadId = createTestThreadResult.threadId;
  });

  describe("upsertClaudeSessionCheckpoint", () => {
    it("should retrieve a checkpoint for valid user, thread, and session", async () => {
      const sessionId = nanoid();
      const r2Key = `checkpoint-${nanoid()}`;
      await upsertClaudeSessionCheckpoint({
        db,
        userId,
        threadId,
        sessionId,
        r2Key,
      });
      const checkpoint = await getClaudeSessionCheckpoint({
        db,
        userId,
        threadId,
        sessionId,
      });
      expect(checkpoint).toBeDefined();
      expect(checkpoint!.threadId).toBe(threadId);
      expect(checkpoint!.sessionId).toBe(sessionId);
      expect(checkpoint!.r2Key).toBe(r2Key);
    });

    it("should return null for non-existent checkpoint", async () => {
      const sessionId = nanoid();
      const checkpoint = await getClaudeSessionCheckpoint({
        db,
        userId,
        threadId,
        sessionId,
      });
      expect(checkpoint).toBeNull();
    });

    it("should return null when user doesn't own the thread", async () => {
      const sessionId = nanoid();
      const anotherUser = await createTestUser({ db });
      const { threadId: anotherThreadId } = await createTestThread({
        db,
        userId: anotherUser.user.id,
      });
      await upsertClaudeSessionCheckpoint({
        db,
        userId: anotherUser.user.id,
        threadId: anotherThreadId,
        sessionId,
        r2Key: `checkpoint-${nanoid()}`,
      });
      const checkpoint = await getClaudeSessionCheckpoint({
        db,
        userId,
        threadId: anotherThreadId,
        sessionId,
      });
      expect(checkpoint).toBeNull();
    });

    it("should return the correct checkpoint when multiple exist", async () => {
      const sessionId1 = nanoid();
      const sessionId2 = nanoid();
      const r2Key1 = `checkpoint-${nanoid()}`;
      const r2Key2 = `checkpoint-${nanoid()}`;
      await upsertClaudeSessionCheckpoint({
        db,
        userId,
        threadId,
        sessionId: sessionId1,
        r2Key: r2Key1,
      });
      await upsertClaudeSessionCheckpoint({
        db,
        userId,
        threadId,
        sessionId: sessionId2,
        r2Key: r2Key2,
      });
      const checkpoint1 = await getClaudeSessionCheckpoint({
        db,
        userId,
        threadId,
        sessionId: sessionId1,
      });

      expect(checkpoint1).toBeDefined();
      expect(checkpoint1!.sessionId).toBe(sessionId1);
      expect(checkpoint1!.r2Key).toBe(r2Key1);
      const checkpoint2 = await getClaudeSessionCheckpoint({
        db,
        userId,
        threadId,
        sessionId: sessionId2,
      });
      expect(checkpoint2).toBeDefined();
      expect(checkpoint2!.sessionId).toBe(sessionId2);
      expect(checkpoint2!.r2Key).toBe(r2Key2);
    });
  });

  describe("upsertClaudeSessionCheckpoint", () => {
    it("should throw error when thread doesn't exist", async () => {
      const sessionId = nanoid();
      const r2Key = `checkpoint-${nanoid()}`;
      const nonExistentThreadId = nanoid();
      await expect(
        upsertClaudeSessionCheckpoint({
          db,
          userId,
          threadId: nonExistentThreadId,
          sessionId,
          r2Key,
        }),
      ).rejects.toThrow("Thread not found");
    });

    it("should throw error when user doesn't own the thread", async () => {
      const sessionId = nanoid();
      const r2Key = `checkpoint-${nanoid()}`;
      const anotherUser = await createTestUser({ db });
      await expect(
        upsertClaudeSessionCheckpoint({
          db,
          userId: anotherUser.user.id,
          threadId,
          sessionId,
          r2Key,
        }),
      ).rejects.toThrow("Thread not found");
    });

    it("should update on duplicate sessionId for same thread", async () => {
      const sessionId = nanoid();
      const r2Key1 = `checkpoint-${nanoid()}`;
      const r2Key2 = `checkpoint-${nanoid()}`;
      await upsertClaudeSessionCheckpoint({
        db,
        userId,
        threadId,
        sessionId,
        r2Key: r2Key1,
      });
      await upsertClaudeSessionCheckpoint({
        db,
        userId,
        threadId,
        sessionId,
        r2Key: r2Key2,
      });
      const checkpoint = await getClaudeSessionCheckpoint({
        db,
        userId,
        threadId,
        sessionId,
      });
      expect(checkpoint).toBeDefined();
      expect(checkpoint!.r2Key).toBe(r2Key2);
    });

    it("should allow same sessionId across different threads", async () => {
      const sessionId = nanoid();
      const r2Key1 = `checkpoint-${nanoid()}`;
      const r2Key2 = `checkpoint-${nanoid()}`;

      // Create another thread
      const { threadId: anotherThreadId } = await createTestThread({
        db,
        userId,
      });

      // Create checkpoint for first thread
      await upsertClaudeSessionCheckpoint({
        db,
        userId,
        threadId,
        sessionId,
        r2Key: r2Key1,
      });

      // Create checkpoint for second thread with same sessionId
      await upsertClaudeSessionCheckpoint({
        db,
        userId,
        threadId: anotherThreadId,
        sessionId,
        r2Key: r2Key2,
      });

      // Verify both exist
      const checkpoint1 = await getClaudeSessionCheckpoint({
        db,
        userId,
        threadId,
        sessionId,
      });

      const checkpoint2 = await getClaudeSessionCheckpoint({
        db,
        userId,
        threadId: anotherThreadId,
        sessionId,
      });

      expect(checkpoint1).toBeDefined();
      expect(checkpoint1!.r2Key).toBe(r2Key1);
      expect(checkpoint2).toBeDefined();
      expect(checkpoint2!.r2Key).toBe(r2Key2);
    });
  });
});
