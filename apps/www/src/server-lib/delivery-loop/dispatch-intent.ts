import {
  type DeliveryLoopDispatchablePhase,
  DeliveryLoopDispatchIntent,
  DeliveryLoopDispatchMechanism,
  DeliveryLoopDispatchStatus,
  DeliveryLoopExecutionClass,
  DeliveryLoopFailureCategory,
  DeliveryLoopSelectedAgent,
} from "@terragon/shared/model/delivery-loop";
import type { SdlcSelfDispatchPayload } from "@terragon/daemon/shared";
import { redis } from "@/lib/redis";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Redis key prefix for dispatch intents. */
const KEY_PREFIX = "dl:dispatch:";
const SELF_DISPATCH_REPLAY_KEY_PREFIX = "dl:self-dispatch-replay:";

/** TTL for active dispatch intents — 1 hour. */
const ACTIVE_TTL_SECONDS = 60 * 60;
const SELF_DISPATCH_REPLAY_TTL_SECONDS = 60 * 60 * 24;

/** Statuses that represent a finished intent (safe to overwrite). */
const TERMINAL_DISPATCH_STATUSES = new Set<DeliveryLoopDispatchStatus>([
  "completed",
  "failed",
]);

/** Short TTL for completed intents — 5 minutes for post-completion inspection. */
const COMPLETED_TTL_SECONDS = 5 * 60;

export type SelfDispatchReplayState =
  | {
      kind: "none";
    }
  | {
      kind: "ready";
      sourceEventId: string;
      sourceSeq: number;
      sourceRunId: string;
      payload: SdlcSelfDispatchPayload;
    };

export type RealtimeDispatchIntent = DeliveryLoopDispatchIntent & {
  selfDispatchReplay: SelfDispatchReplayState;
};

type SelfDispatchReplayRecord =
  | {
      kind: "none";
    }
  | {
      kind: "ready";
      sourceEventId: string;
      sourceSeq: number;
      sourceRunId: string;
      dispatchIntentId: string;
      destinationRunId: string;
      payload: SdlcSelfDispatchPayload;
      createdAt: string;
    };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function redisKey(threadChatId: string): string {
  return `${KEY_PREFIX}${threadChatId}`;
}

function selfDispatchReplayRedisKey(params: {
  threadChatId: string;
  sourceEventId: string;
  sourceSeq: number;
  sourceRunId: string;
}): string {
  return `${SELF_DISPATCH_REPLAY_KEY_PREFIX}${params.threadChatId}:${params.sourceRunId}:${params.sourceEventId}:${params.sourceSeq}`;
}

/** Build the canonical dispatch intent ID from loop and run IDs. */
export function buildDispatchIntentId(loopId: string, runId: string): string {
  return `di_${loopId}_${runId}`;
}

/** Serialize a DeliveryLoopDispatchIntent into a flat string record for HSET. */
function serializeIntent(
  intent: RealtimeDispatchIntent,
): Record<string, string> {
  const baseRecord = {
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

  if (intent.selfDispatchReplay.kind === "none") {
    return {
      ...baseRecord,
      selfDispatchReplayKind: "none",
      selfDispatchReplaySourceEventId: "",
      selfDispatchReplaySourceSeq: "",
      selfDispatchReplaySourceRunId: "",
      selfDispatchReplayPayloadJson: "",
    };
  }

  return {
    ...baseRecord,
    selfDispatchReplayKind: "ready",
    selfDispatchReplaySourceEventId: intent.selfDispatchReplay.sourceEventId,
    selfDispatchReplaySourceSeq: String(intent.selfDispatchReplay.sourceSeq),
    selfDispatchReplaySourceRunId: intent.selfDispatchReplay.sourceRunId,
    selfDispatchReplayPayloadJson: JSON.stringify(
      intent.selfDispatchReplay.payload,
    ),
  };
}

function deserializeSelfDispatchReplayState(
  raw: Record<string, string | undefined>,
): SelfDispatchReplayState {
  if (raw.selfDispatchReplayKind !== "ready") {
    return { kind: "none" };
  }

  if (
    !raw.selfDispatchReplaySourceEventId ||
    !raw.selfDispatchReplaySourceRunId ||
    !raw.selfDispatchReplayPayloadJson
  ) {
    return { kind: "none" };
  }

  const sourceSeq = Number(raw.selfDispatchReplaySourceSeq ?? Number.NaN);
  if (!Number.isInteger(sourceSeq) || sourceSeq < 0) {
    return { kind: "none" };
  }

  try {
    const payload = JSON.parse(raw.selfDispatchReplayPayloadJson);
    if (!isSdlcSelfDispatchPayload(payload)) {
      return { kind: "none" };
    }
    return {
      kind: "ready",
      sourceEventId: raw.selfDispatchReplaySourceEventId,
      sourceSeq,
      sourceRunId: raw.selfDispatchReplaySourceRunId,
      payload,
    };
  } catch {
    return { kind: "none" };
  }
}

function serializeSelfDispatchReplayRecord(
  record: SelfDispatchReplayRecord,
): Record<string, string> {
  if (record.kind === "none") {
    return { kind: "none" };
  }

  return {
    kind: "ready",
    sourceEventId: record.sourceEventId,
    sourceSeq: String(record.sourceSeq),
    sourceRunId: record.sourceRunId,
    dispatchIntentId: record.dispatchIntentId,
    destinationRunId: record.destinationRunId,
    payloadJson: JSON.stringify(record.payload),
    createdAt: record.createdAt,
  };
}

function deserializeSelfDispatchReplayRecord(
  raw: Record<string, string | undefined>,
): SelfDispatchReplayRecord {
  if (raw.kind !== "ready") {
    return { kind: "none" };
  }

  if (
    !raw.sourceEventId ||
    !raw.sourceRunId ||
    !raw.dispatchIntentId ||
    !raw.destinationRunId ||
    !raw.payloadJson ||
    !raw.createdAt
  ) {
    return { kind: "none" };
  }

  const sourceSeq = Number(raw.sourceSeq ?? Number.NaN);
  if (!Number.isInteger(sourceSeq) || sourceSeq < 0) {
    return { kind: "none" };
  }

  try {
    const payload = JSON.parse(raw.payloadJson);
    if (!isSdlcSelfDispatchPayload(payload)) {
      return { kind: "none" };
    }
    if (payload.runId !== raw.destinationRunId) {
      return { kind: "none" };
    }
    return {
      kind: "ready",
      sourceEventId: raw.sourceEventId,
      sourceSeq,
      sourceRunId: raw.sourceRunId,
      dispatchIntentId: raw.dispatchIntentId,
      destinationRunId: raw.destinationRunId,
      payload,
      createdAt: raw.createdAt,
    };
  } catch {
    return { kind: "none" };
  }
}

function isSdlcSelfDispatchPayload(
  value: unknown,
): value is SdlcSelfDispatchPayload {
  if (!value || typeof value !== "object") {
    return false;
  }
  const payload = value as Record<string, unknown>;
  return (
    typeof payload.token === "string" &&
    typeof payload.prompt === "string" &&
    typeof payload.runId === "string" &&
    typeof payload.tokenNonce === "string" &&
    typeof payload.model === "string" &&
    typeof payload.agent === "string" &&
    typeof payload.agentVersion === "number" &&
    (payload.sessionId === null || typeof payload.sessionId === "string") &&
    typeof payload.featureFlags === "object" &&
    payload.featureFlags !== null &&
    typeof payload.permissionMode === "string" &&
    typeof payload.transportMode === "string" &&
    typeof payload.protocolVersion === "number" &&
    typeof payload.threadId === "string" &&
    typeof payload.threadChatId === "string"
  );
}

/** Deserialize a flat string record from HGETALL into a typed intent. */
function deserializeIntent(
  raw: Record<string, string | undefined>,
): RealtimeDispatchIntent | null {
  if (!raw.id) return null;
  return {
    id: raw.id,
    loopId: raw.loopId ?? "",
    threadId: raw.threadId ?? "",
    threadChatId: raw.threadChatId ?? "",
    targetPhase: (raw.targetPhase ??
      "implementing") as DeliveryLoopDispatchablePhase,
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
    selfDispatchReplay: deserializeSelfDispatchReplayState(raw),
  };
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export type CreateDispatchIntentParams = {
  loopId: string;
  threadId: string;
  threadChatId: string;
  targetPhase: DeliveryLoopDispatchablePhase;
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
): Promise<RealtimeDispatchIntent> {
  // Guard: prevent overwriting an active (non-terminal) intent.
  // Only fetch the status field to avoid deserializing the full intent on the hot path.
  const key = redisKey(params.threadChatId);
  const existingStatus = await redis.hget<string>(key, "status");
  if (
    existingStatus &&
    !TERMINAL_DISPATCH_STATUSES.has(
      existingStatus as DeliveryLoopDispatchStatus,
    )
  ) {
    const existingId = await redis.hget<string>(key, "id");
    throw new Error(
      `Cannot create dispatch intent: active intent "${existingId}" exists for threadChat "${params.threadChatId}" with status "${existingStatus}"`,
    );
  }

  const now = new Date();
  const intent: RealtimeDispatchIntent = {
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
    selfDispatchReplay: {
      kind: "none",
    },
  };

  await redis.hset(key, serializeIntent(intent));
  await redis.expire(key, ACTIVE_TTL_SECONDS);

  return intent;
}

/**
 * Partially update an existing dispatch intent in Redis.
 * Validates that the stored intent id matches to prevent stale
 * ack/failure events from mutating a newer intent.
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

  // Guard: verify the stored intent matches the requested id.
  const storedId = await redis.hget<string>(key, "id");
  if (storedId && storedId !== id) {
    console.warn(
      `[dispatch-intent] updateDispatchIntent: id mismatch (requested=${id}, stored=${storedId}), skipping update`,
    );
    return;
  }

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
): Promise<RealtimeDispatchIntent | null> {
  const key = redisKey(threadChatId);
  const raw = await redis.hgetall(key);
  if (!raw || Object.keys(raw).length === 0) return null;
  return deserializeIntent(raw as Record<string, string | undefined>);
}

export async function storeSelfDispatchReplay(params: {
  threadChatId: string;
  sourceEventId: string;
  sourceSeq: number;
  sourceRunId: string;
  dispatchIntentId: string;
  destinationRunId: string;
  payload: SdlcSelfDispatchPayload;
}): Promise<void> {
  const key = selfDispatchReplayRedisKey(params);
  await redis.hset(
    key,
    serializeSelfDispatchReplayRecord({
      kind: "ready",
      sourceEventId: params.sourceEventId,
      sourceSeq: params.sourceSeq,
      sourceRunId: params.sourceRunId,
      dispatchIntentId: params.dispatchIntentId,
      destinationRunId: params.destinationRunId,
      payload: params.payload,
      createdAt: new Date().toISOString(),
    }),
  );
  await redis.expire(key, SELF_DISPATCH_REPLAY_TTL_SECONDS);
}

export async function getReplayableSelfDispatch(params: {
  threadChatId: string;
  sourceEventId: string;
  sourceSeq: number;
  sourceRunId: string;
}): Promise<SdlcSelfDispatchPayload | null> {
  const key = selfDispatchReplayRedisKey(params);
  const raw = await redis.hgetall(key);
  if (!raw || Object.keys(raw).length === 0) {
    return null;
  }
  const replayRecord = deserializeSelfDispatchReplayRecord(
    raw as Record<string, string | undefined>,
  );
  if (replayRecord.kind !== "ready") {
    return null;
  }
  const activeIntent = await getActiveDispatchIntent(params.threadChatId);
  if (
    !activeIntent ||
    activeIntent.id !== replayRecord.dispatchIntentId ||
    activeIntent.runId !== replayRecord.destinationRunId ||
    TERMINAL_DISPATCH_STATUSES.has(activeIntent.status)
  ) {
    return null;
  }
  return replayRecord.payload;
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
