import type {
  DeliveryLoopDispatchIntent,
  DeliveryLoopDispatchMechanism,
  DeliveryLoopDispatchStatus,
  DeliveryLoopExecutionClass,
  DeliveryLoopFailureCategory,
  DeliveryLoopSelectedAgent,
  DeliveryLoopState,
} from "@terragon/shared/model/delivery-loop";
import { redis } from "@/lib/redis";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Redis key prefix for dispatch intents. */
const KEY_PREFIX = "dl:dispatch:";

/** TTL for active dispatch intents — 1 hour. */
const ACTIVE_TTL_SECONDS = 60 * 60;

/** Short TTL for completed intents — 5 minutes for post-completion inspection. */
const COMPLETED_TTL_SECONDS = 5 * 60;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function redisKey(threadChatId: string): string {
  return `${KEY_PREFIX}${threadChatId}`;
}

/** Build the canonical dispatch intent ID from loop and run IDs. */
export function buildDispatchIntentId(loopId: string, runId: string): string {
  return `di_${loopId}_${runId}`;
}

/** Serialize a DeliveryLoopDispatchIntent into a flat string record for HSET. */
function serializeIntent(
  intent: DeliveryLoopDispatchIntent,
): Record<string, string> {
  return {
    id: intent.id,
    loopId: intent.loopId,
    threadId: intent.threadId,
    threadChatId: intent.threadChatId,
    targetPhase: intent.targetPhase,
    selectedAgent: intent.selectedAgent,
    executionClass: intent.executionClass,
    dispatchMechanism: intent.dispatchMechanism,
    runId: intent.runId,
    status: intent.status,
    retryCount: String(intent.retryCount),
    maxRetries: String(intent.maxRetries),
    createdAt: intent.createdAt.toISOString(),
    updatedAt: intent.updatedAt.toISOString(),
    lastError: intent.lastError ?? "",
    lastFailureCategory: intent.lastFailureCategory ?? "",
  };
}

/** Deserialize a flat string record from HGETALL into a typed intent. */
function deserializeIntent(
  raw: Record<string, string | undefined>,
): DeliveryLoopDispatchIntent | null {
  if (!raw.id) return null;
  return {
    id: raw.id,
    loopId: raw.loopId ?? "",
    threadId: raw.threadId ?? "",
    threadChatId: raw.threadChatId ?? "",
    targetPhase: (raw.targetPhase ?? "implementing") as DeliveryLoopState,
    selectedAgent: (raw.selectedAgent ??
      "claudeCode") as DeliveryLoopSelectedAgent,
    executionClass: (raw.executionClass ??
      "implementation_runtime") as DeliveryLoopExecutionClass,
    dispatchMechanism: (raw.dispatchMechanism ??
      "self_dispatch") as DeliveryLoopDispatchMechanism,
    runId: raw.runId ?? "",
    status: (raw.status ?? "prepared") as DeliveryLoopDispatchStatus,
    retryCount: Number(raw.retryCount ?? 0),
    maxRetries: Number(raw.maxRetries ?? 0),
    createdAt: new Date(raw.createdAt ?? 0),
    updatedAt: new Date(raw.updatedAt ?? 0),
    lastError: raw.lastError || null,
    lastFailureCategory:
      (raw.lastFailureCategory as DeliveryLoopFailureCategory) || null,
  };
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export type CreateDispatchIntentParams = {
  loopId: string;
  threadId: string;
  threadChatId: string;
  targetPhase: DeliveryLoopState;
  selectedAgent: DeliveryLoopSelectedAgent;
  executionClass: DeliveryLoopExecutionClass;
  dispatchMechanism: DeliveryLoopDispatchMechanism;
  runId: string;
  maxRetries: number;
};

/**
 * Persist a new dispatch intent to Redis for real-time dispatch tracking.
 * DB migration for durable persistence comes later.
 */
export async function createDispatchIntent(
  params: CreateDispatchIntentParams,
): Promise<DeliveryLoopDispatchIntent> {
  const now = new Date();
  const intent: DeliveryLoopDispatchIntent = {
    id: buildDispatchIntentId(params.loopId, params.runId),
    loopId: params.loopId,
    threadId: params.threadId,
    threadChatId: params.threadChatId,
    targetPhase: params.targetPhase,
    selectedAgent: params.selectedAgent,
    executionClass: params.executionClass,
    dispatchMechanism: params.dispatchMechanism,
    runId: params.runId,
    status: "prepared",
    retryCount: 0,
    maxRetries: params.maxRetries,
    createdAt: now,
    updatedAt: now,
    lastError: null,
    lastFailureCategory: null,
  };

  const key = redisKey(params.threadChatId);
  await redis.hset(key, serializeIntent(intent));
  await redis.expire(key, ACTIVE_TTL_SECONDS);

  return intent;
}

/**
 * Partially update an existing dispatch intent in Redis.
 */
export async function updateDispatchIntent(
  id: string,
  threadChatId: string,
  updates: Partial<
    Pick<
      DeliveryLoopDispatchIntent,
      "status" | "retryCount" | "lastError" | "lastFailureCategory"
    >
  >,
): Promise<void> {
  const key = redisKey(threadChatId);
  const patch: Record<string, string> = {
    updatedAt: new Date().toISOString(),
  };

  if (updates.status !== undefined) patch.status = updates.status;
  if (updates.retryCount !== undefined)
    patch.retryCount = String(updates.retryCount);
  if (updates.lastError !== undefined)
    patch.lastError = updates.lastError ?? "";
  if (updates.lastFailureCategory !== undefined)
    patch.lastFailureCategory = updates.lastFailureCategory ?? "";

  await redis.hset(key, patch);
}

/**
 * Retrieve the active dispatch intent for a thread chat, or null if none
 * exists (or the key has expired).
 */
export async function getActiveDispatchIntent(
  threadChatId: string,
): Promise<DeliveryLoopDispatchIntent | null> {
  const key = redisKey(threadChatId);
  const raw = await redis.hgetall(key);
  if (!raw || Object.keys(raw).length === 0) return null;
  return deserializeIntent(raw as Record<string, string | undefined>);
}

/**
 * Mark a dispatch intent as completed. Redis entry gets a short TTL (5 minutes)
 * for post-completion inspection.
 */
export async function completeDispatchIntent(
  id: string,
  threadChatId: string,
): Promise<void> {
  const key = redisKey(threadChatId);
  await redis.hset(key, {
    status: "completed",
    updatedAt: new Date().toISOString(),
  });
  await redis.expire(key, COMPLETED_TTL_SECONDS);
}
