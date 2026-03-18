import { beforeEach, describe, expect, it, vi } from "vitest";
import { nanoid } from "nanoid/non-secure";
import { db } from "@/lib/db";
import { redis } from "@/lib/redis";
import { drainOutboxV3Worker } from "./worker";

const OUTBOX_REDIS_KEY_PREFIX = "dl3:test:v3-worker";
const OUTBOX_WORKER_DLQ_STREAM = `${OUTBOX_REDIS_KEY_PREFIX}:dead-letter`;
const OUTBOX_WORKER_ATTEMPTS_HASH = `${OUTBOX_REDIS_KEY_PREFIX}:attempts`;
const OUTBOX_WORKER_HEARTBEAT = `${OUTBOX_REDIS_KEY_PREFIX}:heartbeat`;

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

beforeEach(async () => {
  const redisKeys = await redis.keys(`${OUTBOX_REDIS_KEY_PREFIX}*`);
  if (redisKeys.length > 0) {
    await redis.del(...redisKeys);
  }
});

describe("drainOutboxV3Worker", () => {
  it("assigns a stream message to only one parallel worker", async () => {
    const streamKey = `dl3:test:v3-worker:stream:${nanoid()}`;
    const groupName = `dl3:test:group:${nanoid()}`;
    const outboxId = `outbox-${nanoid()}`;
    await addStreamMessage({ streamKey, outboxId });

    const processMessage = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });

    const [first, second] = await Promise.all([
      drainOutboxV3Worker({
        db,
        streamKey,
        groupName,
        consumerName: "worker-a",
        maxItems: 1,
        readBatchSize: 1,
        blockMs: 100,
        attemptsHashKey: OUTBOX_WORKER_ATTEMPTS_HASH,
        deadLetterStreamKey: OUTBOX_WORKER_DLQ_STREAM,
        heartbeatKey: OUTBOX_WORKER_HEARTBEAT,
        processMessage,
      }),
      drainOutboxV3Worker({
        db,
        streamKey,
        groupName,
        consumerName: "worker-b",
        maxItems: 1,
        readBatchSize: 1,
        blockMs: 100,
        attemptsHashKey: OUTBOX_WORKER_ATTEMPTS_HASH,
        deadLetterStreamKey: OUTBOX_WORKER_DLQ_STREAM,
        heartbeatKey: OUTBOX_WORKER_HEARTBEAT,
        processMessage,
      }),
    ]);

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
    const firstAttempts = vi.fn(async () => {
      throw new Error("first worker failed");
    });
    const secondAttempts = vi.fn();

    const firstResult = await drainOutboxV3Worker({
      db,
      streamKey,
      groupName,
      consumerName: "worker-failed",
      maxItems: 1,
      readBatchSize: 1,
      blockMs: 0,
      staleClaimMs: 5,
      processMessage: firstAttempts,
      attemptsHashKey: OUTBOX_WORKER_ATTEMPTS_HASH,
      deadLetterStreamKey: OUTBOX_WORKER_DLQ_STREAM,
      heartbeatKey: OUTBOX_WORKER_HEARTBEAT,
      maxAttempts: 2,
    });

    expect(firstResult.processed).toBe(1);
    expect(firstResult.acknowledged).toBe(0);
    expect(firstResult.retried).toBe(1);
    expect(firstResult.deadLettered).toBe(0);

    await new Promise((resolve) => setTimeout(resolve, 20));

    const secondResult = await drainOutboxV3Worker({
      db,
      streamKey,
      groupName,
      consumerName: "worker-reclaimed",
      maxItems: 1,
      readBatchSize: 1,
      blockMs: 0,
      staleClaimMs: 20,
      processMessage: secondAttempts,
      attemptsHashKey: OUTBOX_WORKER_ATTEMPTS_HASH,
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

    const firstAttempt = await drainOutboxV3Worker({
      db,
      streamKey,
      groupName,
      consumerName: "worker-bound-1",
      maxItems: 1,
      readBatchSize: 1,
      blockMs: 0,
      staleClaimMs: 5,
      maxAttempts: 2,
      processMessage: alwaysFail,
      attemptsHashKey: OUTBOX_WORKER_ATTEMPTS_HASH,
      deadLetterStreamKey: OUTBOX_WORKER_DLQ_STREAM,
      heartbeatKey: OUTBOX_WORKER_HEARTBEAT,
    });

    expect(firstAttempt.processed).toBe(1);
    expect(firstAttempt.retried).toBe(1);
    expect(firstAttempt.deadLettered).toBe(0);
    expect(await redis.xlen(OUTBOX_WORKER_DLQ_STREAM)).toBe(0);

    await new Promise((resolve) => setTimeout(resolve, 20));

    const secondAttempt = await drainOutboxV3Worker({
      db,
      streamKey,
      groupName,
      consumerName: "worker-bound-2",
      maxItems: 1,
      readBatchSize: 1,
      blockMs: 0,
      staleClaimMs: 20,
      maxAttempts: 2,
      processMessage: alwaysFail,
      attemptsHashKey: OUTBOX_WORKER_ATTEMPTS_HASH,
      deadLetterStreamKey: OUTBOX_WORKER_DLQ_STREAM,
      heartbeatKey: OUTBOX_WORKER_HEARTBEAT,
    });

    expect(secondAttempt.deadLettered).toBe(1);
    expect(secondAttempt.acknowledged).toBe(0);
    expect(secondAttempt.retried).toBe(0);
    expect(await redis.xlen(OUTBOX_WORKER_DLQ_STREAM)).toBe(1);
  });
});
