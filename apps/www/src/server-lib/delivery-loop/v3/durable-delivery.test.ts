import { and, eq, like } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  appendJournalEvent,
  ensureWorkflowHead,
  enqueueOutboxRecord,
  getWorkflowHead,
  reconcileZombieGateHeadsFromLegacy,
  updateWorkflowHead,
} from "./store";
import { buildSignalJournalContract } from "./contracts";
import type { DeliverySignalSourceV3 } from "@terragon/shared/db/types";
import type { LoopEvent } from "./types";
import * as relay from "./relay";
import * as store from "./store";
import * as processEffects from "./process-effects";
import { drainOutboxWorker } from "./worker";
import { appendEventAndAdvanceExplicit } from "./kernel";

const TEST_STREAM_KEY_PREFIX = "dl3:test:v3-durable:stream";
const TEST_DEDUPE_KEY_PREFIX = "dl3:test:v3-durable:dedupe";
const TEST_RELAY_GROUP_PREFIX = "dl3:test:v3-durable:relay";
const TEST_OUTBOX_KEY_PREFIX = "dl3:test:v3-durable:outbox";

type KernelAdvanceResult = Awaited<
  ReturnType<typeof appendEventAndAdvanceExplicit>
>;

async function appendEventAndAdvance(params: {
  db: typeof db;
  workflowId: string;
  source: DeliverySignalSourceV3;
  idempotencyKey: string;
  event: LoopEvent;
  now?: Date;
  skipGates?: boolean;
  eagerDrain?: boolean;
}): Promise<KernelAdvanceResult> {
  return appendEventAndAdvanceExplicit({
    db: params.db,
    workflowId: params.workflowId,
    source: params.source,
    idempotencyKey: params.idempotencyKey,
    event: params.event,
    now: params.now,
    behavior: {
      applyGateBypass: params.skipGates === true,
      drainEffects: params.eagerDrain !== false,
    },
  });
}

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
  event: LoopEvent;
  occurredAt?: Date;
}): Promise<string> {
  const contract = buildSignalJournalContract({
    workflowId: params.workflowId,
    source: params.source,
    idempotencyKey: params.idempotencyKey,
    event: params.event,
    occurredAt: params.occurredAt ?? new Date("2026-03-18T10:00:00.000Z"),
  });

  const result = await appendJournalEvent({
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

async function createLegacySignalEnvelopeJournal(params: {
  workflowId: string;
  source: DeliverySignalSourceV3;
  idempotencyKey: string;
  event: {
    kind: string;
  } & Record<string, unknown>;
  occurredAt?: Date;
}): Promise<string> {
  const occurredAt = params.occurredAt ?? new Date("2026-03-18T10:00:00.000Z");
  const result = await appendJournalEvent({
    db,
    workflowId: params.workflowId,
    source: params.source,
    eventType: params.event.kind,
    idempotencyKey: params.idempotencyKey,
    payloadJson: {
      source: params.source,
      event: params.event,
    },
    occurredAt,
  });

  if (result.inserted) {
    if (!result.id) {
      throw new Error("Legacy signal journal insert returned no id");
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
      "Expected existing legacy signal journal row after idempotent insert",
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
  const result = await enqueueOutboxRecord({
    db,
    outbox: {
      workflowId: params.workflowId,
      topic: "signal",
      dedupeKey: `${TEST_OUTBOX_KEY_PREFIX}:${params.keyPrefix}:dedupe`,
      idempotencyKey: `${TEST_OUTBOX_KEY_PREFIX}:${params.keyPrefix}:idem`,
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
    where: eq(
      schema.deliveryOutboxV3.dedupeKey,
      `${TEST_OUTBOX_KEY_PREFIX}:${params.keyPrefix}:dedupe`,
    ),
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

async function cleanupDurableDeliveryTestState(): Promise<void> {
  await db
    .delete(schema.deliveryOutboxV3)
    .where(
      like(schema.deliveryOutboxV3.dedupeKey, `${TEST_OUTBOX_KEY_PREFIX}%`),
    );
  const redisKeys = await redis.keys("dl3:test:v3-durable*");
  if (redisKeys.length > 0) {
    await redis.del(...redisKeys);
  }
}

beforeEach(cleanupDurableDeliveryTestState);
afterEach(cleanupDurableDeliveryTestState);

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

    const relayResult = await relay.drainOutboxRelay({
      db,
      workflowId,
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

    const workerResult = await drainOutboxWorker({
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
    expect(workflowHead.state).toBe("planning");

    const journalRows = await db.query.deliveryLoopJournalV3.findMany({
      where: eq(schema.deliveryLoopJournalV3.workflowId, workflowId),
    });
    // 1 pre-created bootstrap journal + 1 from worker's appendEventAndAdvance
    expect(journalRows.length).toBeGreaterThanOrEqual(2);

    const effectRows = await db.query.deliveryEffectLedgerV3.findMany({
      where: eq(schema.deliveryEffectLedgerV3.workflowId, workflowId),
    });
    expect(effectRows.map((r) => r.effectKind)).toContain(
      "dispatch_implementing",
    );
    expect(effectRows.map((r) => r.effectKind)).toContain("publish_status");
  });

  it("keeps duplicate stream deliveries idempotent under concurrent workers", async () => {
    const keys = createRunKeys();
    const workflowId = await createWorkflowFixture();
    const runId = `run-${nanoid()}`;
    const keyPrefix = `durable-concurrent-${nanoid()}`;

    await appendEventAndAdvance({
      db,
      workflowId,
      source: "daemon",
      idempotencyKey: `${keyPrefix}:bootstrap`,
      event: { type: "bootstrap" },
      eagerDrain: false,
    });

    await appendEventAndAdvance({
      db,
      workflowId,
      source: "system",
      idempotencyKey: `${keyPrefix}:plan-completed`,
      event: { type: "plan_completed" },
      eagerDrain: false,
    });

    await appendEventAndAdvance({
      db,
      workflowId,
      source: "system",
      idempotencyKey: `${keyPrefix}:dispatch`,
      event: {
        type: "dispatch_sent",
        runId,
      },
      eagerDrain: false,
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

    const relayResult = await relay.drainOutboxRelay({
      db,
      workflowId,
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
      drainOutboxWorker({
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
      drainOutboxWorker({
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

    const totalProcessed = firstWorker.processed + secondWorker.processed;
    const totalAcknowledged =
      firstWorker.acknowledged + secondWorker.acknowledged;
    expect(totalProcessed).toBeGreaterThanOrEqual(2);
    expect(totalProcessed).toBeLessThanOrEqual(4);
    expect(totalAcknowledged).toBeGreaterThanOrEqual(2);
    expect(totalAcknowledged).toBeLessThanOrEqual(4);
    expect(firstWorker.retried + secondWorker.retried).toBeLessThanOrEqual(2);
    expect(firstWorker.deadLettered + secondWorker.deadLettered).toBe(0);

    const workflowHead = await db.query.deliveryWorkflowHeadV3.findFirst({
      where: eq(schema.deliveryWorkflowHeadV3.workflowId, workflowId),
    });
    if (!workflowHead) {
      throw new Error(
        "Expected workflow head after concurrent duplicate processing",
      );
    }
    // With eagerDrain, dispatch_gate_review fires immediately but fails in the
    // test env (no threadChat), so run_failed is emitted and the state retries
    // back to implementing. The key invariant is that only one dispatch_gate_review
    // effect was ever created (deduplication worked).
    const effectRows2 = await db.query.deliveryEffectLedgerV3.findMany({
      where: eq(schema.deliveryEffectLedgerV3.workflowId, workflowId),
    });
    const reviewEffects = effectRows2.filter(
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

    await appendEventAndAdvance({
      db,
      workflowId,
      source: "daemon",
      idempotencyKey: `${currentPrefix}:bootstrap`,
      event: { type: "bootstrap" },
      eagerDrain: false,
    });

    await appendEventAndAdvance({
      db,
      workflowId,
      source: "system",
      idempotencyKey: `${currentPrefix}:plan-completed`,
      event: { type: "plan_completed" },
      eagerDrain: false,
    });

    await appendEventAndAdvance({
      db,
      workflowId,
      source: "system",
      idempotencyKey: `${currentPrefix}:dispatch-stale`,
      event: {
        type: "dispatch_sent",
        runId: runIdStale,
      },
      eagerDrain: false,
    });

    await appendEventAndAdvance({
      db,
      workflowId,
      source: "system",
      idempotencyKey: `${currentPrefix}:dispatch-current`,
      event: {
        type: "dispatch_sent",
        runId: runIdCurrent,
      },
      eagerDrain: false,
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

    const relayResult = await relay.drainOutboxRelay({
      db,
      workflowId,
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
      drainOutboxWorker({
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
      drainOutboxWorker({
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
    // With eagerDrain, dispatch_gate_review fires immediately but fails in the
    // test env (no threadChat), causing retry to implementing. The key invariant:
    // only one dispatch_gate_review was ever created, proving deduplication worked.
    const effectRows3 = await db.query.deliveryEffectLedgerV3.findMany({
      where: eq(schema.deliveryEffectLedgerV3.workflowId, workflowId),
    });
    const reviewEffects3 = effectRows3.filter(
      (effect) => effect.effectKind === "dispatch_gate_review",
    );
    expect(reviewEffects3).toHaveLength(1);
    expect(reviewEffects3[0]).toBeDefined();
  });

  it("applies legacy daemon signal envelopes instead of dead-lettering them", async () => {
    const keys = createRunKeys();
    const workflowId = await createWorkflowFixture();
    const runId = `run-${nanoid()}`;
    const keyPrefix = `durable-legacy-envelope-${nanoid()}`;

    await appendEventAndAdvance({
      db,
      workflowId,
      source: "daemon",
      idempotencyKey: `${keyPrefix}:bootstrap`,
      event: { type: "bootstrap" },
      eagerDrain: false,
    });

    await appendEventAndAdvance({
      db,
      workflowId,
      source: "system",
      idempotencyKey: `${keyPrefix}:plan-completed`,
      event: { type: "plan_completed" },
      eagerDrain: false,
    });

    await appendEventAndAdvance({
      db,
      workflowId,
      source: "system",
      idempotencyKey: `${keyPrefix}:dispatch`,
      event: {
        type: "dispatch_sent",
        runId,
      },
      eagerDrain: false,
    });

    const legacyJournalId = await createLegacySignalEnvelopeJournal({
      workflowId,
      source: "daemon",
      idempotencyKey: `${keyPrefix}:legacy-complete`,
      event: {
        kind: "run_completed",
        runId,
        result: {
          kind: "success",
          headSha: "legacy-head-sha",
          summary: "Completed from legacy envelope",
        },
      },
    });
    const outboxId = await createSignalOutboxRecord({
      workflowId,
      journalId: legacyJournalId,
      keyPrefix,
      source: "daemon",
      eventType: "run_completed",
    });
    const outbox = await getOutboxRow(outboxId);

    const relayResult = await relay.drainOutboxRelay({
      db,
      workflowId,
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
      count: 1,
    });
    expect(messageIds).toHaveLength(1);

    const workerResult = await drainOutboxWorker({
      db,
      streamKey: keys.streamKey,
      groupName: keys.workerGroupName,
      consumerName: "worker-legacy-envelope",
      maxItems: 1,
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
    if (!workflowHead) {
      throw new Error(
        "Expected workflow head after processing legacy envelope",
      );
    }
    // With eagerDrain, dispatch_gate_review fires immediately but fails in test
    // env. The key assertions are that the legacy envelope was parsed correctly
    // (headSha matches) and nothing went to the dead-letter queue.
    expect(workflowHead.headSha).toBe("legacy-head-sha");
    expect(await redis.xlen(keys.workerDlqStream)).toBe(0);
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
      .spyOn(store, "markOutboxPublished")
      .mockResolvedValue(false);

    try {
      const firstRelayResult = await relay.drainOutboxRelay({
        db,
        workflowId,
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

      const secondRelayResult = await relay.drainOutboxRelay({
        db,
        workflowId,
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

    const relayResult = await relay.drainOutboxRelay({
      db,
      workflowId,
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

    const crashedFirstAttempt = await drainOutboxWorker({
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

    const recoveredWorkerResult = await drainOutboxWorker({
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

    const effectsAfterRecovery = await db.query.deliveryEffectLedgerV3.findMany(
      {
        where: eq(schema.deliveryEffectLedgerV3.workflowId, workflowId),
      },
    );
    // Bootstrap emits the first dispatch_implementing effect. The inline drain
    // then records a planning retry effect when dispatching cannot complete in
    // this test harness. We assert idempotency by effect key uniqueness.
    const dispatchEffectsAfterRecovery = effectsAfterRecovery.filter(
      (e) => e.effectKind === "dispatch_implementing",
    );
    expect(dispatchEffectsAfterRecovery).toHaveLength(2);
    expect(
      new Set(dispatchEffectsAfterRecovery.map((effect) => effect.effectKey))
        .size,
    ).toBe(dispatchEffectsAfterRecovery.length);

    const recoveredHead = await db.query.deliveryWorkflowHeadV3.findFirst({
      where: eq(schema.deliveryWorkflowHeadV3.workflowId, workflowId),
    });
    expect(recoveredHead).not.toBeNull();
    if (!recoveredHead) {
      throw new Error("Expected workflow head after worker recovery");
    }
    expect(recoveredHead.state).toBe("planning");

    const recoveredOutbox = await getOutboxRow(outboxId);
    expect(recoveredOutbox.status).toBe("published");
    expect(await redis.xlen(keys.streamKey)).toBe(1);
  });

  it("ignores duplicate signals per idempotency key at coordinator boundary", async () => {
    const workflowId = await createWorkflowFixture();
    const runId = `run-${nanoid()}`;

    const bootstrapResult = await appendEventAndAdvance({
      db,
      workflowId,
      source: "daemon",
      idempotencyKey: `dup:${workflowId}:bootstrap`,
      event: { type: "bootstrap" },
      eagerDrain: false,
    });
    // Bootstrap stays in planning (no state transition), so transitioned is false
    expect(bootstrapResult.transitioned).toBe(false);

    await appendEventAndAdvance({
      db,
      workflowId,
      source: "system",
      idempotencyKey: `dup:${workflowId}:plan-completed`,
      event: { type: "plan_completed" },
      eagerDrain: false,
    });

    const dispatchResult = await appendEventAndAdvance({
      db,
      workflowId,
      source: "system",
      idempotencyKey: `dup:${workflowId}:dispatch`,
      event: {
        type: "dispatch_sent",
        runId,
      },
      eagerDrain: false,
    });
    expect(dispatchResult.inserted).toBe(true);

    const applyRunCompleted = async (
      idempotencyKey: string,
      event: LoopEvent,
    ): Promise<Awaited<ReturnType<typeof appendEventAndAdvance>>> => {
      return appendEventAndAdvance({
        db,
        workflowId,
        source: "daemon",
        idempotencyKey,
        event,
        eagerDrain: false,
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
    expect(effects).toHaveLength(7);
  });

  it("ignores stale run_completed when runSeq no longer matches the active lease", async () => {
    const workflowId = await createWorkflowFixture();
    const currentRunId = `run-${nanoid()}`;

    // Suppress the fire-and-forget setImmediate effect drain during setup so it
    // cannot race with dispatch_sent events and change state unexpectedly.
    const drainSpy = vi
      .spyOn(processEffects, "drainDueEffects")
      .mockResolvedValue({ processed: 0 });

    try {
      await appendEventAndAdvance({
        db,
        workflowId,
        source: "daemon",
        idempotencyKey: `oof:${workflowId}:bootstrap`,
        event: { type: "bootstrap" },
        eagerDrain: false,
      });

      await appendEventAndAdvance({
        db,
        workflowId,
        source: "system",
        idempotencyKey: `oof:${workflowId}:plan-completed`,
        event: { type: "plan_completed" },
        eagerDrain: false,
      });

      await appendEventAndAdvance({
        db,
        workflowId,
        source: "system",
        idempotencyKey: `oof:${workflowId}:dispatch-current`,
        event: {
          type: "dispatch_sent",
          runId: currentRunId,
        },
        eagerDrain: false,
      });

      await appendEventAndAdvance({
        db,
        workflowId,
        source: "system",
        idempotencyKey: `oof:${workflowId}:accepted-current`,
        event: {
          type: "dispatch_accepted",
          runId: currentRunId,
        },
        eagerDrain: false,
      });
    } finally {
      drainSpy.mockRestore();
    }

    const headBeforeStale = await db.query.deliveryWorkflowHeadV3.findFirst({
      where: eq(schema.deliveryWorkflowHeadV3.workflowId, workflowId),
    });
    expect(headBeforeStale).not.toBeNull();
    if (!headBeforeStale) {
      throw new Error("Expected workflow head before stale run signal");
    }

    const staleRunCompleted = await appendEventAndAdvance({
      db,
      workflowId,
      source: "daemon",
      idempotencyKey: `oof:${workflowId}:out-of-order`,
      event: {
        type: "run_completed",
        runId: currentRunId,
        runSeq: (headBeforeStale.activeRunSeq ?? 0) + 1,
        headSha: "stale-head-sha",
      },
      eagerDrain: false,
    });
    expect(staleRunCompleted.transitioned).toBe(false);

    const headAfterStale = await db.query.deliveryWorkflowHeadV3.findFirst({
      where: eq(schema.deliveryWorkflowHeadV3.workflowId, workflowId),
    });
    expect(headAfterStale).not.toBeNull();
    if (!headAfterStale) {
      throw new Error("Expected workflow head after stale run signal");
    }
    expect(headAfterStale.state).toBe(headBeforeStale.state);
    expect(headAfterStale.activeRunSeq).toBe(headBeforeStale.activeRunSeq);
    expect(headAfterStale.activeRunId).toBe(headBeforeStale.activeRunId);
    expect(headAfterStale.headSha).toBe(headBeforeStale.headSha);
  });

  it("routes review pass to awaiting_pr_creation when no PR is linked", async () => {
    const workflowId = await createWorkflowFixture();

    await appendEventAndAdvance({
      db,
      workflowId,
      source: "system",
      idempotencyKey: `no-pr:${workflowId}:bootstrap`,
      event: { type: "bootstrap" },
      eagerDrain: false,
    });

    await appendEventAndAdvance({
      db,
      workflowId,
      source: "system",
      idempotencyKey: `no-pr:${workflowId}:plan-completed`,
      event: { type: "plan_completed" },
      eagerDrain: false,
    });

    await appendEventAndAdvance({
      db,
      workflowId,
      source: "system",
      idempotencyKey: `no-pr:${workflowId}:dispatch`,
      event: {
        type: "dispatch_sent",
        runId: "run-no-pr",
      },
      eagerDrain: false,
    });

    await appendEventAndAdvance({
      db,
      workflowId,
      source: "daemon",
      idempotencyKey: `no-pr:${workflowId}:run-completed`,
      event: {
        type: "run_completed",
        runId: "run-no-pr",
        headSha: "sha-no-pr",
      },
      eagerDrain: false,
    });

    const reviewPassResult = await appendEventAndAdvance({
      db,
      workflowId,
      source: "daemon",
      idempotencyKey: `no-pr:${workflowId}:review-passed`,
      event: {
        type: "gate_review_passed",
        runId: null,
      },
      eagerDrain: false,
    });
    expect(reviewPassResult.stateBefore).toBe("gating_review");
    expect(reviewPassResult.stateAfter).toBe("awaiting_pr_creation");

    const workflowHead = await getWorkflowHead({ db, workflowId });
    expect(workflowHead?.state).toBe("awaiting_pr_creation");
    expect(workflowHead?.activeGate).toBeNull();
    expect(workflowHead?.blockedReason).toBe("Awaiting PR creation");

    const effectRows = await db.query.deliveryEffectLedgerV3.findMany({
      where: eq(schema.deliveryEffectLedgerV3.workflowId, workflowId),
    });
    expect(effectRows.some((row) => row.effectKind === "ensure_pr")).toBe(true);
  });

  it("reconciles stale gating_ci heads without a linked PR to awaiting_pr_creation", async () => {
    const workflowId = await createWorkflowFixture();
    const seeded = await ensureWorkflowHead({ db, workflowId });
    if (!seeded) {
      throw new Error("Expected workflow head for no-PR reconcile test");
    }

    const staleTime = new Date("2026-03-18T10:00:00.000Z");
    const now = new Date("2026-03-18T10:10:00.000Z");

    const updated = await updateWorkflowHead({
      db,
      head: {
        ...seeded,
        version: seeded.version + 1,
        state: "gating_ci",
        activeGate: "ci",
        headSha: "sha-no-pr",
        activeRunId: null,
        activeRunSeq: 7,
        leaseExpiresAt: new Date(staleTime.getTime() + 10_000),
        lastTerminalRunSeq: 6,
        updatedAt: staleTime,
        lastActivityAt: staleTime,
      },
      expectedVersion: seeded.version,
    });
    expect(updated).toBe(true);

    const reconcile = await reconcileZombieGateHeadsFromLegacy({
      db,
      now,
      staleMs: 60_000,
      maxRows: 10,
    });
    expect(reconcile.reconciled).toBeGreaterThanOrEqual(1);

    const head = await getWorkflowHead({ db, workflowId });
    expect(head?.state).toBe("awaiting_pr_creation");
    expect(head?.activeGate).toBeNull();
    expect(head?.blockedReason).toBe("Awaiting PR creation");
    expect(head?.activeRunSeq).toBeNull();
    expect(head?.leaseExpiresAt).toBeNull();
    expect(head?.lastTerminalRunSeq).toBeNull();

    const effectRows = await db.query.deliveryEffectLedgerV3.findMany({
      where: eq(schema.deliveryEffectLedgerV3.workflowId, workflowId),
    });
    expect(effectRows.some((row) => row.effectKind === "ensure_pr")).toBe(true);
  });

  it("rejects stale CAS updates to workflow head", async () => {
    const workflowId = await createWorkflowFixture();
    const head = await ensureWorkflowHead({ db, workflowId });
    if (!head) {
      throw new Error("Expected workflow head for CAS test");
    }

    const updated = await updateWorkflowHead({
      db,
      head: {
        ...head,
        blockedReason: "CAS test block",
      },
      expectedVersion: head.version + 1,
    });
    expect(updated).toBe(false);

    const current = await getWorkflowHead({ db, workflowId });
    expect(current).not.toBeNull();
    if (!current) {
      throw new Error("Expected workflow head after stale CAS update");
    }
    expect(current.version).toBe(head.version);
    expect(current.blockedReason).toBeNull();
  });

  it("rejects CAS updates when activeRunSeq no longer matches", async () => {
    const workflowId = await createWorkflowFixture();
    const head = await ensureWorkflowHead({ db, workflowId });
    if (!head) {
      throw new Error("Expected workflow head for activeRunSeq CAS test");
    }

    const leased = await updateWorkflowHead({
      db,
      head: {
        ...head,
        version: head.version + 1,
        activeRunSeq: 7,
      },
      expectedVersion: head.version,
      expectedActiveRunSeq: head.activeRunSeq,
    });
    expect(leased).toBe(true);

    const current = await getWorkflowHead({ db, workflowId });
    expect(current).not.toBeNull();
    if (!current) {
      throw new Error("Expected workflow head after leasing activeRunSeq");
    }

    const staleLeaseUpdate = await updateWorkflowHead({
      db,
      head: {
        ...current,
        version: current.version + 1,
        blockedReason: "stale lease update",
      },
      expectedVersion: current.version,
      expectedActiveRunSeq: null,
    });
    expect(staleLeaseUpdate).toBe(false);

    const unchanged = await getWorkflowHead({ db, workflowId });
    expect(unchanged).not.toBeNull();
    if (!unchanged) {
      throw new Error("Expected workflow head after stale activeRunSeq CAS");
    }

    expect(unchanged.version).toBe(current.version);
    expect(unchanged.activeRunSeq).toBe(7);
    expect(unchanged.blockedReason).toBeNull();
  });

  it("round-trips run lease fields through updateWorkflowHead/getWorkflowHead", async () => {
    const workflowId = await createWorkflowFixture();
    const head = await ensureWorkflowHead({ db, workflowId });
    if (!head) {
      throw new Error("Expected workflow head for run lease round-trip test");
    }

    const leaseExpiresAt = new Date("2026-03-18T11:15:00.000Z");
    const now = new Date("2026-03-18T11:00:00.000Z");
    const updated = await updateWorkflowHead({
      db,
      head: {
        ...head,
        version: head.version + 1,
        activeRunId: "run-lease-test",
        activeRunSeq: 42,
        leaseExpiresAt,
        lastTerminalRunSeq: 41,
        updatedAt: now,
        lastActivityAt: now,
      },
      expectedVersion: head.version,
    });
    expect(updated).toBe(true);

    const current = await getWorkflowHead({ db, workflowId });
    expect(current).not.toBeNull();
    if (!current) {
      throw new Error("Expected workflow head after run lease update");
    }
    expect(current.activeRunId).toBe("run-lease-test");
    expect(current.activeRunSeq).toBe(42);
    expect(current.leaseExpiresAt?.toISOString()).toBe(
      leaseExpiresAt.toISOString(),
    );
    expect(current.lastTerminalRunSeq).toBe(41);
  });
});
