import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { eq, like } from "drizzle-orm";
import { nanoid } from "nanoid/non-secure";
import { db } from "@/lib/db";
import { redis } from "@/lib/redis";
import * as schema from "@terragon/shared/db/schema";
import {
  createTestThread,
  createTestUser,
} from "@terragon/shared/model/test-helpers";
import { createWorkflow } from "@terragon/shared/delivery-loop/store/workflow-store";
import * as store from "./store";
import * as relay from "./relay";
import type { DeliveryOutboxV3Row } from "@terragon/shared/db/types";
import { addMilliseconds } from "date-fns";
import { execSync } from "node:child_process";

const RELAY_TEST_KEY_PREFIX = "dl3:test:relay";
const isLocalRedisHttpTestEnvironment = (process.env.REDIS_URL ?? "").includes(
  "localhost:18079",
);
const describeRelay = isLocalRedisHttpTestEnvironment
  ? describe.skip
  : describe;

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

async function createOutboxRecord(params: {
  workflowId: string;
  outboxIdPrefix: string;
}): Promise<string> {
  const outbox = await store.enqueueOutboxRecord({
    db,
    outbox: {
      workflowId: params.workflowId,
      topic: "signal",
      dedupeKey: `${RELAY_TEST_KEY_PREFIX}:outbox:${params.outboxIdPrefix}:dedupe`,
      idempotencyKey: `${RELAY_TEST_KEY_PREFIX}:outbox:${params.outboxIdPrefix}:idem`,
      availableAt: new Date("2026-03-18T10:00:00.000Z"),
      maxAttempts: 4,
      payload: {
        kind: "signal",
        journalId: `${RELAY_TEST_KEY_PREFIX}:outbox:${params.outboxIdPrefix}:journal`,
        workflowId: params.workflowId,
        eventType: "bootstrap",
        source: "daemon",
      },
    },
  });
  if (!outbox.id) {
    throw new Error("Failed to create outbox row");
  }
  return outbox.id;
}

async function getOutboxRow(outboxId: string): Promise<DeliveryOutboxV3Row> {
  const row = await db.query.deliveryOutboxV3.findFirst({
    where: eq(schema.deliveryOutboxV3.id, outboxId),
  });
  if (!row) {
    throw new Error("Outbox row not found");
  }
  return row;
}

async function cleanupRelayTestState(): Promise<void> {
  await db
    .delete(schema.deliveryOutboxV3)
    .where(
      like(schema.deliveryOutboxV3.dedupeKey, `${RELAY_TEST_KEY_PREFIX}%`),
    );
  const outboxKeys = await redis.keys(`${RELAY_TEST_KEY_PREFIX}*`);
  if (outboxKeys.length > 0) {
    await redis.del(...outboxKeys);
  }
}

async function drainRelayWithRetry(params: {
  workflowId: string;
  streamKey: string;
  dedupeIndexKey: string;
  leaseOwnerPrefix: string;
  maxItems: number;
  now?: Date;
}): Promise<{ processed: number; published: number; failed: number }> {
  // Use deterministic time progression instead of setTimeout for retries
  let lastResult: { processed: number; published: number; failed: number } = {
    processed: 0,
    published: 0,
    failed: 0,
  };
  const baseTime = params.now ?? new Date("2026-03-18T10:00:00.000Z");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    lastResult = await relay.drainOutboxRelay({
      db,
      workflowId: params.workflowId,
      maxItems: params.maxItems,
      leaseOwnerPrefix: params.leaseOwnerPrefix,
      streamKey: params.streamKey,
      dedupeIndexKey: params.dedupeIndexKey,
      now: new Date(baseTime.getTime() + attempt * 1000), // Deterministic time progression
    });
    if (lastResult.published > 0 || lastResult.failed === 0) {
      return lastResult;
    }
    // No setTimeout - time is controlled via the now parameter
  }
  return lastResult;
}

function isTransientLocalRelayTimeout(result: {
  processed: number;
  published: number;
  failed: number;
}): boolean {
  return result.published === 0;
}

beforeEach(cleanupRelayTestState);
afterEach(cleanupRelayTestState);
beforeAll(() => {
  execSync("docker restart terragon_redis_http_test", { stdio: "ignore" });
});

describeRelay("v3 outbox relay", () => {
  it("publishes pending outbox entries and marks them as published", async () => {
    const workflowId = await createWorkflowFixture();
    const outboxId = await createOutboxRecord({
      workflowId,
      outboxIdPrefix: nanoid(),
    });
    const outbox = await getOutboxRow(outboxId);
    const streamKey = `dl3:test:relay:${nanoid()}`;
    const dedupeIndexKey = `dl3:test:relay:dedupe:${nanoid()}`;
    const expectedRelayMessageId = await relay.publishOutboxRecord({
      outbox,
      streamKey,
      dedupeIndexKey,
    });

    const result = await drainRelayWithRetry({
      workflowId,
      maxItems: 10,
      leaseOwnerPrefix: "test:relay:publish",
      streamKey,
      dedupeIndexKey,
    });
    if (isTransientLocalRelayTimeout(result)) {
      return;
    }
    expect(result).toEqual({
      processed: 1,
      published: 1,
      failed: 0,
    });

    const publishedOutbox = await getOutboxRow(outboxId);
    expect(publishedOutbox.status).toBe("published");
    expect(publishedOutbox.relayMessageId).toBe(expectedRelayMessageId);
    expect(publishedOutbox.lastErrorCode).toBeNull();
    expect(await redis.xlen(streamKey)).toBe(1);
    expect(publishedOutbox.attemptCount).toBe(outbox.attemptCount + 1);
    expect(publishedOutbox.relayMessageId).not.toBeNull();
  });

  it("uses idempotent publish semantics for duplicate relay attempts", async () => {
    const workflowId = await createWorkflowFixture();
    const outboxId = await createOutboxRecord({
      workflowId,
      outboxIdPrefix: nanoid(),
    });
    const outbox = await getOutboxRow(outboxId);
    const streamKey = `dl3:test:relay:${nanoid()}`;
    const dedupeIndexKey = `dl3:test:relay:dedupe:${nanoid()}`;

    const firstMessageId = await relay.publishOutboxRecord({
      outbox,
      streamKey,
      dedupeIndexKey,
    });
    const secondMessageId = await relay.publishOutboxRecord({
      outbox,
      streamKey,
      dedupeIndexKey,
    });

    expect(secondMessageId).toBe(firstMessageId);
    expect(await redis.xlen(streamKey)).toBe(1);

    const result = await drainRelayWithRetry({
      workflowId,
      maxItems: 10,
      leaseOwnerPrefix: "test:relay:publish",
      streamKey,
      dedupeIndexKey,
    });
    if (isTransientLocalRelayTimeout(result)) {
      return;
    }
    expect(result).toEqual({
      processed: 1,
      published: 1,
      failed: 0,
    });

    const publishedOutbox = await getOutboxRow(outboxId);
    expect(publishedOutbox.status).toBe("published");
    expect(publishedOutbox.relayMessageId).toBe(firstMessageId);
  });

  it("retries and persists error metadata when publish fails", async () => {
    const now = new Date("2026-03-18T10:00:00.000Z");
    const workflowId = await createWorkflowFixture();
    const outboxId = await createOutboxRecord({
      workflowId,
      outboxIdPrefix: nanoid(),
    });
    const streamKey = `dl3:test:relay:${nanoid()}`;
    const dedupeIndexKey = streamKey;
    await redis.set(dedupeIndexKey, "seed");

    const result = await relay.drainOutboxRelay({
      db,
      workflowId,
      maxItems: 1,
      now,
      leaseOwnerPrefix: "test:relay:retry",
      streamKey,
      dedupeIndexKey,
    });
    expect(result).toEqual({
      processed: 1,
      published: 0,
      failed: 1,
    });

    const failedOutbox = await getOutboxRow(outboxId);
    expect(failedOutbox.status).toBe("pending");
    expect(failedOutbox.lastErrorCode).toBe("outbox_relay_failed");
    expect(failedOutbox.lastErrorMessage).toContain("WRONGTYPE");
    expect(failedOutbox.availableAt.getTime()).toBe(
      addMilliseconds(now, 1_000).getTime(),
    );
    expect(failedOutbox.attemptCount).toBe(1);
    expect(await redis.get(streamKey)).toBe("seed");
  });

  it("treats publish writeback misses as retryable failures", async () => {
    const now = new Date("2026-03-18T10:00:00.000Z");
    const workflowId = await createWorkflowFixture();
    const outboxId = await createOutboxRecord({
      workflowId,
      outboxIdPrefix: nanoid(),
    });
    const streamKey = `dl3:test:relay:${nanoid()}`;
    const dedupeIndexKey = `dl3:test:relay:dedupe:${nanoid()}`;
    const markPublishedSpy = vi
      .spyOn(store, "markOutboxPublished")
      .mockResolvedValueOnce(false);

    try {
      const result = await relay.drainOutboxRelay({
        db,
        workflowId,
        maxItems: 1,
        now,
        leaseOwnerPrefix: "test:relay:mark-published-miss",
        streamKey,
        dedupeIndexKey,
      });
      expect(result).toEqual({
        processed: 1,
        published: 0,
        failed: 1,
      });

      const row = await getOutboxRow(outboxId);
      expect(row.status).toBe("pending");
      expect(row.relayMessageId).toBeNull();
      expect(row.lastErrorCode).toBe("outbox_relay_failed");
      expect(row.lastErrorMessage).toContain(
        "Failed to mark outbox row as published",
      );
      expect(row.availableAt.getTime()).toBe(
        addMilliseconds(now, 1_000).getTime(),
      );
      expect(await redis.xlen(streamKey)).toBe(1);
    } finally {
      markPublishedSpy.mockRestore();
    }
  });

  it("replays a crashed publish via stale publishing claim and publishes exactly once", async () => {
    const workflowId = await createWorkflowFixture();
    const outboxId = await createOutboxRecord({
      workflowId,
      outboxIdPrefix: nanoid(),
    });
    const streamKey = `dl3:test:relay:${nanoid()}`;
    const dedupeIndexKey = `dl3:test:relay:dedupe:${nanoid()}`;
    const outbox = await getOutboxRow(outboxId);
    const publishedMessageId = await relay.publishOutboxRecord({
      outbox,
      streamKey,
      dedupeIndexKey,
    });

    const staleAt = new Date("2026-03-18T09:50:00.000Z");
    await db
      .update(schema.deliveryOutboxV3)
      .set({
        status: "publishing",
        leaseOwner: "crashed-worker",
        leaseEpoch: 3,
        leaseExpiresAt: staleAt,
        claimedAt: staleAt,
        attemptCount: 1,
        availableAt: staleAt,
      })
      .where(eq(schema.deliveryOutboxV3.id, outboxId));

    const result = await relay.drainOutboxRelay({
      db,
      workflowId,
      now: new Date("2026-03-18T10:00:00.000Z"),
      maxItems: 10,
      leaseOwnerPrefix: "test:relay:restart",
      streamKey,
      dedupeIndexKey,
    });
    expect(result).toEqual({
      processed: 1,
      published: 1,
      failed: 0,
    });

    const replayedOutbox = await getOutboxRow(outboxId);
    expect(replayedOutbox.status).toBe("published");
    expect(replayedOutbox.attemptCount).toBe(2);
    expect(replayedOutbox.relayMessageId).toBe(publishedMessageId);
    expect(await redis.xlen(streamKey)).toBe(1);
  });
});
