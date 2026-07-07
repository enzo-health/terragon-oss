import { describe, expect, it, vi, beforeEach } from "vitest";
import { maybeBatchThreads } from "./batch-threads";
import { redis } from "./redis";
import { nanoid } from "nanoid/non-secure";

describe("maybeBatchThreads", () => {
  const userId = "test-user-id";
  let batchKey: string;

  beforeEach(() => {
    batchKey = nanoid();
  });

  it("creates a new thread when no key exists", async () => {
    const threadId = nanoid();
    const threadChatId = nanoid();
    const createNewThread = vi.fn(async () => ({ threadId, threadChatId }));

    const result = await maybeBatchThreads({
      userId,
      batchKey,
      expiresSecs: 60,
      maxWaitTimeMs: 5000,
      createNewThread,
    });

    expect(result.threadId).toBe(threadId);
    expect(result.threadChatId).toBe(threadChatId);
    expect(result.didCreateNewThread).toBe(true);
    expect(createNewThread).toHaveBeenCalledOnce();

    // Key should be set with the threadId
    const key = `thread-batch:${userId}:${batchKey}`;
    const value = await redis.get(key);
    expect(value).toBe(`${threadId}/${threadChatId}`);

    // Cleanup
    await redis.del(key);
  });

  it("returns existing threadId when key has a threadId", async () => {
    const threadId = nanoid();
    const threadChatId = nanoid();
    const key = `thread-batch:${userId}:${batchKey}`;

    // Pre-set the key with a threadId and threadChatId
    await redis.set(key, `${threadId}/${threadChatId}`, { ex: 60 });

    const createNewThread = vi.fn(async () => {
      throw new Error("should-not-be-called");
    });

    const result = await maybeBatchThreads({
      userId,
      batchKey,
      expiresSecs: 60,
      maxWaitTimeMs: 5000,
      createNewThread,
    });

    expect(result.threadId).toBe(threadId);
    expect(result.threadChatId).toBe(threadChatId);
    expect(result.didCreateNewThread).toBe(false);
    expect(createNewThread).not.toHaveBeenCalled();

    // Cleanup
    await redis.del(key);
  });

  it("handles concurrent requests - one creates, the other waits and gets same threadId", async () => {
    const threadId1 = nanoid();
    const threadChatId1 = nanoid();
    const threadId2 = nanoid();
    const threadChatId2 = nanoid();

    const createNewThread1 = vi.fn(async () => {
      // Simulate slow thread creation
      await new Promise((resolve) => setTimeout(resolve, 200));
      return { threadId: threadId1, threadChatId: threadChatId1 };
    });

    const createNewThread2 = vi.fn(async () => ({
      threadId: threadId2,
      threadChatId: threadChatId2,
    }));

    // Start both requests concurrently
    const [result1, result2] = await Promise.all([
      maybeBatchThreads({
        userId,
        batchKey,
        expiresSecs: 60,
        maxWaitTimeMs: 5000,
        createNewThread: createNewThread1,
      }),
      maybeBatchThreads({
        userId,
        batchKey,
        expiresSecs: 60,
        maxWaitTimeMs: 5000,
        createNewThread: createNewThread2,
      }),
    ]);

    const createdResult = result1.didCreateNewThread ? result1 : result2;
    const waitedResult = result1.didCreateNewThread ? result2 : result1;

    expect(createdResult.threadId).toBe(waitedResult.threadId);
    expect(createdResult.threadChatId).toBe(waitedResult.threadChatId);
    expect(waitedResult.didCreateNewThread).toBe(false);

    // Exactly one concurrent request should create the thread. Redis decides
    // which contender acquires the lock first, so this test must not depend on
    // Promise array ordering under shard load.
    expect(
      createNewThread1.mock.calls.length + createNewThread2.mock.calls.length,
    ).toBe(1);

    // Key should still be set with threadId
    const key = `thread-batch:${userId}:${batchKey}`;
    const value = await redis.get(key);
    expect(value).toBe(
      `${createdResult.threadId}/${createdResult.threadChatId}`,
    );

    // Cleanup
    await redis.del(key);
  });

  it("cleans up key on error during thread creation", async () => {
    const error = new Error("Thread creation failed");
    const createNewThread = vi.fn(async () => {
      throw error;
    });

    await expect(
      maybeBatchThreads({
        userId,
        batchKey,
        expiresSecs: 60,
        maxWaitTimeMs: 5000,
        createNewThread,
      }),
    ).rejects.toThrow("Thread creation failed");

    // Verify the key was cleaned up
    const key = `thread-batch:${userId}:${batchKey}`;
    const value = await redis.get(key);
    expect(value).toBeNull();
  });

  it("creates new thread when key is deleted while waiting", async () => {
    const key = `thread-batch:${userId}:${batchKey}`;
    const threadId = nanoid();
    const threadChatId = nanoid();

    // Set a placeholder
    await redis.set(key, "pending", { ex: 60 });

    const createNewThread = vi.fn(async () => ({ threadId, threadChatId }));

    // Start the wait process and delete the key after a short delay
    const resultPromise = maybeBatchThreads({
      userId,
      batchKey,
      expiresSecs: 60,
      maxWaitTimeMs: 5000,
      createNewThread,
    });

    // Delete the key while it's waiting
    await new Promise((resolve) => setTimeout(resolve, 150));
    await redis.del(key);

    const result = await resultPromise;

    // Should create new thread since key was deleted
    expect(result.threadId).toBe(threadId);
    expect(result.threadChatId).toBe(threadChatId);
    expect(result.didCreateNewThread).toBe(true);
    expect(createNewThread).toHaveBeenCalledOnce();

    // Cleanup
    await redis.del(key);
  });

  it("uses different keys for different users", async () => {
    const userId1 = "user-1";
    const userId2 = "user-2";
    const threadId1 = nanoid();
    const threadChatId1 = nanoid();
    const threadId2 = nanoid();
    const threadChatId2 = nanoid();

    const createNewThread1 = vi.fn(async () => ({
      threadId: threadId1,
      threadChatId: threadChatId1,
    }));
    const createNewThread2 = vi.fn(async () => ({
      threadId: threadId2,
      threadChatId: threadChatId2,
    }));

    const [result1, result2] = await Promise.all([
      maybeBatchThreads({
        userId: userId1,
        batchKey,
        expiresSecs: 60,
        maxWaitTimeMs: 5000,
        createNewThread: createNewThread1,
      }),
      maybeBatchThreads({
        userId: userId2,
        batchKey,
        expiresSecs: 60,
        maxWaitTimeMs: 5000,
        createNewThread: createNewThread2,
      }),
    ]);

    expect(result1.threadId).toBe(threadId1);
    expect(result1.threadChatId).toBe(threadChatId1);
    expect(result1.didCreateNewThread).toBe(true);
    expect(result2.threadId).toBe(threadId2);
    expect(result2.threadChatId).toBe(threadChatId2);
    expect(result2.didCreateNewThread).toBe(true);

    // Both should create their own threads
    expect(createNewThread1).toHaveBeenCalledOnce();
    expect(createNewThread2).toHaveBeenCalledOnce();

    // Cleanup
    await redis.del(`thread-batch:${userId1}:${batchKey}`);
    await redis.del(`thread-batch:${userId2}:${batchKey}`);
  });

  it("uses different keys for different batch keys", async () => {
    const batchKey1 = nanoid();
    const batchKey2 = nanoid();
    const threadId1 = nanoid();
    const threadId2 = nanoid();
    const threadChatId1 = nanoid();
    const threadChatId2 = nanoid();

    const createNewThread1 = vi.fn(async () => ({
      threadId: threadId1,
      threadChatId: threadChatId1,
    }));
    const createNewThread2 = vi.fn(async () => ({
      threadId: threadId2,
      threadChatId: threadChatId2,
    }));

    const [result1, result2] = await Promise.all([
      maybeBatchThreads({
        userId,
        batchKey: batchKey1,
        expiresSecs: 60,
        maxWaitTimeMs: 5000,
        createNewThread: createNewThread1,
      }),
      maybeBatchThreads({
        userId,
        batchKey: batchKey2,
        expiresSecs: 60,
        maxWaitTimeMs: 5000,
        createNewThread: createNewThread2,
      }),
    ]);

    expect(result1.threadId).toBe(threadId1);
    expect(result1.threadChatId).toBe(threadChatId1);
    expect(result1.didCreateNewThread).toBe(true);
    expect(result2.threadId).toBe(threadId2);
    expect(result2.threadChatId).toBe(threadChatId2);
    expect(result2.didCreateNewThread).toBe(true);

    // Both should create their own threads
    expect(createNewThread1).toHaveBeenCalledOnce();
    expect(createNewThread2).toHaveBeenCalledOnce();

    // Cleanup
    await redis.del(`thread-batch:${userId}:${batchKey1}`);
    await redis.del(`thread-batch:${userId}:${batchKey2}`);
  });

  it("returns null when timeout waiting for threadId", async () => {
    const key = `thread-batch:${userId}:${batchKey}`;

    // Set a placeholder that never gets updated
    await redis.set(key, "pending", { ex: 60 });

    const createNewThread = vi.fn(async () => ({
      threadId: "test-thread-id",
      threadChatId: "test-thread-chat-id",
    }));

    const result = await maybeBatchThreads({
      userId,
      batchKey,
      expiresSecs: 60,
      maxWaitTimeMs: 200, // Short timeout
      createNewThread,
    });
    // Should timeout and create a new thread
    expect(result.threadId).toBe("test-thread-id");
    expect(result.threadChatId).toBe("test-thread-chat-id");
    expect(result.didCreateNewThread).toBe(true);
    expect(createNewThread).toHaveBeenCalledOnce();
    // Cleanup
    await redis.del(key);
  });

  it("handles concurrent requests with slow thread creation", async () => {
    const threadId = nanoid();
    const threadChatId = nanoid();
    const key = `thread-batch:${userId}:${batchKey}`;

    const createNewThread = vi.fn(async () => {
      // Simulate slow thread creation
      await new Promise((resolve) => setTimeout(resolve, 150));
      return { threadId, threadChatId };
    });

    // Start first request
    const promise1 = maybeBatchThreads({
      userId,
      batchKey,
      expiresSecs: 60,
      maxWaitTimeMs: 5000,
      createNewThread,
    });

    // Wait for the first request to set the "pending" placeholder
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Verify it's pending
    const valueDuringCreation = await redis.get(key);
    expect(valueDuringCreation).toBe("pending");

    // Start second request - it should poll and eventually see the real threadId
    const promise2 = maybeBatchThreads({
      userId,
      batchKey,
      expiresSecs: 60,
      maxWaitTimeMs: 5000,
      createNewThread: vi.fn(async () => {
        throw new Error("should-not-be-called");
      }),
    });

    const [result1, result2] = await Promise.all([promise1, promise2]);

    expect(result1.threadId).toBe(threadId);
    expect(result1.threadChatId).toBe(threadChatId);
    expect(result1.didCreateNewThread).toBe(true);
    expect(result2.threadId).toBe(threadId);
    expect(result2.threadChatId).toBe(threadChatId);
    expect(result2.didCreateNewThread).toBe(false);

    // Only first should create
    expect(createNewThread).toHaveBeenCalledOnce();

    // Key should have the threadId
    const finalValue = await redis.get(key);
    expect(finalValue).toBe(`${threadId}/${threadChatId}`);

    // Cleanup
    await redis.del(key);
  });
});
