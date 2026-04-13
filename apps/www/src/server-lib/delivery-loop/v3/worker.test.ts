import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nanoid } from "nanoid/non-secure";
import { eq, like } from "drizzle-orm";
import { db } from "@/lib/db";
import { redis } from "@/lib/redis";
import * as schema from "@terragon/shared/db/schema";
import {
  createTestThread,
  createTestUser,
} from "@terragon/shared/model/test-helpers";
import { createWorkflow } from "@terragon/shared/delivery-loop/store/workflow-store";
import { drainOutboxWorker } from "./worker";
import { env } from "@terragon/env/apps-www";

// Detect local Redis HTTP environment where streams are not available
const isLocalRedisHttpTestEnvironment = (
  process.env.REDIS_URL ??
  env.REDIS_URL ??
  ""
).includes("localhost:18079");
const describeWorker = isLocalRedisHttpTestEnvironment
  ? describe.skip
  : describe;

const OUTBOX_REDIS_KEY_PREFIX = "dl3:test:v3-worker";
const OUTBOX_WORKER_DLQ_STREAM = `${OUTBOX_REDIS_KEY_PREFIX}:dead-letter`;
const OUTBOX_WORKER_ATTEMPTS_HASH = `${OUTBOX_REDIS_KEY_PREFIX}:attempts`;
const OUTBOX_WORKER_HEARTBEAT = `${OUTBOX_REDIS_KEY_PREFIX}:heartbeat`;
const OUTBOX_WORKER_PROCESSED_HASH = `${OUTBOX_REDIS_KEY_PREFIX}:processed`;

function randomSignalPayload(): string {
  return JSON.stringify({
    kind: "signal",
    journalId: "journal-id",
    workflowId: "workflow-id",
    eventType: "bootstrap",
    source: "daemon",
  });
}

async function addStreamMessage(params: {
  streamKey: string;
  outboxId: string;
  topic?: string;
}): Promise<string> {
  const messageId = await redis.xadd(params.streamKey, "*", {
    outboxId: params.outboxId,
    workflowId: "workflow-id",
    topic: params.topic ?? "signal",
    dedupeKey: `dedupe-${params.outboxId}`,
    idempotencyKey: `idem-${params.outboxId}`,
    payload: randomSignalPayload(),
  });
  if (typeof messageId !== "string") {
    throw new Error("Failed to enqueue stream message");
  }
  return messageId;
}

async function createWorkflowFixture(): Promise<string> {
  const { user } = await createTestUser({ db });
  const { threadId } = await createTestThread({ db, userId: user.id });
  const workflow = await createWorkflow({
    db,
    threadId,
    generation: 1,
    kind: "implementing",
    userId: user.id,
    stateJson: { state: "implementing" },
  });
  return workflow.id;
}

async function createPublishedOutboxRecord(params: {
  workflowId: string;
  keyPrefix: string;
  maxAttempts?: number;
}): Promise<string> {
  const result = await db
    .insert(schema.deliveryOutboxV3)
    .values({
      workflowId: params.workflowId,
      topic: "signal",
      dedupeKey: `${params.keyPrefix}:dedupe`,
      idempotencyKey: `${params.keyPrefix}:idem`,
      availableAt: new Date("2026-03-18T10:00:00.000Z"),
      maxAttempts: params.maxAttempts ?? 3,
      payloadJson: {
        kind: "signal",
        journalId: `${params.keyPrefix}:journal`,
        workflowId: params.workflowId,
        eventType: "bootstrap",
        source: "daemon",
      },
      status: "published",
      publishedAt: new Date("2026-03-18T10:00:00.000Z"),
      relayMessageId: `${params.keyPrefix}:relay`,
    })
    .returning({ id: schema.deliveryOutboxV3.id });

  const row = result[0];
  if (!row) {
    throw new Error("Failed to create published outbox row");
  }
  return row.id;
}

async function cleanupWorkerTestState(): Promise<void> {
  await db
    .delete(schema.deliveryOutboxV3)
    .where(
      like(schema.deliveryOutboxV3.dedupeKey, `${OUTBOX_REDIS_KEY_PREFIX}%`),
    );
  const redisKeys = await redis.keys(`${OUTBOX_REDIS_KEY_PREFIX}*`);
  if (redisKeys.length > 0) {
    await redis.del(...redisKeys);
  }
}

beforeEach(cleanupWorkerTestState);
afterEach(cleanupWorkerTestState);

describeWorker("drainOutboxWorker", () => {
  it("uses the db fallback on local redis-http and retires the row in postgres", async () => {
    const originalRedisUrl = process.env.REDIS_URL;
    process.env.REDIS_URL = "http://localhost:8079";
    const redisCallSpies = [
      vi.spyOn(redis, "xgroup"),
      vi.spyOn(redis, "xreadgroup"),
      vi.spyOn(redis, "xautoclaim"),
      vi.spyOn(redis, "xack"),
      vi.spyOn(redis, "xadd"),
      vi.spyOn(redis, "hset"),
      vi.spyOn(redis, "hget"),
      vi.spyOn(redis, "hincrby"),
      vi.spyOn(redis, "hdel"),
      vi.spyOn(redis, "pexpire"),
    ];

    try {
      const workflowId = await createWorkflowFixture();
      const outboxId = await createPublishedOutboxRecord({
        workflowId,
        keyPrefix: `dl3:test:v3-worker-fallback:${nanoid()}`,
      });

      const processMessage = vi.fn(async () => {});

      const first = await drainOutboxWorker({
        db,
        consumerName: "worker-local-fallback",
        fallbackWorkflowId: workflowId,
        maxItems: 1,
        readBatchSize: 1,
        blockMs: 0,
        processMessage,
      });

      expect(first).toEqual({
        processed: 1,
        acknowledged: 1,
        deadLettered: 0,
        retried: 0,
      });
      expect(processMessage).toHaveBeenCalledTimes(1);
      for (const spy of redisCallSpies) {
        expect(spy).not.toHaveBeenCalled();
      }
      const row = await db.query.deliveryOutboxV3.findFirst({
        where: eq(schema.deliveryOutboxV3.id, outboxId),
      });
      expect(row).toMatchObject({
        status: "cancelled",
        attemptCount: 0,
        lastErrorCode: null,
        lastErrorMessage: null,
      });

      const second = await drainOutboxWorker({
        db,
        consumerName: "worker-local-fallback",
        fallbackWorkflowId: workflowId,
        maxItems: 1,
        readBatchSize: 1,
        blockMs: 0,
        processMessage,
      });

      expect(second).toEqual({
        processed: 0,
        acknowledged: 0,
        deadLettered: 0,
        retried: 0,
      });
      expect(processMessage).toHaveBeenCalledTimes(1);
      for (const spy of redisCallSpies) {
        expect(spy).not.toHaveBeenCalled();
      }
    } finally {
      for (const spy of redisCallSpies) {
        spy.mockRestore();
      }
      if (typeof originalRedisUrl === "undefined") {
        delete process.env.REDIS_URL;
      } else {
        process.env.REDIS_URL = originalRedisUrl;
      }
    }
  });

  it("dead-letters a failing published row in local fallback mode once", async () => {
    const originalRedisUrl = process.env.REDIS_URL;
    process.env.REDIS_URL = "http://localhost:8079";
    const redisCallSpies = [
      vi.spyOn(redis, "xgroup"),
      vi.spyOn(redis, "xreadgroup"),
      vi.spyOn(redis, "xautoclaim"),
      vi.spyOn(redis, "xack"),
      vi.spyOn(redis, "xadd"),
      vi.spyOn(redis, "hset"),
      vi.spyOn(redis, "hget"),
      vi.spyOn(redis, "hincrby"),
      vi.spyOn(redis, "hdel"),
      vi.spyOn(redis, "pexpire"),
    ];

    try {
      const workflowId = await createWorkflowFixture();
      const outboxId = await createPublishedOutboxRecord({
        workflowId,
        keyPrefix: `dl3:test:v3-worker-fallback-fail:${nanoid()}`,
        maxAttempts: 1,
      });

      const processMessage = vi.fn(async () => {
        throw new Error("processor failed");
      });

      const first = await drainOutboxWorker({
        db,
        consumerName: "worker-local-fallback-fail",
        fallbackWorkflowId: workflowId,
        maxItems: 1,
        readBatchSize: 1,
        blockMs: 0,
        processMessage,
      });

      expect(first).toEqual({
        processed: 1,
        acknowledged: 0,
        deadLettered: 1,
        retried: 0,
      });
      expect(processMessage).toHaveBeenCalledTimes(1);
      for (const spy of redisCallSpies) {
        expect(spy).not.toHaveBeenCalled();
      }
      const row = await db.query.deliveryOutboxV3.findFirst({
        where: eq(schema.deliveryOutboxV3.id, outboxId),
      });
      expect(row).toMatchObject({
        status: "dead_letter",
        attemptCount: 1,
        lastErrorCode: "v3_outbox_worker_failed",
        lastErrorMessage: expect.stringContaining("processor failed"),
      });

      const second = await drainOutboxWorker({
        db,
        consumerName: "worker-local-fallback-fail",
        fallbackWorkflowId: workflowId,
        maxItems: 1,
        readBatchSize: 1,
        blockMs: 0,
        processMessage,
      });

      expect(second).toEqual({
        processed: 0,
        acknowledged: 0,
        deadLettered: 0,
        retried: 0,
      });
      expect(processMessage).toHaveBeenCalledTimes(1);
      for (const spy of redisCallSpies) {
        expect(spy).not.toHaveBeenCalled();
      }
    } finally {
      for (const spy of redisCallSpies) {
        spy.mockRestore();
      }
      if (typeof originalRedisUrl === "undefined") {
        delete process.env.REDIS_URL;
      } else {
        process.env.REDIS_URL = originalRedisUrl;
      }
    }
  });

  it("assigns a stream message to only one parallel worker", async () => {
    const streamKey = `dl3:test:v3-worker:stream:${nanoid()}`;
    const groupName = `dl3:test:group:${nanoid()}`;
    const outboxId = `outbox-${nanoid()}`;
    await addStreamMessage({ streamKey, outboxId });

    // Use a synchronous blocker to hold the message while both workers race
    let releaseProcessor: () => void;
    const processorBlocker = new Promise<void>((resolve) => {
      releaseProcessor = resolve;
    });

    const processMessage = vi.fn(async () => {
      await processorBlocker;
    });

    const [first, second] = await Promise.all([
      drainOutboxWorker({
        db,
        streamKey,
        groupName,
        consumerName: "worker-a",
        maxItems: 1,
        readBatchSize: 1,
        blockMs: 0,
        attemptsHashKey: OUTBOX_WORKER_ATTEMPTS_HASH,
        processedHashKey: OUTBOX_WORKER_PROCESSED_HASH,
        deadLetterStreamKey: OUTBOX_WORKER_DLQ_STREAM,
        heartbeatKey: OUTBOX_WORKER_HEARTBEAT,
        processMessage,
      }),
      drainOutboxWorker({
        db,
        streamKey,
        groupName,
        consumerName: "worker-b",
        maxItems: 1,
        readBatchSize: 1,
        blockMs: 0,
        attemptsHashKey: OUTBOX_WORKER_ATTEMPTS_HASH,
        processedHashKey: OUTBOX_WORKER_PROCESSED_HASH,
        deadLetterStreamKey: OUTBOX_WORKER_DLQ_STREAM,
        heartbeatKey: OUTBOX_WORKER_HEARTBEAT,
        processMessage,
      }),
    ]);

    // Release the processor now that both workers have attempted
    releaseProcessor!();

    expect(processMessage).toHaveBeenCalledTimes(1);
    expect(first.processed + second.processed).toBe(1);
    expect(first.acknowledged + second.acknowledged).toBe(1);
    expect(first.deadLettered + second.deadLettered).toBe(0);
    expect(first.retried + second.retried).toBe(0);
    expect(await redis.xlen(OUTBOX_WORKER_DLQ_STREAM)).toBe(0);
  });

  it("reclaims stale claimed messages after worker restart", async () => {
    const streamKey = `dl3:test:v3-worker:stream:${nanoid()}`;
    const groupName = `dl3:test:group:${nanoid()}`;
    const outboxId = `outbox-${nanoid()}`;
    await addStreamMessage({ streamKey, outboxId });

    // Track when first worker has claimed the message
    let messageClaimed = false;
    const firstAttempts = vi.fn(async () => {
      messageClaimed = true;
      throw new Error("first worker failed");
    });
    const secondAttempts = vi.fn();

    const firstResult = await drainOutboxWorker({
      db,
      streamKey,
      groupName,
      consumerName: "worker-failed",
      maxItems: 1,
      readBatchSize: 1,
      blockMs: 0,
      staleClaimMs: 0, // Immediately stale for deterministic reclaim
      processMessage: firstAttempts,
      attemptsHashKey: OUTBOX_WORKER_ATTEMPTS_HASH,
      processedHashKey: OUTBOX_WORKER_PROCESSED_HASH,
      deadLetterStreamKey: OUTBOX_WORKER_DLQ_STREAM,
      heartbeatKey: OUTBOX_WORKER_HEARTBEAT,
      maxAttempts: 2,
    });

    expect(firstResult.processed).toBe(1);
    expect(firstResult.acknowledged).toBe(0);
    expect(firstResult.retried).toBe(1);
    expect(firstResult.deadLettered).toBe(0);
    expect(messageClaimed).toBe(true);

    // With staleClaimMs: 0, the message is immediately reclaimable
    const secondResult = await drainOutboxWorker({
      db,
      streamKey,
      groupName,
      consumerName: "worker-reclaimed",
      maxItems: 1,
      readBatchSize: 1,
      blockMs: 0,
      staleClaimMs: 30_000, // Long stale time for second worker
      processMessage: secondAttempts,
      attemptsHashKey: OUTBOX_WORKER_ATTEMPTS_HASH,
      processedHashKey: OUTBOX_WORKER_PROCESSED_HASH,
      deadLetterStreamKey: OUTBOX_WORKER_DLQ_STREAM,
      heartbeatKey: OUTBOX_WORKER_HEARTBEAT,
      maxAttempts: 2,
    });

    expect(secondResult.acknowledged).toBe(1);
    expect(secondResult.retried).toBe(0);
    expect(secondResult.deadLettered).toBe(0);
    expect(await redis.xlen(OUTBOX_WORKER_DLQ_STREAM)).toBe(0);
  });

  it("moves to dead-letter queue after bounded retries", async () => {
    const streamKey = `dl3:test:v3-worker:stream:${nanoid()}`;
    const groupName = `dl3:test:group:${nanoid()}`;
    const outboxId = `outbox-${nanoid()}`;
    await addStreamMessage({ streamKey, outboxId });

    const alwaysFail = vi.fn(async () => {
      throw new Error("processor failed");
    });

    // First attempt: fails and retries (staleClaimMs: 0 allows immediate reclaim)
    const firstAttempt = await drainOutboxWorker({
      db,
      streamKey,
      groupName,
      consumerName: "worker-bound-1",
      maxItems: 1,
      readBatchSize: 1,
      blockMs: 0,
      staleClaimMs: 0,
      maxAttempts: 2,
      processMessage: alwaysFail,
      attemptsHashKey: OUTBOX_WORKER_ATTEMPTS_HASH,
      processedHashKey: OUTBOX_WORKER_PROCESSED_HASH,
      deadLetterStreamKey: OUTBOX_WORKER_DLQ_STREAM,
      heartbeatKey: OUTBOX_WORKER_HEARTBEAT,
    });

    expect(firstAttempt.processed).toBe(1);
    expect(firstAttempt.retried).toBe(1);
    expect(firstAttempt.deadLettered).toBe(0);
    expect(await redis.xlen(OUTBOX_WORKER_DLQ_STREAM)).toBe(0);

    // Second attempt: exhausts maxAttempts and dead-letters
    const secondAttempt = await drainOutboxWorker({
      db,
      streamKey,
      groupName,
      consumerName: "worker-bound-2",
      maxItems: 1,
      readBatchSize: 1,
      blockMs: 0,
      staleClaimMs: 0,
      maxAttempts: 2,
      processMessage: alwaysFail,
      attemptsHashKey: OUTBOX_WORKER_ATTEMPTS_HASH,
      processedHashKey: OUTBOX_WORKER_PROCESSED_HASH,
      deadLetterStreamKey: OUTBOX_WORKER_DLQ_STREAM,
      heartbeatKey: OUTBOX_WORKER_HEARTBEAT,
    });

    expect(secondAttempt.deadLettered).toBe(1);
    expect(secondAttempt.acknowledged).toBe(0);
    expect(secondAttempt.retried).toBe(0);
    expect(await redis.xlen(OUTBOX_WORKER_DLQ_STREAM)).toBe(1);
  });

  it("does not re-run message processor when ack fails after successful processing", async () => {
    const streamKey = `dl3:test:v3-worker:stream:${nanoid()}`;
    const groupName = `dl3:test:group:${nanoid()}`;
    const outboxId = `outbox-${nanoid()}`;
    await addStreamMessage({ streamKey, outboxId });

    const processMessage = vi.fn(async () => {});
    let ackFailuresRemaining = 1;
    const ackMessage = vi.fn(async () => {
      if (ackFailuresRemaining > 0) {
        ackFailuresRemaining -= 1;
        throw new Error("ack transient failure");
      }
    });

    // First attempt: processing succeeds but ack fails (retried, not dead-lettered)
    const firstAttempt = await drainOutboxWorker({
      db,
      streamKey,
      groupName,
      consumerName: "worker-ack-fail-1",
      maxItems: 1,
      readBatchSize: 1,
      blockMs: 0,
      staleClaimMs: 0, // Immediately reclaimable
      maxAttempts: 2,
      processMessage,
      ackMessage,
      attemptsHashKey: OUTBOX_WORKER_ATTEMPTS_HASH,
      processedHashKey: OUTBOX_WORKER_PROCESSED_HASH,
      deadLetterStreamKey: OUTBOX_WORKER_DLQ_STREAM,
      heartbeatKey: OUTBOX_WORKER_HEARTBEAT,
    });

    expect(firstAttempt.processed).toBe(1);
    expect(firstAttempt.acknowledged).toBe(0);
    expect(firstAttempt.retried).toBe(1);
    expect(firstAttempt.deadLettered).toBe(0);
    expect(processMessage).toHaveBeenCalledTimes(1);
    expect(ackMessage).toHaveBeenCalledTimes(1);

    // Second attempt: message was already processed, just needs ack
    const secondAttempt = await drainOutboxWorker({
      db,
      streamKey,
      groupName,
      consumerName: "worker-ack-fail-2",
      maxItems: 1,
      readBatchSize: 1,
      blockMs: 0,
      staleClaimMs: 0,
      maxAttempts: 2,
      processMessage,
      ackMessage,
      attemptsHashKey: OUTBOX_WORKER_ATTEMPTS_HASH,
      processedHashKey: OUTBOX_WORKER_PROCESSED_HASH,
      deadLetterStreamKey: OUTBOX_WORKER_DLQ_STREAM,
      heartbeatKey: OUTBOX_WORKER_HEARTBEAT,
    });

    expect(secondAttempt.acknowledged).toBe(1);
    expect(secondAttempt.deadLettered).toBe(0);
    expect(secondAttempt.retried).toBe(0);
    // ProcessMessage should NOT be called again (idempotency preserved)
    expect(processMessage).toHaveBeenCalledTimes(1);
    expect(ackMessage).toHaveBeenCalledTimes(2);
    expect(await redis.xlen(OUTBOX_WORKER_DLQ_STREAM)).toBe(0);
  });
});
