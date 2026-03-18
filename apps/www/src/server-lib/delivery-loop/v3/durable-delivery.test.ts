import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { nanoid } from "nanoid/non-secure";
import { addMilliseconds } from "date-fns";
import { db } from "@/lib/db";
import { redis } from "@/lib/redis";
import * as schema from "@terragon/shared/db/schema";
import type { DeliveryOutboxV3Row } from "@terragon/shared/db/types";
import {
  createTestThread,
  createTestUser,
} from "@terragon/shared/model/test-helpers";
import { createWorkflow } from "@terragon/shared/delivery-loop/store/workflow-store";
import {
  appendJournalEventV3,
  ensureWorkflowHeadV3,
  enqueueOutboxRecordV3,
  getWorkflowHeadV3,
  updateWorkflowHeadV3,
} from "./store";
import { buildSignalJournalContractV3 } from "./contracts";
import type { DeliverySignalSourceV3 } from "@terragon/shared/db/types";
import type { LoopEventV3 } from "./types";
import * as relay from "./relay";
import * as store from "./store";
import { drainOutboxV3Worker } from "./worker";
import { appendEventAndAdvanceV3 } from "./kernel";

const TEST_STREAM_KEY_PREFIX = "dl3:test:v3-durable:stream";
const TEST_DEDUPE_KEY_PREFIX = "dl3:test:v3-durable:dedupe";
const TEST_RELAY_GROUP_PREFIX = "dl3:test:v3-durable:relay";

function createRunKeys() {
  const runId = nanoid();
  return {
    streamKey: `${TEST_STREAM_KEY_PREFIX}:${runId}`,
    dedupeIndexKey: `${TEST_DEDUPE_KEY_PREFIX}:${runId}`,
    relayOwnerPrefix: `${TEST_RELAY_GROUP_PREFIX}:${runId}`,
    workerGroupName: `dl3:test:v3-durable-group:${runId}`,
    workerAttemptsHash: `${TEST_STREAM_KEY_PREFIX}:${runId}:attempts`,
    workerProcessedHash: `${TEST_STREAM_KEY_PREFIX}:${runId}:processed`,
    workerHeartbeat: `${TEST_STREAM_KEY_PREFIX}:${runId}:heartbeat`,
    workerDlqStream: `${TEST_STREAM_KEY_PREFIX}:${runId}:dlq`,
  };
}

async function createWorkflowFixture(): Promise<string> {
  const { user } = await createTestUser({ db });
  const { threadId } = await createTestThread({ db, userId: user.id });
  const workflow = await createWorkflow({
    db,
    threadId,
    generation: 1,
    userId: user.id,
    kind: "planning",
    stateJson: { state: "planning" },
  });
  return workflow.id;
}

async function createSignalJournal(params: {
  workflowId: string;
  source: DeliverySignalSourceV3;
  idempotencyKey: string;
  event: LoopEventV3;
  occurredAt?: Date;
}): Promise<string> {
  const contract = buildSignalJournalContractV3({
    workflowId: params.workflowId,
    source: params.source,
    idempotencyKey: params.idempotencyKey,
    event: params.event,
    occurredAt: params.occurredAt ?? new Date("2026-03-18T10:00:00.000Z"),
  });

  const result = await appendJournalEventV3({
    db,
    workflowId: contract.workflowId,
    source: contract.source,
    eventType: contract.eventType,
    idempotencyKey: contract.idempotencyKey,
    payloadJson: contract.payload,
    occurredAt: contract.occurredAt,
  });

  if (result.inserted) {
    if (!result.id) {
      throw new Error("Signal journal insert returned no id");
    }
    return result.id;
  }

  const existing = await db.query.deliveryLoopJournalV3.findFirst({
    where: and(
      eq(schema.deliveryLoopJournalV3.workflowId, params.workflowId),
      eq(schema.deliveryLoopJournalV3.source, params.source),
      eq(schema.deliveryLoopJournalV3.idempotencyKey, params.idempotencyKey),
    ),
  });

  if (!existing) {
    throw new Error(
      "Expected existing signal journal row after idempotent insert",
    );
  }
  return existing.id;
}

async function createBootstrapJournal(params: {
  workflowId: string;
  idempotencyKey: string;
  source?: DeliverySignalSourceV3;
}): Promise<string> {
  return createSignalJournal({
    workflowId: params.workflowId,
    source: params.source ?? "daemon",
    idempotencyKey: params.idempotencyKey,
    event: {
      type: "bootstrap",
    },
  });
}

async function createSignalOutboxRecordForEvent(params: {
  workflowId: string;
  journalId: string;
  keyPrefix: string;
  source: DeliverySignalSourceV3;
  eventType: string;
}): Promise<string> {
  const result = await enqueueOutboxRecordV3({
    db,
    outbox: {
      workflowId: params.workflowId,
      topic: "signal",
      dedupeKey: `${params.keyPrefix}:dedupe`,
      idempotencyKey: `${params.keyPrefix}:idem`,
      availableAt: new Date("2026-03-18T10:00:00.000Z"),
      maxAttempts: 4,
      payload: {
        kind: "signal",
        journalId: params.journalId,
        workflowId: params.workflowId,
        eventType: params.eventType,
        source: params.source,
      },
    },
  });

  if (result.inserted && result.id) {
    return result.id;
  }

  const existing = await db.query.deliveryOutboxV3.findFirst({
    where: eq(schema.deliveryOutboxV3.dedupeKey, `${params.keyPrefix}:dedupe`),
  });
  if (!existing) {
    throw new Error("Expected existing outbox row after idempotent insert");
  }
  return existing.id;
}

async function createSignalOutboxRecord(params: {
  workflowId: string;
  journalId: string;
  keyPrefix: string;
  source?: DeliverySignalSourceV3;
  eventType?: string;
}): Promise<string> {
  return createSignalOutboxRecordForEvent({
    workflowId: params.workflowId,
    journalId: params.journalId,
    keyPrefix: params.keyPrefix,
    source: params.source ?? "daemon",
    eventType: params.eventType ?? "bootstrap",
  });
}

async function writeSignalEntriesToStream(params: {
  streamKey: string;
  outbox: DeliveryOutboxV3Row;
  count: number;
}): Promise<string[]> {
  const messagePayload = JSON.stringify({
    outboxId: params.outbox.id,
    workflowId: params.outbox.workflowId,
    topic: params.outbox.topic,
    payload: params.outbox.payloadJson,
    idempotencyKey: params.outbox.idempotencyKey,
    dedupeKey: params.outbox.dedupeKey,
  });

  const messageIds: string[] = [];

  for (let i = 0; i < params.count; i += 1) {
    const messageId = await redis.xadd(params.streamKey, "*", {
      outboxId: params.outbox.id,
      workflowId: params.outbox.workflowId,
      topic: params.outbox.topic,
      dedupeKey: params.outbox.dedupeKey,
      idempotencyKey: params.outbox.idempotencyKey,
      payload: messagePayload,
    });

    if (typeof messageId !== "string") {
      throw new Error("Failed to write stream message");
    }
    messageIds.push(messageId);
  }

  return messageIds;
}

async function getOutboxRow(outboxId: string) {
  const row = await db.query.deliveryOutboxV3.findFirst({
    where: eq(schema.deliveryOutboxV3.id, outboxId),
  });
  if (!row) {
    throw new Error("Outbox row not found");
  }
  return row;
}

beforeEach(async () => {
  const redisKeys = await redis.keys("dl3:test:v3-durable*");
  if (redisKeys.length > 0) {
    await redis.del(...redisKeys);
  }
});

describe("v3 durable delivery loop", () => {
  it("deduplicates duplicate ingress rows and journals while still advancing once", async () => {
    const keys = createRunKeys();
    const workflowId = await createWorkflowFixture();
    const keyPrefix = `durable-${nanoid()}`;
    const idempotencyKey = `${keyPrefix}:journal`;

    const journalId = await createBootstrapJournal({
      workflowId,
      idempotencyKey,
    });
    await createBootstrapJournal({ workflowId, idempotencyKey });

    const outboxId = await createSignalOutboxRecord({
      workflowId,
      journalId,
      keyPrefix,
    });
    const duplicateOutbox = await createSignalOutboxRecord({
      workflowId,
      journalId,
      keyPrefix,
    });
    expect(duplicateOutbox).toBe(outboxId);

    const relayResult = await relay.drainOutboxV3Relay({
      db,
      maxItems: 10,
      leaseOwnerPrefix: keys.relayOwnerPrefix,
      streamKey: keys.streamKey,
      dedupeIndexKey: keys.dedupeIndexKey,
    });

    expect(relayResult).toEqual({
      processed: 1,
      published: 1,
      failed: 0,
    });

    const workerResult = await drainOutboxV3Worker({
      db,
      streamKey: keys.streamKey,
      groupName: keys.workerGroupName,
      consumerName: "worker-dedup-1",
      maxItems: 5,
      readBatchSize: 1,
      blockMs: 100,
      staleClaimMs: 0,
      attemptsHashKey: keys.workerAttemptsHash,
      processedHashKey: keys.workerProcessedHash,
      deadLetterStreamKey: keys.workerDlqStream,
      heartbeatKey: keys.workerHeartbeat,
    });

    expect(workerResult).toEqual({
      processed: 1,
      acknowledged: 1,
      deadLettered: 0,
      retried: 0,
    });

    const workflowHead = await db.query.deliveryWorkflowHeadV3.findFirst({
      where: eq(schema.deliveryWorkflowHeadV3.workflowId, workflowId),
    });
    expect(workflowHead).not.toBeNull();
    if (!workflowHead) {
      throw new Error("Expected workflow head after worker progression");
    }
    expect(workflowHead.state).toBe("implementing");
    expect(workflowHead.version).toBe(1);

    const journalRows = await db.query.deliveryLoopJournalV3.findMany({
      where: eq(schema.deliveryLoopJournalV3.workflowId, workflowId),
    });
    expect(journalRows).toHaveLength(2);

    const effectRows = await db.query.deliveryEffectLedgerV3.findMany({
      where: eq(schema.deliveryEffectLedgerV3.workflowId, workflowId),
    });
    expect(effectRows).toHaveLength(1);
    const [effectRow] = effectRows;
    expect(effectRow).toBeDefined();
    if (!effectRow) {
      throw new Error("Expected effect row after worker progression");
    }
    expect(effectRow.effectKind).toBe("dispatch_implementing");
  });

  it("keeps duplicate stream deliveries idempotent under concurrent workers", async () => {
    const keys = createRunKeys();
    const workflowId = await createWorkflowFixture();
    const runId = `run-${nanoid()}`;
    const keyPrefix = `durable-concurrent-${nanoid()}`;

    await appendEventAndAdvanceV3({
      db,
      workflowId,
      source: "daemon",
      idempotencyKey: `${keyPrefix}:bootstrap`,
      event: { type: "bootstrap" },
    });

    await appendEventAndAdvanceV3({
      db,
      workflowId,
      source: "system",
      idempotencyKey: `${keyPrefix}:dispatch`,
      event: {
        type: "dispatch_sent",
        runId,
        ackDeadlineAt: new Date("2026-03-18T10:01:00.000Z"),
      },
    });

    const completionJournalId = await createSignalJournal({
      workflowId,
      source: "daemon",
      idempotencyKey: `${keyPrefix}:completion`,
      event: {
        type: "run_completed",
        runId,
        headSha: "abc123",
      },
    });

    const outboxId = await createSignalOutboxRecord({
      workflowId,
      journalId: completionJournalId,
      keyPrefix,
      source: "daemon",
      eventType: "run_completed",
    });
    const outbox = await getOutboxRow(outboxId);

    const relayResult = await relay.drainOutboxV3Relay({
      db,
      maxItems: 1,
      leaseOwnerPrefix: keys.relayOwnerPrefix,
      streamKey: keys.streamKey,
      dedupeIndexKey: keys.dedupeIndexKey,
    });
    expect(relayResult).toEqual({
      processed: 1,
      published: 1,
      failed: 0,
    });

    const messageIds = await writeSignalEntriesToStream({
      streamKey: keys.streamKey,
      outbox,
      count: 2,
    });
    expect(messageIds).toHaveLength(2);

    const [firstWorker, secondWorker] = await Promise.all([
      drainOutboxV3Worker({
        db,
        streamKey: keys.streamKey,
        groupName: keys.workerGroupName,
        consumerName: "worker-concurrent-1",
        maxItems: 2,
        readBatchSize: 2,
        blockMs: 100,
        staleClaimMs: 0,
        attemptsHashKey: keys.workerAttemptsHash,
        processedHashKey: keys.workerProcessedHash,
        deadLetterStreamKey: keys.workerDlqStream,
        heartbeatKey: keys.workerHeartbeat,
      }),
      drainOutboxV3Worker({
        db,
        streamKey: keys.streamKey,
        groupName: keys.workerGroupName,
        consumerName: "worker-concurrent-2",
        maxItems: 2,
        readBatchSize: 2,
        blockMs: 100,
        staleClaimMs: 0,
        attemptsHashKey: keys.workerAttemptsHash,
        processedHashKey: keys.workerProcessedHash,
        deadLetterStreamKey: keys.workerDlqStream,
        heartbeatKey: keys.workerHeartbeat,
      }),
    ]);

    expect(firstWorker.processed + secondWorker.processed).toBe(3);
    expect(firstWorker.acknowledged + secondWorker.acknowledged).toBe(3);
    expect(firstWorker.retried + secondWorker.retried).toBe(0);
    expect(firstWorker.deadLettered + secondWorker.deadLettered).toBe(0);

    const workflowHead = await db.query.deliveryWorkflowHeadV3.findFirst({
      where: eq(schema.deliveryWorkflowHeadV3.workflowId, workflowId),
    });
    if (!workflowHead) {
      throw new Error(
        "Expected workflow head after concurrent duplicate processing",
      );
    }
    expect(workflowHead.state).toBe("gating_review");
    expect(workflowHead.version).toBe(3);

    const effectRows = await db.query.deliveryEffectLedgerV3.findMany({
      where: eq(schema.deliveryEffectLedgerV3.workflowId, workflowId),
    });
    const reviewEffects = effectRows.filter(
      (effect) => effect.effectKind === "dispatch_gate_review",
    );
    expect(reviewEffects).toHaveLength(1);
  });

  it("preserves a single logical transition when out-of-order + duplicate stream messages race", async () => {
    const keys = createRunKeys();
    const workflowId = await createWorkflowFixture();
    const runIdCurrent = `run-${nanoid()}`;
    const runIdStale = `run-${nanoid()}`;
    const currentPrefix = `durable-oof-${nanoid()}`;

    await appendEventAndAdvanceV3({
      db,
      workflowId,
      source: "daemon",
      idempotencyKey: `${currentPrefix}:bootstrap`,
      event: { type: "bootstrap" },
    });

    await appendEventAndAdvanceV3({
      db,
      workflowId,
      source: "system",
      idempotencyKey: `${currentPrefix}:dispatch-stale`,
      event: {
        type: "dispatch_sent",
        runId: runIdStale,
        ackDeadlineAt: new Date("2026-03-18T10:01:00.000Z"),
      },
    });

    await appendEventAndAdvanceV3({
      db,
      workflowId,
      source: "system",
      idempotencyKey: `${currentPrefix}:dispatch-current`,
      event: {
        type: "dispatch_sent",
        runId: runIdCurrent,
        ackDeadlineAt: new Date("2026-03-18T10:01:10.000Z"),
      },
    });

    const staleJournalId = await createSignalJournal({
      workflowId,
      source: "daemon",
      idempotencyKey: `${currentPrefix}:stale-complete`,
      event: {
        type: "run_completed",
        runId: runIdStale,
        headSha: "stale-head",
      },
    });
    const staleOutboxId = await createSignalOutboxRecord({
      workflowId,
      journalId: staleJournalId,
      keyPrefix: `${currentPrefix}-stale`,
      source: "daemon",
      eventType: "run_completed",
    });
    const staleOutbox = await getOutboxRow(staleOutboxId);

    const currentJournalId = await createSignalJournal({
      workflowId,
      source: "daemon",
      idempotencyKey: `${currentPrefix}:current-complete`,
      event: {
        type: "run_completed",
        runId: runIdCurrent,
        headSha: "current-head",
      },
    });
    const currentOutboxId = await createSignalOutboxRecord({
      workflowId,
      journalId: currentJournalId,
      keyPrefix: `${currentPrefix}-current`,
      source: "daemon",
      eventType: "run_completed",
    });
    const currentOutbox = await getOutboxRow(currentOutboxId);

    const relayResult = await relay.drainOutboxV3Relay({
      db,
      maxItems: 2,
      leaseOwnerPrefix: keys.relayOwnerPrefix,
      streamKey: keys.streamKey,
      dedupeIndexKey: keys.dedupeIndexKey,
    });
    expect(relayResult).toEqual({
      processed: 2,
      published: 2,
      failed: 0,
    });

    const staleMessageIds = await writeSignalEntriesToStream({
      streamKey: keys.streamKey,
      outbox: staleOutbox,
      count: 2,
    });
    const currentMessageIds = await writeSignalEntriesToStream({
      streamKey: keys.streamKey,
      outbox: currentOutbox,
      count: 2,
    });

    expect(staleMessageIds).toHaveLength(2);
    expect(currentMessageIds).toHaveLength(2);

    const [firstWorker, secondWorker] = await Promise.all([
      drainOutboxV3Worker({
        db,
        streamKey: keys.streamKey,
        groupName: keys.workerGroupName,
        consumerName: "worker-oof-1",
        maxItems: 4,
        readBatchSize: 4,
        blockMs: 100,
        staleClaimMs: 30_000,
        attemptsHashKey: keys.workerAttemptsHash,
        processedHashKey: keys.workerProcessedHash,
        deadLetterStreamKey: keys.workerDlqStream,
        heartbeatKey: keys.workerHeartbeat,
      }),
      drainOutboxV3Worker({
        db,
        streamKey: keys.streamKey,
        groupName: keys.workerGroupName,
        consumerName: "worker-oof-2",
        maxItems: 4,
        readBatchSize: 4,
        blockMs: 100,
        staleClaimMs: 30_000,
        attemptsHashKey: keys.workerAttemptsHash,
        processedHashKey: keys.workerProcessedHash,
        deadLetterStreamKey: keys.workerDlqStream,
        heartbeatKey: keys.workerHeartbeat,
      }),
    ]);

    expect(firstWorker.processed + secondWorker.processed).toBe(6);
    expect(firstWorker.deadLettered + secondWorker.deadLettered).toBe(0);

    const workflowHead = await db.query.deliveryWorkflowHeadV3.findFirst({
      where: eq(schema.deliveryWorkflowHeadV3.workflowId, workflowId),
    });
    if (!workflowHead) {
      throw new Error("Expected workflow head after oof concurrent processing");
    }
    expect(workflowHead.state).toBe("gating_review");
    expect(workflowHead.activeRunId).toBeNull();
    expect(workflowHead.headSha).toBe("current-head");

    const effectRows = await db.query.deliveryEffectLedgerV3.findMany({
      where: eq(schema.deliveryEffectLedgerV3.workflowId, workflowId),
    });
    const reviewEffects = effectRows.filter(
      (effect) => effect.effectKind === "dispatch_gate_review",
    );
    expect(reviewEffects).toHaveLength(1);
    expect(reviewEffects[0]).toBeDefined();
  });

  it("retries a relay markPublished miss and recovers without duplicate stream messages", async () => {
    const keys = createRunKeys();
    const now = new Date("2026-03-18T10:00:00.000Z");
    const workflowId = await createWorkflowFixture();
    const keyPrefix = `durable-relay-${nanoid()}`;
    const journalId = await createBootstrapJournal({
      workflowId,
      idempotencyKey: `${keyPrefix}:journal`,
    });
    const outboxId = await createSignalOutboxRecord({
      workflowId,
      journalId,
      keyPrefix,
    });

    const markPublishedSpy = vi
      .spyOn(store, "markOutboxPublishedV3")
      .mockResolvedValue(false);

    try {
      const firstRelayResult = await relay.drainOutboxV3Relay({
        db,
        maxItems: 1,
        leaseOwnerPrefix: keys.relayOwnerPrefix,
        streamKey: keys.streamKey,
        dedupeIndexKey: keys.dedupeIndexKey,
        now,
      });

      expect(firstRelayResult).toEqual({
        processed: 1,
        published: 0,
        failed: 1,
      });

      const failedOutbox = await getOutboxRow(outboxId);
      expect(failedOutbox.status).toBe("pending");
      expect(failedOutbox.lastErrorCode).toBe("outbox_relay_failed");
      expect(failedOutbox.attemptCount).toBe(1);

      markPublishedSpy.mockRestore();

      const secondRelayResult = await relay.drainOutboxV3Relay({
        db,
        maxItems: 1,
        leaseOwnerPrefix: keys.relayOwnerPrefix,
        streamKey: keys.streamKey,
        dedupeIndexKey: keys.dedupeIndexKey,
        now: addMilliseconds(now, 1_250),
      });

      expect(secondRelayResult).toEqual({
        processed: 1,
        published: 1,
        failed: 0,
      });

      const recoveredOutbox = await getOutboxRow(outboxId);
      expect(recoveredOutbox.status).toBe("published");
      expect(recoveredOutbox.relayMessageId).not.toBeNull();
      expect(await redis.xlen(keys.streamKey)).toBe(1);
    } finally {
      if (markPublishedSpy.mockRestore) {
        markPublishedSpy.mockRestore();
      }
    }

    const relayJournalRows = await db.query.deliveryLoopJournalV3.findMany({
      where: eq(schema.deliveryLoopJournalV3.workflowId, workflowId),
    });
    expect(relayJournalRows).toHaveLength(1);
  });

  it("recovers a worker after a crash without duplicating journal/effect work", async () => {
    const keys = createRunKeys();
    const workflowId = await createWorkflowFixture();
    const keyPrefix = `durable-worker-${nanoid()}`;
    const journalId = await createBootstrapJournal({
      workflowId,
      idempotencyKey: `${keyPrefix}:journal`,
    });
    const outboxId = await createSignalOutboxRecord({
      workflowId,
      journalId,
      keyPrefix,
    });

    const relayResult = await relay.drainOutboxV3Relay({
      db,
      maxItems: 1,
      leaseOwnerPrefix: keys.relayOwnerPrefix,
      streamKey: keys.streamKey,
      dedupeIndexKey: keys.dedupeIndexKey,
    });
    expect(relayResult).toEqual({
      processed: 1,
      published: 1,
      failed: 0,
    });

    const crashedFirstAttempt = await drainOutboxV3Worker({
      db,
      streamKey: keys.streamKey,
      groupName: keys.workerGroupName,
      consumerName: "worker-crash-1",
      maxItems: 1,
      staleClaimMs: 0,
      blockMs: 100,
      attemptsHashKey: keys.workerAttemptsHash,
      processedHashKey: keys.workerProcessedHash,
      deadLetterStreamKey: keys.workerDlqStream,
      heartbeatKey: keys.workerHeartbeat,
      readBatchSize: 1,
      processMessage: async () => {
        throw new Error("simulated worker crash");
      },
    });

    expect(crashedFirstAttempt).toEqual({
      processed: 1,
      acknowledged: 0,
      deadLettered: 0,
      retried: 1,
    });

    const journalsAfterCrash = await db.query.deliveryLoopJournalV3.findMany({
      where: eq(schema.deliveryLoopJournalV3.workflowId, workflowId),
    });
    expect(journalsAfterCrash).toHaveLength(1);

    const recoveredWorkerResult = await drainOutboxV3Worker({
      db,
      streamKey: keys.streamKey,
      groupName: keys.workerGroupName,
      consumerName: "worker-crash-2",
      maxItems: 1,
      staleClaimMs: 0,
      blockMs: 100,
      attemptsHashKey: keys.workerAttemptsHash,
      processedHashKey: keys.workerProcessedHash,
      deadLetterStreamKey: keys.workerDlqStream,
      heartbeatKey: keys.workerHeartbeat,
      readBatchSize: 1,
    });

    expect(recoveredWorkerResult).toEqual({
      processed: 1,
      acknowledged: 1,
      deadLettered: 0,
      retried: 0,
    });

    const journalsAfterRecovery = await db.query.deliveryLoopJournalV3.findMany(
      {
        where: eq(schema.deliveryLoopJournalV3.workflowId, workflowId),
      },
    );
    expect(journalsAfterRecovery).toHaveLength(2);

    const effectsAfterRecovery = await db.query.deliveryEffectLedgerV3.findMany(
      {
        where: eq(schema.deliveryEffectLedgerV3.workflowId, workflowId),
      },
    );
    expect(effectsAfterRecovery).toHaveLength(1);

    const recoveredHead = await db.query.deliveryWorkflowHeadV3.findFirst({
      where: eq(schema.deliveryWorkflowHeadV3.workflowId, workflowId),
    });
    expect(recoveredHead).not.toBeNull();
    if (!recoveredHead) {
      throw new Error("Expected workflow head after worker recovery");
    }
    expect(recoveredHead.state).toBe("implementing");
    expect(recoveredHead.version).toBe(1);

    const recoveredOutbox = await getOutboxRow(outboxId);
    expect(recoveredOutbox.status).toBe("published");
    expect(await redis.xlen(keys.streamKey)).toBe(1);
  });

  it("ignores duplicate signals per idempotency key at coordinator boundary", async () => {
    const workflowId = await createWorkflowFixture();
    const runId = `run-${nanoid()}`;

    const bootstrapResult = await appendEventAndAdvanceV3({
      db,
      workflowId,
      source: "daemon",
      idempotencyKey: `dup:${workflowId}:bootstrap`,
      event: { type: "bootstrap" },
    });
    expect(bootstrapResult.transitioned).toBe(true);

    const dispatchResult = await appendEventAndAdvanceV3({
      db,
      workflowId,
      source: "system",
      idempotencyKey: `dup:${workflowId}:dispatch`,
      event: {
        type: "dispatch_sent",
        runId,
        ackDeadlineAt: new Date("2026-03-18T11:00:00.000Z"),
      },
    });
    expect(dispatchResult.inserted).toBe(true);

    const applyRunCompleted = async (
      idempotencyKey: string,
      event: LoopEventV3,
    ): Promise<Awaited<ReturnType<typeof appendEventAndAdvanceV3>>> => {
      return appendEventAndAdvanceV3({
        db,
        workflowId,
        source: "daemon",
        idempotencyKey,
        event,
      });
    };

    const runCompletedFirst = await applyRunCompleted(
      `dup:${workflowId}:complete`,
      {
        type: "run_completed",
        runId,
        headSha: "deadbeef",
      },
    );
    const runCompletedSecond = await applyRunCompleted(
      `dup:${workflowId}:complete`,
      {
        type: "run_completed",
        runId,
        headSha: "deadbeef",
      },
    );

    expect(runCompletedFirst.inserted).toBe(true);
    expect(runCompletedFirst.transitioned).toBe(true);
    expect(runCompletedSecond.inserted).toBe(false);
    expect(runCompletedSecond.transitioned).toBe(false);

    const effects = await db.query.deliveryEffectLedgerV3.findMany({
      where: eq(schema.deliveryEffectLedgerV3.workflowId, workflowId),
    });
    const effectKinds = effects.map((effect) => effect.effectKind);
    expect(effectKinds).toContain("dispatch_gate_review");
    expect(
      effectKinds.filter((kind) => kind === "dispatch_gate_review"),
    ).toHaveLength(1);
    expect(effects).toHaveLength(3);
  });

  it("ignores out-of-order stale run signal once a newer dispatch is active", async () => {
    const workflowId = await createWorkflowFixture();
    const staleRunId = `run-${nanoid()}`;
    const currentRunId = `run-${nanoid()}`;

    await appendEventAndAdvanceV3({
      db,
      workflowId,
      source: "daemon",
      idempotencyKey: `oof:${workflowId}:bootstrap`,
      event: { type: "bootstrap" },
    });

    await appendEventAndAdvanceV3({
      db,
      workflowId,
      source: "system",
      idempotencyKey: `oof:${workflowId}:dispatch-stale`,
      event: {
        type: "dispatch_sent",
        runId: staleRunId,
        ackDeadlineAt: new Date("2026-03-18T11:00:00.000Z"),
      },
    });

    await appendEventAndAdvanceV3({
      db,
      workflowId,
      source: "system",
      idempotencyKey: `oof:${workflowId}:dispatch-current`,
      event: {
        type: "dispatch_sent",
        runId: currentRunId,
        ackDeadlineAt: new Date("2026-03-18T11:00:10.000Z"),
      },
    });

    const staleRunCompleted = await appendEventAndAdvanceV3({
      db,
      workflowId,
      source: "daemon",
      idempotencyKey: `oof:${workflowId}:out-of-order`,
      event: {
        type: "run_completed",
        runId: staleRunId,
        headSha: "stale-head-sha",
      },
    });
    expect(staleRunCompleted.transitioned).toBe(false);

    const headAfterStale = await db.query.deliveryWorkflowHeadV3.findFirst({
      where: eq(schema.deliveryWorkflowHeadV3.workflowId, workflowId),
    });
    expect(headAfterStale).not.toBeNull();
    if (!headAfterStale) {
      throw new Error("Expected workflow head after stale run signal");
    }
    expect(headAfterStale.state).toBe("implementing");
    expect(headAfterStale.activeRunId).toBe(currentRunId);

    const currentRunCompleted = await appendEventAndAdvanceV3({
      db,
      workflowId,
      source: "daemon",
      idempotencyKey: `oof:${workflowId}:in-order`,
      event: {
        type: "run_completed",
        runId: currentRunId,
        headSha: "current-head-sha",
      },
    });
    expect(currentRunCompleted.transitioned).toBe(true);

    const headAfterCurrent = await db.query.deliveryWorkflowHeadV3.findFirst({
      where: eq(schema.deliveryWorkflowHeadV3.workflowId, workflowId),
    });
    expect(headAfterCurrent).not.toBeNull();
    if (!headAfterCurrent) {
      throw new Error("Expected workflow head after in-order run signal");
    }
    expect(headAfterCurrent.state).toBe("gating_review");
    expect(headAfterCurrent.activeRunId).toBeNull();
    expect(headAfterCurrent.headSha).toBe("current-head-sha");
  });

  it("rejects stale CAS updates to workflow head", async () => {
    const workflowId = await createWorkflowFixture();
    const head = await ensureWorkflowHeadV3({ db, workflowId });
    if (!head) {
      throw new Error("Expected workflow head for CAS test");
    }

    const updated = await updateWorkflowHeadV3({
      db,
      head: {
        ...head,
        blockedReason: "CAS test block",
      },
      expectedVersion: head.version + 1,
    });
    expect(updated).toBe(false);

    const current = await getWorkflowHeadV3({ db, workflowId });
    expect(current).not.toBeNull();
    if (!current) {
      throw new Error("Expected workflow head after stale CAS update");
    }
    expect(current.version).toBe(head.version);
    expect(current.blockedReason).toBeNull();
  });
});
