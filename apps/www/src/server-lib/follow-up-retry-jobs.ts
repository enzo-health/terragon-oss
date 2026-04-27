import { redis } from "@/lib/redis";

const RETRY_JOB_PREFIX = "dlrj:job:";
const RETRY_JOB_SCHEDULED_KEY = "dlrj:scheduled";
const RETRY_JOB_CLAIM_PREFIX = "dlrj:claim:";
const RETRY_JOB_TTL_SECONDS = 24 * 60 * 60;
const RETRY_JOB_CLAIM_TTL_SECONDS = 60;
const DEFER_RETRY_DELAY_MS = 30_000;
const CONDITIONAL_RESCHEDULE_RETRY_JOB_SCRIPT = `
local jobKey = KEYS[1]
local scheduledKey = KEYS[2]
local claimKey = KEYS[3]
local expectedRunAt = ARGV[1]
local expectedDispatchAttempt = ARGV[2]
local expectedDeferCount = ARGV[3]
local nextRunAt = ARGV[4]
local nextDispatchAttempt = ARGV[5]
local nextDeferCount = ARGV[6]
local ttlSeconds = tonumber(ARGV[7])
local nextRunAtMs = tonumber(ARGV[8])
local jobId = ARGV[9]

local currentRunAt = redis.call("HGET", jobKey, "runAt")
local currentDispatchAttempt = redis.call("HGET", jobKey, "dispatchAttempt")
local currentDeferCount = redis.call("HGET", jobKey, "deferCount")

if not currentRunAt then
  redis.call("DEL", claimKey)
  return 0
end

if (
  currentRunAt ~= expectedRunAt or
  currentDispatchAttempt ~= expectedDispatchAttempt or
  currentDeferCount ~= expectedDeferCount
) then
  redis.call("DEL", claimKey)
  return 0
end

redis.call("HSET", jobKey, "runAt", nextRunAt)
redis.call("HSET", jobKey, "dispatchAttempt", nextDispatchAttempt)
redis.call("HSET", jobKey, "deferCount", nextDeferCount)
redis.call("EXPIRE", jobKey, ttlSeconds)
redis.call("ZADD", scheduledKey, nextRunAtMs, jobId)
redis.call("DEL", claimKey)
return 1
`;
const CONDITIONAL_DELETE_RETRY_JOB_SCRIPT = `
local jobKey = KEYS[1]
local scheduledKey = KEYS[2]
local claimKey = KEYS[3]
local expectedRunAt = ARGV[1]
local expectedDispatchAttempt = ARGV[2]
local expectedDeferCount = ARGV[3]
local jobId = ARGV[4]

local currentRunAt = redis.call("HGET", jobKey, "runAt")
local currentDispatchAttempt = redis.call("HGET", jobKey, "dispatchAttempt")
local currentDeferCount = redis.call("HGET", jobKey, "deferCount")

if expectedRunAt ~= "" then
  if currentRunAt and (
    currentRunAt ~= expectedRunAt or
    currentDispatchAttempt ~= expectedDispatchAttempt or
    currentDeferCount ~= expectedDeferCount
  ) then
    redis.call("DEL", claimKey)
    return 0
  end
else
  if currentRunAt then
    redis.call("DEL", claimKey)
    return 0
  end
end

redis.call("DEL", jobKey)
redis.call("ZREM", scheduledKey, jobId)
redis.call("DEL", claimKey)
return 1
`;

export type FollowUpRetryJob = {
  id: string;
  kind: "follow_up_dispatch";
  userId: string;
  threadId: string;
  threadChatId: string;
  dispatchAttempt: number;
  deferCount: number;
  runAt: Date;
};

function retryJobKey(jobId: string): string {
  return `${RETRY_JOB_PREFIX}${jobId}`;
}

function retryJobClaimKey(jobId: string): string {
  return `${RETRY_JOB_CLAIM_PREFIX}${jobId}`;
}

function buildFollowUpRetryJobId(threadChatId: string): string {
  return `follow-up:${threadChatId}`;
}

function serializeRetryJob(job: FollowUpRetryJob) {
  return {
    id: job.id,
    kind: job.kind,
    userId: job.userId,
    threadId: job.threadId,
    threadChatId: job.threadChatId,
    dispatchAttempt: String(job.dispatchAttempt),
    deferCount: String(job.deferCount),
    runAt: job.runAt.toISOString(),
  };
}

function deserializeRetryJob(
  raw: Record<string, unknown> | null,
): FollowUpRetryJob | null {
  if (!raw || Object.keys(raw).length === 0) {
    return null;
  }
  if (
    typeof raw.id !== "string" ||
    raw.kind !== "follow_up_dispatch" ||
    typeof raw.userId !== "string" ||
    typeof raw.threadId !== "string" ||
    typeof raw.threadChatId !== "string" ||
    typeof raw.runAt !== "string"
  ) {
    return null;
  }

  const runAt = new Date(raw.runAt);
  if (Number.isNaN(runAt.getTime())) {
    return null;
  }

  const dispatchAttemptRaw = raw.dispatchAttempt ?? raw.attempt;
  const dispatchAttempt =
    typeof dispatchAttemptRaw === "number"
      ? dispatchAttemptRaw
      : typeof dispatchAttemptRaw === "string"
        ? Number.parseInt(dispatchAttemptRaw, 10)
        : Number.NaN;
  if (!Number.isFinite(dispatchAttempt)) {
    return null;
  }

  const deferCountRaw = raw.deferCount ?? 0;
  const deferCount =
    typeof deferCountRaw === "number"
      ? deferCountRaw
      : typeof deferCountRaw === "string"
        ? Number.parseInt(deferCountRaw, 10)
        : Number.NaN;
  if (!Number.isFinite(deferCount)) {
    return null;
  }

  return {
    id: raw.id,
    kind: "follow_up_dispatch",
    userId: raw.userId,
    threadId: raw.threadId,
    threadChatId: raw.threadChatId,
    dispatchAttempt,
    deferCount,
    runAt,
  };
}

export async function scheduleFollowUpRetryJob({
  userId,
  threadId,
  threadChatId,
  dispatchAttempt,
  deferCount = 0,
  attempt,
  runAt,
}: {
  userId: string;
  threadId: string;
  threadChatId: string;
  dispatchAttempt?: number;
  deferCount?: number;
  attempt?: number;
  runAt: Date;
}): Promise<FollowUpRetryJob> {
  const normalizedDispatchAttempt = dispatchAttempt ?? attempt;
  if (normalizedDispatchAttempt === undefined) {
    throw new Error(
      "scheduleFollowUpRetryJob requires dispatchAttempt (or legacy attempt)",
    );
  }
  const job: FollowUpRetryJob = {
    id: buildFollowUpRetryJobId(threadChatId),
    kind: "follow_up_dispatch",
    userId,
    threadId,
    threadChatId,
    dispatchAttempt: normalizedDispatchAttempt,
    deferCount,
    runAt,
  };

  await redis.hset(retryJobKey(job.id), serializeRetryJob(job));
  await redis.expire(retryJobKey(job.id), RETRY_JOB_TTL_SECONDS);
  await redis.zadd(RETRY_JOB_SCHEDULED_KEY, {
    score: runAt.getTime(),
    member: job.id,
  });

  return job;
}

export async function getRetryJob(
  jobId: string,
): Promise<FollowUpRetryJob | null> {
  const raw = await redis.hgetall(retryJobKey(jobId));
  return deserializeRetryJob(raw);
}

type RetryJobDeleteOutcome = "deleted" | "preserved_newer";

async function deleteRetryJobIfSnapshotMatches(params: {
  jobId: string;
  expectedJob: FollowUpRetryJob | null;
}): Promise<RetryJobDeleteOutcome> {
  const scriptResult = await redis.eval(
    CONDITIONAL_DELETE_RETRY_JOB_SCRIPT,
    [
      retryJobKey(params.jobId),
      RETRY_JOB_SCHEDULED_KEY,
      retryJobClaimKey(params.jobId),
    ],
    [
      params.expectedJob?.runAt.toISOString() ?? "",
      params.expectedJob ? String(params.expectedJob.dispatchAttempt) : "",
      params.expectedJob ? String(params.expectedJob.deferCount) : "",
      params.jobId,
    ],
  );

  if (scriptResult === 1 || scriptResult === "1") {
    return "deleted";
  }
  return "preserved_newer";
}

type RetryJobRescheduleOutcome = "rescheduled" | "preserved_newer";

async function rescheduleRetryJob({
  job,
  runAt,
}: {
  job: FollowUpRetryJob;
  runAt: Date;
}): Promise<RetryJobRescheduleOutcome> {
  const nextDeferCount = job.deferCount + 1;
  const scriptResult = await redis.eval(
    CONDITIONAL_RESCHEDULE_RETRY_JOB_SCRIPT,
    [retryJobKey(job.id), RETRY_JOB_SCHEDULED_KEY, retryJobClaimKey(job.id)],
    [
      job.runAt.toISOString(),
      String(job.dispatchAttempt),
      String(job.deferCount),
      runAt.toISOString(),
      String(job.dispatchAttempt),
      String(nextDeferCount),
      String(RETRY_JOB_TTL_SECONDS),
      String(runAt.getTime()),
      job.id,
    ],
  );
  if (scriptResult === 1 || scriptResult === "1") {
    return "rescheduled";
  }
  return "preserved_newer";
}

export async function drainDueFollowUpRetryJobs({
  now = new Date(),
  leaseOwnerTokenPrefix,
  processFollowUpQueue,
}: {
  now?: Date;
  leaseOwnerTokenPrefix: string;
  processFollowUpQueue?: typeof import("@/server-lib/process-follow-up-queue").maybeProcessFollowUpQueue;
}): Promise<{
  claimed: number;
  completed: number;
  rescheduled: number;
  skipped: number;
}> {
  const dueJobIds: string[] =
    ((await redis.zrange(RETRY_JOB_SCHEDULED_KEY, 0, now.getTime(), {
      byScore: true,
    })) as string[] | null) ?? [];

  let claimed = 0;
  let completed = 0;
  let rescheduled = 0;
  let skipped = 0;
  const runFollowUpQueue =
    processFollowUpQueue ??
    (await import("@/server-lib/process-follow-up-queue"))
      .maybeProcessFollowUpQueue;

  for (const jobId of dueJobIds) {
    const claim = await redis.set(
      retryJobClaimKey(jobId),
      `${leaseOwnerTokenPrefix}:${Date.now()}`,
      {
        nx: true,
        ex: RETRY_JOB_CLAIM_TTL_SECONDS,
      },
    );
    if (claim !== "OK") {
      skipped += 1;
      continue;
    }

    claimed += 1;
    const job = await getRetryJob(jobId);
    if (!job) {
      const deleteOutcome = await deleteRetryJobIfSnapshotMatches({
        jobId,
        expectedJob: null,
      });
      if (deleteOutcome === "deleted") {
        skipped += 1;
      } else {
        rescheduled += 1;
      }
      continue;
    }

    const result = await runFollowUpQueue({
      userId: job.userId,
      threadId: job.threadId,
      threadChatId: job.threadChatId,
    });

    let effectiveResult = result;
    if (
      !effectiveResult.processed &&
      (effectiveResult.reason === "stale_cas" ||
        effectiveResult.reason === "invalid_event")
    ) {
      effectiveResult = await runFollowUpQueue({
        userId: job.userId,
        threadId: job.threadId,
        threadChatId: job.threadChatId,
      });
    }

    if (
      effectiveResult.processed ||
      effectiveResult.reason === "no_queued_messages"
    ) {
      const deleteOutcome = await deleteRetryJobIfSnapshotMatches({
        jobId: job.id,
        expectedJob: job,
      });
      if (deleteOutcome === "deleted") {
        completed += 1;
      } else {
        rescheduled += 1;
      }
      continue;
    }

    if (effectiveResult.reason === "dispatch_retry_scheduled") {
      await redis.del(retryJobClaimKey(job.id));
      completed += 1;
      continue;
    }

    if (
      effectiveResult.reason === "scheduled_not_runnable" ||
      effectiveResult.reason === "stale_cas_busy" ||
      effectiveResult.reason === "dispatch_not_started" ||
      effectiveResult.reason === "agent_rate_limited" ||
      effectiveResult.reason === "stale_cas" ||
      effectiveResult.reason === "invalid_event" ||
      effectiveResult.reason === "dispatch_retry_persistence_failed"
    ) {
      await rescheduleRetryJob({
        job,
        runAt: new Date(Date.now() + DEFER_RETRY_DELAY_MS),
      });
      rescheduled += 1;
      continue;
    }

    const deleteOutcome = await deleteRetryJobIfSnapshotMatches({
      jobId: job.id,
      expectedJob: job,
    });
    if (deleteOutcome === "deleted") {
      completed += 1;
    } else {
      rescheduled += 1;
    }
  }

  return {
    claimed,
    completed,
    rescheduled,
    skipped,
  };
}
