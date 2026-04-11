import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { redis } from "@/lib/redis";
import {
  drainDueDeliveryLoopRetryJobs,
  getRetryJob,
  scheduleFollowUpRetryJob,
} from "./retry-jobs";
import { execSync } from "node:child_process";

describe("delivery loop retry jobs", () => {
  beforeAll(() => {
    execSync("docker restart terragon_redis_http_test", { stdio: "ignore" });
  });

  beforeEach(async () => {
    const keys = await redis.keys("dlrj:*");
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  });

  async function drainWithRetry(
    args: Parameters<typeof drainDueDeliveryLoopRetryJobs>[0],
  ): ReturnType<typeof drainDueDeliveryLoopRetryJobs> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await drainDueDeliveryLoopRetryJobs(args);
      } catch (error) {
        const message =
          error instanceof Error ? error.message.toLowerCase() : "";
        if (!message.includes("local redis-http command timeout")) {
          throw error;
        }
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    throw lastError;
  }

  it("persists a follow-up retry job into the durable schedule", async () => {
    const runAt = new Date("2026-03-09T12:00:00.000Z");

    const job = await scheduleFollowUpRetryJob({
      userId: "user-1",
      threadId: "thread-1",
      threadChatId: "chat-1",
      dispatchAttempt: 2,
      deferCount: 1,
      runAt,
    });

    expect(job).toEqual({
      id: "follow-up:chat-1",
      kind: "follow_up_dispatch",
      userId: "user-1",
      threadId: "thread-1",
      threadChatId: "chat-1",
      dispatchAttempt: 2,
      deferCount: 1,
      runAt,
    });
    await expect(getRetryJob(job.id)).resolves.toEqual(job);
  });

  it("drains a due retry job and completes it after successful queue processing", async () => {
    await scheduleFollowUpRetryJob({
      userId: "user-1",
      threadId: "thread-1",
      threadChatId: "chat-1",
      dispatchAttempt: 1,
      runAt: new Date("2026-03-09T12:00:00.000Z"),
    });

    const result = await drainWithRetry({
      now: new Date("2026-03-09T12:00:05.000Z"),
      leaseOwnerTokenPrefix: "test",
      processFollowUpQueue: async () => ({
        processed: true,
        dispatchLaunched: true,
        reason: "dispatch_started_batch",
      }),
    });

    expect(result).toEqual({
      claimed: 1,
      completed: 1,
      rescheduled: 0,
      skipped: 0,
    });
    await expect(getRetryJob("follow-up:chat-1")).resolves.toBeNull();
  });

  it("reschedules a due retry job when queue processing remains deferred", async () => {
    await scheduleFollowUpRetryJob({
      userId: "user-1",
      threadId: "thread-1",
      threadChatId: "chat-1",
      dispatchAttempt: 1,
      runAt: new Date("2026-03-09T12:00:00.000Z"),
    });

    const result = await drainWithRetry({
      now: new Date("2026-03-09T12:00:05.000Z"),
      leaseOwnerTokenPrefix: "test",
      processFollowUpQueue: async () => ({
        processed: false,
        dispatchLaunched: false,
        reason: "stale_cas_busy",
      }),
    });

    expect(result).toEqual({
      claimed: 1,
      completed: 0,
      rescheduled: 1,
      skipped: 0,
    });

    const job = await getRetryJob("follow-up:chat-1");
    expect(job?.dispatchAttempt).toBe(1);
    expect(job?.deferCount).toBe(1);
    expect(job?.runAt.getTime()).toBeGreaterThan(
      new Date("2026-03-09T12:00:05.000Z").getTime(),
    );
  });

  it("reschedules legacy dispatch_not_started outcomes as compatibility fallback", async () => {
    await scheduleFollowUpRetryJob({
      userId: "user-1",
      threadId: "thread-1",
      threadChatId: "chat-1",
      dispatchAttempt: 1,
      runAt: new Date("2026-03-09T12:00:00.000Z"),
    });

    const result = await drainWithRetry({
      now: new Date("2026-03-09T12:00:05.000Z"),
      leaseOwnerTokenPrefix: "test",
      processFollowUpQueue: async () => ({
        processed: false,
        dispatchLaunched: false,
        reason: "dispatch_not_started",
      }),
    });

    expect(result).toEqual({
      claimed: 1,
      completed: 0,
      rescheduled: 1,
      skipped: 0,
    });

    const job = await getRetryJob("follow-up:chat-1");
    expect(job?.dispatchAttempt).toBe(1);
    expect(job?.deferCount).toBe(1);
    expect(job?.runAt.getTime()).toBeGreaterThan(
      new Date("2026-03-09T12:00:05.000Z").getTime(),
    );
  });

  it("reschedules transient invalid_event outcomes instead of dropping the retry job", async () => {
    await scheduleFollowUpRetryJob({
      userId: "user-1",
      threadId: "thread-1",
      threadChatId: "chat-1",
      dispatchAttempt: 1,
      runAt: new Date("2026-03-09T12:00:00.000Z"),
    });

    const result = await drainWithRetry({
      now: new Date("2026-03-09T12:00:05.000Z"),
      leaseOwnerTokenPrefix: "test",
      processFollowUpQueue: async () => ({
        processed: false,
        dispatchLaunched: false,
        reason: "invalid_event",
      }),
    });

    expect(result).toEqual({
      claimed: 1,
      completed: 0,
      rescheduled: 1,
      skipped: 0,
    });

    const job = await getRetryJob("follow-up:chat-1");
    expect(job?.dispatchAttempt).toBe(1);
    expect(job?.deferCount).toBe(1);
    expect(job?.runAt.getTime()).toBeGreaterThan(
      new Date("2026-03-09T12:00:05.000Z").getTime(),
    );
  });

  it("does not let a stale worker overwrite a newer retry schedule during reschedule", async () => {
    await scheduleFollowUpRetryJob({
      userId: "user-1",
      threadId: "thread-1",
      threadChatId: "chat-1",
      dispatchAttempt: 1,
      deferCount: 0,
      runAt: new Date("2026-03-09T12:00:00.000Z"),
    });

    const newerRunAt = new Date("2026-03-09T12:06:00.000Z");
    const result = await drainWithRetry({
      now: new Date("2026-03-09T12:00:05.000Z"),
      leaseOwnerTokenPrefix: "test",
      processFollowUpQueue: async () => {
        await scheduleFollowUpRetryJob({
          userId: "user-1",
          threadId: "thread-1",
          threadChatId: "chat-1",
          dispatchAttempt: 7,
          deferCount: 4,
          runAt: newerRunAt,
        });
        return {
          processed: false,
          dispatchLaunched: false,
          reason: "stale_cas_busy",
        };
      },
    });

    expect(result).toEqual({
      claimed: 1,
      completed: 0,
      rescheduled: 1,
      skipped: 0,
    });
    const job = await getRetryJob("follow-up:chat-1");
    expect(job?.dispatchAttempt).toBe(7);
    expect(job?.deferCount).toBe(4);
    expect(job?.runAt.toISOString()).toBe(newerRunAt.toISOString());
  });

  it("does not delete a newer schedule written during drain for the same chat", async () => {
    await scheduleFollowUpRetryJob({
      userId: "user-1",
      threadId: "thread-1",
      threadChatId: "chat-1",
      dispatchAttempt: 1,
      runAt: new Date("2026-03-09T12:00:00.000Z"),
    });

    const newerRunAt = new Date("2026-03-09T12:05:00.000Z");
    const result = await drainWithRetry({
      now: new Date("2026-03-09T12:00:05.000Z"),
      leaseOwnerTokenPrefix: "test",
      processFollowUpQueue: async () => {
        await scheduleFollowUpRetryJob({
          userId: "user-1",
          threadId: "thread-1",
          threadChatId: "chat-1",
          dispatchAttempt: 2,
          deferCount: 0,
          runAt: newerRunAt,
        });
        return {
          processed: true,
          dispatchLaunched: true,
          reason: "dispatch_started_batch",
        };
      },
    });

    expect(result).toEqual({
      claimed: 1,
      completed: 0,
      rescheduled: 1,
      skipped: 0,
    });
    const job = await getRetryJob("follow-up:chat-1");
    expect(job).toBeTruthy();
    expect(job?.dispatchAttempt).toBe(2);
    expect(job?.deferCount).toBe(0);
    expect(job?.runAt.toISOString()).toBe(newerRunAt.toISOString());
  });
});
