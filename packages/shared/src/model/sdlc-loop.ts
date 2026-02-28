import { createHash } from "node:crypto";
import {
  and,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lte,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import * as z from "zod/v4";
import { DB } from "../db";
import * as schema from "../db/schema";
import {
  SdlcCarmackReviewSeverity,
  SdlcCarmackReviewStatus,
  SdlcCiCapabilityState,
  SdlcCiGateStatus,
  SdlcCiRequiredCheckSource,
  SdlcDeepReviewSeverity,
  SdlcDeepReviewStatus,
  SdlcLoopCauseType,
  SdlcLoopOutboxActionType,
  SdlcLoopOutboxSupersessionGroup,
  SdlcParityTargetClass,
  SdlcLoopState,
  SdlcPhase,
  SdlcArtifactType,
  SdlcArtifactStatus,
  SdlcArtifactGeneratedBy,
  SdlcPlanTaskStatus,
  SdlcPlanTaskCompletedBy,
  SdlcPlanApprovalPolicy,
  SdlcPlanSpecPayload,
  SdlcImplementationSnapshotPayload,
  SdlcReviewBundlePayload,
  SdlcUiSmokePayload,
  SdlcPrLinkPayload,
  SdlcBabysitEvaluationPayload,
  SdlcPlanTask,
  SdlcPlanTaskCompletionEvidence,
  SdlcOutboxAttemptStatus,
  SdlcReviewThreadEvaluationSource,
  SdlcReviewThreadGateStatus,
  SdlcVideoFailureClass,
} from "../db/types";

const activeSdlcLoopStates = [
  "planning",
  "implementing",
  "reviewing",
  "ui_testing",
  "pr_babysitting",
  // Legacy active states retained during migration.
  "enrolled",
  "gates_running",
  "video_pending",
  "human_review_ready",
  "video_degraded_ready",
  "blocked_on_agent_fixes",
  "blocked_on_ci",
  "blocked_on_review_threads",
  "blocked_on_human_feedback",
] as const satisfies readonly SdlcLoopState[];
const activeSdlcLoopStateList: SdlcLoopState[] = [...activeSdlcLoopStates];
const activeSdlcLoopStateSet: ReadonlySet<SdlcLoopState> = new Set(
  activeSdlcLoopStateList,
);

const terminalSdlcLoopStates = [
  "terminated_pr_closed",
  "terminated_pr_merged",
  "done",
  "stopped",
] as const satisfies readonly SdlcLoopState[];
const terminalSdlcLoopStateList: SdlcLoopState[] = [...terminalSdlcLoopStates];
const terminalSdlcLoopStateSet: ReadonlySet<SdlcLoopState> = new Set(
  terminalSdlcLoopStateList,
);

export type SdlcLoopTransitionEvent =
  | "plan_completed"
  | "implementation_completed"
  | "review_passed"
  | "review_blocked"
  | "ui_smoke_passed"
  | "ui_smoke_failed"
  | "pr_linked"
  | "babysit_passed"
  | "babysit_blocked"
  // Legacy transition events kept for compatibility while callsites migrate.
  | "implementation_progress"
  | "ci_gate_passed"
  | "ci_gate_blocked"
  | "review_threads_gate_passed"
  | "review_threads_gate_blocked"
  | "deep_review_gate_passed"
  | "deep_review_gate_blocked"
  | "carmack_review_gate_passed"
  | "carmack_review_gate_blocked"
  | "video_capture_started"
  | "video_capture_succeeded"
  | "video_capture_failed"
  | "human_feedback_requested"
  | "pr_closed_unmerged"
  | "pr_merged"
  | "manual_stop"
  | "mark_done";

type SdlcArtifactPayload =
  | SdlcPlanSpecPayload
  | SdlcImplementationSnapshotPayload
  | SdlcReviewBundlePayload
  | SdlcUiSmokePayload
  | SdlcPrLinkPayload
  | SdlcBabysitEvaluationPayload
  | Record<string, unknown>;

const sdlcPlanTaskNonBlockingTerminalStatusSet = new Set<SdlcPlanTaskStatus>([
  "done",
  "skipped",
]);

const sdlcPlanTaskIncompleteStatusSet = new Set<SdlcPlanTaskStatus>([
  "todo",
  "in_progress",
  "blocked",
]);

function isIncompletePlanTaskStatus(status: SdlcPlanTaskStatus): boolean {
  return sdlcPlanTaskIncompleteStatusSet.has(status);
}

function isNonBlockingTerminalPlanTaskStatus(
  status: SdlcPlanTaskStatus,
): boolean {
  return sdlcPlanTaskNonBlockingTerminalStatusSet.has(status);
}

type SdlcLoopArtifactPointerField =
  | "activePlanArtifactId"
  | "activeImplementationArtifactId"
  | "activeReviewArtifactId"
  | "activeUiArtifactId"
  | "activeBabysitArtifactId";

const phaseToLoopPointerColumn: Record<
  SdlcPhase,
  SdlcLoopArtifactPointerField | null
> = {
  planning: "activePlanArtifactId",
  implementing: "activeImplementationArtifactId",
  reviewing: "activeReviewArtifactId",
  ui_testing: "activeUiArtifactId",
  pr_linking: null,
  pr_babysitting: "activeBabysitArtifactId",
};

export function isSdlcLoopTerminalState(state: SdlcLoopState): boolean {
  return terminalSdlcLoopStateSet.has(state);
}

export function resolveSdlcLoopNextState({
  currentState,
  event,
}: {
  currentState: SdlcLoopState;
  event: SdlcLoopTransitionEvent;
}): SdlcLoopState | null {
  if (currentState === "done") {
    if (
      event === "video_capture_succeeded" ||
      event === "video_capture_failed" ||
      event === "babysit_passed" ||
      event === "mark_done"
    ) {
      return "done";
    }
    return null;
  }

  if (isSdlcLoopTerminalState(currentState)) {
    return null;
  }

  const globalTransitions: Partial<
    Record<SdlcLoopTransitionEvent, SdlcLoopState>
  > = {
    pr_closed_unmerged: "terminated_pr_closed",
    pr_merged: "terminated_pr_merged",
    manual_stop: "stopped",
    human_feedback_requested: "blocked_on_human_feedback",
  };
  if (event in globalTransitions) {
    return globalTransitions[event] ?? null;
  }

  switch (currentState) {
    case "planning":
      if (event === "plan_completed") {
        return "implementing";
      }
      return null;
    case "implementing":
      if (event === "implementation_progress") {
        return "implementing";
      }
      if (event === "implementation_completed") {
        return "reviewing";
      }
      return null;
    case "reviewing":
      if (
        event === "review_blocked" ||
        event === "deep_review_gate_blocked" ||
        event === "carmack_review_gate_blocked"
      ) {
        return "implementing";
      }
      if (event === "review_passed") {
        return "ui_testing";
      }
      if (
        event === "deep_review_gate_passed" ||
        event === "carmack_review_gate_passed"
      ) {
        return "reviewing";
      }
      return null;
    case "ui_testing":
      if (event === "ui_smoke_failed" || event === "video_capture_failed") {
        return "implementing";
      }
      if (event === "ui_smoke_passed" || event === "video_capture_started") {
        return "ui_testing";
      }
      if (event === "pr_linked" || event === "video_capture_succeeded") {
        return "pr_babysitting";
      }
      return null;
    case "pr_babysitting":
      if (
        event === "babysit_blocked" ||
        event === "ci_gate_blocked" ||
        event === "review_threads_gate_blocked" ||
        event === "deep_review_gate_blocked" ||
        event === "carmack_review_gate_blocked"
      ) {
        return "implementing";
      }
      if (event === "babysit_passed" || event === "mark_done") {
        return "done";
      }
      if (
        event === "pr_linked" ||
        event === "ci_gate_passed" ||
        event === "review_threads_gate_passed" ||
        event === "deep_review_gate_passed" ||
        event === "carmack_review_gate_passed"
      ) {
        return "pr_babysitting";
      }
      return null;
    // Legacy migration states.
    case "enrolled":
      if (event === "plan_completed") {
        return "implementing";
      }
      return null;
    case "gates_running":
      if (
        event === "review_blocked" ||
        event === "deep_review_gate_blocked" ||
        event === "carmack_review_gate_blocked"
      ) {
        return "implementing";
      }
      if (event === "review_passed") {
        return "ui_testing";
      }
      if (
        event === "deep_review_gate_passed" ||
        event === "carmack_review_gate_passed"
      ) {
        return "gates_running";
      }
      return null;
    case "video_pending":
      if (event === "video_capture_failed") {
        return "implementing";
      }
      if (event === "video_capture_succeeded") {
        return "pr_babysitting";
      }
      if (event === "video_capture_started") {
        return "video_pending";
      }
      return null;
    case "human_review_ready":
    case "video_degraded_ready":
      if (event === "pr_linked") {
        return "pr_babysitting";
      }
      if (event === "mark_done") {
        return "done";
      }
      return null;
    case "blocked_on_agent_fixes":
    case "blocked_on_ci":
    case "blocked_on_review_threads":
      if (event === "implementation_progress") {
        return "implementing";
      }
      return null;
    case "blocked_on_human_feedback":
      if (event === "mark_done") {
        return "done";
      }
      return null;
    default:
      return null;
  }
}

export const SDLC_CAUSE_IDENTITY_VERSION = 1;
export const GITHUB_WEBHOOK_CLAIM_TTL_MS = 5 * 60 * 1000;

type DaemonTerminalCause = {
  causeType: "daemon_terminal";
  eventId: string;
};

type NonDaemonCause =
  | {
      causeType: "check_run.completed";
      deliveryId: string;
      checkRunId: number | string;
    }
  | {
      causeType: "check_suite.completed";
      deliveryId: string;
      checkSuiteId: number | string;
    }
  | {
      causeType: "pull_request.synchronize";
      deliveryId: string;
      pullRequestId: number | string;
      headSha: string;
    }
  | {
      causeType: "pull_request.closed";
      deliveryId: string;
      pullRequestId: number | string;
      merged: boolean;
    }
  | {
      causeType: "pull_request.reopened";
      deliveryId: string;
      pullRequestId: number | string;
    }
  | {
      causeType: "pull_request.edited";
      deliveryId: string;
      pullRequestId: number | string;
    }
  | {
      causeType: "pull_request_review";
      deliveryId: string;
      reviewId: number | string;
      reviewState: string;
    }
  | {
      causeType: "pull_request_review_comment";
      deliveryId: string;
      commentId: number | string;
    };

type SyntheticPollCause = {
  causeType: "review-thread-poll-synthetic";
  loopId: string;
  pollWindowStartIso: string;
  pollWindowEndIso: string;
  pollSequence: number;
};

export type SdlcCanonicalCauseInput =
  | DaemonTerminalCause
  | NonDaemonCause
  | SyntheticPollCause;

export type SdlcCanonicalCause = {
  causeType: SdlcLoopCauseType;
  canonicalCauseId: string;
  signalHeadShaOrNull: string | null;
  causeIdentityVersion: number;
};

export type GithubWebhookDeliveryClaimOutcome =
  | "claimed_new"
  | "already_completed"
  | "in_progress_fresh"
  | "stale_stolen";

export type GithubWebhookDeliveryClaimResult = {
  outcome: GithubWebhookDeliveryClaimOutcome;
  shouldProcess: boolean;
};

const outboxSupersessionGroupMap: Record<
  SdlcLoopOutboxActionType,
  SdlcLoopOutboxSupersessionGroup
> = {
  publish_status_comment: "publication_status",
  publish_check_summary: "publication_status",
  enqueue_fix_task: "fix_task_enqueue",
  publish_video_link: "publication_video",
  emit_telemetry: "telemetry",
};

export function getSdlcOutboxSupersessionGroup(
  actionType: SdlcLoopOutboxActionType,
): SdlcLoopOutboxSupersessionGroup {
  return outboxSupersessionGroupMap[actionType];
}

export function buildSdlcCanonicalCause(
  input: SdlcCanonicalCauseInput,
): SdlcCanonicalCause {
  switch (input.causeType) {
    case "daemon_terminal":
      return {
        causeType: input.causeType,
        canonicalCauseId: input.eventId,
        signalHeadShaOrNull: null,
        causeIdentityVersion: SDLC_CAUSE_IDENTITY_VERSION,
      };
    case "check_run.completed":
      return {
        causeType: input.causeType,
        canonicalCauseId: `${input.deliveryId}:${input.checkRunId}`,
        signalHeadShaOrNull: null,
        causeIdentityVersion: SDLC_CAUSE_IDENTITY_VERSION,
      };
    case "check_suite.completed":
      return {
        causeType: input.causeType,
        canonicalCauseId: `${input.deliveryId}:${input.checkSuiteId}`,
        signalHeadShaOrNull: null,
        causeIdentityVersion: SDLC_CAUSE_IDENTITY_VERSION,
      };
    case "pull_request.synchronize":
      return {
        causeType: input.causeType,
        canonicalCauseId: `${input.deliveryId}:${input.pullRequestId}:${input.headSha}`,
        signalHeadShaOrNull: input.headSha,
        causeIdentityVersion: SDLC_CAUSE_IDENTITY_VERSION,
      };
    case "pull_request.closed":
      return {
        causeType: input.causeType,
        canonicalCauseId: `${input.deliveryId}:${input.pullRequestId}:closed:${input.merged ? "merged" : "unmerged"}`,
        signalHeadShaOrNull: null,
        causeIdentityVersion: SDLC_CAUSE_IDENTITY_VERSION,
      };
    case "pull_request.reopened":
      return {
        causeType: input.causeType,
        canonicalCauseId: `${input.deliveryId}:${input.pullRequestId}:reopened`,
        signalHeadShaOrNull: null,
        causeIdentityVersion: SDLC_CAUSE_IDENTITY_VERSION,
      };
    case "pull_request.edited":
      return {
        causeType: input.causeType,
        canonicalCauseId: `${input.deliveryId}:${input.pullRequestId}:edited`,
        signalHeadShaOrNull: null,
        causeIdentityVersion: SDLC_CAUSE_IDENTITY_VERSION,
      };
    case "pull_request_review":
      return {
        causeType: input.causeType,
        canonicalCauseId: `${input.deliveryId}:${input.reviewId}:${input.reviewState}`,
        signalHeadShaOrNull: null,
        causeIdentityVersion: SDLC_CAUSE_IDENTITY_VERSION,
      };
    case "pull_request_review_comment":
      return {
        causeType: input.causeType,
        canonicalCauseId: `${input.deliveryId}:${input.commentId}`,
        signalHeadShaOrNull: null,
        causeIdentityVersion: SDLC_CAUSE_IDENTITY_VERSION,
      };
    case "review-thread-poll-synthetic":
      return {
        causeType: input.causeType,
        canonicalCauseId: `${input.loopId}:${input.pollWindowStartIso}:${input.pollWindowEndIso}:${input.pollSequence}`,
        signalHeadShaOrNull: null,
        causeIdentityVersion: SDLC_CAUSE_IDENTITY_VERSION,
      };
    default: {
      const _exhaustive: never = input;
      throw new Error(`Unhandled SDLC canonical cause input: ${_exhaustive}`);
    }
  }
}

export function getGithubWebhookClaimHttpStatus(
  outcome: GithubWebhookDeliveryClaimOutcome,
): number {
  switch (outcome) {
    case "already_completed":
      return 200;
    case "claimed_new":
    case "stale_stolen":
    case "in_progress_fresh":
      return 202;
    default: {
      const _exhaustive: never = outcome;
      throw new Error(`Unhandled GitHub claim outcome: ${_exhaustive}`);
    }
  }
}

export type SdlcGuardrailReasonCode =
  | "kill_switch"
  | "terminal_state"
  | "lease_invalid"
  | "cooldown"
  | "max_iterations"
  | "manual_intent_denied";

export function evaluateSdlcLoopGuardrails({
  killSwitchEnabled,
  isTerminalState,
  hasValidLease,
  cooldownUntil,
  iterationCount,
  maxIterations,
  manualIntentAllowed,
  now = new Date(),
}: {
  killSwitchEnabled: boolean;
  isTerminalState: boolean;
  hasValidLease: boolean;
  cooldownUntil: Date | null;
  iterationCount: number;
  maxIterations: number | null;
  manualIntentAllowed: boolean;
  now?: Date;
}):
  | { allowed: true }
  | { allowed: false; reasonCode: SdlcGuardrailReasonCode } {
  if (killSwitchEnabled) {
    return { allowed: false, reasonCode: "kill_switch" };
  }

  if (isTerminalState) {
    return { allowed: false, reasonCode: "terminal_state" };
  }

  if (!hasValidLease) {
    return { allowed: false, reasonCode: "lease_invalid" };
  }

  if (cooldownUntil && cooldownUntil > now) {
    return { allowed: false, reasonCode: "cooldown" };
  }

  if (maxIterations !== null && iterationCount >= maxIterations) {
    return { allowed: false, reasonCode: "max_iterations" };
  }

  if (!manualIntentAllowed) {
    return { allowed: false, reasonCode: "manual_intent_denied" };
  }

  return { allowed: true };
}

export async function getActiveSdlcLoopForGithubPRAndUser({
  db,
  userId,
  repoFullName,
  prNumber,
}: {
  db: DB;
  userId: string;
  repoFullName: string;
  prNumber: number;
}) {
  return await getPreferredActiveSdlcLoopForGithubPRAndUser({
    db,
    userId,
    repoFullName,
    prNumber,
  });
}

export async function getActiveSdlcLoopsForGithubPR({
  db,
  repoFullName,
  prNumber,
}: {
  db: DB;
  repoFullName: string;
  prNumber: number;
}) {
  return await db.query.sdlcLoop.findMany({
    where: and(
      eq(schema.sdlcLoop.repoFullName, repoFullName),
      eq(schema.sdlcLoop.prNumber, prNumber),
      inArray(schema.sdlcLoop.state, activeSdlcLoopStateList),
    ),
    orderBy: [desc(schema.sdlcLoop.updatedAt), desc(schema.sdlcLoop.id)],
  });
}

export async function getPreferredActiveSdlcLoopForGithubPRAndUser({
  db,
  userId,
  repoFullName,
  prNumber,
}: {
  db: DB;
  userId: string;
  repoFullName: string;
  prNumber: number;
}) {
  const loops = await getActiveSdlcLoopsForGithubPR({
    db,
    repoFullName,
    prNumber,
  });
  const userLoops = loops.filter((loop) => loop.userId === userId);
  if (userLoops.length === 0) {
    return undefined;
  }

  const canonicalPr = await db.query.githubPR.findFirst({
    where: and(
      eq(schema.githubPR.repoFullName, repoFullName),
      eq(schema.githubPR.number, prNumber),
    ),
    columns: {
      threadId: true,
    },
  });
  if (canonicalPr?.threadId) {
    const canonicalLoop = userLoops.find(
      (loop) => loop.threadId === canonicalPr.threadId,
    );
    if (canonicalLoop) {
      return canonicalLoop;
    }
  }

  return userLoops[0];
}

export async function getActiveSdlcLoopForGithubPR({
  db,
  repoFullName,
  prNumber,
}: {
  db: DB;
  repoFullName: string;
  prNumber: number;
}) {
  const activeLoops = await getActiveSdlcLoopsForGithubPR({
    db,
    repoFullName,
    prNumber,
  });
  return activeLoops[0];
}

export async function transitionActiveSdlcLoopsForGithubPREvent({
  db,
  repoFullName,
  prNumber,
  transitionEvent,
  now = new Date(),
}: {
  db: DB;
  repoFullName: string;
  prNumber: number;
  transitionEvent: SdlcLoopTransitionEvent;
  now?: Date;
}) {
  const loops = await getActiveSdlcLoopsForGithubPR({
    db,
    repoFullName,
    prNumber,
  });

  let updatedCount = 0;
  for (const loop of loops) {
    const result = await transitionSdlcLoopState({
      db,
      loopId: loop.id,
      transitionEvent,
      now,
    });
    if (result === "updated") {
      updatedCount += 1;
    }
  }

  return {
    totalLoops: loops.length,
    updatedCount,
  };
}

export async function enrollSdlcLoopForGithubPR({
  db,
  userId,
  repoFullName,
  prNumber,
  threadId,
  currentHeadSha,
  planApprovalPolicy,
}: {
  db: DB;
  userId: string;
  repoFullName: string;
  prNumber: number;
  threadId: string;
  currentHeadSha?: string | null;
  planApprovalPolicy?: SdlcPlanApprovalPolicy;
}) {
  const enrolled = await enrollSdlcLoopForThread({
    db,
    userId,
    repoFullName,
    threadId,
    currentHeadSha,
    planApprovalPolicy,
  });
  if (!enrolled) {
    return enrolled;
  }

  return await linkSdlcLoopToGithubPRForThread({
    db,
    userId,
    repoFullName,
    threadId,
    prNumber,
    currentHeadSha,
  });
}

export async function enrollSdlcLoopForThread({
  db,
  userId,
  repoFullName,
  threadId,
  currentHeadSha,
  planApprovalPolicy,
}: {
  db: DB;
  userId: string;
  repoFullName: string;
  threadId: string;
  currentHeadSha?: string | null;
  planApprovalPolicy?: SdlcPlanApprovalPolicy;
}) {
  const now = new Date();
  const inserted = await db
    .insert(schema.sdlcLoop)
    .values({
      userId,
      repoFullName,
      threadId,
      state: "planning",
      currentHeadSha: currentHeadSha ?? null,
      planApprovalPolicy: planApprovalPolicy ?? "auto",
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning();

  if (inserted[0]) {
    return inserted[0];
  }

  const activeLoop = await getActiveSdlcLoopForThread({
    db,
    userId,
    threadId,
  });
  if (activeLoop) {
    return activeLoop;
  }

  const reactivationSet: {
    state: "planning";
    stopReason: null;
    updatedAt: Date;
    currentHeadSha?: string | null;
    planApprovalPolicy?: SdlcPlanApprovalPolicy;
  } = {
    state: "planning",
    stopReason: null,
    updatedAt: now,
  };
  if (currentHeadSha !== undefined) {
    reactivationSet.currentHeadSha = currentHeadSha;
  }
  if (planApprovalPolicy !== undefined) {
    reactivationSet.planApprovalPolicy = planApprovalPolicy;
  }

  const [reactivated] = await db
    .update(schema.sdlcLoop)
    .set(reactivationSet)
    .where(
      and(
        eq(schema.sdlcLoop.threadId, threadId),
        eq(schema.sdlcLoop.userId, userId),
        eq(schema.sdlcLoop.repoFullName, repoFullName),
        notInArray(schema.sdlcLoop.state, activeSdlcLoopStateList),
      ),
    )
    .returning();
  if (reactivated) {
    return reactivated;
  }

  return await getActiveSdlcLoopForThread({
    db,
    userId,
    threadId,
  });
}

export async function linkSdlcLoopToGithubPRForThread({
  db,
  userId,
  repoFullName,
  threadId,
  prNumber,
  currentHeadSha,
}: {
  db: DB;
  userId: string;
  repoFullName: string;
  threadId: string;
  prNumber: number;
  currentHeadSha?: string | null;
}) {
  const now = new Date();
  const activeLoop =
    (await getActiveSdlcLoopForThread({
      db,
      userId,
      threadId,
    })) ??
    (await enrollSdlcLoopForThread({
      db,
      userId,
      repoFullName,
      threadId,
      currentHeadSha,
    }));
  if (!activeLoop) {
    return undefined;
  }

  const nextValues: {
    prNumber: number;
    updatedAt: Date;
    currentHeadSha?: string | null;
  } = {
    prNumber,
    updatedAt: now,
  };
  if (currentHeadSha !== undefined) {
    nextValues.currentHeadSha = currentHeadSha;
  }

  const [updated] = await db
    .update(schema.sdlcLoop)
    .set(nextValues)
    .where(
      and(
        eq(schema.sdlcLoop.id, activeLoop.id),
        eq(schema.sdlcLoop.userId, userId),
        eq(schema.sdlcLoop.threadId, threadId),
        eq(schema.sdlcLoop.repoFullName, repoFullName),
      ),
    )
    .returning();
  if (updated) {
    return updated;
  }

  return await getPreferredActiveSdlcLoopForGithubPRAndUser({
    db,
    userId,
    repoFullName,
    prNumber,
  });
}

export async function getActiveSdlcLoopForThread({
  db,
  userId,
  threadId,
}: {
  db: DB;
  userId: string;
  threadId: string;
}) {
  return await db.query.sdlcLoop.findFirst({
    where: and(
      eq(schema.sdlcLoop.userId, userId),
      eq(schema.sdlcLoop.threadId, threadId),
      inArray(schema.sdlcLoop.state, activeSdlcLoopStateList),
    ),
  });
}

function buildLoopArtifactPointerUpdate({
  phase,
  artifactId,
}: {
  phase: SdlcPhase;
  artifactId: string;
}): Partial<typeof schema.sdlcLoop.$inferInsert> {
  const pointer = phaseToLoopPointerColumn[phase];
  if (!pointer) {
    return {};
  }
  return {
    [pointer]: artifactId,
  };
}

function getPlanArtifactRequiredStatus(
  policy: SdlcPlanApprovalPolicy,
): SdlcArtifactStatus {
  return policy === "human_required" ? "approved" : "accepted";
}

export async function getLatestAcceptedArtifact({
  db,
  loopId,
  phase,
  headSha,
  includeApprovedForPlanning = true,
}: {
  db: DB;
  loopId: string;
  phase: SdlcPhase;
  headSha?: string | null;
  includeApprovedForPlanning?: boolean;
}) {
  const acceptedStatuses: SdlcArtifactStatus[] =
    includeApprovedForPlanning && phase === "planning"
      ? ["accepted", "approved"]
      : ["accepted"];

  const whereClauses = [
    eq(schema.sdlcPhaseArtifact.loopId, loopId),
    eq(schema.sdlcPhaseArtifact.phase, phase),
    inArray(schema.sdlcPhaseArtifact.status, acceptedStatuses),
  ];
  if (headSha !== undefined) {
    if (headSha === null) {
      whereClauses.push(isNull(schema.sdlcPhaseArtifact.headSha));
    } else {
      whereClauses.push(eq(schema.sdlcPhaseArtifact.headSha, headSha));
    }
  }

  return await db.query.sdlcPhaseArtifact.findFirst({
    where: and(...whereClauses),
    orderBy: [
      desc(schema.sdlcPhaseArtifact.createdAt),
      desc(schema.sdlcPhaseArtifact.id),
    ],
  });
}

export async function createPlanArtifactForLoop({
  db,
  loopId,
  loopVersion,
  payload,
  generatedBy = "agent",
  status = "generated",
  now = new Date(),
}: {
  db: DB;
  loopId: string;
  loopVersion: number;
  payload: SdlcPlanSpecPayload;
  generatedBy?: SdlcArtifactGeneratedBy;
  status?: SdlcArtifactStatus;
  now?: Date;
}) {
  return await db.transaction(async (tx) => {
    await tx
      .update(schema.sdlcPhaseArtifact)
      .set({
        status: "superseded",
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.sdlcPhaseArtifact.loopId, loopId),
          eq(schema.sdlcPhaseArtifact.phase, "planning"),
          inArray(schema.sdlcPhaseArtifact.status, [
            "generated",
            "approved",
            "accepted",
          ]),
        ),
      );

    const [artifact] = await tx
      .insert(schema.sdlcPhaseArtifact)
      .values({
        loopId,
        phase: "planning",
        artifactType: "plan_spec",
        headSha: null,
        loopVersion,
        status,
        generatedBy,
        payload,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    if (!artifact) {
      throw new Error("Failed to create SDLC plan artifact");
    }

    await tx
      .update(schema.sdlcLoop)
      .set({
        ...buildLoopArtifactPointerUpdate({
          phase: "planning",
          artifactId: artifact.id,
        }),
        updatedAt: now,
      })
      .where(eq(schema.sdlcLoop.id, loopId));

    return artifact;
  });
}

export async function approvePlanArtifactForLoop({
  db,
  loopId,
  artifactId,
  approvedByUserId,
  now = new Date(),
}: {
  db: DB;
  loopId: string;
  artifactId: string;
  approvedByUserId: string;
  now?: Date;
}) {
  const [artifact] = await db
    .update(schema.sdlcPhaseArtifact)
    .set({
      status: "approved",
      approvedByUserId,
      approvedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.sdlcPhaseArtifact.id, artifactId),
        eq(schema.sdlcPhaseArtifact.loopId, loopId),
        eq(schema.sdlcPhaseArtifact.phase, "planning"),
        eq(schema.sdlcPhaseArtifact.artifactType, "plan_spec"),
        inArray(schema.sdlcPhaseArtifact.status, ["generated", "accepted"]),
      ),
    )
    .returning();

  if (!artifact) {
    return undefined;
  }

  await db
    .update(schema.sdlcLoop)
    .set({
      activePlanArtifactId: artifact.id,
      updatedAt: now,
    })
    .where(eq(schema.sdlcLoop.id, loopId));

  return artifact;
}

export async function replacePlanTasksForArtifact({
  db,
  loopId,
  artifactId,
  tasks,
  now = new Date(),
}: {
  db: DB;
  loopId: string;
  artifactId: string;
  tasks: Array<{
    stableTaskId: string;
    title: string;
    description?: string | null;
    acceptance: string[];
  }>;
  now?: Date;
}) {
  return await db.transaction(async (tx) => {
    const artifact = await tx.query.sdlcPhaseArtifact.findFirst({
      where: and(
        eq(schema.sdlcPhaseArtifact.id, artifactId),
        eq(schema.sdlcPhaseArtifact.loopId, loopId),
        eq(schema.sdlcPhaseArtifact.phase, "planning"),
        eq(schema.sdlcPhaseArtifact.artifactType, "plan_spec"),
      ),
    });
    if (!artifact) {
      throw new Error("Plan artifact not found for loop");
    }

    await tx
      .delete(schema.sdlcPlanTask)
      .where(eq(schema.sdlcPlanTask.artifactId, artifactId));

    if (tasks.length === 0) {
      return [] as SdlcPlanTask[];
    }

    const dedupedTasks = new Map<
      string,
      {
        stableTaskId: string;
        title: string;
        description?: string | null;
        acceptance: string[];
      }
    >();
    for (const task of tasks) {
      const stableTaskId = task.stableTaskId.trim();
      if (!stableTaskId) {
        continue;
      }
      dedupedTasks.set(stableTaskId, {
        stableTaskId,
        title: task.title.trim(),
        description: task.description?.trim() || null,
        acceptance: task.acceptance,
      });
    }

    const preparedTasks = [...dedupedTasks.values()].filter(
      (task) => task.title.length > 0,
    );
    if (preparedTasks.length === 0) {
      return [] as SdlcPlanTask[];
    }

    const taskRows: Array<typeof schema.sdlcPlanTask.$inferInsert> =
      preparedTasks.map((task) => ({
        artifactId,
        loopId,
        stableTaskId: task.stableTaskId,
        title: task.title,
        description: task.description ?? null,
        acceptance: task.acceptance,
        status: "todo",
        createdAt: now,
        updatedAt: now,
      }));

    return await tx.insert(schema.sdlcPlanTask).values(taskRows).returning();
  });
}

export async function markPlanTasksCompletedByAgent({
  db,
  loopId,
  artifactId,
  completions,
  now = new Date(),
}: {
  db: DB;
  loopId: string;
  artifactId: string;
  completions: Array<{
    stableTaskId: string;
    status?: Extract<SdlcPlanTaskStatus, "done" | "skipped" | "blocked">;
    evidence: SdlcPlanTaskCompletionEvidence;
  }>;
  now?: Date;
}) {
  if (completions.length === 0) {
    return {
      updatedTaskCount: 0,
    };
  }

  let updatedTaskCount = 0;
  for (const completion of completions) {
    const stableTaskId = completion.stableTaskId.trim();
    if (!stableTaskId) {
      continue;
    }
    const nextStatus = completion.status ?? "done";
    const completedAt =
      nextStatus === "done" || nextStatus === "skipped" ? now : null;
    const completedBy: SdlcPlanTaskCompletedBy | null =
      nextStatus === "done" || nextStatus === "skipped" ? "agent" : null;

    const [updated] = await db
      .update(schema.sdlcPlanTask)
      .set({
        status: nextStatus,
        completedAt,
        completedBy,
        completionEvidence: completion.evidence,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.sdlcPlanTask.loopId, loopId),
          eq(schema.sdlcPlanTask.artifactId, artifactId),
          eq(schema.sdlcPlanTask.stableTaskId, stableTaskId),
        ),
      )
      .returning({ id: schema.sdlcPlanTask.id });
    if (updated) {
      updatedTaskCount += 1;
    }
  }

  return {
    updatedTaskCount,
  };
}

export async function verifyPlanTaskCompletionForHead({
  db,
  loopId,
  artifactId,
  headSha,
}: {
  db: DB;
  loopId: string;
  artifactId: string;
  headSha: string;
}) {
  const tasks = await db.query.sdlcPlanTask.findMany({
    where: and(
      eq(schema.sdlcPlanTask.loopId, loopId),
      eq(schema.sdlcPlanTask.artifactId, artifactId),
    ),
  });

  const incompleteTasks = tasks.filter((task) =>
    isIncompletePlanTaskStatus(task.status),
  );

  const invalidEvidenceTaskIds: string[] = [];
  for (const task of tasks) {
    if (!isNonBlockingTerminalPlanTaskStatus(task.status)) {
      continue;
    }
    if (task.status === "skipped") {
      continue;
    }
    const evidence =
      task.completionEvidence as SdlcPlanTaskCompletionEvidence | null;
    if (!evidence || evidence.headSha !== headSha) {
      invalidEvidenceTaskIds.push(task.stableTaskId);
    }
  }

  return {
    gatePassed:
      tasks.length > 0 &&
      incompleteTasks.length === 0 &&
      invalidEvidenceTaskIds.length === 0,
    totalTasks: tasks.length,
    incompleteTaskIds: incompleteTasks.map((task) => task.stableTaskId),
    invalidEvidenceTaskIds,
  };
}

async function createHeadScopedArtifact({
  db,
  loopId,
  phase,
  artifactType,
  headSha,
  loopVersion,
  payload,
  generatedBy = "system",
  status = "accepted",
  now = new Date(),
}: {
  db: DB;
  loopId: string;
  phase: SdlcPhase;
  artifactType: SdlcArtifactType;
  headSha: string;
  loopVersion: number;
  payload: SdlcArtifactPayload;
  generatedBy?: SdlcArtifactGeneratedBy;
  status?: SdlcArtifactStatus;
  now?: Date;
}) {
  return await db.transaction(async (tx) => {
    await tx
      .update(schema.sdlcPhaseArtifact)
      .set({
        status: "superseded",
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.sdlcPhaseArtifact.loopId, loopId),
          eq(schema.sdlcPhaseArtifact.phase, phase),
          eq(schema.sdlcPhaseArtifact.headSha, headSha),
          inArray(schema.sdlcPhaseArtifact.status, [
            "generated",
            "approved",
            "accepted",
          ]),
        ),
      );

    const [artifact] = await tx
      .insert(schema.sdlcPhaseArtifact)
      .values({
        loopId,
        phase,
        artifactType,
        headSha,
        loopVersion,
        status,
        generatedBy,
        payload,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!artifact) {
      throw new Error("Failed to create SDLC phase artifact");
    }

    await tx
      .update(schema.sdlcLoop)
      .set({
        ...buildLoopArtifactPointerUpdate({
          phase,
          artifactId: artifact.id,
        }),
        updatedAt: now,
      })
      .where(eq(schema.sdlcLoop.id, loopId));

    return artifact;
  });
}

export async function createImplementationArtifactForHead({
  db,
  loopId,
  headSha,
  loopVersion,
  payload,
  generatedBy = "system",
  status = "accepted",
  now = new Date(),
}: {
  db: DB;
  loopId: string;
  headSha: string;
  loopVersion: number;
  payload: SdlcImplementationSnapshotPayload;
  generatedBy?: SdlcArtifactGeneratedBy;
  status?: SdlcArtifactStatus;
  now?: Date;
}) {
  return await createHeadScopedArtifact({
    db,
    loopId,
    phase: "implementing",
    artifactType: "implementation_snapshot",
    headSha,
    loopVersion,
    payload,
    generatedBy,
    status,
    now,
  });
}

export async function createReviewBundleArtifactForHead({
  db,
  loopId,
  headSha,
  loopVersion,
  payload,
  generatedBy = "system",
  status = "accepted",
  now = new Date(),
}: {
  db: DB;
  loopId: string;
  headSha: string;
  loopVersion: number;
  payload: SdlcReviewBundlePayload;
  generatedBy?: SdlcArtifactGeneratedBy;
  status?: SdlcArtifactStatus;
  now?: Date;
}) {
  return await createHeadScopedArtifact({
    db,
    loopId,
    phase: "reviewing",
    artifactType: "review_bundle",
    headSha,
    loopVersion,
    payload,
    generatedBy,
    status,
    now,
  });
}

export async function createUiSmokeArtifactForHead({
  db,
  loopId,
  headSha,
  loopVersion,
  payload,
  generatedBy = "system",
  status = "accepted",
  now = new Date(),
}: {
  db: DB;
  loopId: string;
  headSha: string;
  loopVersion: number;
  payload: SdlcUiSmokePayload;
  generatedBy?: SdlcArtifactGeneratedBy;
  status?: SdlcArtifactStatus;
  now?: Date;
}) {
  return await createHeadScopedArtifact({
    db,
    loopId,
    phase: "ui_testing",
    artifactType: "ui_smoke_result",
    headSha,
    loopVersion,
    payload,
    generatedBy,
    status,
    now,
  });
}

export async function createPrLinkArtifact({
  db,
  loopId,
  loopVersion,
  payload,
  generatedBy = "system",
  status = "accepted",
  now = new Date(),
}: {
  db: DB;
  loopId: string;
  loopVersion: number;
  payload: SdlcPrLinkPayload;
  generatedBy?: SdlcArtifactGeneratedBy;
  status?: SdlcArtifactStatus;
  now?: Date;
}) {
  return await db.transaction(async (tx) => {
    await tx
      .update(schema.sdlcPhaseArtifact)
      .set({
        status: "superseded",
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.sdlcPhaseArtifact.loopId, loopId),
          eq(schema.sdlcPhaseArtifact.phase, "pr_linking"),
          inArray(schema.sdlcPhaseArtifact.status, [
            "generated",
            "approved",
            "accepted",
          ]),
        ),
      );

    const [artifact] = await tx
      .insert(schema.sdlcPhaseArtifact)
      .values({
        loopId,
        phase: "pr_linking",
        artifactType: "pr_link",
        headSha: null,
        loopVersion,
        status,
        generatedBy,
        payload,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!artifact) {
      throw new Error("Failed to create SDLC PR link artifact");
    }

    return artifact;
  });
}

export async function createBabysitEvaluationArtifactForHead({
  db,
  loopId,
  headSha,
  loopVersion,
  payload,
  generatedBy = "system",
  status = "accepted",
  now = new Date(),
}: {
  db: DB;
  loopId: string;
  headSha: string;
  loopVersion: number;
  payload: SdlcBabysitEvaluationPayload;
  generatedBy?: SdlcArtifactGeneratedBy;
  status?: SdlcArtifactStatus;
  now?: Date;
}) {
  return await createHeadScopedArtifact({
    db,
    loopId,
    phase: "pr_babysitting",
    artifactType: "babysit_evaluation",
    headSha,
    loopVersion,
    payload,
    generatedBy,
    status,
    now,
  });
}

export type SdlcTransitionWithArtifactOutcome =
  | SdlcGateLoopUpdateOutcome
  | "artifact_not_found"
  | "artifact_gate_failed";

export async function transitionSdlcLoopStateWithArtifact({
  db,
  loopId,
  artifactId,
  transitionEvent,
  headSha,
  loopVersion,
  expectedPhase,
  now = new Date(),
}: {
  db: DB;
  loopId: string;
  artifactId: string;
  transitionEvent: SdlcLoopTransitionEvent;
  headSha?: string | null;
  loopVersion?: number;
  expectedPhase: SdlcPhase;
  now?: Date;
}): Promise<SdlcTransitionWithArtifactOutcome> {
  return await db.transaction(async (tx) => {
    const [loop, artifact] = await Promise.all([
      tx.query.sdlcLoop.findFirst({
        where: eq(schema.sdlcLoop.id, loopId),
      }),
      tx.query.sdlcPhaseArtifact.findFirst({
        where: and(
          eq(schema.sdlcPhaseArtifact.id, artifactId),
          eq(schema.sdlcPhaseArtifact.loopId, loopId),
          eq(schema.sdlcPhaseArtifact.phase, expectedPhase),
        ),
      }),
    ]);

    if (!loop || !artifact) {
      return "artifact_not_found";
    }

    const requiredStatus =
      transitionEvent === "plan_completed"
        ? getPlanArtifactRequiredStatus(loop.planApprovalPolicy)
        : "accepted";
    if (artifact.status !== requiredStatus) {
      return "artifact_gate_failed";
    }

    if (headSha !== undefined) {
      if (headSha === null) {
        if (artifact.headSha !== null) {
          return "artifact_gate_failed";
        }
      } else if (artifact.headSha !== headSha) {
        return "artifact_gate_failed";
      }
    }

    if (
      loopVersion !== undefined &&
      Number.isFinite(loopVersion) &&
      artifact.loopVersion > loopVersion
    ) {
      return "artifact_gate_failed";
    }

    const loopPointerUpdate = buildLoopArtifactPointerUpdate({
      phase: expectedPhase,
      artifactId: artifact.id,
    });
    if (Object.keys(loopPointerUpdate).length > 0) {
      await tx
        .update(schema.sdlcLoop)
        .set({
          ...loopPointerUpdate,
          updatedAt: now,
        })
        .where(eq(schema.sdlcLoop.id, loopId));
    }

    return await persistGuardedGateLoopState({
      tx,
      loopId,
      transitionEvent,
      headSha,
      loopVersion,
      now,
    });
  });
}

export type SdlcLoopLeaseAcquireResult =
  | {
      acquired: true;
      leaseEpoch: number;
      leaseOwner: string;
      leaseExpiresAt: Date;
    }
  | {
      acquired: false;
      reason: "held_by_other";
      leaseOwner: string | null;
      leaseExpiresAt: Date | null;
    };

export async function acquireSdlcLoopLease({
  db,
  loopId,
  leaseOwner,
  leaseTtlMs,
  now = new Date(),
}: {
  db: DB;
  loopId: string;
  leaseOwner: string;
  leaseTtlMs: number;
  now?: Date;
}): Promise<SdlcLoopLeaseAcquireResult> {
  const leaseExpiresAt = new Date(now.getTime() + leaseTtlMs);

  const inserted = await db
    .insert(schema.sdlcLoopLease)
    .values({
      loopId,
      leaseOwner,
      leaseEpoch: 1,
      leaseExpiresAt,
    })
    .onConflictDoNothing()
    .returning({
      leaseEpoch: schema.sdlcLoopLease.leaseEpoch,
      leaseOwner: schema.sdlcLoopLease.leaseOwner,
      leaseExpiresAt: schema.sdlcLoopLease.leaseExpiresAt,
    });

  if (inserted[0]) {
    return {
      acquired: true,
      leaseEpoch: inserted[0].leaseEpoch,
      leaseOwner: inserted[0].leaseOwner ?? leaseOwner,
      leaseExpiresAt: inserted[0].leaseExpiresAt ?? leaseExpiresAt,
    };
  }

  const updated = await db
    .update(schema.sdlcLoopLease)
    .set({
      leaseOwner,
      leaseEpoch: sql`${schema.sdlcLoopLease.leaseEpoch} + 1`,
      leaseExpiresAt,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.sdlcLoopLease.loopId, loopId),
        or(
          eq(schema.sdlcLoopLease.leaseOwner, leaseOwner),
          isNull(schema.sdlcLoopLease.leaseExpiresAt),
          lte(schema.sdlcLoopLease.leaseExpiresAt, now),
        ),
      ),
    )
    .returning({
      leaseEpoch: schema.sdlcLoopLease.leaseEpoch,
      leaseOwner: schema.sdlcLoopLease.leaseOwner,
      leaseExpiresAt: schema.sdlcLoopLease.leaseExpiresAt,
    });

  if (updated[0]) {
    return {
      acquired: true,
      leaseEpoch: updated[0].leaseEpoch,
      leaseOwner: updated[0].leaseOwner ?? leaseOwner,
      leaseExpiresAt: updated[0].leaseExpiresAt ?? leaseExpiresAt,
    };
  }

  const existing = await db.query.sdlcLoopLease.findFirst({
    where: eq(schema.sdlcLoopLease.loopId, loopId),
  });

  return {
    acquired: false,
    reason: "held_by_other",
    leaseOwner: existing?.leaseOwner ?? null,
    leaseExpiresAt: existing?.leaseExpiresAt ?? null,
  };
}

export async function releaseSdlcLoopLease({
  db,
  loopId,
  leaseOwner,
  now = new Date(),
}: {
  db: DB;
  loopId: string;
  leaseOwner: string;
  now?: Date;
}) {
  const updated = await db
    .update(schema.sdlcLoopLease)
    .set({
      leaseOwner: null,
      leaseExpiresAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.sdlcLoopLease.loopId, loopId),
        eq(schema.sdlcLoopLease.leaseOwner, leaseOwner),
      ),
    )
    .returning({ loopId: schema.sdlcLoopLease.loopId });

  return updated.length > 0;
}

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

function normalizeOutboxErrorMessage(
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

export function classifySdlcVideoCaptureFailure(error: unknown): {
  failureClass: SdlcVideoFailureClass;
  failureCode: string;
  failureMessage: string;
} {
  const failureMessage =
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : typeof error === "string"
        ? error
        : (JSON.stringify(error) ?? String(error));
  const normalized = failureMessage.toLowerCase();

  if (
    /(401|403|unauthori[sz]ed|forbidden|auth|token|permission denied)/.test(
      normalized,
    )
  ) {
    return {
      failureClass: "auth",
      failureCode: "video_capture_auth",
      failureMessage,
    };
  }

  if (/(429|quota|rate limit|insufficient credits|billing)/.test(normalized)) {
    return {
      failureClass: "quota",
      failureCode: "video_capture_quota",
      failureMessage,
    };
  }

  if (
    /(script|selector|assert|dom|playwright|puppeteer|navigation failed)/.test(
      normalized,
    )
  ) {
    return {
      failureClass: "script",
      failureCode: "video_capture_script",
      failureMessage,
    };
  }

  return {
    failureClass: "infra",
    failureCode: "video_capture_infra",
    failureMessage,
  };
}

export function resolveSdlcReadyStateAfterVideoCapture({
  currentState,
  artifactR2Key,
}: {
  currentState: SdlcLoopState;
  artifactR2Key: string | null;
}): Extract<SdlcLoopState, "pr_babysitting" | "implementing" | "done"> | null {
  const transitionEvent: SdlcLoopTransitionEvent = artifactR2Key
    ? "video_capture_succeeded"
    : "video_capture_failed";
  const nextState = resolveSdlcLoopNextState({
    currentState,
    event: transitionEvent,
  });

  if (nextState === "pr_babysitting" || nextState === "implementing") {
    return nextState;
  }

  if (nextState === "done") {
    return "done";
  }

  return null;
}

export async function persistSdlcVideoCaptureOutcome({
  db,
  loopId,
  headSha,
  loopVersion,
  artifactR2Key,
  artifactMimeType,
  artifactBytes,
  failureClass,
  failureCode,
  failureMessage,
  now = new Date(),
}: {
  db: DB;
  loopId: string;
  headSha: string;
  loopVersion: number;
  artifactR2Key: string | null;
  artifactMimeType?: string | null;
  artifactBytes?: number | null;
  failureClass?: SdlcVideoFailureClass | null;
  failureCode?: string | null;
  failureMessage?: string | null;
  now?: Date;
}) {
  if (!artifactR2Key && !failureClass) {
    throw new Error(
      "persistSdlcVideoCaptureOutcome requires either an artifact or a failure class",
    );
  }

  const loop = await db.query.sdlcLoop.findFirst({
    where: eq(schema.sdlcLoop.id, loopId),
  });

  if (!loop) {
    throw new Error(`SDLC loop not found: ${loopId}`);
  }

  const normalizedLoopVersion = Math.max(Math.trunc(loopVersion), 0);
  if (loop.loopVersion > normalizedLoopVersion) {
    return loop;
  }
  if (
    loop.loopVersion === normalizedLoopVersion &&
    loop.currentHeadSha !== null &&
    loop.currentHeadSha !== headSha
  ) {
    return loop;
  }

  const nextState = resolveSdlcReadyStateAfterVideoCapture({
    currentState: loop.state,
    artifactR2Key,
  });
  if (!nextState) {
    return loop;
  }

  const whereCondition = and(
    eq(schema.sdlcLoop.id, loopId),
    eq(schema.sdlcLoop.state, loop.state),
    lte(schema.sdlcLoop.loopVersion, normalizedLoopVersion),
    or(
      lte(schema.sdlcLoop.loopVersion, normalizedLoopVersion - 1),
      isNull(schema.sdlcLoop.currentHeadSha),
      eq(schema.sdlcLoop.currentHeadSha, headSha),
    ),
  );

  const [updated] = await db
    .update(schema.sdlcLoop)
    .set({
      currentHeadSha: headSha,
      loopVersion: normalizedLoopVersion,
      state: nextState,
      videoCaptureStatus: artifactR2Key ? "captured" : "failed",
      latestVideoArtifactR2Key: artifactR2Key,
      latestVideoArtifactMimeType: artifactR2Key
        ? (artifactMimeType ?? null)
        : null,
      latestVideoArtifactBytes: artifactR2Key ? (artifactBytes ?? null) : null,
      latestVideoCapturedAt: artifactR2Key ? now : null,
      latestVideoFailureClass: artifactR2Key ? null : (failureClass ?? null),
      latestVideoFailureCode: artifactR2Key ? null : (failureCode ?? null),
      latestVideoFailureMessage: artifactR2Key
        ? null
        : normalizeOutboxErrorMessage(failureMessage ?? null),
      latestVideoFailedAt: artifactR2Key ? null : now,
      updatedAt: now,
    })
    .where(whereCondition)
    .returning();

  if (updated) {
    return updated;
  }

  return await db.query.sdlcLoop.findFirst({
    where: eq(schema.sdlcLoop.id, loopId),
  });
}

export async function recordSdlcParityMetricSample({
  db,
  causeType,
  targetClass,
  matched,
  eligible = true,
  observedAt = new Date(),
}: {
  db: DB;
  causeType: SdlcLoopCauseType;
  targetClass: SdlcParityTargetClass;
  matched: boolean;
  eligible?: boolean;
  observedAt?: Date;
}) {
  const [sample] = await db
    .insert(schema.sdlcParityMetricSample)
    .values({
      causeType,
      targetClass,
      matched,
      eligible,
      observedAt,
    })
    .returning();

  return sample;
}

export type SdlcParityBucketStats = {
  causeType: SdlcLoopCauseType;
  targetClass: SdlcParityTargetClass;
  eligibleCount: number;
  matchedCount: number;
  parity: number;
};

export async function getSdlcParityBucketStats({
  db,
  windowStart,
  windowEnd,
}: {
  db: DB;
  windowStart: Date;
  windowEnd: Date;
}): Promise<SdlcParityBucketStats[]> {
  const grouped = await db
    .select({
      causeType: schema.sdlcParityMetricSample.causeType,
      targetClass: schema.sdlcParityMetricSample.targetClass,
      eligibleCount: sql<number>`count(*)`,
      matchedCount: sql<number>`sum(case when ${schema.sdlcParityMetricSample.matched} then 1 else 0 end)`,
    })
    .from(schema.sdlcParityMetricSample)
    .where(
      and(
        eq(schema.sdlcParityMetricSample.eligible, true),
        gte(schema.sdlcParityMetricSample.observedAt, windowStart),
        lte(schema.sdlcParityMetricSample.observedAt, windowEnd),
      ),
    )
    .groupBy(
      schema.sdlcParityMetricSample.causeType,
      schema.sdlcParityMetricSample.targetClass,
    );

  return grouped.map((row) => {
    const eligibleCount = Number(row.eligibleCount ?? 0);
    const matchedCount = Number(row.matchedCount ?? 0);
    const parity = eligibleCount === 0 ? 1 : matchedCount / eligibleCount;

    return {
      causeType: row.causeType,
      targetClass: row.targetClass,
      eligibleCount,
      matchedCount,
      parity,
    };
  });
}

export function evaluateSdlcParitySlo({
  bucketStats,
  criticalInvariantViolation,
  cutoverThreshold = 0.999,
  rollbackThreshold = 0.99,
}: {
  bucketStats: SdlcParityBucketStats[];
  criticalInvariantViolation: boolean;
  cutoverThreshold?: number;
  rollbackThreshold?: number;
}) {
  const failingCutoverBuckets = bucketStats.filter(
    (bucket) => bucket.eligibleCount === 0 || bucket.parity < cutoverThreshold,
  );
  const failingRollbackBuckets = bucketStats.filter(
    (bucket) => bucket.eligibleCount > 0 && bucket.parity < rollbackThreshold,
  );

  return {
    cutoverEligible:
      bucketStats.length > 0 &&
      failingCutoverBuckets.length === 0 &&
      !criticalInvariantViolation,
    rollbackRequired:
      criticalInvariantViolation || failingRollbackBuckets.length > 0,
    failingCutoverBuckets,
    failingRollbackBuckets,
  };
}

export async function claimGithubWebhookDelivery({
  db,
  deliveryId,
  claimantToken,
  eventType,
  now = new Date(),
}: {
  db: DB;
  deliveryId: string;
  claimantToken: string;
  eventType?: string;
  now?: Date;
}): Promise<GithubWebhookDeliveryClaimResult> {
  const claimExpiresAt = new Date(now.getTime() + GITHUB_WEBHOOK_CLAIM_TTL_MS);

  const inserted = await db
    .insert(schema.githubWebhookDeliveries)
    .values({
      deliveryId,
      claimantToken,
      claimExpiresAt,
      eventType: eventType ?? null,
    })
    .onConflictDoNothing()
    .returning({ deliveryId: schema.githubWebhookDeliveries.deliveryId });

  if (inserted.length > 0) {
    return { outcome: "claimed_new", shouldProcess: true };
  }

  const existing = await db.query.githubWebhookDeliveries.findFirst({
    where: eq(schema.githubWebhookDeliveries.deliveryId, deliveryId),
  });

  if (!existing) {
    return { outcome: "in_progress_fresh", shouldProcess: false };
  }

  if (existing.completedAt) {
    return { outcome: "already_completed", shouldProcess: false };
  }

  if (existing.claimExpiresAt > now) {
    return { outcome: "in_progress_fresh", shouldProcess: false };
  }

  const stolen = await db
    .update(schema.githubWebhookDeliveries)
    .set({
      claimantToken,
      claimExpiresAt,
      eventType: eventType ?? existing.eventType,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.githubWebhookDeliveries.deliveryId, deliveryId),
        isNull(schema.githubWebhookDeliveries.completedAt),
        lte(schema.githubWebhookDeliveries.claimExpiresAt, now),
      ),
    )
    .returning({ deliveryId: schema.githubWebhookDeliveries.deliveryId });

  if (stolen.length > 0) {
    return { outcome: "stale_stolen", shouldProcess: true };
  }

  const raced = await db.query.githubWebhookDeliveries.findFirst({
    where: eq(schema.githubWebhookDeliveries.deliveryId, deliveryId),
  });

  if (raced?.completedAt) {
    return { outcome: "already_completed", shouldProcess: false };
  }

  return { outcome: "in_progress_fresh", shouldProcess: false };
}

export async function completeGithubWebhookDelivery({
  db,
  deliveryId,
  claimantToken,
  completedAt = new Date(),
}: {
  db: DB;
  deliveryId: string;
  claimantToken: string;
  completedAt?: Date;
}): Promise<boolean> {
  const updated = await db
    .update(schema.githubWebhookDeliveries)
    .set({
      completedAt,
      updatedAt: completedAt,
    })
    .where(
      and(
        eq(schema.githubWebhookDeliveries.deliveryId, deliveryId),
        eq(schema.githubWebhookDeliveries.claimantToken, claimantToken),
        isNull(schema.githubWebhookDeliveries.completedAt),
      ),
    )
    .returning({ deliveryId: schema.githubWebhookDeliveries.deliveryId });

  return updated.length > 0;
}

export async function releaseGithubWebhookDeliveryClaim({
  db,
  deliveryId,
  claimantToken,
  releasedAt = new Date(),
}: {
  db: DB;
  deliveryId: string;
  claimantToken: string;
  releasedAt?: Date;
}): Promise<boolean> {
  const updated = await db
    .update(schema.githubWebhookDeliveries)
    .set({
      claimExpiresAt: releasedAt,
      updatedAt: releasedAt,
    })
    .where(
      and(
        eq(schema.githubWebhookDeliveries.deliveryId, deliveryId),
        eq(schema.githubWebhookDeliveries.claimantToken, claimantToken),
        isNull(schema.githubWebhookDeliveries.completedAt),
      ),
    )
    .returning({ deliveryId: schema.githubWebhookDeliveries.deliveryId });

  return updated.length > 0;
}

function normalizeCheckNames(checks: string[]): string[] {
  return [...new Set(checks.map((check) => check.trim()).filter(Boolean))].sort(
    (a, b) => a.localeCompare(b),
  );
}

function resolveRequiredCheckSource({
  rulesetChecks,
  branchProtectionChecks,
  allowlistChecks,
}: {
  rulesetChecks: string[];
  branchProtectionChecks: string[];
  allowlistChecks: string[];
}): {
  source: SdlcCiRequiredCheckSource;
  requiredChecks: string[];
} {
  if (rulesetChecks.length > 0) {
    return { source: "ruleset", requiredChecks: rulesetChecks };
  }
  if (branchProtectionChecks.length > 0) {
    return {
      source: "branch_protection",
      requiredChecks: branchProtectionChecks,
    };
  }
  if (allowlistChecks.length > 0) {
    return { source: "allowlist", requiredChecks: allowlistChecks };
  }
  return { source: "no_required", requiredChecks: [] };
}

export type SdlcGateLoopUpdateOutcome =
  | "updated"
  | "terminal_noop"
  | "stale_noop";

const fixAttemptIncrementEvents: ReadonlySet<SdlcLoopTransitionEvent> = new Set(
  [
    "review_blocked",
    "ui_smoke_failed",
    "babysit_blocked",
    // Legacy gate-blocked events still increment attempts during migration.
    "ci_gate_blocked",
    "review_threads_gate_blocked",
    "deep_review_gate_blocked",
    "carmack_review_gate_blocked",
  ],
);

async function persistGuardedGateLoopState({
  tx,
  loopId,
  transitionEvent,
  headSha,
  loopVersion,
  now = new Date(),
}: {
  tx: Pick<DB, "query" | "update">;
  loopId: string;
  transitionEvent: SdlcLoopTransitionEvent;
  headSha?: string | null;
  loopVersion?: number;
  now?: Date;
}): Promise<SdlcGateLoopUpdateOutcome> {
  const loop = await tx.query.sdlcLoop.findFirst({
    where: eq(schema.sdlcLoop.id, loopId),
    columns: {
      state: true,
      loopVersion: true,
      currentHeadSha: true,
      fixAttemptCount: true,
      maxFixAttempts: true,
    },
  });

  if (!loop) {
    return "stale_noop";
  }

  if (!activeSdlcLoopStateSet.has(loop.state)) {
    return "terminal_noop";
  }

  const normalizedLoopVersion =
    typeof loopVersion === "number" && Number.isFinite(loopVersion)
      ? Math.max(Math.trunc(loopVersion), 0)
      : null;
  if (
    transitionEvent === "implementation_progress" &&
    normalizedLoopVersion === null &&
    loop.state !== "planning" &&
    loop.state !== "implementing"
  ) {
    return "stale_noop";
  }
  let nextState = resolveSdlcLoopNextState({
    currentState: loop.state,
    event: transitionEvent,
  });

  if (!nextState) {
    return "stale_noop";
  }

  const shouldIncrementFixAttempt =
    fixAttemptIncrementEvents.has(transitionEvent);
  const nextFixAttemptCount = shouldIncrementFixAttempt
    ? loop.fixAttemptCount + 1
    : loop.fixAttemptCount;
  if (
    shouldIncrementFixAttempt &&
    nextFixAttemptCount > Math.max(loop.maxFixAttempts, 0)
  ) {
    nextState = "blocked_on_human_feedback";
  }

  if (normalizedLoopVersion !== null) {
    if (loop.loopVersion > normalizedLoopVersion) {
      return "stale_noop";
    }

    if (
      typeof headSha === "string" &&
      loop.loopVersion === normalizedLoopVersion &&
      loop.currentHeadSha !== null &&
      loop.currentHeadSha !== headSha
    ) {
      return "stale_noop";
    }
  }

  const nextValues: {
    state: SdlcLoopState;
    updatedAt: Date;
    currentHeadSha?: string | null;
    loopVersion?: number;
    fixAttemptCount?: number;
  } = {
    state: nextState,
    updatedAt: now,
  };
  if (shouldIncrementFixAttempt) {
    nextValues.fixAttemptCount = nextFixAttemptCount;
  }
  if (
    normalizedLoopVersion !== null &&
    (typeof headSha === "string" || headSha === null)
  ) {
    nextValues.currentHeadSha = headSha;
  }
  if (normalizedLoopVersion !== null) {
    nextValues.loopVersion = normalizedLoopVersion;
  }

  let whereCondition = and(
    eq(schema.sdlcLoop.id, loopId),
    eq(schema.sdlcLoop.state, loop.state),
    inArray(schema.sdlcLoop.state, activeSdlcLoopStateList),
  );

  if (normalizedLoopVersion !== null && whereCondition) {
    whereCondition = and(
      whereCondition,
      lte(schema.sdlcLoop.loopVersion, normalizedLoopVersion),
    );
    if (typeof headSha === "string" && whereCondition) {
      const headShaGuard = or(
        lte(schema.sdlcLoop.loopVersion, normalizedLoopVersion - 1),
        isNull(schema.sdlcLoop.currentHeadSha),
        eq(schema.sdlcLoop.currentHeadSha, headSha),
      );
      if (headShaGuard) {
        whereCondition = and(whereCondition, headShaGuard);
      }
    }
  }

  if (!whereCondition) {
    return "stale_noop";
  }

  const [updated] = await tx
    .update(schema.sdlcLoop)
    .set(nextValues)
    .where(whereCondition)
    .returning({ id: schema.sdlcLoop.id });

  return updated ? "updated" : "stale_noop";
}

export async function transitionSdlcLoopState({
  db,
  loopId,
  transitionEvent,
  headSha,
  loopVersion,
  now = new Date(),
}: {
  db: DB;
  loopId: string;
  transitionEvent: SdlcLoopTransitionEvent;
  headSha?: string | null;
  loopVersion?: number;
  now?: Date;
}): Promise<SdlcGateLoopUpdateOutcome> {
  return await db.transaction(async (tx) => {
    return await persistGuardedGateLoopState({
      tx,
      loopId,
      transitionEvent,
      headSha,
      loopVersion,
      now,
    });
  });
}

export type PersistSdlcCiGateEvaluationResult = {
  runId: string;
  status: SdlcCiGateStatus;
  gatePassed: boolean;
  requiredCheckSource: SdlcCiRequiredCheckSource;
  requiredChecks: string[];
  failingRequiredChecks: string[];
  shouldQueueFollowUp: boolean;
  loopUpdateOutcome: SdlcGateLoopUpdateOutcome;
};

export async function persistSdlcCiGateEvaluation({
  db,
  loopId,
  headSha,
  loopVersion,
  triggerEventType,
  capabilityState,
  rulesetChecks = [],
  branchProtectionChecks = [],
  allowlistChecks = [],
  failingChecks = [],
  provenance,
  normalizationVersion = 1,
  now = new Date(),
}: {
  db: DB;
  loopId: string;
  headSha: string;
  loopVersion: number;
  triggerEventType: "check_run.completed" | "check_suite.completed";
  capabilityState: SdlcCiCapabilityState;
  rulesetChecks?: string[];
  branchProtectionChecks?: string[];
  allowlistChecks?: string[];
  failingChecks?: string[];
  provenance?: Record<string, unknown>;
  normalizationVersion?: number;
  now?: Date;
}): Promise<PersistSdlcCiGateEvaluationResult> {
  return await db.transaction(async (tx) => {
    const normalizedRuleset = normalizeCheckNames(rulesetChecks);
    const normalizedBranchProtection = normalizeCheckNames(
      branchProtectionChecks,
    );
    const normalizedAllowlist = normalizeCheckNames(allowlistChecks);
    const normalizedFailing = normalizeCheckNames(failingChecks);

    const { source, requiredChecks } = resolveRequiredCheckSource({
      rulesetChecks: normalizedRuleset,
      branchProtectionChecks: normalizedBranchProtection,
      allowlistChecks: normalizedAllowlist,
    });

    const relevantFailingChecks = normalizedFailing.filter((check) =>
      requiredChecks.includes(check),
    );

    const hasCapabilityError = capabilityState !== "supported";
    const gatePassed =
      !hasCapabilityError &&
      (requiredChecks.length === 0 || relevantFailingChecks.length === 0);
    const status: SdlcCiGateStatus = hasCapabilityError
      ? "capability_error"
      : gatePassed
        ? "passed"
        : "blocked";

    const [run] = await tx
      .insert(schema.sdlcCiGateRun)
      .values({
        loopId,
        headSha,
        loopVersion,
        status,
        gatePassed,
        actorType: "installation_app",
        capabilityState,
        requiredCheckSource: source,
        requiredChecks,
        failingRequiredChecks: relevantFailingChecks,
        provenance: provenance ?? null,
        normalizationVersion,
        triggerEventType,
        errorCode: hasCapabilityError
          ? `ci_capability_${capabilityState}`
          : null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [schema.sdlcCiGateRun.loopId, schema.sdlcCiGateRun.headSha],
        set: {
          loopVersion,
          status,
          gatePassed,
          actorType: "installation_app",
          capabilityState,
          requiredCheckSource: source,
          requiredChecks,
          failingRequiredChecks: relevantFailingChecks,
          provenance: provenance ?? null,
          normalizationVersion,
          triggerEventType,
          errorCode: hasCapabilityError
            ? `ci_capability_${capabilityState}`
            : null,
          updatedAt: now,
        },
      })
      .returning({ id: schema.sdlcCiGateRun.id });

    if (!run) {
      throw new Error("Failed to persist CI gate run");
    }

    const loopUpdateOutcome = await persistGuardedGateLoopState({
      tx,
      loopId,
      headSha,
      loopVersion,
      transitionEvent: gatePassed ? "ci_gate_passed" : "ci_gate_blocked",
      now,
    });

    return {
      runId: run.id,
      status,
      gatePassed,
      requiredCheckSource: source,
      requiredChecks,
      failingRequiredChecks: relevantFailingChecks,
      shouldQueueFollowUp: !gatePassed && loopUpdateOutcome === "updated",
      loopUpdateOutcome,
    };
  });
}

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
  now?: Date;
}): Promise<PersistSdlcReviewThreadGateResult> {
  return await db.transaction(async (tx) => {
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

const deepReviewSeveritySchema = z.enum(["critical", "high", "medium", "low"]);

export const deepReviewFindingSchema = z.object({
  stableFindingId: z.string().trim().min(1).optional(),
  title: z.string().trim().min(1),
  severity: deepReviewSeveritySchema,
  category: z.string().trim().min(1),
  detail: z.string().trim().min(1),
  suggestedFix: z.string().trim().min(1).nullable().optional(),
  isBlocking: z.boolean().optional().default(true),
});

export const deepReviewGateOutputSchema = z.object({
  gatePassed: z.boolean(),
  blockingFindings: z.array(deepReviewFindingSchema),
});

export type DeepReviewGateOutput = z.infer<typeof deepReviewGateOutputSchema>;

type NormalizedDeepReviewFinding = {
  stableFindingId: string;
  title: string;
  severity: SdlcDeepReviewSeverity;
  category: string;
  detail: string;
  suggestedFix: string | null;
  isBlocking: boolean;
};

export type PersistDeepReviewGateResult = {
  runId: string;
  status: SdlcDeepReviewStatus;
  gatePassed: boolean;
  invalidOutput: boolean;
  errorCode: string | null;
  unresolvedBlockingFindings: number;
  shouldQueueFollowUp: boolean;
  loopUpdateOutcome: SdlcGateLoopUpdateOutcome;
  findings: NormalizedDeepReviewFinding[];
};

const DEEP_REVIEW_INVALID_OUTPUT_ERROR = "deep_review_invalid_output";

function buildDeepReviewFindingStableId(
  finding: z.infer<typeof deepReviewFindingSchema>,
): string {
  if (finding.stableFindingId?.trim()) {
    return finding.stableFindingId.trim();
  }

  const canonical = [
    finding.title.trim().toLowerCase(),
    finding.severity,
    finding.category.trim().toLowerCase(),
    finding.detail.trim().toLowerCase(),
  ].join("|");

  return `deep_review_${createHash("sha256").update(canonical).digest("hex").slice(0, 24)}`;
}

function normalizeDeepReviewFindings(
  findings: z.infer<typeof deepReviewFindingSchema>[],
): NormalizedDeepReviewFinding[] {
  const deduped = new Map<string, NormalizedDeepReviewFinding>();

  for (const finding of findings) {
    const stableFindingId = buildDeepReviewFindingStableId(finding);
    if (deduped.has(stableFindingId)) {
      continue;
    }
    deduped.set(stableFindingId, {
      stableFindingId,
      title: finding.title.trim(),
      severity: finding.severity,
      category: finding.category.trim(),
      detail: finding.detail.trim(),
      suggestedFix: finding.suggestedFix?.trim() || null,
      isBlocking: finding.isBlocking,
    });
  }

  return [...deduped.values()];
}

type DeepReviewParseResult =
  | { ok: true; output: DeepReviewGateOutput }
  | {
      ok: false;
      errorCode: typeof DEEP_REVIEW_INVALID_OUTPUT_ERROR;
      errorDetails: string[];
    };

export function parseDeepReviewGateOutput(
  rawOutput: unknown,
): DeepReviewParseResult {
  const parsed = deepReviewGateOutputSchema.safeParse(rawOutput);
  if (!parsed.success) {
    return {
      ok: false,
      errorCode: DEEP_REVIEW_INVALID_OUTPUT_ERROR,
      errorDetails: parsed.error.issues.map((issue) => issue.message),
    };
  }
  return { ok: true, output: parsed.data };
}

export async function persistDeepReviewGateResult({
  db,
  loopId,
  headSha,
  loopVersion,
  model,
  rawOutput,
  promptVersion = 1,
  updateLoopState = true,
}: {
  db: DB;
  loopId: string;
  headSha: string;
  loopVersion: number;
  model: string;
  rawOutput: unknown;
  promptVersion?: number;
  updateLoopState?: boolean;
}): Promise<PersistDeepReviewGateResult> {
  return await db.transaction(async (tx) => {
    const parsed = parseDeepReviewGateOutput(rawOutput);

    if (!parsed.ok) {
      const [run] = await tx
        .insert(schema.sdlcDeepReviewRun)
        .values({
          loopId,
          headSha,
          loopVersion,
          status: "invalid_output",
          gatePassed: false,
          invalidOutput: true,
          model,
          promptVersion,
          rawOutput,
          errorCode: parsed.errorCode,
        })
        .onConflictDoUpdate({
          target: [
            schema.sdlcDeepReviewRun.loopId,
            schema.sdlcDeepReviewRun.headSha,
          ],
          set: {
            loopVersion,
            status: "invalid_output",
            gatePassed: false,
            invalidOutput: true,
            model,
            promptVersion,
            rawOutput,
            errorCode: parsed.errorCode,
            updatedAt: new Date(),
          },
        })
        .returning();

      if (!run) {
        throw new Error("Failed to persist invalid-output deep review run");
      }

      await tx
        .delete(schema.sdlcDeepReviewFinding)
        .where(
          and(
            eq(schema.sdlcDeepReviewFinding.loopId, loopId),
            eq(schema.sdlcDeepReviewFinding.headSha, headSha),
          ),
        );

      const loopUpdateOutcome = updateLoopState
        ? await persistGuardedGateLoopState({
            tx,
            loopId,
            headSha,
            loopVersion,
            transitionEvent: "deep_review_gate_blocked",
            now: new Date(),
          })
        : "stale_noop";

      return {
        runId: run.id,
        status: "invalid_output",
        gatePassed: false,
        invalidOutput: true,
        errorCode: parsed.errorCode,
        unresolvedBlockingFindings: 0,
        shouldQueueFollowUp: false,
        loopUpdateOutcome,
        findings: [],
      };
    }

    const findings = normalizeDeepReviewFindings(
      parsed.output.blockingFindings,
    );
    const blockingFindings = findings.filter((finding) => finding.isBlocking);
    const gatePassed =
      parsed.output.gatePassed && blockingFindings.length === 0;
    const status: SdlcDeepReviewStatus = gatePassed ? "passed" : "blocked";

    const [run] = await tx
      .insert(schema.sdlcDeepReviewRun)
      .values({
        loopId,
        headSha,
        loopVersion,
        status,
        gatePassed,
        invalidOutput: false,
        model,
        promptVersion,
        rawOutput,
        errorCode: null,
      })
      .onConflictDoUpdate({
        target: [
          schema.sdlcDeepReviewRun.loopId,
          schema.sdlcDeepReviewRun.headSha,
        ],
        set: {
          loopVersion,
          status,
          gatePassed,
          invalidOutput: false,
          model,
          promptVersion,
          rawOutput,
          errorCode: null,
          updatedAt: new Date(),
        },
      })
      .returning();

    if (!run) {
      throw new Error("Failed to persist deep review run");
    }

    if (findings.length === 0) {
      await tx
        .delete(schema.sdlcDeepReviewFinding)
        .where(
          and(
            eq(schema.sdlcDeepReviewFinding.loopId, loopId),
            eq(schema.sdlcDeepReviewFinding.headSha, headSha),
          ),
        );
    } else {
      const stableFindingIds = findings.map(
        (finding) => finding.stableFindingId,
      );
      await tx
        .delete(schema.sdlcDeepReviewFinding)
        .where(
          and(
            eq(schema.sdlcDeepReviewFinding.loopId, loopId),
            eq(schema.sdlcDeepReviewFinding.headSha, headSha),
            notInArray(
              schema.sdlcDeepReviewFinding.stableFindingId,
              stableFindingIds,
            ),
          ),
        );

      for (const finding of findings) {
        await tx
          .insert(schema.sdlcDeepReviewFinding)
          .values({
            reviewRunId: run.id,
            loopId,
            headSha,
            stableFindingId: finding.stableFindingId,
            title: finding.title,
            severity: finding.severity,
            category: finding.category,
            detail: finding.detail,
            suggestedFix: finding.suggestedFix,
            isBlocking: finding.isBlocking,
          })
          .onConflictDoUpdate({
            target: [
              schema.sdlcDeepReviewFinding.loopId,
              schema.sdlcDeepReviewFinding.headSha,
              schema.sdlcDeepReviewFinding.stableFindingId,
            ],
            set: {
              reviewRunId: run.id,
              title: finding.title,
              severity: finding.severity,
              category: finding.category,
              detail: finding.detail,
              suggestedFix: finding.suggestedFix,
              isBlocking: finding.isBlocking,
              resolvedAt: null,
              resolvedByEventId: null,
              updatedAt: new Date(),
            },
          });
      }
    }

    const loopUpdateOutcome = updateLoopState
      ? await persistGuardedGateLoopState({
          tx,
          loopId,
          headSha,
          loopVersion,
          transitionEvent:
            status === "blocked"
              ? "deep_review_gate_blocked"
              : "deep_review_gate_passed",
          now: new Date(),
        })
      : "stale_noop";

    const unresolvedBlockingFindings = (
      await tx
        .select({ id: schema.sdlcDeepReviewFinding.id })
        .from(schema.sdlcDeepReviewFinding)
        .where(
          and(
            eq(schema.sdlcDeepReviewFinding.loopId, loopId),
            eq(schema.sdlcDeepReviewFinding.headSha, headSha),
            eq(schema.sdlcDeepReviewFinding.isBlocking, true),
            isNull(schema.sdlcDeepReviewFinding.resolvedAt),
          ),
        )
    ).length;

    return {
      runId: run.id,
      status,
      gatePassed,
      invalidOutput: false,
      errorCode: null,
      unresolvedBlockingFindings,
      shouldQueueFollowUp:
        loopUpdateOutcome === "updated" && unresolvedBlockingFindings > 0,
      loopUpdateOutcome,
      findings,
    };
  });
}

export async function getUnresolvedBlockingDeepReviewFindings({
  db,
  loopId,
  headSha,
}: {
  db: DB;
  loopId: string;
  headSha: string;
}) {
  return await db.query.sdlcDeepReviewFinding.findMany({
    where: and(
      eq(schema.sdlcDeepReviewFinding.loopId, loopId),
      eq(schema.sdlcDeepReviewFinding.headSha, headSha),
      eq(schema.sdlcDeepReviewFinding.isBlocking, true),
      isNull(schema.sdlcDeepReviewFinding.resolvedAt),
    ),
    orderBy: [schema.sdlcDeepReviewFinding.createdAt],
  });
}

export async function resolveDeepReviewFinding({
  db,
  loopId,
  headSha,
  stableFindingId,
  resolvedByEventId,
}: {
  db: DB;
  loopId: string;
  headSha: string;
  stableFindingId: string;
  resolvedByEventId: string;
}) {
  const [finding] = await db
    .update(schema.sdlcDeepReviewFinding)
    .set({
      resolvedAt: new Date(),
      resolvedByEventId,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.sdlcDeepReviewFinding.loopId, loopId),
        eq(schema.sdlcDeepReviewFinding.headSha, headSha),
        eq(schema.sdlcDeepReviewFinding.stableFindingId, stableFindingId),
      ),
    )
    .returning();

  return finding;
}

export async function shouldQueueFollowUpForDeepReview({
  db,
  loopId,
  headSha,
}: {
  db: DB;
  loopId: string;
  headSha: string;
}) {
  const unresolved = await getUnresolvedBlockingDeepReviewFindings({
    db,
    loopId,
    headSha,
  });
  return unresolved.length > 0;
}

const carmackReviewSeveritySchema = z.enum([
  "critical",
  "high",
  "medium",
  "low",
]);

export const carmackReviewFindingSchema = z.object({
  stableFindingId: z.string().trim().min(1).optional(),
  title: z.string().trim().min(1),
  severity: carmackReviewSeveritySchema,
  category: z.string().trim().min(1),
  detail: z.string().trim().min(1),
  suggestedFix: z.string().trim().min(1).nullable().optional(),
  isBlocking: z.boolean().optional().default(true),
});

export const carmackReviewGateOutputSchema = z.object({
  gatePassed: z.boolean(),
  blockingFindings: z.array(carmackReviewFindingSchema),
});

export type CarmackReviewGateOutput = z.infer<
  typeof carmackReviewGateOutputSchema
>;

type NormalizedCarmackReviewFinding = {
  stableFindingId: string;
  title: string;
  severity: SdlcCarmackReviewSeverity;
  category: string;
  detail: string;
  suggestedFix: string | null;
  isBlocking: boolean;
};

export type PersistCarmackReviewGateResult = {
  runId: string;
  status: SdlcCarmackReviewStatus;
  gatePassed: boolean;
  invalidOutput: boolean;
  errorCode: string | null;
  unresolvedBlockingFindings: number;
  shouldQueueFollowUp: boolean;
  loopUpdateOutcome: SdlcGateLoopUpdateOutcome;
  findings: NormalizedCarmackReviewFinding[];
};

const CARMACK_REVIEW_INVALID_OUTPUT_ERROR = "carmack_review_invalid_output";

type CarmackReviewParseResult =
  | { ok: true; output: CarmackReviewGateOutput }
  | {
      ok: false;
      errorCode: typeof CARMACK_REVIEW_INVALID_OUTPUT_ERROR;
      errorDetails: string[];
    };

function buildCarmackReviewFindingStableId(
  finding: z.infer<typeof carmackReviewFindingSchema>,
): string {
  if (finding.stableFindingId?.trim()) {
    return finding.stableFindingId.trim();
  }

  const canonical = [
    finding.title.trim().toLowerCase(),
    finding.severity,
    finding.category.trim().toLowerCase(),
    finding.detail.trim().toLowerCase(),
  ].join("|");

  return `carmack_review_${createHash("sha256").update(canonical).digest("hex").slice(0, 24)}`;
}

function normalizeCarmackReviewFindings(
  findings: z.infer<typeof carmackReviewFindingSchema>[],
): NormalizedCarmackReviewFinding[] {
  const deduped = new Map<string, NormalizedCarmackReviewFinding>();

  for (const finding of findings) {
    const stableFindingId = buildCarmackReviewFindingStableId(finding);
    if (deduped.has(stableFindingId)) {
      continue;
    }
    deduped.set(stableFindingId, {
      stableFindingId,
      title: finding.title.trim(),
      severity: finding.severity,
      category: finding.category.trim(),
      detail: finding.detail.trim(),
      suggestedFix: finding.suggestedFix?.trim() || null,
      isBlocking: finding.isBlocking,
    });
  }

  return [...deduped.values()];
}

export function parseCarmackReviewGateOutput(
  rawOutput: unknown,
): CarmackReviewParseResult {
  const parsed = carmackReviewGateOutputSchema.safeParse(rawOutput);
  if (!parsed.success) {
    return {
      ok: false,
      errorCode: CARMACK_REVIEW_INVALID_OUTPUT_ERROR,
      errorDetails: parsed.error.issues.map((issue) => issue.message),
    };
  }
  return { ok: true, output: parsed.data };
}

export async function canRunCarmackReviewForHeadSha({
  db,
  loopId,
  headSha,
}: {
  db: DB;
  loopId: string;
  headSha: string;
}) {
  const deepReviewRun = await db.query.sdlcDeepReviewRun.findFirst({
    where: and(
      eq(schema.sdlcDeepReviewRun.loopId, loopId),
      eq(schema.sdlcDeepReviewRun.headSha, headSha),
    ),
    orderBy: [schema.sdlcDeepReviewRun.updatedAt],
  });

  return Boolean(
    deepReviewRun?.gatePassed && deepReviewRun.status === "passed",
  );
}

export async function persistCarmackReviewGateResult({
  db,
  loopId,
  headSha,
  loopVersion,
  model,
  rawOutput,
  promptVersion = 1,
  updateLoopState = true,
}: {
  db: DB;
  loopId: string;
  headSha: string;
  loopVersion: number;
  model: string;
  rawOutput: unknown;
  promptVersion?: number;
  updateLoopState?: boolean;
}): Promise<PersistCarmackReviewGateResult> {
  return await db.transaction(async (tx) => {
    const parsed = parseCarmackReviewGateOutput(rawOutput);

    if (!parsed.ok) {
      const [run] = await tx
        .insert(schema.sdlcCarmackReviewRun)
        .values({
          loopId,
          headSha,
          loopVersion,
          status: "invalid_output",
          gatePassed: false,
          invalidOutput: true,
          model,
          promptVersion,
          rawOutput,
          errorCode: parsed.errorCode,
        })
        .onConflictDoUpdate({
          target: [
            schema.sdlcCarmackReviewRun.loopId,
            schema.sdlcCarmackReviewRun.headSha,
          ],
          set: {
            loopVersion,
            status: "invalid_output",
            gatePassed: false,
            invalidOutput: true,
            model,
            promptVersion,
            rawOutput,
            errorCode: parsed.errorCode,
            updatedAt: new Date(),
          },
        })
        .returning();

      if (!run) {
        throw new Error("Failed to persist invalid-output carmack review run");
      }

      await tx
        .delete(schema.sdlcCarmackReviewFinding)
        .where(
          and(
            eq(schema.sdlcCarmackReviewFinding.loopId, loopId),
            eq(schema.sdlcCarmackReviewFinding.headSha, headSha),
          ),
        );

      const loopUpdateOutcome = updateLoopState
        ? await persistGuardedGateLoopState({
            tx,
            loopId,
            headSha,
            loopVersion,
            transitionEvent: "carmack_review_gate_blocked",
            now: new Date(),
          })
        : "stale_noop";

      return {
        runId: run.id,
        status: "invalid_output",
        gatePassed: false,
        invalidOutput: true,
        errorCode: parsed.errorCode,
        unresolvedBlockingFindings: 0,
        shouldQueueFollowUp: false,
        loopUpdateOutcome,
        findings: [],
      };
    }

    const findings = normalizeCarmackReviewFindings(
      parsed.output.blockingFindings,
    );
    const blockingFindings = findings.filter((finding) => finding.isBlocking);
    const gatePassed =
      parsed.output.gatePassed && blockingFindings.length === 0;
    const status: SdlcCarmackReviewStatus = gatePassed ? "passed" : "blocked";

    const [run] = await tx
      .insert(schema.sdlcCarmackReviewRun)
      .values({
        loopId,
        headSha,
        loopVersion,
        status,
        gatePassed,
        invalidOutput: false,
        model,
        promptVersion,
        rawOutput,
        errorCode: null,
      })
      .onConflictDoUpdate({
        target: [
          schema.sdlcCarmackReviewRun.loopId,
          schema.sdlcCarmackReviewRun.headSha,
        ],
        set: {
          loopVersion,
          status,
          gatePassed,
          invalidOutput: false,
          model,
          promptVersion,
          rawOutput,
          errorCode: null,
          updatedAt: new Date(),
        },
      })
      .returning();

    if (!run) {
      throw new Error("Failed to persist carmack review run");
    }

    if (findings.length === 0) {
      await tx
        .delete(schema.sdlcCarmackReviewFinding)
        .where(
          and(
            eq(schema.sdlcCarmackReviewFinding.loopId, loopId),
            eq(schema.sdlcCarmackReviewFinding.headSha, headSha),
          ),
        );
    } else {
      const stableFindingIds = findings.map(
        (finding) => finding.stableFindingId,
      );

      await tx
        .delete(schema.sdlcCarmackReviewFinding)
        .where(
          and(
            eq(schema.sdlcCarmackReviewFinding.loopId, loopId),
            eq(schema.sdlcCarmackReviewFinding.headSha, headSha),
            notInArray(
              schema.sdlcCarmackReviewFinding.stableFindingId,
              stableFindingIds,
            ),
          ),
        );

      for (const finding of findings) {
        await tx
          .insert(schema.sdlcCarmackReviewFinding)
          .values({
            reviewRunId: run.id,
            loopId,
            headSha,
            stableFindingId: finding.stableFindingId,
            title: finding.title,
            severity: finding.severity,
            category: finding.category,
            detail: finding.detail,
            suggestedFix: finding.suggestedFix,
            isBlocking: finding.isBlocking,
          })
          .onConflictDoUpdate({
            target: [
              schema.sdlcCarmackReviewFinding.loopId,
              schema.sdlcCarmackReviewFinding.headSha,
              schema.sdlcCarmackReviewFinding.stableFindingId,
            ],
            set: {
              reviewRunId: run.id,
              title: finding.title,
              severity: finding.severity,
              category: finding.category,
              detail: finding.detail,
              suggestedFix: finding.suggestedFix,
              isBlocking: finding.isBlocking,
              resolvedAt: null,
              resolvedByEventId: null,
              updatedAt: new Date(),
            },
          });
      }
    }

    const loopUpdateOutcome = updateLoopState
      ? await persistGuardedGateLoopState({
          tx,
          loopId,
          headSha,
          loopVersion,
          transitionEvent:
            status === "blocked"
              ? "carmack_review_gate_blocked"
              : "carmack_review_gate_passed",
          now: new Date(),
        })
      : "stale_noop";

    const unresolvedBlockingFindings = (
      await tx
        .select({ id: schema.sdlcCarmackReviewFinding.id })
        .from(schema.sdlcCarmackReviewFinding)
        .where(
          and(
            eq(schema.sdlcCarmackReviewFinding.loopId, loopId),
            eq(schema.sdlcCarmackReviewFinding.headSha, headSha),
            eq(schema.sdlcCarmackReviewFinding.isBlocking, true),
            isNull(schema.sdlcCarmackReviewFinding.resolvedAt),
          ),
        )
    ).length;

    return {
      runId: run.id,
      status,
      gatePassed,
      invalidOutput: false,
      errorCode: null,
      unresolvedBlockingFindings,
      shouldQueueFollowUp:
        loopUpdateOutcome === "updated" && unresolvedBlockingFindings > 0,
      loopUpdateOutcome,
      findings,
    };
  });
}

export async function getUnresolvedBlockingCarmackReviewFindings({
  db,
  loopId,
  headSha,
}: {
  db: DB;
  loopId: string;
  headSha: string;
}) {
  return await db.query.sdlcCarmackReviewFinding.findMany({
    where: and(
      eq(schema.sdlcCarmackReviewFinding.loopId, loopId),
      eq(schema.sdlcCarmackReviewFinding.headSha, headSha),
      eq(schema.sdlcCarmackReviewFinding.isBlocking, true),
      isNull(schema.sdlcCarmackReviewFinding.resolvedAt),
    ),
    orderBy: [schema.sdlcCarmackReviewFinding.createdAt],
  });
}

export async function resolveCarmackReviewFinding({
  db,
  loopId,
  headSha,
  stableFindingId,
  resolvedByEventId,
}: {
  db: DB;
  loopId: string;
  headSha: string;
  stableFindingId: string;
  resolvedByEventId: string;
}) {
  const [finding] = await db
    .update(schema.sdlcCarmackReviewFinding)
    .set({
      resolvedAt: new Date(),
      resolvedByEventId,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.sdlcCarmackReviewFinding.loopId, loopId),
        eq(schema.sdlcCarmackReviewFinding.headSha, headSha),
        eq(schema.sdlcCarmackReviewFinding.stableFindingId, stableFindingId),
      ),
    )
    .returning();

  return finding;
}

export async function shouldQueueFollowUpForCarmackReview({
  db,
  loopId,
  headSha,
}: {
  db: DB;
  loopId: string;
  headSha: string;
}) {
  const unresolved = await getUnresolvedBlockingCarmackReviewFindings({
    db,
    loopId,
    headSha,
  });
  return unresolved.length > 0;
}
