import {
  and,
  eq,
  inArray,
  isNull,
  lte,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { DB } from "../../db";
import * as schema from "../../db/schema";
import type {
  SdlcLoopOutboxActionType,
  SdlcLoopOutboxSupersessionGroup,
  SdlcVideoFailureClass,
  SdlcOutboxAttemptStatus,
} from "../../db/types";
import { persistGuardedGateLoopState } from "./guarded-state";
import { getSdlcOutboxSupersessionGroup } from "./legacy-transitions";

export async function transitionLoopToStoppedAndCancelPendingOutbox({
  db,
  loopId,
  stopReason,
}: {
  db: DB;
  loopId: string;
  stopReason: string;
}) {
  return await db.transaction(async (tx) => {
    const stopTransitionOutcome = await persistGuardedGateLoopState({
      tx,
      loopId,
      transitionEvent: "manual_stop",
      now: new Date(),
    });
    if (stopTransitionOutcome === "updated") {
      await tx
        .update(schema.sdlcLoop)
        .set({
          stopReason,
          updatedAt: new Date(),
        })
        .where(eq(schema.sdlcLoop.id, loopId));
    }

    const canceled = await tx
      .update(schema.sdlcLoopOutbox)
      .set({
        status: "canceled",
        canceledReason: "canceled_due_to_stop",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.sdlcLoopOutbox.loopId, loopId),
          inArray(schema.sdlcLoopOutbox.status, ["pending", "running"]),
        ),
      )
      .returning({ id: schema.sdlcLoopOutbox.id });

    return {
      canceledOutboxCount: canceled.length,
    };
  });
}

const SDLC_OUTBOX_DEFAULT_MAX_ATTEMPTS = 5;
const SDLC_OUTBOX_DEFAULT_BASE_BACKOFF_MS = 30_000;
const SDLC_OUTBOX_DEFAULT_MAX_BACKOFF_MS = 30 * 60_000;

export type SdlcOutboxErrorClass = SdlcVideoFailureClass | "unknown";

export type EnqueueSdlcOutboxActionResult = {
  outboxId: string;
  supersededOutboxCount: number;
};

export async function enqueueSdlcOutboxAction({
  db,
  loopId,
  transitionSeq,
  actionType,
  actionKey,
  payload,
  now = new Date(),
}: {
  db: DB;
  loopId: string;
  transitionSeq: number;
  actionType: SdlcLoopOutboxActionType;
  actionKey: string;
  payload: Record<string, unknown>;
  now?: Date;
}): Promise<EnqueueSdlcOutboxActionResult> {
  return await db.transaction(async (tx) => {
    const supersessionGroup = getSdlcOutboxSupersessionGroup(actionType);

    const [outboxRow] = await tx
      .insert(schema.sdlcLoopOutbox)
      .values({
        loopId,
        transitionSeq,
        actionType,
        supersessionGroup,
        actionKey,
        payload,
        status: "pending",
        attemptCount: 0,
        nextRetryAt: null,
        lastErrorClass: null,
        lastErrorCode: null,
        lastErrorMessage: null,
        supersededByOutboxId: null,
        canceledReason: null,
        claimedBy: null,
        claimedAt: null,
        completedAt: null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [schema.sdlcLoopOutbox.loopId, schema.sdlcLoopOutbox.actionKey],
        set: {
          transitionSeq,
          actionType,
          supersessionGroup,
          payload,
          status: "pending",
          attemptCount: 0,
          nextRetryAt: null,
          lastErrorClass: null,
          lastErrorCode: null,
          lastErrorMessage: null,
          supersededByOutboxId: null,
          canceledReason: null,
          claimedBy: null,
          claimedAt: null,
          completedAt: null,
          updatedAt: now,
        },
      })
      .returning({
        id: schema.sdlcLoopOutbox.id,
        transitionSeq: schema.sdlcLoopOutbox.transitionSeq,
        supersessionGroup: schema.sdlcLoopOutbox.supersessionGroup,
      });

    if (!outboxRow) {
      throw new Error("Failed to enqueue SDLC outbox action");
    }

    const supersededRows = await tx
      .update(schema.sdlcLoopOutbox)
      .set({
        status: "canceled",
        canceledReason: "superseded_by_newer_transition",
        supersededByOutboxId: outboxRow.id,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.sdlcLoopOutbox.loopId, loopId),
          eq(
            schema.sdlcLoopOutbox.supersessionGroup,
            outboxRow.supersessionGroup,
          ),
          lte(schema.sdlcLoopOutbox.transitionSeq, outboxRow.transitionSeq),
          inArray(schema.sdlcLoopOutbox.status, ["pending", "running"]),
          notInArray(schema.sdlcLoopOutbox.id, [outboxRow.id]),
        ),
      )
      .returning({ id: schema.sdlcLoopOutbox.id });

    return {
      outboxId: outboxRow.id,
      supersededOutboxCount: supersededRows.length,
    };
  });
}

export type ClaimedSdlcOutboxAction = {
  id: string;
  loopId: string;
  transitionSeq: number;
  actionType: SdlcLoopOutboxActionType;
  supersessionGroup: SdlcLoopOutboxSupersessionGroup;
  actionKey: string;
  payload: Record<string, unknown>;
  attemptCount: number;
};

export async function claimNextSdlcOutboxActionForExecution({
  db,
  loopId,
  leaseOwner,
  leaseEpoch,
  allowedActionTypes,
  now = new Date(),
}: {
  db: DB;
  loopId: string;
  leaseOwner: string;
  leaseEpoch: number;
  allowedActionTypes?: SdlcLoopOutboxActionType[];
  now?: Date;
}): Promise<ClaimedSdlcOutboxAction | null> {
  return await db.transaction(async (tx) => {
    const lease = await tx.query.sdlcLoopLease.findFirst({
      where: eq(schema.sdlcLoopLease.loopId, loopId),
    });

    if (
      !lease ||
      lease.leaseOwner !== leaseOwner ||
      lease.leaseEpoch !== leaseEpoch ||
      !lease.leaseExpiresAt ||
      lease.leaseExpiresAt <= now
    ) {
      return null;
    }

    const candidateWhere =
      allowedActionTypes && allowedActionTypes.length > 0
        ? and(
            eq(schema.sdlcLoopOutbox.loopId, loopId),
            eq(schema.sdlcLoopOutbox.status, "pending"),
            inArray(schema.sdlcLoopOutbox.actionType, allowedActionTypes),
            or(
              isNull(schema.sdlcLoopOutbox.nextRetryAt),
              lte(schema.sdlcLoopOutbox.nextRetryAt, now),
            ),
          )
        : and(
            eq(schema.sdlcLoopOutbox.loopId, loopId),
            eq(schema.sdlcLoopOutbox.status, "pending"),
            or(
              isNull(schema.sdlcLoopOutbox.nextRetryAt),
              lte(schema.sdlcLoopOutbox.nextRetryAt, now),
            ),
          );

    const candidate = await tx.query.sdlcLoopOutbox.findFirst({
      where: candidateWhere,
      orderBy: [
        schema.sdlcLoopOutbox.transitionSeq,
        schema.sdlcLoopOutbox.createdAt,
      ],
    });

    if (!candidate) {
      return null;
    }

    const [claimed] = await tx
      .update(schema.sdlcLoopOutbox)
      .set({
        status: "running",
        claimedBy: leaseOwner,
        claimedAt: now,
        attemptCount: sql`${schema.sdlcLoopOutbox.attemptCount} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.sdlcLoopOutbox.id, candidate.id),
          eq(schema.sdlcLoopOutbox.status, "pending"),
        ),
      )
      .returning({
        id: schema.sdlcLoopOutbox.id,
        loopId: schema.sdlcLoopOutbox.loopId,
        transitionSeq: schema.sdlcLoopOutbox.transitionSeq,
        actionType: schema.sdlcLoopOutbox.actionType,
        supersessionGroup: schema.sdlcLoopOutbox.supersessionGroup,
        actionKey: schema.sdlcLoopOutbox.actionKey,
        payload: schema.sdlcLoopOutbox.payload,
        attemptCount: schema.sdlcLoopOutbox.attemptCount,
      });

    if (!claimed) {
      return null;
    }

    return {
      id: claimed.id,
      loopId: claimed.loopId,
      transitionSeq: claimed.transitionSeq,
      actionType: claimed.actionType,
      supersessionGroup: claimed.supersessionGroup,
      actionKey: claimed.actionKey,
      payload: claimed.payload,
      attemptCount: claimed.attemptCount,
    };
  });
}

function getSdlcOutboxRetryDelayMs({
  attempt,
  baseBackoffMs,
  maxBackoffMs,
}: {
  attempt: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
}) {
  const exponent = Math.max(0, attempt - 1);
  return Math.min(maxBackoffMs, baseBackoffMs * 2 ** exponent);
}

export type CompleteSdlcOutboxActionResult =
  | {
      updated: true;
      status: "completed";
      retryAt: null;
      attempt: number;
    }
  | {
      updated: true;
      status: "pending" | "failed";
      retryAt: Date | null;
      attempt: number;
    }
  | {
      updated: false;
      reason: "not_running_or_not_owner" | "not_found";
    };

export function normalizeOutboxErrorMessage(
  errorMessage: string | null,
): string | null {
  if (!errorMessage) {
    return null;
  }
  const trimmed = errorMessage.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 1000) : null;
}

async function recordSdlcOutboxAttempt({
  tx,
  outboxId,
  loopId,
  actionType,
  attempt,
  status,
  errorClass,
  errorCode,
  errorMessage,
  retryAt,
}: {
  tx: Pick<DB, "insert">;
  outboxId: string;
  loopId: string;
  actionType: SdlcLoopOutboxActionType;
  attempt: number;
  status: SdlcOutboxAttemptStatus;
  errorClass: SdlcOutboxErrorClass | null;
  errorCode: string | null;
  errorMessage: string | null;
  retryAt: Date | null;
}) {
  await tx.insert(schema.sdlcLoopOutboxAttempt).values({
    outboxId,
    loopId,
    actionType,
    attempt,
    status,
    errorClass,
    errorCode,
    errorMessage: normalizeOutboxErrorMessage(errorMessage),
    retryAt,
  });
}

export async function completeSdlcOutboxActionExecution({
  db,
  outboxId,
  leaseOwner,
  succeeded,
  retriable = false,
  errorClass = null,
  errorCode = null,
  errorMessage = null,
  maxAttempts = SDLC_OUTBOX_DEFAULT_MAX_ATTEMPTS,
  baseBackoffMs = SDLC_OUTBOX_DEFAULT_BASE_BACKOFF_MS,
  maxBackoffMs = SDLC_OUTBOX_DEFAULT_MAX_BACKOFF_MS,
  now = new Date(),
}: {
  db: DB;
  outboxId: string;
  leaseOwner: string;
  succeeded: boolean;
  retriable?: boolean;
  errorClass?: SdlcOutboxErrorClass | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  maxAttempts?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  now?: Date;
}): Promise<CompleteSdlcOutboxActionResult> {
  return await db.transaction(async (tx) => {
    const row = await tx.query.sdlcLoopOutbox.findFirst({
      where: eq(schema.sdlcLoopOutbox.id, outboxId),
    });

    if (!row) {
      return { updated: false, reason: "not_found" };
    }

    if (row.status !== "running" || row.claimedBy !== leaseOwner) {
      return { updated: false, reason: "not_running_or_not_owner" };
    }

    const attempt = row.attemptCount;

    if (succeeded) {
      await tx
        .update(schema.sdlcLoopOutbox)
        .set({
          status: "completed",
          completedAt: now,
          claimedBy: null,
          claimedAt: null,
          nextRetryAt: null,
          updatedAt: now,
        })
        .where(eq(schema.sdlcLoopOutbox.id, outboxId));

      await recordSdlcOutboxAttempt({
        tx,
        outboxId,
        loopId: row.loopId,
        actionType: row.actionType,
        attempt,
        status: "completed",
        errorClass: null,
        errorCode: null,
        errorMessage: null,
        retryAt: null,
      });

      return {
        updated: true,
        status: "completed",
        retryAt: null,
        attempt,
      };
    }

    const shouldRetry = retriable && attempt < maxAttempts;
    const retryAt = shouldRetry
      ? new Date(
          now.getTime() +
            getSdlcOutboxRetryDelayMs({
              attempt,
              baseBackoffMs,
              maxBackoffMs,
            }),
        )
      : null;
    const nextStatus: "pending" | "failed" = shouldRetry ? "pending" : "failed";

    await tx
      .update(schema.sdlcLoopOutbox)
      .set({
        status: nextStatus,
        claimedBy: null,
        claimedAt: null,
        nextRetryAt: retryAt,
        lastErrorClass: errorClass,
        lastErrorCode: errorCode,
        lastErrorMessage: normalizeOutboxErrorMessage(errorMessage),
        updatedAt: now,
      })
      .where(eq(schema.sdlcLoopOutbox.id, outboxId));

    await recordSdlcOutboxAttempt({
      tx,
      outboxId,
      loopId: row.loopId,
      actionType: row.actionType,
      attempt,
      status: shouldRetry ? "retry_scheduled" : "failed",
      errorClass,
      errorCode,
      errorMessage,
      retryAt,
    });

    return {
      updated: true,
      status: nextStatus,
      retryAt,
      attempt,
    };
  });
}

export async function persistSdlcCanonicalStatusCommentReference({
  db,
  loopId,
  commentId,
  commentNodeId,
  now = new Date(),
}: {
  db: DB;
  loopId: string;
  commentId: string;
  commentNodeId?: string | null;
  now?: Date;
}) {
  const [updated] = await db
    .update(schema.sdlcLoop)
    .set({
      canonicalStatusCommentId: commentId,
      canonicalStatusCommentNodeId: commentNodeId ?? null,
      canonicalStatusCommentUpdatedAt: now,
      updatedAt: now,
    })
    .where(eq(schema.sdlcLoop.id, loopId))
    .returning();

  return updated;
}

export async function clearSdlcCanonicalStatusCommentReference({
  db,
  loopId,
  now = new Date(),
}: {
  db: DB;
  loopId: string;
  now?: Date;
}) {
  const [updated] = await db
    .update(schema.sdlcLoop)
    .set({
      canonicalStatusCommentId: null,
      canonicalStatusCommentNodeId: null,
      canonicalStatusCommentUpdatedAt: now,
      updatedAt: now,
    })
    .where(eq(schema.sdlcLoop.id, loopId))
    .returning();

  return updated;
}

export async function persistSdlcCanonicalCheckRunReference({
  db,
  loopId,
  checkRunId,
  now = new Date(),
}: {
  db: DB;
  loopId: string;
  checkRunId: number;
  now?: Date;
}) {
  const [updated] = await db
    .update(schema.sdlcLoop)
    .set({
      canonicalCheckRunId: checkRunId,
      canonicalCheckRunUpdatedAt: now,
      updatedAt: now,
    })
    .where(eq(schema.sdlcLoop.id, loopId))
    .returning();

  return updated;
}
