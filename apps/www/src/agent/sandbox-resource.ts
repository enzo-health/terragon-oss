import {
  isLocalRedisHttpMode,
  isRedisTransportParseError,
  redis,
} from "@/lib/redis";

/**
 * For each sandbox id, we track if it is:
 * - being used by a thread chat (set of thread chat ids)
 * - being used in a terminal (terminal status = 1)
 * - being used elsewhere (active users > 0)
 */

const THREAD_CHATS_PREFIX = "sandbox-active-thread-chats:";
const THREAD_CHAT_RUNS_PREFIX = "sandbox-active-thread-chat-runs:";
const TERMINAL_STATUS_PREFIX = "sandbox-terminal-status:";
const ACTIVE_USERS_PREFIX = "sandbox-active-users:";
const LAST_ACTIVITY_PREFIX = "sandbox-last-activity:";
const LAST_ACTIVITY_TTL_SECONDS = 60 * 60 * 24; // 24 hours
const DEFAULT_WARM_GRACE_SECONDS = 10 * 60; // 10 minutes

function isRecoverableSandboxTrackingError(error: unknown): boolean {
  if (isRedisTransportParseError(error)) {
    return true;
  }
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return (
    message.includes("local redis-http command timeout") ||
    message.includes("timeout") ||
    message.includes("time out") ||
    message.includes("socket hang up") ||
    message.includes("econnreset") ||
    message.includes("econnrefused") ||
    message.includes("fetch failed")
  );
}

function logSandboxTrackingRecovery(
  operation: string,
  sandboxId: string,
  error: unknown,
) {
  console.warn(
    `[sandbox-resource] recoverable redis tracking failure during ${operation}`,
    {
      sandboxId,
      error,
    },
  );
}

function getWarmGraceSeconds(): number {
  const raw = process.env.SANDBOX_WARM_GRACE_SECONDS;
  if (!raw) {
    return DEFAULT_WARM_GRACE_SECONDS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    console.warn(
      `Invalid SANDBOX_WARM_GRACE_SECONDS value: ${raw}. Using default ${DEFAULT_WARM_GRACE_SECONDS}.`,
    );
    return DEFAULT_WARM_GRACE_SECONDS;
  }
  return parsed;
}

async function markSandboxActivity(sandboxId: string) {
  if (isLocalRedisHttpMode()) {
    return;
  }
  try {
    await redis.set(
      `${LAST_ACTIVITY_PREFIX}${sandboxId}`,
      new Date().toISOString(),
      {
        ex: LAST_ACTIVITY_TTL_SECONDS,
      },
    );
  } catch (error) {
    if (isRecoverableSandboxTrackingError(error)) {
      logSandboxTrackingRecovery("markSandboxActivity", sandboxId, error);
      return;
    }
    throw error;
  }
}

async function getLastSandboxActivityOrNull(
  sandboxId: string,
): Promise<Date | null> {
  if (isLocalRedisHttpMode()) {
    return null;
  }
  let value: string | null = null;
  try {
    value = await redis.get<string>(`${LAST_ACTIVITY_PREFIX}${sandboxId}`);
  } catch (error) {
    if (isRecoverableSandboxTrackingError(error)) {
      logSandboxTrackingRecovery(
        "getLastSandboxActivityOrNull:get",
        sandboxId,
        error,
      );
      return null;
    }
    throw error;
  }
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    console.error(
      `Invalid last activity timestamp for sandbox ${sandboxId}: ${value}`,
    );
    try {
      await redis.del(`${LAST_ACTIVITY_PREFIX}${sandboxId}`);
    } catch (error) {
      if (isRecoverableSandboxTrackingError(error)) {
        logSandboxTrackingRecovery(
          "getLastSandboxActivityOrNull:delete-invalid",
          sandboxId,
          error,
        );
        return null;
      }
      throw error;
    }
    return null;
  }
  return parsed;
}

export async function setTerminalActive({
  sandboxId,
  expires,
}: {
  sandboxId: string;
  expires: number;
}) {
  if (isLocalRedisHttpMode()) {
    return;
  }
  const pipeline = redis.pipeline();
  pipeline.set(`${TERMINAL_STATUS_PREFIX}${sandboxId}`, "1");
  pipeline.expire(`${TERMINAL_STATUS_PREFIX}${sandboxId}`, expires);
  pipeline.set(`${LAST_ACTIVITY_PREFIX}${sandboxId}`, new Date().toISOString());
  pipeline.expire(
    `${LAST_ACTIVITY_PREFIX}${sandboxId}`,
    LAST_ACTIVITY_TTL_SECONDS,
  );
  try {
    await pipeline.exec();
  } catch (error) {
    if (isRecoverableSandboxTrackingError(error)) {
      logSandboxTrackingRecovery("setTerminalActive", sandboxId, error);
      return;
    }
    throw error;
  }
}

export async function setActiveThreadChat({
  sandboxId,
  threadChatId,
  isActive,
  runId,
}: {
  sandboxId: string;
  threadChatId: string;
  isActive: boolean;
  runId?: string | null;
}) {
  if (isLocalRedisHttpMode()) {
    return;
  }

  const threadChatsKey = `${THREAD_CHATS_PREFIX}${sandboxId}`;
  const threadChatRunsKey = `${THREAD_CHAT_RUNS_PREFIX}${sandboxId}:${threadChatId}`;
  if (isActive) {
    const pipeline = redis.pipeline();
    pipeline.sadd(threadChatsKey, threadChatId);
    pipeline.expire(threadChatsKey, 60 * 60 * 24); // 1 day
    if (runId) {
      pipeline.sadd(threadChatRunsKey, runId);
      pipeline.expire(threadChatRunsKey, 60 * 60 * 24); // 1 day
    }
    pipeline.set(
      `${LAST_ACTIVITY_PREFIX}${sandboxId}`,
      new Date().toISOString(),
    );
    pipeline.expire(
      `${LAST_ACTIVITY_PREFIX}${sandboxId}`,
      LAST_ACTIVITY_TTL_SECONDS,
    );
    try {
      await pipeline.exec();
    } catch (error) {
      if (isRecoverableSandboxTrackingError(error)) {
        logSandboxTrackingRecovery(
          "setActiveThreadChat:activate",
          sandboxId,
          error,
        );
        return;
      }
      throw error;
    }
  } else {
    try {
      await markSandboxActivity(sandboxId);
    } catch (error) {
      console.error(
        `Failed to mark sandbox activity for sandbox ${sandboxId}`,
        error,
      );
    }
    if (!runId) {
      try {
        await redis.srem(threadChatsKey, threadChatId);
      } catch (error) {
        if (isRecoverableSandboxTrackingError(error)) {
          logSandboxTrackingRecovery(
            "setActiveThreadChat:deactivate-srem",
            sandboxId,
            error,
          );
          return;
        }
        throw error;
      }
      return;
    }

    const pipeline = redis.pipeline();
    pipeline.srem(threadChatRunsKey, runId);
    pipeline.scard(threadChatRunsKey);
    let remainingRunCountRaw: unknown;
    try {
      [, remainingRunCountRaw] = await pipeline.exec();
    } catch (error) {
      if (isRecoverableSandboxTrackingError(error)) {
        logSandboxTrackingRecovery(
          "setActiveThreadChat:deactivate-run-membership",
          sandboxId,
          error,
        );
        return;
      }
      throw error;
    }
    const remainingRunCount =
      typeof remainingRunCountRaw === "number" ? remainingRunCountRaw : 0;
    if (remainingRunCount > 0) {
      return;
    }

    const cleanupPipeline = redis.pipeline();
    cleanupPipeline.del(threadChatRunsKey);
    cleanupPipeline.srem(threadChatsKey, threadChatId);
    try {
      await cleanupPipeline.exec();
    } catch (error) {
      if (isRecoverableSandboxTrackingError(error)) {
        logSandboxTrackingRecovery(
          "setActiveThreadChat:deactivate-cleanup",
          sandboxId,
          error,
        );
        return;
      }
      throw error;
    }
  }
}

/**
 * Check if there are other active runs for a threadChat on a sandbox,
 * excluding the specified runId. Uses the Redis run-tracking set
 * (THREAD_CHAT_RUNS_PREFIX).
 */
export async function hasOtherActiveRuns({
  sandboxId,
  threadChatId,
  excludeRunId,
}: {
  sandboxId: string;
  threadChatId: string;
  excludeRunId: string;
}): Promise<boolean> {
  if (isLocalRedisHttpMode()) {
    return false;
  }
  const key = `${THREAD_CHAT_RUNS_PREFIX}${sandboxId}:${threadChatId}`;
  let members: string[] = [];
  try {
    members = await redis.smembers(key);
  } catch (error) {
    if (isRecoverableSandboxTrackingError(error)) {
      logSandboxTrackingRecovery("hasOtherActiveRuns", sandboxId, error);
      return false;
    }
    throw error;
  }
  return members.some((id) => id !== excludeRunId);
}

export async function withSandboxResource<T>({
  sandboxId,
  label,
  callback,
}: {
  sandboxId: string;
  label: string;
  callback: () => Promise<T>;
}): Promise<T> {
  if (isLocalRedisHttpMode()) {
    return callback();
  }
  const pipeline = redis.pipeline();
  pipeline.incr(`${ACTIVE_USERS_PREFIX}${sandboxId}`);
  pipeline.expire(`${ACTIVE_USERS_PREFIX}${sandboxId}`, 10 * 60); // 10 minutes
  let activeUsersAfterIncrement: unknown;
  try {
    [activeUsersAfterIncrement] = await pipeline.exec();
  } catch (error) {
    if (isRecoverableSandboxTrackingError(error)) {
      console.warn(
        `withSandboxResource(${label}): recoverable redis tracking failure, bypassing resource lock`,
        error,
      );
      return callback();
    }
    throw error;
  }
  if (!activeUsersAfterIncrement) {
    throw new Error("Failed to acquire sandbox resource");
  }
  console.log(
    `withSandboxResource(${label}): activeUsers after increment`,
    activeUsersAfterIncrement,
  );
  try {
    return await callback();
  } finally {
    try {
      const activeUsersAfterDecrement = await redis.decr(
        `${ACTIVE_USERS_PREFIX}${sandboxId}`,
      );
      console.log(
        `withSandboxResource(${label}): activeUsers after decrement`,
        activeUsersAfterDecrement,
      );
    } catch (e) {
      console.error("Failed to decrement active users for sandbox", e);
      // Safety: set a short expiry so the counter self-heals
      try {
        await redis.expire(`${ACTIVE_USERS_PREFIX}${sandboxId}`, 60);
      } catch {
        // Best effort
      }
    }
  }
}

export async function getActiveUsers(sandboxId: string) {
  if (isLocalRedisHttpMode()) {
    return 0;
  }
  let activeUsers: unknown = null;
  try {
    activeUsers = await redis.get(`${ACTIVE_USERS_PREFIX}${sandboxId}`);
  } catch (error) {
    if (isRecoverableSandboxTrackingError(error)) {
      logSandboxTrackingRecovery("getActiveUsers:get", sandboxId, error);
      return 0;
    }
    throw error;
  }
  if (!activeUsers) {
    return 0;
  }
  const activeUsersParsed = Number.parseInt(String(activeUsers), 10);
  if (isNaN(activeUsersParsed)) {
    console.error(
      `Invalid active users for sandbox ${sandboxId}: ${activeUsers}`,
    );
    try {
      await redis.del(`${ACTIVE_USERS_PREFIX}${sandboxId}`);
    } catch (error) {
      if (isRecoverableSandboxTrackingError(error)) {
        logSandboxTrackingRecovery(
          "getActiveUsers:delete-invalid",
          sandboxId,
          error,
        );
        return 0;
      }
      throw error;
    }
    return 0;
  }
  return activeUsersParsed;
}

export async function getActiveThreadChats(sandboxId: string) {
  if (isLocalRedisHttpMode()) {
    return [];
  }
  try {
    const activeThreadChats = await redis.smembers(
      `${THREAD_CHATS_PREFIX}${sandboxId}`,
    );
    return activeThreadChats;
  } catch (error) {
    if (isRecoverableSandboxTrackingError(error)) {
      logSandboxTrackingRecovery("getActiveThreadChats", sandboxId, error);
      return [];
    }
    throw error;
  }
}

export async function getTerminalStatus(sandboxId: string) {
  if (isLocalRedisHttpMode()) {
    return 0;
  }
  let terminalStatus: unknown = null;
  try {
    terminalStatus = await redis.get(`${TERMINAL_STATUS_PREFIX}${sandboxId}`);
  } catch (error) {
    if (isRecoverableSandboxTrackingError(error)) {
      logSandboxTrackingRecovery("getTerminalStatus:get", sandboxId, error);
      return 0;
    }
    throw error;
  }
  if (!terminalStatus) {
    return 0;
  }
  const terminalStatusParsed = Number.parseInt(String(terminalStatus), 10);
  if (terminalStatusParsed !== 0 && terminalStatusParsed !== 1) {
    console.error(
      `Invalid terminal status for sandbox ${sandboxId}: ${terminalStatus}`,
    );
    try {
      await redis.del(`${TERMINAL_STATUS_PREFIX}${sandboxId}`);
    } catch (error) {
      if (isRecoverableSandboxTrackingError(error)) {
        logSandboxTrackingRecovery(
          "getTerminalStatus:delete-invalid",
          sandboxId,
          error,
        );
        return 0;
      }
      throw error;
    }
    return 0;
  }
  return terminalStatusParsed;
}

export async function shouldHibernateSandbox(sandboxId: string) {
  const [activeUsers, activeThreadChats, terminalStatus, lastActivity] =
    await Promise.all([
      getActiveUsers(sandboxId),
      getActiveThreadChats(sandboxId),
      getTerminalStatus(sandboxId),
      getLastSandboxActivityOrNull(sandboxId),
    ]);
  const warmGraceSeconds = getWarmGraceSeconds();
  const warmGraceActive =
    !!lastActivity &&
    Date.now() - lastActivity.getTime() < warmGraceSeconds * 1000;
  const shouldHibernate =
    activeUsers <= 0 &&
    activeThreadChats.length === 0 &&
    terminalStatus === 0 &&
    !warmGraceActive;
  console.log("shouldHibernateSandbox", {
    sandboxId,
    activeUsers,
    activeThreadChats,
    terminalStatus,
    lastActivity,
    warmGraceSeconds,
    warmGraceActive,
    shouldHibernate,
  });
  return shouldHibernate;
}
