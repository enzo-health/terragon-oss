import type { DBUserMessage } from "@terragon/shared";
import type { DB } from "@terragon/shared/db";
import * as schema from "@terragon/shared/db/schema";
import type {
  SdlcLoopCauseType,
  SdlcLoopState,
} from "@terragon/shared/db/types";
import {
  terminalSdlcLoopStateList,
  terminalSdlcLoopStateSet,
  acquireSdlcLoopLease,
  createBabysitEvaluationArtifactForHead,
  enqueueSdlcOutboxAction,
  evaluateSdlcLoopGuardrails,
  getLatestAcceptedArtifact,
  releaseSdlcLoopLease,
  transitionSdlcLoopState,
  transitionSdlcLoopStateWithArtifact,
  markPlanTasksCompletedByAgent,
  verifyPlanTaskCompletionForHead,
  type DeliveryLoopSnapshot,
  type SdlcGuardrailReasonCode,
} from "@terragon/shared/model/delivery-loop";
import {
  claimNextUnprocessedSignal,
  classifySignalPolicy,
  completeSignalClaim,
  refreshSignalClaim,
  releaseSignalClaim,
  evaluateBabysitCompletionForHead,
  persistGateEvaluationForSignal,
  getPayloadText,
  buildPersistedLoopPhaseContext,
  type PendingSignal,
  type SignalPolicy,
} from "@terragon/shared/model/signal-inbox-core";
import { getThread } from "@terragon/shared/model/threads";
import { getPrimaryThreadChat } from "@terragon/shared/utils/thread-utils";
import {
  and,
  eq,
  isNotNull,
  isNull,
  lte,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { queueFollowUpInternal } from "@/server-lib/follow-up";

import {
  type RuntimeActionOutcome,
  type RuntimeRoutingReason,
  type SdlcSignalInboxGuardrailRuntimeInput,
  buildDurableSignalInboxGuardrailRuntime,
  buildFeedbackFollowUpMessage,
  buildPublicationStatusBody,
  hasEquivalentRoutedFollowUp,
  resolveSignalInboxGuardrailInputs,
  resolveSignalTransitionSeq,
  shouldSuppressFeedbackRuntimeRouting,
  stringifyError,
} from "./signal-inbox-helpers";

/**
 * Schedule a background babysit recheck: poll GitHub CI and insert a
 * synthetic signal if checks completed. The 1-min cron drain will process it.
 */
async function scheduleBabysitRecheck(db: DB, loopId: string): Promise<void> {
  const { recheckBabysitCompletion } = await import(
    "@/server-lib/delivery-loop/babysit-recheck"
  );
  await recheckBabysitCompletion({ db, loopId });
}

/**
 * Schedule a background ci_gate recheck: poll GitHub CI and insert a
 * synthetic signal if checks completed or failed. The 1-min cron drain will process it.
 */
async function scheduleCiGateRecheck(db: DB, loopId: string): Promise<void> {
  const { recheckCiGateCompletion } = await import(
    "@/server-lib/delivery-loop/babysit-recheck"
  );
  await recheckCiGateCompletion({ db, loopId });
}

const SDLC_SIGNAL_INBOX_LEASE_TTL_MS = 30_000;
const SDLC_SIGNAL_INBOX_DURABLE_DRAIN_MAX_LOOPS = 20;
const SDLC_SIGNAL_INBOX_DURABLE_DRAIN_MAX_SIGNALS_TOTAL = 50;
const SDLC_SIGNAL_INBOX_DURABLE_DRAIN_MAX_SIGNALS_PER_LOOP = 5;
const SDLC_SIGNAL_INBOX_CLAIM_STALE_MS = 60_000;
const SDLC_SIGNAL_INBOX_CLAIM_HEARTBEAT_INTERVAL_MS = Math.max(
  5_000,
  Math.trunc(SDLC_SIGNAL_INBOX_CLAIM_STALE_MS / 3),
);
const SDLC_SIGNAL_INBOX_LEASE_HEARTBEAT_INTERVAL_MS = Math.max(
  5_000,
  Math.trunc(SDLC_SIGNAL_INBOX_LEASE_TTL_MS / 3),
);

type SignalGateEvaluationOutcome = {
  shouldQueueRuntimeFollowUp: boolean;
  gateEvaluated: boolean;
};

export type { SdlcSignalInboxGuardrailRuntimeInput } from "./signal-inbox-helpers";

export const SDLC_SIGNAL_INBOX_NOOP_FEEDBACK_FOLLOW_UP_ENQUEUE_FAILED =
  "feedback_follow_up_enqueue_failed";

export type SdlcSignalInboxTickNoopReason =
  | "loop_not_found"
  | "lease_held"
  | "no_unprocessed_signal"
  | "signal_claim_lost"
  | typeof SDLC_SIGNAL_INBOX_NOOP_FEEDBACK_FOLLOW_UP_ENQUEUE_FAILED
  | SdlcGuardrailReasonCode;

export type SdlcSignalInboxTickResult =
  | {
      processed: false;
      reason: SdlcSignalInboxTickNoopReason;
      runtimeRouting?: {
        routed: boolean;
        followUpQueued: boolean;
        reason: RuntimeRoutingReason;
        error: string | null;
      };
    }
  | {
      processed: true;
      signalId: string;
      causeType: SdlcLoopCauseType;
      runtimeAction: RuntimeActionOutcome;
      outboxId: string | null;
      feedbackQueuedMessage: DBUserMessage | null;
      runtimeRouting?: {
        routed: boolean;
        followUpQueued: boolean;
        reason: RuntimeRoutingReason;
        error: string | null;
      };
    };

export type SdlcDurableSignalInboxDrainResult = {
  dueLoopCount: number;
  visitedLoopCount: number;
  loopsWithProcessedSignals: number;
  processedSignalCount: number;
  reachedSignalLimit: boolean;
};

async function evaluateAndPersistGate(params: {
  db: DB;
  loop: {
    id: string;
    loopVersion: number;
    currentHeadSha: string | null;
    state: SdlcLoopState;
    blockedFromState: SdlcLoopState | null;
  };
  signal: PendingSignal;
  policy: SignalPolicy;
  now: Date;
}): Promise<SignalGateEvaluationOutcome> {
  if (!params.policy.isFeedbackSignal) {
    return {
      shouldQueueRuntimeFollowUp: false,
      gateEvaluated: false,
    };
  }
  const shouldQueueRuntimeFollowUp = await persistGateEvaluationForSignal({
    db: params.db,
    loop: params.loop,
    signal: params.signal,
    now: params.now,
  });
  return {
    shouldQueueRuntimeFollowUp,
    gateEvaluated: true,
  };
}

type SignalClaimLeaseHeartbeatStatus = "ok" | "claim_lost" | "lease_lost";

function mapSignalClaimLeaseHeartbeatStatusToNoopReason(
  status: Exclude<SignalClaimLeaseHeartbeatStatus, "ok">,
): SdlcSignalInboxTickNoopReason {
  return status === "claim_lost" ? "signal_claim_lost" : "lease_held";
}

function createSignalClaimLeaseHeartbeat(params: {
  db: DB;
  loopId: string;
  leaseOwner: string;
  signalId: string;
  claimToken: string;
}) {
  let lastLeaseRefreshAtMs = Date.now();
  let lastClaimRefreshAtMs = lastLeaseRefreshAtMs;

  return {
    async refreshIfDue(): Promise<SignalClaimLeaseHeartbeatStatus> {
      const nowMs = Date.now();
      let heartbeatNow: Date | null = null;

      if (
        nowMs - lastLeaseRefreshAtMs >=
        SDLC_SIGNAL_INBOX_LEASE_HEARTBEAT_INTERVAL_MS
      ) {
        heartbeatNow = new Date(nowMs);
        const refreshedLease = await acquireSdlcLoopLease({
          db: params.db,
          loopId: params.loopId,
          leaseOwner: params.leaseOwner,
          leaseTtlMs: SDLC_SIGNAL_INBOX_LEASE_TTL_MS,
          now: heartbeatNow,
        });
        if (!refreshedLease.acquired) {
          return "lease_lost";
        }
        lastLeaseRefreshAtMs = nowMs;
      }

      if (
        nowMs - lastClaimRefreshAtMs >=
        SDLC_SIGNAL_INBOX_CLAIM_HEARTBEAT_INTERVAL_MS
      ) {
        const claimRefreshNow = heartbeatNow ?? new Date(nowMs);
        const claimRefreshed = await refreshSignalClaim({
          db: params.db,
          signalId: params.signalId,
          claimToken: params.claimToken,
          now: claimRefreshNow,
        });
        if (!claimRefreshed) {
          return "claim_lost";
        }
        lastClaimRefreshAtMs = nowMs;
      }

      return "ok";
    },
  };
}

async function routeFeedbackSignalToEnrolledThread({
  db,
  loopId,
  loopUserId,
  loopThreadId,
  repoFullName,
  prNumber,
  loopSnapshot,
  signal,
  beforeEnqueue,
}: {
  db: DB;
  loopId: string;
  loopUserId: string;
  loopThreadId: string;
  repoFullName: string;
  prNumber: number | null;
  loopSnapshot: DeliveryLoopSnapshot;
  signal: PendingSignal;
  beforeEnqueue?: () => Promise<void>;
}) {
  const thread = await getThread({
    db,
    userId: loopUserId,
    threadId: loopThreadId,
  });
  if (!thread) {
    throw new Error(
      `Unable to route feedback signal ${signal.id}; loop thread is missing (${loopThreadId})`,
    );
  }

  const threadChat = getPrimaryThreadChat(thread);
  const message = buildFeedbackFollowUpMessage({
    loopRepoFullName: repoFullName,
    loopPrNumber: prNumber,
    loopSnapshot,
    signalCauseType: signal.causeType,
    payload: signal.payload,
  });

  const routingTarget = {
    loopId,
    threadId: loopThreadId,
    threadChatId: threadChat.id,
  };

  if (
    hasEquivalentRoutedFollowUp({
      queuedMessages: threadChat.queuedMessages,
      messages: threadChat.messages,
      candidate: message,
    })
  ) {
    return {
      ...routingTarget,
      didEnqueue: false,
      queuedMessage: null,
    };
  }

  if (beforeEnqueue) {
    await beforeEnqueue();
  }

  try {
    await queueFollowUpInternal({
      userId: loopUserId,
      threadId: loopThreadId,
      threadChatId: threadChat.id,
      messages: [message],
      appendOrReplace: "append",
      source: "github",
    });
  } catch (error) {
    const refreshedThread = await getThread({
      db,
      userId: loopUserId,
      threadId: loopThreadId,
    });
    const refreshedThreadChat = refreshedThread
      ? getPrimaryThreadChat(refreshedThread)
      : null;
    const alreadyQueued =
      refreshedThreadChat !== null &&
      hasEquivalentRoutedFollowUp({
        queuedMessages: refreshedThreadChat.queuedMessages,
        messages: refreshedThreadChat.messages,
        candidate: message,
      });
    if (!alreadyQueued) {
      throw error;
    }
    return {
      ...routingTarget,
      didEnqueue: false,
      queuedMessage: null,
    };
  }

  return {
    ...routingTarget,
    didEnqueue: true,
    queuedMessage: message,
  };
}

// ── Sub-functions for runBestEffortSdlcSignalInboxTick (Phase 3b) ──

/**
 * Handles daemon_terminal + implementing phase completion: auto-marks plan
 * tasks as done, transitions to review_gate, and returns updated phase context.
 */
async function handleImplementingPhaseCompletion({
  db,
  loopId,
  loop,
  signal,
  loopPhaseContext,
  gateEvaluationOutcome,
  now,
}: {
  db: DB;
  loopId: string;
  loop: { loopVersion: number; currentHeadSha: string | null };
  signal: PendingSignal;
  loopPhaseContext: ReturnType<typeof buildPersistedLoopPhaseContext>;
  gateEvaluationOutcome: SignalGateEvaluationOutcome;
  now: Date;
}): Promise<{
  loopPhaseContext: ReturnType<typeof buildPersistedLoopPhaseContext>;
  gateEvaluationOutcome: SignalGateEvaluationOutcome;
}> {
  if (
    signal.causeType !== "daemon_terminal" ||
    loopPhaseContext.effectivePhase !== "implementing" ||
    !gateEvaluationOutcome.shouldQueueRuntimeFollowUp
  ) {
    return { loopPhaseContext, gateEvaluationOutcome };
  }

  const daemonRunStatus = getPayloadText(signal.payload, "daemonRunStatus");
  if (daemonRunStatus !== "completed") {
    return { loopPhaseContext, gateEvaluationOutcome };
  }

  const headShaAtCompletion = getPayloadText(
    signal.payload,
    "headShaAtCompletion",
  );
  const effectiveHeadSha = headShaAtCompletion || loop.currentHeadSha || "";

  if (!effectiveHeadSha) {
    // No headSha — agent completed without pushing code.
    // Don't re-dispatch (no new info to act on), just log.
    console.log(
      "[sdlc-loop] implementing: agent completed without headSha — not re-dispatching",
      { loopId, signalId: signal.id },
    );
    return {
      loopPhaseContext,
      gateEvaluationOutcome: {
        ...gateEvaluationOutcome,
        shouldQueueRuntimeFollowUp: false,
      },
    };
  }

  const acceptedPlanArtifact = await getLatestAcceptedArtifact({
    db,
    loopId,
    phase: "planning",
    includeApprovedForPlanning: true,
  });

  if (acceptedPlanArtifact) {
    // Auto-mark any unmarked tasks — the agent ran and produced
    // commits, so treat all tasks as done. The MCP tool may have
    // already marked some; this catches the rest.
    const verified = await verifyPlanTaskCompletionForHead({
      db,
      loopId,
      artifactId: acceptedPlanArtifact.id,
      headSha: effectiveHeadSha,
    });

    const unmarkedTaskIds = [
      ...verified.incompleteTaskIds,
      ...verified.invalidEvidenceTaskIds,
    ];
    if (unmarkedTaskIds.length > 0) {
      console.log("[sdlc-loop] auto-marking unmarked tasks as complete", {
        loopId,
        signalId: signal.id,
        unmarkedTaskIds,
      });
      await markPlanTasksCompletedByAgent({
        db,
        loopId,
        artifactId: acceptedPlanArtifact.id,
        completions: unmarkedTaskIds.map((id) => ({
          stableTaskId: id,
          status: "done" as const,
          evidence: {
            headSha: effectiveHeadSha,
            note: "auto-marked on implementing completion",
          },
        })),
      });
    }
  }

  // Transition to review_gate — the checkpoint path runs the actual
  // review inline when the agent wakes up. Keep
  // shouldQueueRuntimeFollowUp=true so the follow-up routing below
  // dispatches the agent.
  await transitionSdlcLoopState({
    db,
    loopId,
    transitionEvent: "implementation_completed",
    headSha: effectiveHeadSha,
    loopVersion:
      typeof loop.loopVersion === "number" && Number.isFinite(loop.loopVersion)
        ? loop.loopVersion + 1
        : 1,
    now,
  });

  // Recompute phase context so the follow-up message reflects
  // review_gate, not the pre-transition implementing state.
  const postTransitionLoop = await db.query.sdlcLoop.findFirst({
    where: eq(schema.sdlcLoop.id, loopId),
    columns: {
      state: true,
      currentHeadSha: true,
      blockedFromState: true,
      prNumber: true,
    },
  });

  let updatedPhaseContext = loopPhaseContext;
  if (postTransitionLoop) {
    updatedPhaseContext = buildPersistedLoopPhaseContext({
      state: postTransitionLoop.state,
      blockedFromState: postTransitionLoop.blockedFromState,
    });
  }

  console.log(
    "[sdlc-loop] implementing complete — transitioned to review_gate, follow-up routing enabled",
    { loopId, signalId: signal.id, headSha: effectiveHeadSha },
  );

  return { loopPhaseContext: updatedPhaseContext, gateEvaluationOutcome };
}

/**
 * Routes feedback signal to the enrolled thread if eligible. Returns a
 * discriminated result indicating what happened.
 */
async function routeFeedbackIfEligible({
  db,
  loopId,
  loop,
  signal,
  signalPolicy,
  gateEvaluationOutcome,
  shouldSuppressFeedbackRuntimeAction,
  effectivePrNumber,
  loopPhaseContext,
  signalClaimLeaseHeartbeat,
  includeRuntimeRouting,
  runtimeRouting,
  now,
}: {
  db: DB;
  loopId: string;
  loop: {
    userId: string;
    threadId: string;
    repoFullName: string;
    loopVersion: number;
  };
  signal: PendingSignal;
  signalPolicy: SignalPolicy;
  gateEvaluationOutcome: SignalGateEvaluationOutcome;
  shouldSuppressFeedbackRuntimeAction: boolean;
  effectivePrNumber: number | null;
  loopPhaseContext: ReturnType<typeof buildPersistedLoopPhaseContext>;
  signalClaimLeaseHeartbeat: ReturnType<typeof createSignalClaimLeaseHeartbeat>;
  includeRuntimeRouting: boolean;
  runtimeRouting: {
    routed: boolean;
    followUpQueued: boolean;
    reason: RuntimeRoutingReason;
    error: string | null;
  };
  now: Date;
}): Promise<
  | {
      outcome: "routed";
      runtimeAction: RuntimeActionOutcome;
      feedbackQueuedMessage: DBUserMessage | null;
      runtimeRouting: typeof runtimeRouting;
    }
  | {
      outcome: "skipped";
      runtimeAction: RuntimeActionOutcome;
      feedbackQueuedMessage: null;
      runtimeRouting: typeof runtimeRouting;
    }
  | {
      outcome: "heartbeat_lost";
      noopResult: SdlcSignalInboxTickResult;
    }
  | {
      outcome: "enqueue_failed";
      noopResult: SdlcSignalInboxTickResult;
    }
> {
  const canRouteWithoutPrNumber = signalPolicy.allowRoutingWithoutPrLink;

  if (
    signalPolicy.isFeedbackSignal &&
    gateEvaluationOutcome.shouldQueueRuntimeFollowUp &&
    !shouldSuppressFeedbackRuntimeAction &&
    (typeof effectivePrNumber === "number" || canRouteWithoutPrNumber)
  ) {
    const preRoutingHeartbeat = await signalClaimLeaseHeartbeat.refreshIfDue();
    if (preRoutingHeartbeat !== "ok") {
      return {
        outcome: "heartbeat_lost",
        noopResult: {
          processed: false,
          reason:
            mapSignalClaimLeaseHeartbeatStatusToNoopReason(preRoutingHeartbeat),
        },
      };
    }

    try {
      const routeResult = await routeFeedbackSignalToEnrolledThread({
        db,
        loopId,
        loopUserId: loop.userId,
        loopThreadId: loop.threadId,
        repoFullName: loop.repoFullName,
        prNumber: effectivePrNumber,
        loopSnapshot: loopPhaseContext.snapshot,
        signal,
        beforeEnqueue: async () => {
          // Increment loopVersion immediately before enqueue so guardrail
          // iterationCount advances even if enqueue fails.
          await db
            .update(schema.sdlcLoop)
            .set({
              loopVersion: sql`${schema.sdlcLoop.loopVersion} + 1`,
              updatedAt: now,
            })
            .where(eq(schema.sdlcLoop.id, loopId));
        },
      });

      const updatedRouting = { ...runtimeRouting, routed: true };
      if (routeResult.didEnqueue) {
        return {
          outcome: "routed",
          runtimeAction: "feedback_follow_up_queued" as RuntimeActionOutcome,
          feedbackQueuedMessage: routeResult.queuedMessage,
          runtimeRouting: {
            ...updatedRouting,
            followUpQueued: true,
            reason: "follow_up_queued" as RuntimeRoutingReason,
          },
        };
      }
      return {
        outcome: "routed",
        runtimeAction: "none" as RuntimeActionOutcome,
        feedbackQueuedMessage: null,
        runtimeRouting: {
          ...updatedRouting,
          reason: "follow_up_deduped" as RuntimeRoutingReason,
        },
      };
    } catch (error) {
      console.error("[sdlc-loop] feedback runtime action failed", {
        loopId,
        signalId: signal.id,
        causeType: signal.causeType,
        error,
      });
      return {
        outcome: "enqueue_failed",
        noopResult: {
          processed: false,
          reason: SDLC_SIGNAL_INBOX_NOOP_FEEDBACK_FOLLOW_UP_ENQUEUE_FAILED,
          ...(includeRuntimeRouting
            ? {
                runtimeRouting: {
                  ...runtimeRouting,
                  reason: "follow_up_enqueue_failed" as RuntimeRoutingReason,
                  error: stringifyError(error),
                },
              }
            : {}),
        },
      };
    }
  }

  // Not routing — determine reason
  const updatedRouting = { ...runtimeRouting };
  if (
    signalPolicy.isFeedbackSignal &&
    gateEvaluationOutcome.shouldQueueRuntimeFollowUp &&
    shouldSuppressFeedbackRuntimeAction
  ) {
    updatedRouting.reason = "suppressed_for_loop_state";
    console.log(
      "[sdlc-loop] suppressing feedback runtime action outside PR babysitting phase",
      {
        loopId,
        signalId: signal.id,
        causeType: signal.causeType,
        loopState: loopPhaseContext.effectivePhase,
      },
    );
  } else if (
    signalPolicy.isFeedbackSignal &&
    gateEvaluationOutcome.shouldQueueRuntimeFollowUp
  ) {
    updatedRouting.reason = "missing_pr_link";
    console.warn(
      "[sdlc-loop] skipping feedback runtime action due to missing PR link",
      {
        loopId,
        signalId: signal.id,
        causeType: signal.causeType,
      },
    );
  } else if (signalPolicy.isFeedbackSignal) {
    updatedRouting.reason = "gate_eval_no_follow_up";
  }

  return {
    outcome: "skipped",
    runtimeAction: "none",
    feedbackQueuedMessage: null,
    runtimeRouting: updatedRouting,
  };
}

/**
 * Evaluates babysit completion and schedules CI gate rechecks.
 */
async function evaluateBabysitAndScheduleRechecks({
  db,
  loopId,
  loop,
  signal,
  signalPolicy,
  refreshedLoopForRouting,
  signalClaimLeaseHeartbeat,
  now,
}: {
  db: DB;
  loopId: string;
  loop: { loopVersion: number };
  signal: PendingSignal;
  signalPolicy: SignalPolicy;
  refreshedLoopForRouting: {
    state: SdlcLoopState;
    currentHeadSha: string | null;
    blockedFromState: SdlcLoopState | null;
    prNumber: number | null;
  } | null;
  signalClaimLeaseHeartbeat: ReturnType<typeof createSignalClaimLeaseHeartbeat>;
  now: Date;
}): Promise<
  | { outcome: "ok" }
  | { outcome: "heartbeat_lost"; noopResult: SdlcSignalInboxTickResult }
> {
  const refreshedLoopPhaseContext = refreshedLoopForRouting
    ? buildPersistedLoopPhaseContext({
        state: refreshedLoopForRouting.state,
        blockedFromState: refreshedLoopForRouting.blockedFromState,
      })
    : null;

  if (
    refreshedLoopPhaseContext &&
    refreshedLoopPhaseContext.effectivePhase === "babysitting" &&
    signalPolicy.isFeedbackSignal
  ) {
    const preBabysitHeartbeat = await signalClaimLeaseHeartbeat.refreshIfDue();
    if (preBabysitHeartbeat !== "ok") {
      return {
        outcome: "heartbeat_lost",
        noopResult: {
          processed: false,
          reason:
            mapSignalClaimLeaseHeartbeatStatusToNoopReason(preBabysitHeartbeat),
        },
      };
    }

    const babysitHeadSha =
      getPayloadText(signal.payload, "headSha") ??
      refreshedLoopForRouting?.currentHeadSha;
    if (babysitHeadSha) {
      const babysitEvaluation = await evaluateBabysitCompletionForHead({
        db,
        loopId,
        headSha: babysitHeadSha,
      });
      const loopVersionForArtifact =
        typeof loop.loopVersion === "number" &&
        Number.isFinite(loop.loopVersion)
          ? Math.max(loop.loopVersion, 0) + 1
          : 1;
      const babysitArtifact = await createBabysitEvaluationArtifactForHead({
        db,
        loopId,
        headSha: babysitHeadSha,
        loopVersion: loopVersionForArtifact,
        payload: {
          headSha: babysitHeadSha,
          requiredCiPassed: babysitEvaluation.requiredCiPassed,
          unresolvedReviewThreads: babysitEvaluation.unresolvedReviewThreads,
          unresolvedDeepBlockers: babysitEvaluation.unresolvedDeepBlockers,
          unresolvedCarmackBlockers:
            babysitEvaluation.unresolvedCarmackBlockers,
          allRequiredGatesPassed: babysitEvaluation.allRequiredGatesPassed,
        },
        generatedBy: "system",
        status: "accepted",
      });
      if (babysitEvaluation.allRequiredGatesPassed) {
        await transitionSdlcLoopStateWithArtifact({
          db,
          loopId,
          artifactId: babysitArtifact.id,
          expectedPhase: "babysitting",
          transitionEvent: "babysit_passed",
          headSha: babysitHeadSha,
          loopVersion: loopVersionForArtifact,
          now,
        });
      } else {
        // Self-scheduling: gates didn't pass, schedule a background
        // recheck so the 1-min cron picks it up with fresh GitHub data.
        scheduleBabysitRecheck(db, loopId).catch((err) => {
          console.warn("[sdlc-loop] failed to schedule babysit recheck", {
            loopId,
            error: err,
          });
        });
      }
    }
  }

  // ci_gate recheck: if the loop is in ci_gate after gate evaluation,
  // schedule a recheck so missed webhooks don't leave it stuck.
  if (
    refreshedLoopPhaseContext &&
    refreshedLoopPhaseContext.effectivePhase === "ci_gate" &&
    signalPolicy.isFeedbackSignal
  ) {
    scheduleCiGateRecheck(db, loopId).catch((err) => {
      console.warn("[sdlc-loop] failed to schedule ci_gate recheck", {
        loopId,
        error: err,
      });
    });
  }

  return { outcome: "ok" };
}

/**
 * Publishes outbox action and completes the signal claim.
 */
async function finalizeSignalProcessing({
  db,
  loopId,
  loop,
  signal,
  runtimeAction,
  effectivePrNumber,
  signalClaimLeaseHeartbeat,
  now,
}: {
  db: DB;
  loopId: string;
  loop: { loopVersion: number; repoFullName: string };
  signal: PendingSignal;
  runtimeAction: RuntimeActionOutcome;
  effectivePrNumber: number | null;
  signalClaimLeaseHeartbeat: ReturnType<typeof createSignalClaimLeaseHeartbeat>;
  now: Date;
}): Promise<
  | {
      outcome: "completed";
      outboxId: string | null;
    }
  | {
      outcome: "heartbeat_lost" | "claim_lost";
      noopResult: SdlcSignalInboxTickResult;
    }
> {
  const preOutboxHeartbeat = await signalClaimLeaseHeartbeat.refreshIfDue();
  if (preOutboxHeartbeat !== "ok") {
    return {
      outcome: "heartbeat_lost",
      noopResult: {
        processed: false,
        reason:
          mapSignalClaimLeaseHeartbeatStatusToNoopReason(preOutboxHeartbeat),
      },
    };
  }

  let outboxId: string | null = null;
  if (typeof effectivePrNumber === "number") {
    const outbox = await enqueueSdlcOutboxAction({
      db,
      loopId,
      transitionSeq: resolveSignalTransitionSeq({
        loopVersion: loop.loopVersion,
        signalReceivedAt: signal.receivedAt,
        now,
      }),
      actionType: "publish_status_comment",
      actionKey: `signal-inbox:${signal.id}:publish-status-comment`,
      payload: {
        repoFullName: loop.repoFullName,
        prNumber: effectivePrNumber,
        body: buildPublicationStatusBody({
          signal,
          runtimeAction,
        }),
      },
      now,
    });
    outboxId = outbox.outboxId;
  }

  const preCompleteHeartbeat = await signalClaimLeaseHeartbeat.refreshIfDue();
  if (preCompleteHeartbeat !== "ok") {
    return {
      outcome: "heartbeat_lost",
      noopResult: {
        processed: false,
        reason:
          mapSignalClaimLeaseHeartbeatStatusToNoopReason(preCompleteHeartbeat),
      },
    };
  }

  const markedProcessed = await completeSignalClaim({
    db,
    signalId: signal.id,
    claimToken: signal.claimToken,
    now,
  });

  if (!markedProcessed) {
    return {
      outcome: "claim_lost",
      noopResult: { processed: false, reason: "signal_claim_lost" },
    };
  }

  return { outcome: "completed", outboxId };
}

// ── Public API ──

export async function drainDueSdlcSignalInboxActions({
  db,
  now = new Date(),
  leaseOwnerTokenPrefix,
  maxLoops = SDLC_SIGNAL_INBOX_DURABLE_DRAIN_MAX_LOOPS,
  maxSignalsTotal = SDLC_SIGNAL_INBOX_DURABLE_DRAIN_MAX_SIGNALS_TOTAL,
  maxSignalsPerLoop = SDLC_SIGNAL_INBOX_DURABLE_DRAIN_MAX_SIGNALS_PER_LOOP,
}: {
  db: DB;
  now?: Date;
  leaseOwnerTokenPrefix: string;
  maxLoops?: number;
  maxSignalsTotal?: number;
  maxSignalsPerLoop?: number;
}): Promise<SdlcDurableSignalInboxDrainResult> {
  const boundedMaxLoops = Math.max(0, Math.trunc(maxLoops));
  const boundedMaxSignalsTotal = Math.max(0, Math.trunc(maxSignalsTotal));
  const boundedMaxSignalsPerLoop = Math.max(0, Math.trunc(maxSignalsPerLoop));
  const staleClaimCutoff = new Date(
    now.getTime() - SDLC_SIGNAL_INBOX_CLAIM_STALE_MS,
  );

  if (
    boundedMaxLoops === 0 ||
    boundedMaxSignalsTotal === 0 ||
    boundedMaxSignalsPerLoop === 0
  ) {
    return {
      dueLoopCount: 0,
      visitedLoopCount: 0,
      loopsWithProcessedSignals: 0,
      processedSignalCount: 0,
      reachedSignalLimit: false,
    };
  }

  const dueRows = await db
    .select({
      loopId: schema.sdlcLoopSignalInbox.loopId,
    })
    .from(schema.sdlcLoopSignalInbox)
    .innerJoin(
      schema.sdlcLoop,
      eq(schema.sdlcLoop.id, schema.sdlcLoopSignalInbox.loopId),
    )
    .where(
      and(
        notInArray(schema.sdlcLoop.state, terminalSdlcLoopStateList),
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
      ),
    )
    .groupBy(schema.sdlcLoopSignalInbox.loopId)
    .orderBy(sql`min(${schema.sdlcLoopSignalInbox.receivedAt})`)
    .limit(boundedMaxLoops);

  const dueLoopIds: string[] = [];
  for (const row of dueRows) {
    dueLoopIds.push(row.loopId);
  }

  let visitedLoopCount = 0;
  let loopsWithProcessedSignals = 0;
  let processedSignalCount = 0;

  for (const loopId of dueLoopIds) {
    if (processedSignalCount >= boundedMaxSignalsTotal) {
      break;
    }
    visitedLoopCount += 1;
    let processedForLoop = 0;

    while (
      processedForLoop < boundedMaxSignalsPerLoop &&
      processedSignalCount < boundedMaxSignalsTotal
    ) {
      const tick = await runBestEffortSdlcSignalInboxTick({
        db,
        loopId,
        leaseOwnerToken: `${leaseOwnerTokenPrefix}:${loopId}:${processedForLoop + 1}`,
        now,
        guardrailRuntime: buildDurableSignalInboxGuardrailRuntime(),
      });
      if (!tick.processed) {
        break;
      }
      processedForLoop += 1;
      processedSignalCount += 1;
    }

    if (processedForLoop > 0) {
      loopsWithProcessedSignals += 1;
    }
  }

  return {
    dueLoopCount: dueLoopIds.length,
    visitedLoopCount,
    loopsWithProcessedSignals,
    processedSignalCount,
    reachedSignalLimit: processedSignalCount >= boundedMaxSignalsTotal,
  };
}

export async function runBestEffortSdlcSignalInboxTick({
  db,
  loopId,
  leaseOwnerToken,
  now = new Date(),
  guardrailRuntime,
  includeRuntimeRouting = false,
}: {
  db: DB;
  loopId: string;
  leaseOwnerToken: string;
  now?: Date;
  guardrailRuntime?: SdlcSignalInboxGuardrailRuntimeInput;
  includeRuntimeRouting?: boolean;
}): Promise<SdlcSignalInboxTickResult> {
  const loop = await db.query.sdlcLoop.findFirst({
    where: eq(schema.sdlcLoop.id, loopId),
  });
  if (!loop) {
    return { processed: false, reason: "loop_not_found" };
  }
  if (terminalSdlcLoopStateSet.has(loop.state)) {
    return { processed: false, reason: "terminal_state" };
  }

  const leaseOwner = `sdlc-signal-inbox:${leaseOwnerToken}`;
  const lease = await acquireSdlcLoopLease({
    db,
    loopId,
    leaseOwner,
    leaseTtlMs: SDLC_SIGNAL_INBOX_LEASE_TTL_MS,
    now,
  });
  if (!lease.acquired) {
    return { processed: false, reason: "lease_held" };
  }

  try {
    const guardrailInputs = resolveSignalInboxGuardrailInputs({
      loop,
      runtimeInput: guardrailRuntime,
    });
    const guardrailDecision = evaluateSdlcLoopGuardrails({
      killSwitchEnabled: guardrailInputs.killSwitchEnabled,
      isTerminalState: terminalSdlcLoopStateSet.has(loop.state),
      hasValidLease: true,
      cooldownUntil: guardrailInputs.cooldownUntil,
      iterationCount: guardrailInputs.iterationCount,
      maxIterations: guardrailInputs.maxIterations,
      manualIntentAllowed: guardrailInputs.manualIntentAllowed,
      now,
    });
    if (!guardrailDecision.allowed) {
      return {
        processed: false,
        reason: guardrailDecision.reasonCode,
      };
    }

    const signalClaimToken = `sdlc-signal-inbox:${leaseOwnerToken}:${randomUUID()}`;
    const signal = await claimNextUnprocessedSignal({
      db,
      loopId,
      claimToken: signalClaimToken,
      now,
      staleClaimMs: SDLC_SIGNAL_INBOX_CLAIM_STALE_MS,
    });
    if (!signal) {
      return { processed: false, reason: "no_unprocessed_signal" };
    }
    const signalClaimLeaseHeartbeat = createSignalClaimLeaseHeartbeat({
      db,
      loopId,
      leaseOwner,
      signalId: signal.id,
      claimToken: signal.claimToken,
    });
    let shouldReleaseClaim = true;
    try {
      const signalPolicy = classifySignalPolicy(signal.causeType);
      let gateEvaluationOutcome: SignalGateEvaluationOutcome = {
        shouldQueueRuntimeFollowUp: signalPolicy.isFeedbackSignal,
        gateEvaluated: false,
      };
      try {
        gateEvaluationOutcome = await evaluateAndPersistGate({
          db,
          loop: {
            id: loop.id,
            loopVersion: loop.loopVersion,
            currentHeadSha: loop.currentHeadSha,
            state: loop.state,
            blockedFromState: loop.blockedFromState,
          },
          signal,
          policy: signalPolicy,
          now,
        });
      } catch (error) {
        console.error("[sdlc-loop] enrolled-loop gate evaluation failed", {
          loopId,
          signalId: signal.id,
          causeType: signal.causeType,
          error,
        });
      }

      const postGateHeartbeat = await signalClaimLeaseHeartbeat.refreshIfDue();
      if (postGateHeartbeat !== "ok") {
        return {
          processed: false,
          reason:
            mapSignalClaimLeaseHeartbeatStatusToNoopReason(postGateHeartbeat),
        };
      }

      // Refresh loop state for routing decisions
      const refreshedLoopForRouting = await db.query.sdlcLoop.findFirst({
        where: eq(schema.sdlcLoop.id, loopId),
        columns: {
          state: true,
          currentHeadSha: true,
          blockedFromState: true,
          prNumber: true,
        },
      });
      let loopPhaseContext = buildPersistedLoopPhaseContext({
        state: refreshedLoopForRouting?.state ?? loop.state,
        blockedFromState:
          refreshedLoopForRouting?.blockedFromState ?? loop.blockedFromState,
      });
      const effectivePrNumber =
        typeof refreshedLoopForRouting?.prNumber === "number" &&
        Number.isFinite(refreshedLoopForRouting.prNumber)
          ? refreshedLoopForRouting.prNumber
          : loop.prNumber;

      // ── Implementing-phase completion intercept ──
      const implResult = await handleImplementingPhaseCompletion({
        db,
        loopId,
        loop,
        signal,
        loopPhaseContext,
        gateEvaluationOutcome,
        now,
      });
      loopPhaseContext = implResult.loopPhaseContext;
      gateEvaluationOutcome = implResult.gateEvaluationOutcome;

      const shouldSuppressFeedbackRuntimeAction =
        shouldSuppressFeedbackRuntimeRouting({
          policy: signalPolicy,
          signal,
          effectivePhase: loopPhaseContext.effectivePhase,
        });

      // ── Feedback routing ──
      const runtimeRouting: {
        routed: boolean;
        followUpQueued: boolean;
        reason: RuntimeRoutingReason;
        error: string | null;
      } = {
        routed: false,
        followUpQueued: false,
        reason: "non_feedback_signal",
        error: null,
      };

      const feedbackResult = await routeFeedbackIfEligible({
        db,
        loopId,
        loop,
        signal,
        signalPolicy,
        gateEvaluationOutcome,
        shouldSuppressFeedbackRuntimeAction,
        effectivePrNumber: effectivePrNumber ?? null,
        loopPhaseContext,
        signalClaimLeaseHeartbeat,
        includeRuntimeRouting,
        runtimeRouting,
        now,
      });

      if (
        feedbackResult.outcome === "heartbeat_lost" ||
        feedbackResult.outcome === "enqueue_failed"
      ) {
        return feedbackResult.noopResult;
      }

      const runtimeAction = feedbackResult.runtimeAction;
      const feedbackQueuedMessage = feedbackResult.feedbackQueuedMessage;
      const finalRouting = feedbackResult.runtimeRouting;

      // ── Babysit evaluation & CI gate rechecks ──
      const babysitResult = await evaluateBabysitAndScheduleRechecks({
        db,
        loopId,
        loop,
        signal,
        signalPolicy,
        refreshedLoopForRouting: refreshedLoopForRouting ?? null,
        signalClaimLeaseHeartbeat,
        now,
      });

      if (babysitResult.outcome === "heartbeat_lost") {
        return babysitResult.noopResult;
      }

      // ── Finalize: outbox + claim completion ──
      const finalizeResult = await finalizeSignalProcessing({
        db,
        loopId,
        loop,
        signal,
        runtimeAction,
        effectivePrNumber: effectivePrNumber ?? null,
        signalClaimLeaseHeartbeat,
        now,
      });

      if (finalizeResult.outcome !== "completed") {
        return finalizeResult.noopResult;
      }

      shouldReleaseClaim = false;

      return {
        processed: true,
        signalId: signal.id,
        causeType: signal.causeType,
        runtimeAction,
        outboxId: finalizeResult.outboxId,
        feedbackQueuedMessage,
        ...(includeRuntimeRouting ? { runtimeRouting: finalRouting } : {}),
      };
    } finally {
      if (shouldReleaseClaim) {
        await releaseSignalClaim({
          db,
          signalId: signal.id,
          claimToken: signal.claimToken,
        });
      }
    }
  } finally {
    const released = await releaseSdlcLoopLease({
      db,
      loopId,
      leaseOwner,
      now,
    });
    if (!released) {
      console.warn("[sdlc signal inbox] failed to release coordinator lease", {
        loopId,
        leaseOwner,
      });
    }
  }
}
