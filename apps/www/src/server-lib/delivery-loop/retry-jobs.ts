import { redis } from "@/lib/redis";

const RETRY_JOB_PREFIX = "dlrj:job:";
const RETRY_JOB_SCHEDULED_KEY = "dlrj:scheduled";
const RETRY_JOB_CLAIM_PREFIX = "dlrj:claim:";
const RETRY_JOB_TTL_SECONDS = 24 * 60 * 60;
const RETRY_JOB_CLAIM_TTL_SECONDS = 60;
const DEFER_RETRY_DELAY_MS = 30_000;

export type DeliveryLoopRetryJob = {
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

function serializeRetryJob(job: DeliveryLoopRetryJob) {
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
): DeliveryLoopRetryJob | null {
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
}): Promise<DeliveryLoopRetryJob> {
  const normalizedDispatchAttempt = dispatchAttempt ?? attempt;
  if (normalizedDispatchAttempt === undefined) {
    throw new Error(
      "scheduleFollowUpRetryJob requires dispatchAttempt (or legacy attempt)",
    );
  }
  const job: DeliveryLoopRetryJob = {
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
): Promise<DeliveryLoopRetryJob | null> {
  const raw = await redis.hgetall(retryJobKey(jobId));
  return deserializeRetryJob(raw);
}

async function deleteRetryJob(jobId: string): Promise<void> {
  await Promise.all([
    redis.del(retryJobKey(jobId)),
    redis.zrem(RETRY_JOB_SCHEDULED_KEY, jobId),
    redis.del(retryJobClaimKey(jobId)),
  ]);
}

async function rescheduleRetryJob({
  job,
  runAt,
}: {
  job: DeliveryLoopRetryJob;
  runAt: Date;
}): Promise<void> {
  await scheduleFollowUpRetryJob({
    userId: job.userId,
    threadId: job.threadId,
    threadChatId: job.threadChatId,
    dispatchAttempt: job.dispatchAttempt,
    deferCount: job.deferCount + 1,
    runAt,
  });
  await redis.del(retryJobClaimKey(job.id));
}

export async function drainDueDeliveryLoopRetryJobs({
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
      await deleteRetryJob(jobId);
      skipped += 1;
      continue;
    }

    const result = await runFollowUpQueue({
      userId: job.userId,
      threadId: job.threadId,
      threadChatId: job.threadChatId,
    });

    let effectiveResult = result;
    if (!effectiveResult.processed && effectiveResult.reason === "stale_cas") {
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
      await deleteRetryJob(job.id);
      completed += 1;
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
      effectiveResult.reason === "agent_rate_limited" ||
      effectiveResult.reason === "stale_cas"
    ) {
      await rescheduleRetryJob({
        job,
        runAt: new Date(Date.now() + DEFER_RETRY_DELAY_MS),
      });
      rescheduled += 1;
      continue;
    }

    await deleteRetryJob(job.id);
    completed += 1;
  }

  return {
    claimed,
    completed,
    rescheduled,
    skipped,
  };
}
