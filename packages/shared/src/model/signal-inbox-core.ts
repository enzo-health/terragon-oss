/**
 * Signal-inbox core: pure-DB signal processing functions extracted from
 * apps/www/src/server-lib/delivery-loop/signal-inbox.ts so that both the
 * production orchestrator and the E2E test can share the same code.
 *
 * ZERO Next.js dependencies — only drizzle-orm, schema, and delivery-loop.
 */

import {
  and,
  desc,
  eq,
  isNotNull,
  isNull,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";
import type { DB } from "../db";
import * as schema from "../db/schema";
import type { SdlcLoopCauseType, SdlcLoopState } from "../db/types";
import {
  buildPersistedDeliveryLoopSnapshot,
  getEffectiveDeliveryLoopPhase,
  persistSdlcCiGateEvaluation,
  persistSdlcReviewThreadGateEvaluation,
  type DeliveryLoopSnapshot,
} from "./delivery-loop";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PendingSignal = {
  id: string;
  causeType: SdlcLoopCauseType;
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

export type PersistedLoopPhaseContext = {
  snapshot: DeliveryLoopSnapshot;
  effectivePhase: ReturnType<typeof getEffectiveDeliveryLoopPhase>;
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

const feedbackSignalCauseTypes: ReadonlySet<SdlcLoopCauseType> = new Set([
  "daemon_terminal",
  "check_run.completed",
  "check_suite.completed",
  "pull_request_review",
  "pull_request_review_comment",
]);

export function classifySignalPolicy(
  causeType: SdlcLoopCauseType,
): SignalPolicy {
  const isFeedbackSignal = feedbackSignalCauseTypes.has(causeType);
  return {
    isFeedbackSignal,
    allowRoutingWithoutPrLink: causeType === "daemon_terminal",
    suppressPlanningRuntimeRouting: isFeedbackSignal,
  };
}

// ---------------------------------------------------------------------------
// Loop phase context
// ---------------------------------------------------------------------------

export function buildPersistedLoopPhaseContext(params: {
  state: SdlcLoopState;
  blockedFromState?: SdlcLoopState | null;
}): PersistedLoopPhaseContext {
  const snapshot = buildPersistedDeliveryLoopSnapshot({
    state: params.state,
    blockedFromState: params.blockedFromState,
  });
  return {
    snapshot,
    effectivePhase: getEffectiveDeliveryLoopPhase(snapshot),
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
}: {
  db: DB;
  loopId: string;
  claimToken: string;
  now: Date;
  staleClaimMs?: number;
}): Promise<PendingSignal | null> {
  const staleClaimCutoff = new Date(now.getTime() - staleClaimMs);
  const claimableWhere = and(
    eq(schema.sdlcLoopSignalInbox.loopId, loopId),
    isNull(schema.sdlcLoopSignalInbox.processedAt),
    or(
      isNull(schema.sdlcLoopSignalInbox.claimToken),
      lte(schema.sdlcLoopSignalInbox.claimedAt, staleClaimCutoff),
    ),
    or(
      ne(schema.sdlcLoopSignalInbox.causeType, "daemon_terminal"),
      and(
        eq(schema.sdlcLoopSignalInbox.causeType, "daemon_terminal"),
        isNotNull(schema.sdlcLoopSignalInbox.committedAt),
      ),
    ),
  );

  const signal = await db.query.sdlcLoopSignalInbox.findFirst({
    where: claimableWhere,
    orderBy: [
      sql`case when ${schema.sdlcLoopSignalInbox.causeType} = 'daemon_terminal' then 0 else 1 end`,
      schema.sdlcLoopSignalInbox.receivedAt,
    ],
  });
  if (!signal) {
    return null;
  }

  const [claimedSignal] = await db
    .update(schema.sdlcLoopSignalInbox)
    .set({
      claimToken,
      claimedAt: now,
    })
    .where(
      and(
        eq(schema.sdlcLoopSignalInbox.id, signal.id),
        isNull(schema.sdlcLoopSignalInbox.processedAt),
        or(
          isNull(schema.sdlcLoopSignalInbox.claimToken),
          lte(schema.sdlcLoopSignalInbox.claimedAt, staleClaimCutoff),
        ),
      ),
    )
    .returning({ id: schema.sdlcLoopSignalInbox.id });

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
    .update(schema.sdlcLoopSignalInbox)
    .set({
      claimedAt: params.now,
    })
    .where(
      and(
        eq(schema.sdlcLoopSignalInbox.id, params.signalId),
        eq(schema.sdlcLoopSignalInbox.claimToken, params.claimToken),
        isNull(schema.sdlcLoopSignalInbox.processedAt),
      ),
    )
    .returning({ id: schema.sdlcLoopSignalInbox.id });
  return Boolean(refreshedClaim);
}

export async function releaseSignalClaim(params: {
  db: DB;
  signalId: string;
  claimToken: string;
}): Promise<void> {
  await params.db
    .update(schema.sdlcLoopSignalInbox)
    .set({
      claimToken: null,
      claimedAt: null,
    })
    .where(
      and(
        eq(schema.sdlcLoopSignalInbox.id, params.signalId),
        eq(schema.sdlcLoopSignalInbox.claimToken, params.claimToken),
        isNull(schema.sdlcLoopSignalInbox.processedAt),
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
    .update(schema.sdlcLoopSignalInbox)
    .set({
      processedAt: params.now,
      claimToken: null,
      claimedAt: null,
    })
    .where(
      and(
        eq(schema.sdlcLoopSignalInbox.id, params.signalId),
        eq(schema.sdlcLoopSignalInbox.claimToken, params.claimToken),
        isNull(schema.sdlcLoopSignalInbox.processedAt),
      ),
    )
    .returning({ id: schema.sdlcLoopSignalInbox.id });
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
  const latestCiRun = await db.query.sdlcCiGateRun.findFirst({
    where: and(
      eq(schema.sdlcCiGateRun.loopId, loopId),
      eq(schema.sdlcCiGateRun.headSha, headSha),
    ),
    orderBy: [
      desc(schema.sdlcCiGateRun.updatedAt),
      desc(schema.sdlcCiGateRun.createdAt),
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
    db.query.sdlcCiGateRun.findFirst({
      where: and(
        eq(schema.sdlcCiGateRun.loopId, loopId),
        eq(schema.sdlcCiGateRun.headSha, headSha),
      ),
      orderBy: [
        desc(schema.sdlcCiGateRun.updatedAt),
        desc(schema.sdlcCiGateRun.createdAt),
      ],
      columns: {
        gatePassed: true,
        status: true,
      },
    }),
    db.query.sdlcReviewThreadGateRun.findFirst({
      where: and(
        eq(schema.sdlcReviewThreadGateRun.loopId, loopId),
        eq(schema.sdlcReviewThreadGateRun.headSha, headSha),
      ),
      orderBy: [
        desc(schema.sdlcReviewThreadGateRun.updatedAt),
        desc(schema.sdlcReviewThreadGateRun.createdAt),
      ],
      columns: {
        gatePassed: true,
        unresolvedThreadCount: true,
        status: true,
      },
    }),
    db
      .select({ id: schema.sdlcDeepReviewFinding.id })
      .from(schema.sdlcDeepReviewFinding)
      .where(
        and(
          eq(schema.sdlcDeepReviewFinding.loopId, loopId),
          eq(schema.sdlcDeepReviewFinding.headSha, headSha),
          eq(schema.sdlcDeepReviewFinding.isBlocking, true),
          isNull(schema.sdlcDeepReviewFinding.resolvedAt),
        ),
      ),
    db
      .select({ id: schema.sdlcCarmackReviewFinding.id })
      .from(schema.sdlcCarmackReviewFinding)
      .where(
        and(
          eq(schema.sdlcCarmackReviewFinding.loopId, loopId),
          eq(schema.sdlcCarmackReviewFinding.headSha, headSha),
          eq(schema.sdlcCarmackReviewFinding.isBlocking, true),
          isNull(schema.sdlcCarmackReviewFinding.resolvedAt),
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
// Gate persistence (orchestrates CI + review gate evaluation for a signal)
// ---------------------------------------------------------------------------

export async function persistGateEvaluationForSignal({
  db,
  loop,
  signal,
  now,
}: {
  db: DB;
  loop: {
    id: string;
    loopVersion: number;
    currentHeadSha: string | null;
    state: SdlcLoopState;
    blockedFromState: SdlcLoopState | null;
  };
  signal: PendingSignal;
  now: Date;
}): Promise<boolean> {
  const { effectivePhase: effectiveLoopPhase } = buildPersistedLoopPhaseContext(
    {
      state: loop.state,
      blockedFromState: loop.blockedFromState,
    },
  );

  if (signal.causeType === "daemon_terminal") {
    const daemonRunStatus = getPayloadText(signal.payload, "daemonRunStatus");
    if (daemonRunStatus === "stopped") {
      return false;
    }
    return true;
  }

  if (
    signal.causeType !== "check_run.completed" &&
    signal.causeType !== "check_suite.completed" &&
    signal.causeType !== "pull_request_review" &&
    signal.causeType !== "pull_request_review_comment"
  ) {
    return false;
  }

  const headSha =
    getPayloadText(signal.payload, "headSha") ?? loop.currentHeadSha;
  if (!headSha) {
    console.warn(
      "[sdlc-loop] skipping gate evaluation due to missing head sha",
      {
        loopId: loop.id,
        signalId: signal.id,
        causeType: signal.causeType,
      },
    );
    return false;
  }

  const loopVersion =
    typeof loop.loopVersion === "number" && Number.isFinite(loop.loopVersion)
      ? Math.max(loop.loopVersion, 0)
      : 0;

  if (
    signal.causeType === "check_run.completed" ||
    signal.causeType === "check_suite.completed"
  ) {
    const ciSnapshotSource = getPayloadText(signal.payload, "ciSnapshotSource");
    const ciSnapshotComplete = signal.payload?.ciSnapshotComplete === true;
    const ciSnapshotCheckNames = getPayloadStringArray(
      signal.payload,
      "ciSnapshotCheckNames",
    );
    const ciSnapshotFailingChecks = (
      getPayloadStringArray(signal.payload, "ciSnapshotFailingChecks") ?? []
    ).filter((checkName) => ciSnapshotCheckNames?.includes(checkName));

    const checkOutcome = getPayloadText(signal.payload, "checkOutcome");
    if (checkOutcome !== "pass" && checkOutcome !== "fail") {
      console.warn(
        "[sdlc-loop] skipping CI gate evaluation due to missing check outcome",
        {
          loopId: loop.id,
          signalId: signal.id,
          causeType: signal.causeType,
        },
      );
      return false;
    }

    if (checkOutcome === "pass") {
      if (
        ciSnapshotSource !== "github_check_runs" ||
        !ciSnapshotComplete ||
        !ciSnapshotCheckNames
      ) {
        console.warn(
          "[sdlc-loop] skipping CI gate optimistic pass without trusted complete snapshot",
          {
            loopId: loop.id,
            signalId: signal.id,
            causeType: signal.causeType,
            ciSnapshotSource,
            ciSnapshotComplete,
            ciSnapshotCheckCount: ciSnapshotCheckNames?.length ?? null,
          },
        );
        return false;
      }

      const priorRequiredChecks = await getPriorCiRequiredChecksForHead({
        db,
        loopId: loop.id,
        headSha,
      });
      if (!priorRequiredChecks) {
        console.warn(
          "[sdlc-loop] skipping CI gate optimistic pass without prior required-check baseline",
          {
            loopId: loop.id,
            signalId: signal.id,
            causeType: signal.causeType,
            headSha,
          },
        );
        return false;
      }
      const missingRequiredChecks = priorRequiredChecks.filter(
        (check) => !ciSnapshotCheckNames.includes(check),
      );
      if (missingRequiredChecks.length > 0) {
        console.warn(
          "[sdlc-loop] skipping CI gate optimistic pass due to incomplete required-check coverage",
          {
            loopId: loop.id,
            signalId: signal.id,
            causeType: signal.causeType,
            headSha,
            missingRequiredChecks,
            ciSnapshotCheckCount: ciSnapshotCheckNames.length,
          },
        );
        return false;
      }

      const evaluation = await persistSdlcCiGateEvaluation({
        db,
        loopId: loop.id,
        headSha,
        loopVersion,
        triggerEventType: signal.causeType,
        capabilityState: "supported",
        allowlistChecks: priorRequiredChecks,
        failingChecks: ciSnapshotFailingChecks,
        provenance: {
          source: "signal_inbox_ci_snapshot",
          signalId: signal.id,
          canonicalCauseId: signal.canonicalCauseId,
        },
        now,
      });
      return evaluation.shouldQueueFollowUp;
    }

    if (
      ciSnapshotSource === "github_check_runs" &&
      ciSnapshotComplete &&
      ciSnapshotCheckNames
    ) {
      const evaluation = await persistSdlcCiGateEvaluation({
        db,
        loopId: loop.id,
        headSha,
        loopVersion,
        triggerEventType: signal.causeType,
        capabilityState: "supported",
        allowlistChecks: ciSnapshotCheckNames,
        failingChecks: ciSnapshotFailingChecks,
        provenance: {
          source: "signal_inbox_ci_snapshot",
          signalId: signal.id,
          canonicalCauseId: signal.canonicalCauseId,
        },
        now,
      });
      return (
        evaluation.shouldQueueFollowUp || effectiveLoopPhase !== "babysitting"
      );
    }

    const requiredCheck = buildCiRequiredCheckFromSignalPayload(signal.payload);
    if (!requiredCheck) {
      console.warn(
        "[sdlc-loop] skipping CI gate evaluation due to missing check identity",
        {
          loopId: loop.id,
          signalId: signal.id,
          causeType: signal.causeType,
        },
      );
      return checkOutcome === "fail";
    }

    const evaluation = await persistSdlcCiGateEvaluation({
      db,
      loopId: loop.id,
      headSha,
      loopVersion,
      triggerEventType: signal.causeType,
      capabilityState: "supported",
      allowlistChecks: [requiredCheck],
      failingChecks: [requiredCheck],
      provenance: {
        source: "signal_inbox",
        signalId: signal.id,
        canonicalCauseId: signal.canonicalCauseId,
      },
      now,
    });
    return (
      evaluation.shouldQueueFollowUp || effectiveLoopPhase !== "babysitting"
    );
  }

  const unresolvedThreadCount = deriveReviewUnresolvedThreadCount({
    signal,
    payload: signal.payload,
  });
  if (unresolvedThreadCount === null) {
    console.warn(
      "[sdlc-loop] skipping review gate evaluation due to missing unresolved thread signal",
      {
        loopId: loop.id,
        signalId: signal.id,
        causeType: signal.causeType,
      },
    );
    return false;
  }

  if (unresolvedThreadCount === 0) {
    const unresolvedThreadCountSource = getPayloadText(
      signal.payload,
      "unresolvedThreadCountSource",
    );
    if (unresolvedThreadCountSource !== "github_graphql") {
      console.warn(
        "[sdlc-loop] skipping review gate optimistic pass without authoritative unresolved-thread source",
        {
          loopId: loop.id,
          signalId: signal.id,
          causeType: signal.causeType,
          unresolvedThreadCountSource,
        },
      );
      return false;
    }
  }

  const evaluation = await persistSdlcReviewThreadGateEvaluation({
    db,
    loopId: loop.id,
    headSha,
    loopVersion,
    triggerEventType:
      signal.causeType === "pull_request_review"
        ? "pull_request_review.submitted"
        : "pull_request_review_comment.created",
    evaluationSource: "webhook",
    unresolvedThreadCount,
    now,
  });
  return (
    evaluation.shouldQueueFollowUp ||
    (unresolvedThreadCount > 0 && effectiveLoopPhase !== "babysitting")
  );
}
