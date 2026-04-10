import { getUser } from "@leo/shared/model/user";
import { Ratelimit } from "@upstash/ratelimit";
import { db } from "@/lib/db";
import {
  isLocalRedisHttpMode,
  isRedisTransportParseError,
  redis,
} from "./redis";

const PREFIX = "@upstash/ratelimit";

const productionRefillRate = 20;
const productionWindow = "1h";
const productionMaxTokens = 20;
// In development, we want to be able to test the rate limit more easily.
const developmentRefillRate = 100;
const developmentWindow = "1h";
const developmentMaxTokens = 100;

export const sandboxCreationRateLimit = new Ratelimit({
  redis,
  limiter: Ratelimit.tokenBucket(
    process.env.NODE_ENV === "production"
      ? productionRefillRate
      : developmentRefillRate,
    process.env.NODE_ENV === "production"
      ? productionWindow
      : developmentWindow,
    process.env.NODE_ENV === "production"
      ? productionMaxTokens
      : developmentMaxTokens,
  ),
  prefix: `${PREFIX}:sandbox-creation`,
});

type SandboxCreationRateLimitRemaining = Awaited<
  ReturnType<typeof sandboxCreationRateLimit.getRemaining>
>;
type SandboxCreationRateLimitResult = Awaited<
  ReturnType<typeof sandboxCreationRateLimit.limit>
>;

function isRecoverableLocalRateLimitError(error: unknown): boolean {
  if (!isLocalRedisHttpMode()) {
    return false;
  }
  if (isRedisTransportParseError(error)) {
    return true;
  }
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return (
    message.includes("timeout") ||
    message.includes("time out") ||
    message.includes("socket hang up") ||
    message.includes("econnreset") ||
    message.includes("econnrefused") ||
    message.includes("enotfound") ||
    message.includes("fetch failed") ||
    message.includes("failed to fetch")
  );
}

function logRateLimitRecovery({
  operation,
  userId,
  error,
}: {
  operation: string;
  userId: string;
  error: unknown;
}) {
  console.warn(`[rate-limit] recovered from local redis-http failure`, {
    operation,
    userId,
    error,
  });
}

function buildFallbackSandboxCreationRateLimitRemaining(): SandboxCreationRateLimitRemaining {
  return {
    remaining:
      process.env.NODE_ENV === "production"
        ? productionMaxTokens
        : developmentMaxTokens,
    reset: Date.now() + 60 * 60 * 1000,
  };
}

function buildFallbackRateLimitResult(
  limit: number,
): SandboxCreationRateLimitResult {
  return {
    success: true,
    limit,
    remaining: limit,
    reset: Date.now() + 60 * 60 * 1000,
    pending: Promise.resolve(),
  };
}

function shouldBypassRateLimitInTest(): boolean {
  return process.env.NODE_ENV === "test";
}

export async function getSandboxCreationRateLimitRemaining(
  userId: string,
): Promise<SandboxCreationRateLimitRemaining> {
  if (shouldBypassRateLimitInTest()) {
    return buildFallbackSandboxCreationRateLimitRemaining();
  }
  try {
    return await sandboxCreationRateLimit.getRemaining(userId);
  } catch (error) {
    if (!isRecoverableLocalRateLimitError(error)) {
      throw error;
    }
    logRateLimitRecovery({
      operation: "sandboxCreationRateLimit.getRemaining",
      userId,
      error,
    });
    return buildFallbackSandboxCreationRateLimitRemaining();
  }
}

export async function trackSandboxCreation(userId: string) {
  if (shouldBypassRateLimitInTest()) {
    return;
  }
  let result: SandboxCreationRateLimitResult;
  try {
    result = await sandboxCreationRateLimit.limit(userId);
  } catch (error) {
    if (!isRecoverableLocalRateLimitError(error)) {
      throw error;
    }
    logRateLimitRecovery({
      operation: "sandboxCreationRateLimit.limit",
      userId,
      error,
    });
    result = buildFallbackRateLimitResult(
      process.env.NODE_ENV === "production"
        ? productionMaxTokens
        : developmentMaxTokens,
    );
  }
  // Don't throw an error here, just log a warning because there might be a race condition
  // between the rate limit check and the sandbox creation and its okay if we go over.
  if (!result.success) {
    console.log(
      `Going over sandbox creation rate limit: ${result.remaining} remaining, reset in ${result.reset}`,
    );
  }
}

// CLI task creation rate limiting (by user ID)
export const cliTaskCreationRateLimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(
    50, // 50 tasks
    "1d", // per day
  ),
  prefix: `${PREFIX}:cli-task-creation`,
});

export async function checkCliTaskCreationRateLimit(userId: string) {
  if (shouldBypassRateLimitInTest() || isLocalRedisHttpMode()) {
    return buildFallbackRateLimitResult(50);
  }
  let result: SandboxCreationRateLimitResult;
  try {
    result = await cliTaskCreationRateLimit.limit(userId);
  } catch (error) {
    if (!isRecoverableLocalRateLimitError(error)) {
      throw error;
    }
    logRateLimitRecovery({
      operation: "cliTaskCreationRateLimit.limit",
      userId,
      error,
    });
    result = buildFallbackRateLimitResult(50);
  }
  if (!result.success) {
    const hoursUntilReset = Math.ceil(
      (result.reset - Date.now()) / 1000 / 60 / 60,
    );
    throw new Error(
      `Daily task creation limit reached (50 tasks per day). Try again in ${hoursUntilReset} hours.`,
    );
  }
  return result;
}

// Shadow-banned users: 3 tasks per hour (applies across sources)
export const shadowBanTaskCreationRateLimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(3, "1h"),
  prefix: `${PREFIX}:shadowban-task-creation`,
});

// No-op for non-shadow-banned users; used by web and internal paths
export async function checkShadowBanTaskCreationRateLimit(userId: string) {
  const user = await getUser({ db, userId });
  if (!user?.shadowBanned) return { success: true } as const;
  if (shouldBypassRateLimitInTest()) {
    return buildFallbackRateLimitResult(3);
  }
  let result: SandboxCreationRateLimitResult;
  try {
    result = await shadowBanTaskCreationRateLimit.limit(userId);
  } catch (error) {
    if (!isRecoverableLocalRateLimitError(error)) {
      throw error;
    }
    logRateLimitRecovery({
      operation: "shadowBanTaskCreationRateLimit.limit",
      userId,
      error,
    });
    result = buildFallbackRateLimitResult(3);
  }
  if (!result.success) {
    const minutesUntilReset = Math.ceil(
      (result.reset - Date.now()) / 1000 / 60,
    );
    // Generic message (do not expose shadow ban state)
    throw new Error(
      `Task creation limit reached. Try again in ${minutesUntilReset} minutes.`,
    );
  }
  return result;
}
