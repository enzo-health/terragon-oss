import { redis } from "@/lib/redis";

const LOCK_TTL_SECONDS = 5;
const SUBMISSION_DEDUPE_TTL_SECONDS = 60 * 60 * 24;

export type FollowUpSubmissionGuardResult<T> =
  | { type: "completed"; value: T }
  | { type: "duplicate-submission" }
  | { type: "lock-held" };

export function runLockKey(threadChatId: string): string {
  return `lock:run:${threadChatId}`;
}

export function submissionDedupeKey(
  userId: string,
  threadId: string,
  threadChatId: string,
  clientSubmissionId: string,
): string {
  return `dedupe:ag-ui-submission:${userId}:${threadId}:${threadChatId}:${clientSubmissionId}`;
}

export async function withFollowUpSubmissionGuard<T>(args: {
  userId: string;
  threadId: string;
  threadChatId: string;
  clientSubmissionId: string | null;
  dispatch: (markDispatched: () => void) => Promise<T>;
}): Promise<FollowUpSubmissionGuardResult<T>> {
  const { userId, threadId, threadChatId, clientSubmissionId, dispatch } = args;
  const submissionKey =
    clientSubmissionId !== null
      ? submissionDedupeKey(userId, threadId, threadChatId, clientSubmissionId)
      : null;

  if (submissionKey !== null) {
    const claimedSubmission = await redis.set(submissionKey, "1", {
      nx: true,
      ex: SUBMISSION_DEDUPE_TTL_SECONDS,
    });

    if (claimedSubmission === null) {
      return { type: "duplicate-submission" };
    }
  }

  const lockKey = runLockKey(threadChatId);
  const acquired = await redis.set(lockKey, "1", {
    nx: true,
    ex: LOCK_TTL_SECONDS,
  });

  if (acquired === null) {
    if (submissionKey !== null) {
      await redis.del(submissionKey);
    }
    return { type: "lock-held" };
  }

  let dispatched = false;
  const markDispatched = (): void => {
    dispatched = true;
  };

  try {
    return { type: "completed", value: await dispatch(markDispatched) };
  } catch (error) {
    if (!dispatched && submissionKey !== null) {
      await redis.del(submissionKey);
    }
    throw error;
  } finally {
    await redis.del(lockKey);
  }
}
