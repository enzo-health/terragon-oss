import { eq } from "drizzle-orm";
import { DB } from "../../db";
import * as schema from "../../db/schema";
import type {
  SdlcReviewThreadEvaluationSource,
  SdlcReviewThreadGateStatus,
} from "../../db/types";
import type { SdlcGateLoopUpdateOutcome } from "./guarded-state";
import { persistGuardedGateLoopState } from "./guarded-state";

export type PersistSdlcReviewThreadGateResult = {
  runId: string;
  status: SdlcReviewThreadGateStatus;
  gatePassed: boolean;
  unresolvedThreadCount: number;
  shouldQueueFollowUp: boolean;
  loopUpdateOutcome: SdlcGateLoopUpdateOutcome;
};

export async function persistSdlcReviewThreadGateEvaluation({
  db,
  loopId,
  headSha,
  loopVersion,
  triggerEventType,
  evaluationSource,
  unresolvedThreadCount,
  timeoutMs,
  errorCode,
  idempotencyKey,
  now = new Date(),
}: {
  db: DB;
  loopId: string;
  headSha: string;
  loopVersion: number;
  triggerEventType:
    | "pull_request_review.submitted"
    | "pull_request_review_comment.created"
    | "review-thread-poll-synthetic";
  evaluationSource: SdlcReviewThreadEvaluationSource;
  unresolvedThreadCount: number;
  timeoutMs?: number | null;
  errorCode?: string | null;
  idempotencyKey?: string;
  now?: Date;
}): Promise<PersistSdlcReviewThreadGateResult> {
  return await db.transaction(async (tx) => {
    if (idempotencyKey) {
      const existing = await tx.query.sdlcReviewThreadGateRun.findFirst({
        where: eq(
          schema.sdlcReviewThreadGateRun.idempotencyKey,
          idempotencyKey,
        ),
      });
      if (existing) {
        return {
          runId: existing.id,
          status: existing.status,
          gatePassed: existing.gatePassed,
          unresolvedThreadCount: existing.unresolvedThreadCount,
          shouldQueueFollowUp: false,
          loopUpdateOutcome: "updated",
        };
      }
    }

    const hasTransientError = Boolean(errorCode);
    const gatePassed = !hasTransientError && unresolvedThreadCount === 0;
    const status: SdlcReviewThreadGateStatus = hasTransientError
      ? "transient_error"
      : gatePassed
        ? "passed"
        : "blocked";

    const [run] = await tx
      .insert(schema.sdlcReviewThreadGateRun)
      .values({
        loopId,
        headSha,
        loopVersion,
        status,
        gatePassed,
        evaluationSource,
        unresolvedThreadCount,
        timeoutMs: timeoutMs ?? null,
        triggerEventType,
        errorCode: errorCode ?? null,
        idempotencyKey: idempotencyKey ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          schema.sdlcReviewThreadGateRun.loopId,
          schema.sdlcReviewThreadGateRun.headSha,
        ],
        set: {
          loopVersion,
          status,
          gatePassed,
          evaluationSource,
          unresolvedThreadCount,
          timeoutMs: timeoutMs ?? null,
          triggerEventType,
          errorCode: errorCode ?? null,
          idempotencyKey: idempotencyKey ?? null,
          updatedAt: now,
        },
      })
      .returning({ id: schema.sdlcReviewThreadGateRun.id });

    if (!run) {
      throw new Error("Failed to persist review-thread gate run");
    }

    const loopUpdateOutcome = await persistGuardedGateLoopState({
      tx,
      loopId,
      headSha,
      loopVersion,
      transitionEvent: gatePassed
        ? "review_threads_gate_passed"
        : "review_threads_gate_blocked",
      blockedFromState: gatePassed ? null : "ci_gate",
      now,
    });

    return {
      runId: run.id,
      status,
      gatePassed,
      unresolvedThreadCount,
      shouldQueueFollowUp: !gatePassed && loopUpdateOutcome === "updated",
      loopUpdateOutcome,
    };
  });
}
