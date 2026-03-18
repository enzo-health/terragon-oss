import { addMilliseconds } from "date-fns";
import { redis } from "@/lib/redis";
import type { DB } from "@terragon/shared/db";
import type { DeliveryOutboxV3Row } from "@terragon/shared/db/types";
import {
  claimNextOutboxRecordV3,
  markOutboxFailedV3,
  markOutboxPublishedV3,
} from "./store";

const OUTBOX_RELAY_STREAM_KEY = "dl3:outbox:stream";
const OUTBOX_RELAY_DEDUPE_INDEX_KEY = "dl3:outbox:relay:dedupe";
const OUTBOX_RELAY_LEASE_OWNER_PREFIX = "cron:v3-relay";
const OUTBOX_RELAY_MAX_ITEMS = 25;

const BASE_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 30_000;

const PUBLISH_OUTBOX_RECORD_SCRIPT = `
local dedupeKey = KEYS[1]
local streamKey = KEYS[2]
local outboxId = ARGV[1]
local workflowId = ARGV[2]
local topic = ARGV[3]
local dedupeKeyValue = ARGV[4]
local idempotencyKey = ARGV[5]
local payloadJson = ARGV[6]

local existingMessageId = redis.call("HGET", dedupeKey, outboxId)
if existingMessageId then
  return existingMessageId
end

local messageId = redis.call(
  "XADD",
  streamKey,
  "*",
  "outboxId",
  outboxId,
  "workflowId",
  workflowId,
  "topic",
  topic,
  "dedupeKey",
  dedupeKeyValue,
  "idempotencyKey",
  idempotencyKey,
  "payload",
  payloadJson
)

redis.call("HSET", dedupeKey, outboxId, messageId)
return messageId
`;

export type OutboxRelayResult = {
  processed: number;
  published: number;
  failed: number;
};

export type OutboxRelayOptions = {
  db: DB;
  maxItems?: number;
  leaseOwnerPrefix?: string;
  now?: Date;
  streamKey?: string;
  dedupeIndexKey?: string;
};

export function getOutboxRelayStreamKey(): string {
  return OUTBOX_RELAY_STREAM_KEY;
}

export function getOutboxRelayDedupeIndexKey(): string {
  return OUTBOX_RELAY_DEDUPE_INDEX_KEY;
}

function computeOutboxRetryDelayMs(attemptCount: number): number {
  if (attemptCount <= 0) {
    return BASE_RETRY_DELAY_MS;
  }
  const exponentialDelay = Math.pow(2, attemptCount - 1) * BASE_RETRY_DELAY_MS;
  return Math.min(exponentialDelay, MAX_RETRY_DELAY_MS);
}

function coerceRedisMessageId(messageId: unknown): string {
  if (typeof messageId === "string" && messageId.length > 0) {
    return messageId;
  }
  if (typeof messageId === "number" && Number.isFinite(messageId)) {
    return String(messageId);
  }
  if (Array.isArray(messageId)) {
    const [value] = messageId;
    return coerceRedisMessageId(value);
  }
  throw new Error("Failed to publish outbox record: invalid stream message id");
}

export async function publishOutboxRecordV3(params: {
  outbox: DeliveryOutboxV3Row;
  streamKey?: string;
  dedupeIndexKey?: string;
}): Promise<string> {
  const streamKey = params.streamKey ?? OUTBOX_RELAY_STREAM_KEY;
  const dedupeIndexKey = params.dedupeIndexKey ?? OUTBOX_RELAY_DEDUPE_INDEX_KEY;

  const payloadJson = JSON.stringify({
    outboxId: params.outbox.id,
    workflowId: params.outbox.workflowId,
    topic: params.outbox.topic,
    payload: params.outbox.payloadJson,
    idempotencyKey: params.outbox.idempotencyKey,
    dedupeKey: params.outbox.dedupeKey,
  });

  const messageId = await redis.eval(
    PUBLISH_OUTBOX_RECORD_SCRIPT,
    [dedupeIndexKey, streamKey],
    [
      params.outbox.id,
      params.outbox.workflowId,
      params.outbox.topic,
      params.outbox.dedupeKey,
      params.outbox.idempotencyKey,
      payloadJson,
    ],
  );

  return coerceRedisMessageId(messageId);
}

export async function markOutboxRecordFailedV3(params: {
  db: DB;
  outbox: DeliveryOutboxV3Row;
  leaseOwner: string;
  leaseEpoch: number;
  errorCode: string;
  errorMessage: string;
  retryAt: Date;
}): Promise<void> {
  await markOutboxFailedV3({
    db: params.db,
    outboxId: params.outbox.id,
    leaseOwner: params.leaseOwner,
    leaseEpoch: params.leaseEpoch,
    errorCode: params.errorCode,
    errorMessage: params.errorMessage,
    retryAt: params.retryAt,
  });
}

export async function drainOutboxV3Relay(
  params: OutboxRelayOptions,
): Promise<OutboxRelayResult> {
  const maxItems = params.maxItems ?? OUTBOX_RELAY_MAX_ITEMS;
  const leaseOwnerPrefix =
    params.leaseOwnerPrefix ?? OUTBOX_RELAY_LEASE_OWNER_PREFIX;
  const now = params.now ?? new Date();
  const streamKey = params.streamKey ?? OUTBOX_RELAY_STREAM_KEY;
  const dedupeIndexKey = params.dedupeIndexKey ?? OUTBOX_RELAY_DEDUPE_INDEX_KEY;

  let processed = 0;
  let published = 0;
  let failed = 0;

  for (let i = 0; i < maxItems; i += 1) {
    const leaseOwner = `${leaseOwnerPrefix}:${crypto.randomUUID()}`;
    const outbox = await claimNextOutboxRecordV3({
      db: params.db,
      leaseOwner,
      now,
    });
    if (!outbox) {
      break;
    }

    processed += 1;

    try {
      const relayMessageId = await publishOutboxRecordV3({
        outbox,
        streamKey,
        dedupeIndexKey,
      });

      await markOutboxPublishedV3({
        db: params.db,
        outboxId: outbox.id,
        leaseOwner,
        leaseEpoch: outbox.leaseEpoch,
        relayMessageId,
      });

      published += 1;
      continue;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const retryAt = addMilliseconds(
        now,
        computeOutboxRetryDelayMs(outbox.attemptCount),
      );

      try {
        await markOutboxRecordFailedV3({
          db: params.db,
          outbox,
          leaseOwner,
          leaseEpoch: outbox.leaseEpoch,
          errorCode: "outbox_relay_failed",
          errorMessage,
          retryAt,
        });
        failed += 1;
      } catch {
        // If we cannot persist the failure state, keep moving to avoid blocking
        // the entire relay loop. The row remains published/pending/claimed with a
        // lease and will be retried by the stale-claim reclaim path.
      }
    }
  }

  return {
    processed,
    published,
    failed,
  };
}
