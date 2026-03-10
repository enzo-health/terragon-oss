import { beforeEach, describe, expect, it } from "vitest";
import { redis } from "@/lib/redis";
import {
  drainDueDeliveryLoopRetryJobs,
  getRetryJob,
  scheduleFollowUpRetryJob,
} from "./retry-jobs";

describe("delivery loop retry jobs", () => {
  beforeEach(async () => {
    const keys = await redis.keys("dlrj:*");
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  });

  it("persists a follow-up retry job into the durable schedule", async () => {
    const runAt = new Date("2026-03-09T12:00:00.000Z");

    const job = await scheduleFollowUpRetryJob({
      userId: "user-1",
      threadId: "thread-1",
      threadChatId: "chat-1",
      attempt: 2,
      runAt,
    });

    expect(job).toEqual({
      id: "follow-up:chat-1",
      kind: "follow_up_dispatch",
      userId: "user-1",
      threadId: "thread-1",
      threadChatId: "chat-1",
      attempt: 2,
      runAt,
    });
    await expect(getRetryJob(job.id)).resolves.toEqual(job);
  });

  it("drains a due retry job and completes it after successful queue processing", async () => {
    await scheduleFollowUpRetryJob({
      userId: "user-1",
      threadId: "thread-1",
      threadChatId: "chat-1",
      attempt: 1,
      runAt: new Date("2026-03-09T12:00:00.000Z"),
    });

    const result = await drainDueDeliveryLoopRetryJobs({
      now: new Date("2026-03-09T12:00:05.000Z"),
      leaseOwnerTokenPrefix: "test",
      processFollowUpQueue: async () => ({
        processed: true,
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
      attempt: 1,
      runAt: new Date("2026-03-09T12:00:00.000Z"),
    });

    const result = await drainDueDeliveryLoopRetryJobs({
      now: new Date("2026-03-09T12:00:05.000Z"),
      leaseOwnerTokenPrefix: "test",
      processFollowUpQueue: async () => ({
        processed: false,
        reason: "status_transition_noop_busy",
      }),
    });

    expect(result).toEqual({
      claimed: 1,
      completed: 0,
      rescheduled: 1,
      skipped: 0,
    });

    const job = await getRetryJob("follow-up:chat-1");
    expect(job?.attempt).toBe(2);
    expect(job?.runAt.getTime()).toBeGreaterThan(
      new Date("2026-03-09T12:00:05.000Z").getTime(),
    );
  });
});
