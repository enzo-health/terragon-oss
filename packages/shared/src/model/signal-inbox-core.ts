/**
 * Signal-inbox core: pure-DB signal processing functions extracted from
 * apps/www/src/server-lib/delivery-loop/signal-inbox.ts so that both the
 * production orchestrator and the E2E test can share the same code.
 *
 * ZERO Next.js dependencies — only drizzle-orm and schema.
 */

import {
  and,
  desc,
  eq,
  isNotNull,
  isNull,
  lte,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import type { DB } from "../db";
import * as schema from "../db/schema";
import type { DeliveryLoopCauseType } from "../db/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PendingSignal = {
  id: string;
  causeType: DeliveryLoopCauseType;
  canonicalCauseId: string;
  payload: Record<string, unknown> | null;
  receivedAt: Date;
  claimToken: string;
};

export type BabysitCompletionResult = {
  requiredCiPassed: boolean;
  unresolvedReviewThreads: number;
  unresolvedDeepBlockers: number;
  unresolvedCarmackBlockers: number;
  allRequiredGatesPassed: boolean;
};

export type SignalPolicy = {
  isFeedbackSignal: boolean;
  allowRoutingWithoutPrLink: boolean;
  suppressPlanningRuntimeRouting: boolean;
};

// ---------------------------------------------------------------------------
// Payload helpers (pure)
// ---------------------------------------------------------------------------

export function getPayloadText(
  payload: Record<string, unknown> | null,
  key: string,
): string | null {
  if (!payload) {
    return null;
  }
  const value = payload[key];
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function getPayloadNonNegativeInteger(
  payload: Record<string, unknown> | null,
  key: string,
): number | null {
  if (!payload) {
    return null;
  }
  const value = payload[key];
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.trunc(value);
  }
  return null;
}

export function getPayloadStringArray(
  payload: Record<string, unknown> | null,
  key: string,
): string[] | null {
  if (!payload) {
    return null;
  }
  const rawValue = payload[key];
  if (!Array.isArray(rawValue)) {
    return null;
  }

  const values = Array.from(
    new Set(
      rawValue
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    ),
  ).sort((a, b) => a.localeCompare(b));

  return values.length > 0 ? values : null;
}

// ---------------------------------------------------------------------------
// Signal classification
// ---------------------------------------------------------------------------

const feedbackSignalCauseTypes: ReadonlySet<DeliveryLoopCauseType> = new Set([
  "daemon_terminal",
  "check_run.completed",
  "check_suite.completed",
  "pull_request_review",
  "pull_request_review_comment",
]);

export function classifySignalPolicy(
  causeType: DeliveryLoopCauseType,
): SignalPolicy {
  const isFeedbackSignal = feedbackSignalCauseTypes.has(causeType);
  return {
    isFeedbackSignal,
    allowRoutingWithoutPrLink: causeType === "daemon_terminal",
    suppressPlanningRuntimeRouting: isFeedbackSignal,
  };
}

// ---------------------------------------------------------------------------
// CI check helpers
// ---------------------------------------------------------------------------

export function buildCiRequiredCheckFromSignalPayload(
  payload: Record<string, unknown> | null,
): string | null {
  const checkName = getPayloadText(payload, "checkName");
  if (checkName) {
    return checkName;
  }
  const checkSuiteId = getPayloadText(payload, "checkSuiteId");
  if (checkSuiteId) {
    return `check-suite:${checkSuiteId}`;
  }
  return null;
}

export function deriveReviewUnresolvedThreadCount({
  signal,
  payload,
}: {
  signal: PendingSignal;
  payload: Record<string, unknown> | null;
}): number | null {
  const explicitCount = getPayloadNonNegativeInteger(
    payload,
    "unresolvedThreadCount",
  );
  if (explicitCount !== null) {
    return explicitCount;
  }

  if (signal.causeType === "pull_request_review_comment") {
    return 1;
  }

  const reviewState = getPayloadText(payload, "reviewState")?.toLowerCase();
  if (reviewState === "approved") {
    return 0;
  }
  if (reviewState === "changes_requested") {
    return 1;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Signal claim lifecycle (DB operations)
// ---------------------------------------------------------------------------

const DEFAULT_STALE_CLAIM_MS = 60_000;

export async function claimNextUnprocessedSignal({
  db,
  loopId,
  claimToken,
  now,
  staleClaimMs = DEFAULT_STALE_CLAIM_MS,
  excludeIds,
}: {
  db: DB;
  loopId: string;
  claimToken: string;
  now: Date;
  staleClaimMs?: number;
  /** Signal IDs to skip (e.g. retryable signals already seen this tick). */
  excludeIds?: ReadonlySet<string>;
}): Promise<PendingSignal | null> {
  const staleClaimCutoff = new Date(now.getTime() - staleClaimMs);
  const excludeArray = excludeIds?.size ? [...excludeIds] : null;
  const claimableWhere = and(
    eq(schema.deliverySignalInbox.loopId, loopId),
    isNull(schema.deliverySignalInbox.processedAt),
    isNull(schema.deliverySignalInbox.deadLetteredAt),
    or(
      isNull(schema.deliverySignalInbox.claimToken),
      lte(schema.deliverySignalInbox.claimedAt, staleClaimCutoff),
    ),
    or(
      ne(schema.deliverySignalInbox.causeType, "daemon_terminal"),
      and(
        eq(schema.deliverySignalInbox.causeType, "daemon_terminal"),
        isNotNull(schema.deliverySignalInbox.committedAt),
      ),
    ),
    ...(excludeArray
      ? [notInArray(schema.deliverySignalInbox.id, excludeArray)]
      : []),
  );

  const signal = await db.query.deliverySignalInbox.findFirst({
    where: claimableWhere,
    orderBy: [
      sql`case when ${schema.deliverySignalInbox.causeType} = 'daemon_terminal' then 0 else 1 end`,
      schema.deliverySignalInbox.receivedAt,
    ],
  });
  if (!signal) {
    return null;
  }

  const [claimedSignal] = await db
    .update(schema.deliverySignalInbox)
    .set({
      claimToken,
      claimedAt: now,
    })
    .where(
      and(
        eq(schema.deliverySignalInbox.id, signal.id),
        isNull(schema.deliverySignalInbox.processedAt),
        or(
          isNull(schema.deliverySignalInbox.claimToken),
          lte(schema.deliverySignalInbox.claimedAt, staleClaimCutoff),
        ),
      ),
    )
    .returning({ id: schema.deliverySignalInbox.id });

  if (!claimedSignal) {
    return null;
  }

  return {
    id: claimedSignal.id,
    causeType: signal.causeType,
    canonicalCauseId: signal.canonicalCauseId,
    payload: signal.payload ?? null,
    receivedAt: signal.receivedAt,
    claimToken,
  };
}

export async function refreshSignalClaim(params: {
  db: DB;
  signalId: string;
  claimToken: string;
  now: Date;
}): Promise<boolean> {
  const [refreshedClaim] = await params.db
    .update(schema.deliverySignalInbox)
    .set({
      claimedAt: params.now,
    })
    .where(
      and(
        eq(schema.deliverySignalInbox.id, params.signalId),
        eq(schema.deliverySignalInbox.claimToken, params.claimToken),
        isNull(schema.deliverySignalInbox.processedAt),
      ),
    )
    .returning({ id: schema.deliverySignalInbox.id });
  return Boolean(refreshedClaim);
}

export async function releaseSignalClaim(params: {
  db: DB;
  signalId: string;
  claimToken: string;
}): Promise<void> {
  await params.db
    .update(schema.deliverySignalInbox)
    .set({
      claimToken: null,
      claimedAt: null,
    })
    .where(
      and(
        eq(schema.deliverySignalInbox.id, params.signalId),
        eq(schema.deliverySignalInbox.claimToken, params.claimToken),
        isNull(schema.deliverySignalInbox.processedAt),
      ),
    );
}

export async function completeSignalClaim(params: {
  db: DB;
  signalId: string;
  claimToken: string;
  now: Date;
}): Promise<boolean> {
  const [markedProcessed] = await params.db
    .update(schema.deliverySignalInbox)
    .set({
      processedAt: params.now,
      claimToken: null,
      claimedAt: null,
    })
    .where(
      and(
        eq(schema.deliverySignalInbox.id, params.signalId),
        eq(schema.deliverySignalInbox.claimToken, params.claimToken),
        isNull(schema.deliverySignalInbox.processedAt),
      ),
    )
    .returning({ id: schema.deliverySignalInbox.id });
  return Boolean(markedProcessed);
}

// ---------------------------------------------------------------------------
// Gate evaluation queries
// ---------------------------------------------------------------------------

export async function getPriorCiRequiredChecksForHead({
  db,
  loopId,
  headSha,
}: {
  db: DB;
  loopId: string;
  headSha: string;
}): Promise<string[] | null> {
  const latestCiRun = await db.query.deliveryCiGateRun.findFirst({
    where: and(
      eq(schema.deliveryCiGateRun.loopId, loopId),
      eq(schema.deliveryCiGateRun.headSha, headSha),
    ),
    orderBy: [
      desc(schema.deliveryCiGateRun.updatedAt),
      desc(schema.deliveryCiGateRun.createdAt),
    ],
    columns: {
      requiredChecks: true,
    },
  });

  const requiredChecks = Array.from(
    new Set(
      (latestCiRun?.requiredChecks ?? [])
        .filter((check): check is string => typeof check === "string")
        .map((check) => check.trim())
        .filter((check) => check.length > 0),
    ),
  ).sort((a, b) => a.localeCompare(b));

  return requiredChecks.length > 0 ? requiredChecks : null;
}

export async function evaluateBabysitCompletionForHead({
  db,
  loopId,
  headSha,
}: {
  db: DB;
  loopId: string;
  headSha: string;
}): Promise<BabysitCompletionResult> {
  const [
    latestCiRun,
    latestReviewRun,
    unresolvedDeepFindings,
    unresolvedCarmackFindings,
  ] = await Promise.all([
    db.query.deliveryCiGateRun.findFirst({
      where: and(
        eq(schema.deliveryCiGateRun.loopId, loopId),
        eq(schema.deliveryCiGateRun.headSha, headSha),
      ),
      orderBy: [
        desc(schema.deliveryCiGateRun.updatedAt),
        desc(schema.deliveryCiGateRun.createdAt),
      ],
      columns: {
        gatePassed: true,
        status: true,
      },
    }),
    db.query.deliveryReviewThreadGateRun.findFirst({
      where: and(
        eq(schema.deliveryReviewThreadGateRun.loopId, loopId),
        eq(schema.deliveryReviewThreadGateRun.headSha, headSha),
      ),
      orderBy: [
        desc(schema.deliveryReviewThreadGateRun.updatedAt),
        desc(schema.deliveryReviewThreadGateRun.createdAt),
      ],
      columns: {
        gatePassed: true,
        unresolvedThreadCount: true,
        status: true,
      },
    }),
    db
      .select({ id: schema.deliveryDeepReviewFinding.id })
      .from(schema.deliveryDeepReviewFinding)
      .where(
        and(
          eq(schema.deliveryDeepReviewFinding.loopId, loopId),
          eq(schema.deliveryDeepReviewFinding.headSha, headSha),
          eq(schema.deliveryDeepReviewFinding.isBlocking, true),
          isNull(schema.deliveryDeepReviewFinding.resolvedAt),
        ),
      ),
    db
      .select({ id: schema.deliveryCarmackReviewFinding.id })
      .from(schema.deliveryCarmackReviewFinding)
      .where(
        and(
          eq(schema.deliveryCarmackReviewFinding.loopId, loopId),
          eq(schema.deliveryCarmackReviewFinding.headSha, headSha),
          eq(schema.deliveryCarmackReviewFinding.isBlocking, true),
          isNull(schema.deliveryCarmackReviewFinding.resolvedAt),
        ),
      ),
  ]);

  const hasDeepReviewBlocker = unresolvedDeepFindings.length > 0;
  const hasCarmackReviewBlocker = unresolvedCarmackFindings.length > 0;
  const unresolvedReviewThreads = latestReviewRun?.unresolvedThreadCount ?? 0;
  const requiredCiPassed = Boolean(latestCiRun?.gatePassed);
  const unresolvedDeepBlockers = unresolvedDeepFindings.length;
  const unresolvedCarmackBlockers = unresolvedCarmackFindings.length;

  const allRequiredGatesPassed =
    requiredCiPassed &&
    Boolean(latestReviewRun?.gatePassed) &&
    unresolvedReviewThreads === 0 &&
    !hasDeepReviewBlocker &&
    !hasCarmackReviewBlocker;

  return {
    requiredCiPassed,
    unresolvedReviewThreads,
    unresolvedDeepBlockers,
    unresolvedCarmackBlockers,
    allRequiredGatesPassed,
  };
}

// ---------------------------------------------------------------------------
// Gate persistence — REMOVED
// persistGateEvaluationForSignal was removed with the v1 delivery loop table drop.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Dead Letter Queue
// ---------------------------------------------------------------------------

const MAX_SIGNAL_PROCESSING_ATTEMPTS = 5;

export function shouldDeadLetterSignal(attemptCount: number): boolean {
  return attemptCount >= MAX_SIGNAL_PROCESSING_ATTEMPTS;
}

export async function deferSignalProcessing(params: {
  db: DB;
  signalId: string;
  claimToken: string;
  error: string;
  baseBackoffMs?: number;
  now?: Date;
}): Promise<{ deferred: boolean; attemptCount: number }> {
  const [updated] = await params.db
    .update(schema.deliverySignalInbox)
    .set({
      claimToken: null,
      claimedAt: null,
      processingAttemptCount: sql`${schema.deliverySignalInbox.processingAttemptCount} + 1`,
      lastProcessingError: params.error,
    })
    .where(
      and(
        eq(schema.deliverySignalInbox.id, params.signalId),
        eq(schema.deliverySignalInbox.claimToken, params.claimToken),
        isNull(schema.deliverySignalInbox.processedAt),
      ),
    )
    .returning({
      id: schema.deliverySignalInbox.id,
      processingAttemptCount: schema.deliverySignalInbox.processingAttemptCount,
    });

  if (!updated) {
    return { deferred: false, attemptCount: 0 };
  }
  return { deferred: true, attemptCount: updated.processingAttemptCount };
}

export async function deadLetterSignal(params: {
  db: DB;
  signalId: string;
  claimToken: string;
  reason: string;
  now?: Date;
}): Promise<boolean> {
  const now = params.now ?? new Date();
  const [updated] = await params.db
    .update(schema.deliverySignalInbox)
    .set({
      deadLetteredAt: now,
      deadLetterReason: params.reason,
      processedAt: now,
    })
    .where(
      and(
        eq(schema.deliverySignalInbox.id, params.signalId),
        eq(schema.deliverySignalInbox.claimToken, params.claimToken),
        isNull(schema.deliverySignalInbox.processedAt),
      ),
    )
    .returning({ id: schema.deliverySignalInbox.id });
  return Boolean(updated);
}
