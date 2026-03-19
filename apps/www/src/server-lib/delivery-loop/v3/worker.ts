import { and, asc, eq, gt, or } from "drizzle-orm";
import { parseLoopEventV3 } from "./contracts";
import { appendEventAndAdvanceV3 } from "./kernel";
import { type OutboxPayloadV3 } from "./contracts";
import { env } from "@terragon/env/apps-www";
import type { DB } from "@terragon/shared/db";
import * as schema from "@terragon/shared/db/schema";
import type {
  DeliveryEffectKindV3,
  DeliveryOutboxTopicV3,
  DeliveryOutboxV3Row,
  DeliverySignalSourceV3,
  DeliveryTimerKindV3,
} from "@terragon/shared/db/types";
import { redis } from "@/lib/redis";
import { getOutboxRelayStreamKey } from "./relay";

const OUTBOX_WORKER_STREAM_GROUP = "dl3:outbox:v3-consumers";
const OUTBOX_WORKER_HEARTBEAT_KEY = "dl3:outbox:v3:worker-heartbeat";
const OUTBOX_WORKER_ATTEMPTS_KEY = "dl3:outbox:v3:worker-attempts";
const OUTBOX_WORKER_PROCESSED_KEY = "dl3:outbox:v3:worker-processed";
const OUTBOX_WORKER_DLQ_STREAM = "dl3:outbox:v3:dead-letter";

const OUTBOX_WORKER_DEFAULT_MAX_ATTEMPTS = 3;
const OUTBOX_WORKER_DEFAULT_STALE_CLAIM_MS = 30_000;
const OUTBOX_WORKER_DEFAULT_READ_BATCH = 10;
const OUTBOX_WORKER_DEFAULT_RECLAIM_BATCH = 10;
const OUTBOX_WORKER_DEFAULT_MAX_ITEMS = 25;
const OUTBOX_WORKER_DEFAULT_HEARTBEAT_TTL_MS = 20_000;
const OUTBOX_WORKER_DEFAULT_BLOCK_MS = 0;
const OUTBOX_WORKER_ATTEMPT_TTL_MS = 10 * 60 * 1000;
const OUTBOX_WORKER_PROCESSED_TTL_MS = 60 * 60 * 1000;
const LOCAL_REDIS_HTTP_PORT = 8079;

export type OutboxWorkerMessage = {
  streamMessageId: string;
  outboxId: string;
  workflowId: string;
  topic: DeliveryOutboxTopicV3;
  payload: OutboxPayloadV3;
  dedupeKey: string;
  idempotencyKey: string;
};

export type OutboxWorkerOptions = {
  db: DB;
  streamKey?: string;
  groupName?: string;
  consumerName?: string;
  leaseOwnerPrefix?: string;
  maxItems?: number;
  readBatchSize?: number;
  reclaimBatchSize?: number;
  maxAttempts?: number;
  staleClaimMs?: number;
  heartbeatTtlMs?: number;
  blockMs?: number;
  processMessage?: (params: {
    db: DB;
    message: OutboxWorkerMessage;
  }) => Promise<void>;
  ackMessage?: (params: {
    streamKey: string;
    groupName: string;
    messageId: string;
  }) => Promise<void>;
  heartbeatKey?: string;
  attemptsHashKey?: string;
  processedHashKey?: string;
  deadLetterStreamKey?: string;
};

export type OutboxWorkerResult = {
  processed: number;
  acknowledged: number;
  deadLettered: number;
  retried: number;
};

type RedisStreamEntry = {
  id: string;
  fields: Record<string, string>;
};

type ParsedXAutoClaimResult = {
  cursor: string;
  entries: RedisStreamEntry[];
};

type DeadLetterPayload = Pick<
  OutboxWorkerMessage,
  "streamMessageId" | "outboxId" | "workflowId" | "topic"
> & {
  reason: string;
};

function isLocalRedisHttpEndpoint(redisUrl: string | undefined): boolean {
  if (!redisUrl) {
    return false;
  }

  try {
    const parsed = new URL(redisUrl);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") &&
      parsed.port === String(LOCAL_REDIS_HTTP_PORT)
    );
  } catch {
    return false;
  }
}

function parseRedisMessageValues(
  rawValues: unknown,
): Record<string, string> | null {
  if (!Array.isArray(rawValues) || rawValues.length % 2 !== 0) {
    return null;
  }

  const fields: Record<string, string> = {};

  for (let index = 0; index < rawValues.length; index += 2) {
    const key = rawValues[index];
    const value = rawValues[index + 1];

    if (typeof key !== "string") {
      return null;
    }

    if (typeof value === "string") {
      fields[key] = value;
      continue;
    }

    if (typeof value === "number" || typeof value === "boolean") {
      fields[key] = String(value);
      continue;
    }

    if (value === null) {
      fields[key] = "";
      continue;
    }

    if (typeof value === "object") {
      try {
        fields[key] = JSON.stringify(value);
      } catch {
        return null;
      }
      continue;
    }

    return null;
  }

  return fields;
}

function parseXReadGroupResponse(raw: unknown): RedisStreamEntry[] {
  if (!Array.isArray(raw) || raw.length < 1) {
    return [];
  }

  const firstStream = raw[0];
  if (!Array.isArray(firstStream) || firstStream.length < 2) {
    return [];
  }

  const rawEntries = firstStream[1];
  if (!Array.isArray(rawEntries)) {
    return [];
  }

  return rawEntries
    .map((entry: unknown): RedisStreamEntry | null => {
      if (!Array.isArray(entry) || entry.length < 2) {
        return null;
      }
      const [id, rawEntryValues] = entry;
      if (typeof id !== "string") {
        return null;
      }
      const fields = parseRedisMessageValues(rawEntryValues);
      return fields ? { id, fields } : null;
    })
    .filter((entry): entry is RedisStreamEntry => entry !== null);
}

function parseXAutoClaimResponse(raw: unknown): ParsedXAutoClaimResult {
  if (!Array.isArray(raw) || raw.length < 2) {
    return { cursor: "0-0", entries: [] };
  }

  const cursor =
    typeof raw[0] === "string"
      ? raw[0]
      : Array.isArray(raw[0])
        ? String(raw[0][0])
        : "0-0";

  const rawEntries = raw[1];
  if (!Array.isArray(rawEntries)) {
    return { cursor, entries: [] };
  }

  return {
    cursor,
    entries: rawEntries
      .map((entry: unknown): RedisStreamEntry | null => {
        if (!Array.isArray(entry) || entry.length < 2) {
          return null;
        }
        const [id, rawEntryValues] = entry;
        if (typeof id !== "string") {
          return null;
        }
        const fields = parseRedisMessageValues(rawEntryValues);
        return fields ? { id, fields } : null;
      })
      .filter((entry): entry is RedisStreamEntry => entry !== null),
  };
}

function parseOutboxPayload(rawPayload: unknown): OutboxPayloadV3 | null {
  let parsed: unknown = rawPayload;
  if (typeof rawPayload === "string") {
    try {
      parsed = JSON.parse(rawPayload);
    } catch {
      return null;
    }
  }

  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  const record = parsed as Record<string, unknown>;
  if (
    "payload" in record &&
    typeof record.payload !== "undefined" &&
    !("kind" in record)
  ) {
    parsed = record.payload;
  }

  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  const payloadRecord = parsed as Record<string, unknown>;
  if (typeof payloadRecord.kind !== "string") {
    return null;
  }

  if (payloadRecord.kind === "signal") {
    if (
      typeof payloadRecord.source !== "string" ||
      !isDeliverySignalSource(payloadRecord.source)
    ) {
      return null;
    }
    if (
      typeof payloadRecord.journalId !== "string" ||
      typeof payloadRecord.workflowId !== "string" ||
      typeof payloadRecord.eventType !== "string"
    ) {
      return null;
    }

    return {
      kind: "signal",
      journalId: payloadRecord.journalId,
      workflowId: payloadRecord.workflowId,
      eventType: payloadRecord.eventType,
      source: payloadRecord.source,
    };
  }

  if (payloadRecord.kind === "effect") {
    const effectKind =
      typeof payloadRecord.effectKind === "string"
        ? payloadRecord.effectKind
        : null;
    if (!isDeliveryEffectKind(effectKind)) {
      return null;
    }
    if (
      typeof payloadRecord.effectId !== "string" ||
      typeof payloadRecord.workflowId !== "string" ||
      typeof payloadRecord.effectKind !== "string"
    ) {
      return null;
    }
    return {
      kind: "effect",
      effectId: payloadRecord.effectId,
      workflowId: payloadRecord.workflowId,
      effectKind,
    };
  }

  if (payloadRecord.kind === "timer") {
    const timerKind =
      typeof payloadRecord.timerKind === "string"
        ? payloadRecord.timerKind
        : null;
    if (!isDeliveryTimerKind(timerKind)) {
      return null;
    }
    if (
      typeof payloadRecord.timerId !== "string" ||
      typeof payloadRecord.workflowId !== "string" ||
      typeof payloadRecord.timerKind !== "string"
    ) {
      return null;
    }
    return {
      kind: "timer",
      timerId: payloadRecord.timerId,
      workflowId: payloadRecord.workflowId,
      timerKind,
    };
  }

  return null;
}

function isDeliverySignalSource(
  source: string,
): source is DeliverySignalSourceV3 {
  return (
    source === "daemon" ||
    source === "github" ||
    source === "human" ||
    source === "timer" ||
    source === "system"
  );
}

function isDeliveryEffectKind(
  kind: string | null,
): kind is DeliveryEffectKindV3 {
  return (
    kind === "dispatch_implementing" ||
    kind === "dispatch_gate_review" ||
    kind === "ack_timeout_check"
  );
}

function isDeliveryTimerKind(kind: string | null): kind is DeliveryTimerKindV3 {
  return kind === "dispatch_ack_timeout";
}

function isSignalPayload(
  payload: OutboxPayloadV3,
): payload is Extract<OutboxPayloadV3, { kind: "signal" }> {
  return payload.kind === "signal";
}

function parseOutboxWorkerMessage(
  raw: RedisStreamEntry,
): OutboxWorkerMessage | null {
  if (
    typeof raw.fields.topic !== "string" ||
    (raw.fields.topic !== "signal" &&
      raw.fields.topic !== "effect" &&
      raw.fields.topic !== "timer")
  ) {
    return null;
  }

  const payload = parseOutboxPayload(raw.fields.payload);
  if (!payload) {
    return null;
  }

  if (
    typeof raw.fields.outboxId !== "string" ||
    typeof raw.fields.workflowId !== "string" ||
    typeof raw.fields.dedupeKey !== "string" ||
    typeof raw.fields.idempotencyKey !== "string"
  ) {
    return null;
  }

  return {
    streamMessageId: raw.id,
    outboxId: raw.fields.outboxId,
    workflowId: raw.fields.workflowId,
    topic: raw.fields.topic,
    payload,
    dedupeKey: raw.fields.dedupeKey,
    idempotencyKey: raw.fields.idempotencyKey,
  };
}

function parseRedisError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isBusyGroupError(error: Error): boolean {
  return (
    error.message.includes("BUSYGROUP") ||
    error.message.includes("consumer group already exists")
  );
}

function parseAttemptCount(raw: unknown): number {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.trunc(raw);
  }
  if (typeof raw === "string") {
    const parsed = Number.parseInt(raw, 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

function coerceString(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return "";
}

async function ensureConsumerGroup(
  streamKey: string,
  groupName: string,
): Promise<void> {
  try {
    await redis.xgroup(streamKey, {
      type: "CREATE",
      group: groupName,
      id: "0",
      options: {
        MKSTREAM: true,
      },
    });
  } catch (error) {
    const parsed = parseRedisError(error);
    if (!isBusyGroupError(parsed)) {
      throw parsed;
    }
  }
}

async function loadPublishedOutboxRows(params: {
  db: DB;
  maxItems: number;
  cursor?: {
    publishedAt: Date;
    id: string;
  };
}): Promise<DeliveryOutboxV3Row[]> {
  const cursor = params.cursor;
  const whereClause = cursor
    ? and(
        eq(schema.deliveryOutboxV3.status, "published"),
        or(
          gt(schema.deliveryOutboxV3.publishedAt, cursor.publishedAt),
          and(
            eq(schema.deliveryOutboxV3.publishedAt, cursor.publishedAt),
            gt(schema.deliveryOutboxV3.id, cursor.id),
          ),
        ),
      )
    : eq(schema.deliveryOutboxV3.status, "published");

  return params.db
    .select()
    .from(schema.deliveryOutboxV3)
    .where(whereClause)
    .orderBy(
      asc(schema.deliveryOutboxV3.publishedAt),
      asc(schema.deliveryOutboxV3.id),
    )
    .limit(params.maxItems);
}

async function heartbeatConsumer(
  heartbeatKey: string,
  consumerName: string,
  heartbeatTtlMs: number,
): Promise<void> {
  await redis.hset(heartbeatKey, {
    [consumerName]: new Date().toISOString(),
  });
  await redis.pexpire(heartbeatKey, heartbeatTtlMs);
}

async function reclaimStaleMessages(
  streamKey: string,
  groupName: string,
  consumerName: string,
  staleMs: number,
  batchSize: number,
  cursor: string,
): Promise<ParsedXAutoClaimResult> {
  const raw = await redis.xautoclaim(
    streamKey,
    groupName,
    consumerName,
    staleMs,
    cursor,
    { count: batchSize },
  );
  return parseXAutoClaimResponse(raw);
}

async function readNewMessages(
  streamKey: string,
  groupName: string,
  consumerName: string,
  batchSize: number,
  blockMs: number,
): Promise<RedisStreamEntry[]> {
  const raw = await redis.xreadgroup(groupName, consumerName, streamKey, ">", {
    count: batchSize,
    blockMS: blockMs,
  });
  return parseXReadGroupResponse(raw);
}

async function ackStreamMessage(params: {
  streamKey: string;
  groupName: string;
  messageId: string;
}): Promise<void> {
  const acknowledged = await redis.xack(
    params.streamKey,
    params.groupName,
    params.messageId,
  );
  const count = parseAttemptCount(acknowledged);
  if (count < 1) {
    throw new Error(
      `Outbox worker failed to acknowledge stream message ${params.messageId}`,
    );
  }
}

function parsePublishedOutboxRow(
  row: DeliveryOutboxV3Row,
): OutboxWorkerMessage | null {
  const payload = parseOutboxPayload(row.payloadJson);
  if (!payload) {
    return null;
  }

  return {
    streamMessageId: row.relayMessageId ?? row.id,
    outboxId: row.id,
    workflowId: row.workflowId,
    topic: row.topic,
    payload,
    dedupeKey: row.dedupeKey,
    idempotencyKey: row.idempotencyKey,
  };
}

async function incrementAttemptCount(
  attemptsHashKey: string,
  outboxId: string,
): Promise<number> {
  const value = await redis.hincrby(attemptsHashKey, outboxId, 1);
  await redis.pexpire(attemptsHashKey, OUTBOX_WORKER_ATTEMPT_TTL_MS);
  return parseAttemptCount(value);
}

async function clearAttemptCount(
  attemptsHashKey: string,
  outboxId: string,
): Promise<void> {
  await redis.hdel(attemptsHashKey, outboxId);
}

async function markMessageProcessed(
  processedHashKey: string,
  outboxId: string,
  streamMessageId: string,
): Promise<void> {
  await redis.hset(processedHashKey, {
    [outboxId]: streamMessageId,
  });
  await redis.pexpire(processedHashKey, OUTBOX_WORKER_PROCESSED_TTL_MS);
}

async function isMessageAlreadyProcessed(
  processedHashKey: string,
  outboxId: string,
): Promise<boolean> {
  const existing = await redis.hget(processedHashKey, outboxId);
  return typeof existing === "string" && existing.length > 0;
}

async function deadLetterMessage(params: {
  deadLetterStreamKey: string;
  message: DeadLetterPayload;
}): Promise<void> {
  await redis.xadd(params.deadLetterStreamKey, "*", {
    streamMessageId: params.message.streamMessageId,
    outboxId: params.message.outboxId,
    workflowId: params.message.workflowId,
    topic: params.message.topic,
    reason: params.message.reason,
  });
}

async function markPublishedOutboxDeadLettered(params: {
  db: DB;
  outboxId: string;
  errorCode: string;
  errorMessage: string;
}): Promise<void> {
  await params.db
    .update(schema.deliveryOutboxV3)
    .set({
      status: "dead_letter",
      lastErrorCode: params.errorCode,
      lastErrorMessage: params.errorMessage,
      leaseOwner: null,
      leaseExpiresAt: null,
    })
    .where(eq(schema.deliveryOutboxV3.id, params.outboxId));
}

async function applySignalMessage(params: {
  db: DB;
  message: OutboxWorkerMessage;
}): Promise<void> {
  if (!isSignalPayload(params.message.payload)) {
    throw new Error(
      `Outbox worker received non-signal payload for outbox ${params.message.outboxId}`,
    );
  }

  const journal = await params.db.query.deliveryLoopJournalV3.findFirst({
    where: eq(
      schema.deliveryLoopJournalV3.id,
      params.message.payload.journalId,
    ),
  });
  if (!journal) {
    throw new Error(
      `Outbox worker could not find signal journal ${params.message.payload.journalId}`,
    );
  }

  const event = parseLoopEventV3(journal.payloadJson);
  if (!event) {
    throw new Error(
      `Outbox worker parsed invalid loop event for journal ${journal.id}`,
    );
  }

  await appendEventAndAdvanceV3({
    db: params.db,
    workflowId: params.message.workflowId,
    source: journal.source,
    idempotencyKey: params.message.idempotencyKey,
    event,
  });
}

async function processOutboxMessageWithDefaults(params: {
  db: DB;
  message: OutboxWorkerMessage;
}): Promise<void> {
  if (params.message.topic !== "signal") {
    throw new Error(
      `Outbox worker does not yet support topic ${params.message.topic}`,
    );
  }

  await applySignalMessage(params);
}

function createDeadLetterFromRaw(
  raw: RedisStreamEntry,
  reason: string,
): DeadLetterPayload {
  return {
    streamMessageId: raw.id,
    outboxId: raw.fields.outboxId ?? "",
    workflowId: raw.fields.workflowId ?? "",
    topic:
      raw.fields.topic === "signal" ||
      raw.fields.topic === "effect" ||
      raw.fields.topic === "timer"
        ? raw.fields.topic
        : "timer",
    reason,
  };
}

async function processEntries(params: {
  streamKey: string;
  groupName: string;
  attemptsHashKey: string;
  processedHashKey: string;
  deadLetterStreamKey: string;
  ackMessage: (params: {
    streamKey: string;
    groupName: string;
    messageId: string;
  }) => Promise<void>;
  entries: RedisStreamEntry[];
  messageProcessor: (params: {
    db: DB;
    message: OutboxWorkerMessage;
  }) => Promise<void>;
  maxAttempts: number;
  db: DB;
  remaining: number;
  result: OutboxWorkerResult;
}): Promise<number> {
  let consumed = 0;

  for (const raw of params.entries) {
    if (consumed >= params.remaining) {
      break;
    }

    const parsed = parseOutboxWorkerMessage(raw);
    if (!parsed) {
      await deadLetterMessage({
        deadLetterStreamKey: params.deadLetterStreamKey,
        message: createDeadLetterFromRaw(raw, "Failed to parse stream payload"),
      });
      if (raw.fields.outboxId) {
        await clearAttemptCount(params.attemptsHashKey, raw.fields.outboxId);
      }
      await params.ackMessage({
        streamKey: params.streamKey,
        groupName: params.groupName,
        messageId: raw.id,
      });
      params.result.deadLettered += 1;
      params.result.processed += 1;
      consumed += 1;
      continue;
    }

    try {
      const alreadyProcessed = await isMessageAlreadyProcessed(
        params.processedHashKey,
        parsed.outboxId,
      );

      if (!alreadyProcessed) {
        await params.messageProcessor({ db: params.db, message: parsed });
        await markMessageProcessed(
          params.processedHashKey,
          parsed.outboxId,
          parsed.streamMessageId,
        );
      }

      try {
        await params.ackMessage({
          streamKey: params.streamKey,
          groupName: params.groupName,
          messageId: parsed.streamMessageId,
        });
        await clearAttemptCount(params.attemptsHashKey, parsed.outboxId);
        params.result.acknowledged += 1;
      } catch {
        params.result.retried += 1;
      }

      params.result.processed += 1;
      consumed += 1;
      continue;
    } catch (error) {
      const attempts = await incrementAttemptCount(
        params.attemptsHashKey,
        parsed.outboxId,
      );

      if (attempts >= params.maxAttempts) {
        await deadLetterMessage({
          deadLetterStreamKey: params.deadLetterStreamKey,
          message: {
            ...parsed,
            reason: `Outbox worker exhausted attempts: ${coerceString(
              error instanceof Error ? error.message : error,
            )}`,
          },
        });
        await params.ackMessage({
          streamKey: params.streamKey,
          groupName: params.groupName,
          messageId: parsed.streamMessageId,
        });
        await clearAttemptCount(params.attemptsHashKey, parsed.outboxId);
        params.result.deadLettered += 1;
        params.result.processed += 1;
        consumed += 1;
        continue;
      }

      params.result.retried += 1;
      params.result.processed += 1;
      consumed += 1;
    }
  }

  return consumed;
}

async function processPublishedOutboxRows(params: {
  db: DB;
  maxItems: number;
  attemptsHashKey: string;
  processedHashKey: string;
  deadLetterStreamKey: string;
  messageProcessor: (params: {
    db: DB;
    message: OutboxWorkerMessage;
  }) => Promise<void>;
  maxAttempts: number;
  result: OutboxWorkerResult;
}): Promise<number> {
  let consumed = 0;
  let cursor: { publishedAt: Date; id: string } | undefined;

  while (consumed < params.maxItems) {
    const rows = await loadPublishedOutboxRows({
      db: params.db,
      maxItems: params.maxItems - consumed,
      cursor,
    });
    if (rows.length === 0) {
      break;
    }

    for (const row of rows) {
      cursor = { publishedAt: row.publishedAt ?? row.createdAt, id: row.id };

      const parsed = parsePublishedOutboxRow(row);
      if (!parsed) {
        const reason = "Failed to parse published outbox payload";
        await deadLetterMessage({
          deadLetterStreamKey: params.deadLetterStreamKey,
          message: {
            streamMessageId: row.relayMessageId ?? row.id,
            outboxId: row.id,
            workflowId: row.workflowId,
            topic: row.topic,
            reason,
          },
        });
        await markPublishedOutboxDeadLettered({
          db: params.db,
          outboxId: row.id,
          errorCode: "outbox_worker_parse_failed",
          errorMessage: reason,
        });
        await clearAttemptCount(params.attemptsHashKey, row.id);
        await markMessageProcessed(
          params.processedHashKey,
          row.id,
          row.relayMessageId ?? row.id,
        );
        params.result.deadLettered += 1;
        params.result.processed += 1;
        consumed += 1;
        if (consumed >= params.maxItems) {
          break;
        }
        continue;
      }

      const alreadyProcessed = await isMessageAlreadyProcessed(
        params.processedHashKey,
        parsed.outboxId,
      );
      if (alreadyProcessed) {
        await clearAttemptCount(params.attemptsHashKey, parsed.outboxId);
        continue;
      }

      try {
        await params.messageProcessor({ db: params.db, message: parsed });
        await markMessageProcessed(
          params.processedHashKey,
          parsed.outboxId,
          parsed.streamMessageId,
        );
        await clearAttemptCount(params.attemptsHashKey, parsed.outboxId);
        params.result.acknowledged += 1;
        params.result.processed += 1;
        consumed += 1;
        if (consumed >= params.maxItems) {
          break;
        }
        continue;
      } catch (error) {
        const attempts = await incrementAttemptCount(
          params.attemptsHashKey,
          parsed.outboxId,
        );

        if (attempts >= params.maxAttempts) {
          const reason = `Outbox worker exhausted attempts: ${coerceString(
            error instanceof Error ? error.message : error,
          )}`;
          await deadLetterMessage({
            deadLetterStreamKey: params.deadLetterStreamKey,
            message: {
              ...parsed,
              reason,
            },
          });
          await markPublishedOutboxDeadLettered({
            db: params.db,
            outboxId: parsed.outboxId,
            errorCode: "v3_outbox_worker_failed",
            errorMessage: reason,
          });
          await markMessageProcessed(
            params.processedHashKey,
            parsed.outboxId,
            parsed.streamMessageId,
          );
          await clearAttemptCount(params.attemptsHashKey, parsed.outboxId);
          params.result.deadLettered += 1;
          params.result.processed += 1;
          consumed += 1;
          if (consumed >= params.maxItems) {
            break;
          }
          continue;
        }

        params.result.retried += 1;
        params.result.processed += 1;
        consumed += 1;
        if (consumed >= params.maxItems) {
          break;
        }
      }
    }
  }

  return consumed;
}

export async function drainOutboxV3Worker(
  params: OutboxWorkerOptions,
): Promise<OutboxWorkerResult> {
  const streamKey = params.streamKey ?? getOutboxRelayStreamKey();
  const groupName = params.groupName ?? OUTBOX_WORKER_STREAM_GROUP;
  const consumerName =
    params.consumerName ??
    `${params.leaseOwnerPrefix ?? "cron:v3-worker"}:${crypto.randomUUID()}`;
  const maxItems = params.maxItems ?? OUTBOX_WORKER_DEFAULT_MAX_ITEMS;
  const readBatchSize =
    params.readBatchSize ?? OUTBOX_WORKER_DEFAULT_READ_BATCH;
  const reclaimBatchSize =
    params.reclaimBatchSize ?? OUTBOX_WORKER_DEFAULT_RECLAIM_BATCH;
  const maxAttempts = params.maxAttempts ?? OUTBOX_WORKER_DEFAULT_MAX_ATTEMPTS;
  const staleClaimMs =
    params.staleClaimMs ?? OUTBOX_WORKER_DEFAULT_STALE_CLAIM_MS;
  const heartbeatTtlMs =
    params.heartbeatTtlMs ?? OUTBOX_WORKER_DEFAULT_HEARTBEAT_TTL_MS;
  const blockMs = params.blockMs ?? OUTBOX_WORKER_DEFAULT_BLOCK_MS;
  const heartbeatKey = params.heartbeatKey ?? OUTBOX_WORKER_HEARTBEAT_KEY;
  const attemptsHashKey = params.attemptsHashKey ?? OUTBOX_WORKER_ATTEMPTS_KEY;
  const processedHashKey =
    params.processedHashKey ?? OUTBOX_WORKER_PROCESSED_KEY;
  const deadLetterStreamKey =
    params.deadLetterStreamKey ?? OUTBOX_WORKER_DLQ_STREAM;
  const messageProcessor =
    params.processMessage ?? processOutboxMessageWithDefaults;
  const ackMessage = params.ackMessage ?? ackStreamMessage;
  const useLocalDbFallback = isLocalRedisHttpEndpoint(
    process.env.REDIS_URL ?? env.REDIS_URL,
  );

  let remaining = maxItems;
  let staleCursor = "0-0";
  const result: OutboxWorkerResult = {
    processed: 0,
    acknowledged: 0,
    deadLettered: 0,
    retried: 0,
  };

  if (useLocalDbFallback) {
    await heartbeatConsumer(heartbeatKey, consumerName, heartbeatTtlMs);
    const consumed = await processPublishedOutboxRows({
      db: params.db,
      maxItems: remaining,
      attemptsHashKey,
      processedHashKey,
      deadLetterStreamKey,
      messageProcessor,
      maxAttempts,
      result,
    });
    remaining = Math.max(0, remaining - consumed);
    return result;
  }

  await ensureConsumerGroup(streamKey, groupName);

  while (remaining > 0) {
    await heartbeatConsumer(heartbeatKey, consumerName, heartbeatTtlMs);

    // Sweep stale pending claims before new work, so crashes can recover deterministically.
    for (
      let reclaimDepth = 0;
      remaining > 0 && reclaimDepth < 10;
      reclaimDepth += 1
    ) {
      const stale = await reclaimStaleMessages(
        streamKey,
        groupName,
        consumerName,
        staleClaimMs,
        reclaimBatchSize,
        staleCursor,
      );
      staleCursor = stale.cursor;

      const reclaimed = await processEntries({
        streamKey,
        groupName,
        attemptsHashKey,
        processedHashKey,
        deadLetterStreamKey,
        ackMessage,
        entries: stale.entries,
        messageProcessor,
        maxAttempts,
        db: params.db,
        remaining,
        result,
      });
      remaining = Math.max(0, remaining - reclaimed);

      if (
        stale.entries.length === 0 ||
        stale.cursor === "0-0" ||
        remaining <= 0
      ) {
        break;
      }
    }

    if (remaining <= 0) {
      break;
    }

    const newMessages = await readNewMessages(
      streamKey,
      groupName,
      consumerName,
      Math.min(readBatchSize, remaining),
      blockMs,
    );
    if (newMessages.length === 0) {
      break;
    }

    const consumedNew = await processEntries({
      streamKey,
      groupName,
      attemptsHashKey,
      processedHashKey,
      deadLetterStreamKey,
      ackMessage,
      entries: newMessages,
      messageProcessor,
      maxAttempts,
      db: params.db,
      remaining,
      result,
    });
    remaining -= consumedNew;
  }

  return result;
}
