"use server";

import { userOnlyAction } from "@/lib/auth-server";
import { db } from "@/lib/db";
import {
  buildDeliveryLoopTopProgressPhases,
  buildDeliveryLoopStatusChecks,
  buildSnapshotFromHead,
  type DeliveryLoopTopProgressPhase,
  getDeliveryLoopBlockedAttentionTitle,
  getDeliveryLoopSnapshotStateSummary,
  type DeliveryLoopStatusCheck,
  type DeliveryLoopStatusCheckKey,
} from "@/lib/delivery-loop-status";
import { UserFacingError } from "@/lib/server-actions";
import { getThreadWithUserPermissions } from "@/server-actions/get-thread";
import * as schema from "@terragon/shared/db/schema";
import type { DeliveryLoopState } from "@terragon/shared/db/types";
import {
  getUnresolvedBlockingCarmackReviewFindings,
  getUnresolvedBlockingDeepReviewFindings,
} from "@terragon/shared/delivery-loop/store/gate-persistence";
import type { DeliveryLoopSnapshot } from "@terragon/shared/delivery-loop/domain/snapshot-types";
import {
  getActiveWorkflowForThread,
  type ActiveWorkflowForThread,
} from "@/server-lib/delivery-loop/v3/store";
import { normalizePlanApprovalPolicy } from "@/server-lib/delivery-loop/v3/types";
import { and, desc, eq, isNull } from "drizzle-orm";
import * as z from "zod/v4";

type DeliveryCiGateRun = typeof schema.deliveryCiGateRun.$inferSelect;
type DeliveryReviewThreadGateRun =
  typeof schema.deliveryReviewThreadGateRun.$inferSelect;
type DeliveryLoopStatusBlocker = {
  title: string;
  source: DeliveryLoopStatusCheckKey | "human_feedback";
};
type DeliveryPlannedTask = {
  stableTaskId: string;
  title: string;
  description: string | null;
  acceptance: string[];
  status: "todo" | "in_progress" | "done" | "blocked" | "skipped";
};

type DeliveryLoopStatus = {
  loopId: string;
  state: DeliveryLoopState;
  planApprovalPolicy: "auto" | "human_required";
  stateLabel: string;
  explanation: string;
  progressPercent: number;
  actions: {
    canResume: boolean;
    canBypassOnce: boolean;
    canApprovePlan: boolean;
  };
  phases: DeliveryLoopTopProgressPhase[];
  checks: DeliveryLoopStatusCheck[];
  needsAttention: {
    isBlocked: boolean;
    blockerCount: number;
    topBlockers: DeliveryLoopStatusBlocker[];
  };
  links: {
    pullRequestUrl: string | null;
    statusCommentUrl: string | null;
    checkRunUrl: string | null;
  };
  artifacts: {
    planningArtifact: {
      id: string;
      status: "generated" | "approved" | "accepted" | "rejected" | "superseded";
      updatedAtIso: string;
      planText: string | null;
    } | null;
    implementationArtifact: {
      id: string;
      status: "generated" | "approved" | "accepted" | "rejected" | "superseded";
      headSha: string | null;
      updatedAtIso: string;
    } | null;
    plannedTaskSummary: {
      total: number;
      done: number;
      remaining: number;
    };
    plannedTasks: DeliveryPlannedTask[];
  };
  updatedAtIso: string;
};

const deliveryLoopStatusSchema = z.object({
  loopId: z.string().min(1),
  state: z.string().min(1),
  planApprovalPolicy: z.enum(["auto", "human_required"]),
  stateLabel: z.string().min(1),
  explanation: z.string().min(1),
  progressPercent: z.number().int().min(0).max(100),
  actions: z.object({
    canResume: z.boolean(),
    canBypassOnce: z.boolean(),
    canApprovePlan: z.boolean(),
  }),
  phases: z.array(
    z.object({
      key: z.enum([
        "planning",
        "implementing",
        "reviewing",
        "ci",
        "ui_testing",
      ]),
      label: z.string().min(1),
      status: z.string().min(1),
    }),
  ),
  checks: z.array(
    z.object({
      key: z.string().min(1),
      label: z.string().min(1),
      status: z.string().min(1),
      detail: z.string(),
    }),
  ),
  needsAttention: z.object({
    isBlocked: z.boolean(),
    blockerCount: z.number().int().min(0),
    topBlockers: z.array(
      z.object({
        title: z.string().min(1),
        source: z.string().min(1),
      }),
    ),
  }),
  links: z.object({
    pullRequestUrl: z.string().url().nullable(),
    statusCommentUrl: z.string().url().nullable(),
    checkRunUrl: z.string().url().nullable(),
  }),
  artifacts: z.object({
    planningArtifact: z
      .object({
        id: z.string().min(1),
        status: z.enum([
          "generated",
          "approved",
          "accepted",
          "rejected",
          "superseded",
        ]),
        updatedAtIso: z.string().datetime(),
        planText: z.string().nullable(),
      })
      .nullable(),
    implementationArtifact: z
      .object({
        id: z.string().min(1),
        status: z.enum([
          "generated",
          "approved",
          "accepted",
          "rejected",
          "superseded",
        ]),
        headSha: z.string().nullable(),
        updatedAtIso: z.string().datetime(),
      })
      .nullable(),
    plannedTaskSummary: z.object({
      total: z.number().int().min(0),
      done: z.number().int().min(0),
      remaining: z.number().int().min(0),
    }),
    plannedTasks: z.array(
      z.object({
        stableTaskId: z.string().min(1),
        title: z.string().min(1),
        description: z.string().nullable(),
        acceptance: z.array(z.string()),
        status: z.enum(["todo", "in_progress", "done", "blocked", "skipped"]),
      }),
    ),
  }),
  updatedAtIso: z.string().datetime(),
});

type NeedsAttentionInput = {
  loopSnapshot: DeliveryLoopSnapshot;
  ciRun: DeliveryCiGateRun | null;
  reviewThreadRun: DeliveryReviewThreadGateRun | null;
  unresolvedDeepFindingTitles: string[];
  unresolvedCarmackFindingTitles: string[];
};

function buildDeliveryLoopActions({
  loopState,
  loopSnapshot,
  planApprovalPolicy,
  planningArtifactStatus,
}: {
  loopState: DeliveryLoopState;
  loopSnapshot: DeliveryLoopSnapshot;
  planApprovalPolicy: "auto" | "human_required";
  planningArtifactStatus:
    | "generated"
    | "approved"
    | "accepted"
    | "rejected"
    | "superseded"
    | null;
}) {
  return {
    canResume: loopSnapshot.kind === "blocked",
    canBypassOnce: false,
    canApprovePlan:
      loopState === "planning" &&
      planApprovalPolicy === "human_required" &&
      planningArtifactStatus !== "accepted",
  };
}

function buildNeedsAttention({
  loopSnapshot,
  ciRun,
  reviewThreadRun,
  unresolvedDeepFindingTitles,
  unresolvedCarmackFindingTitles,
}: NeedsAttentionInput): {
  isBlocked: boolean;
  blockerCount: number;
  topBlockers: DeliveryLoopStatusBlocker[];
} {
  const blockers: DeliveryLoopStatusBlocker[] = [
    ...unresolvedDeepFindingTitles.map((title) => ({
      title,
      source: "deep_review" as const,
    })),
    ...unresolvedCarmackFindingTitles.map((title) => ({
      title,
      source: "architecture_carmack" as const,
    })),
    ...(ciRun?.failingRequiredChecks ?? []).map((checkName) => ({
      title: `CI failing: ${checkName}`,
      source: "ci" as const,
    })),
    ...(reviewThreadRun?.status === "blocked"
      ? [
          {
            title: `${reviewThreadRun.unresolvedThreadCount} unresolved review thread(s)`,
            source: "review_threads" as const,
          },
        ]
      : []),
    ...(reviewThreadRun?.status === "transient_error"
      ? [
          {
            title:
              "Review-thread evaluation had a transient error and will retry",
            source: "review_threads" as const,
          },
        ]
      : []),
    ...(loopSnapshot.kind === "blocked"
      ? [
          {
            title: getDeliveryLoopBlockedAttentionTitle(loopSnapshot),
            source: "human_feedback" as const,
          },
        ]
      : []),
  ];

  return {
    isBlocked: blockers.length > 0,
    blockerCount: blockers.length,
    topBlockers: blockers.slice(0, 3),
  };
}

/**
 * Fetches gate runs, artifacts, planned tasks, review findings from the DB
 * and assembles the common status data structure from the v2 workflow.
 */
async function assembleLoopStatusData(params: {
  loopId: string;
  loopSnapshot: DeliveryLoopSnapshot;
  currentHeadSha: string | null;
  repoFullName: string;
  prNumber: number | null;
  canonicalStatusCommentId: string | null;
  canonicalCheckRunId: number | null;
}): Promise<{
  ciRun: DeliveryCiGateRun | null;
  reviewThreadRun: DeliveryReviewThreadGateRun | null;
  checks: DeliveryLoopStatusCheck[];
  phases: DeliveryLoopTopProgressPhase[];
  needsAttention: ReturnType<typeof buildNeedsAttention>;
  pullRequestUrl: string | null;
  links: DeliveryLoopStatus["links"];
  artifacts: DeliveryLoopStatus["artifacts"];
}> {
  const { loopId, loopSnapshot, currentHeadSha } = params;

  const [ciRun, reviewThreadRun, deepReviewRun, carmackReviewRun] =
    await Promise.all([
      currentHeadSha
        ? db.query.deliveryCiGateRun
            .findFirst({
              where: and(
                eq(schema.deliveryCiGateRun.loopId, loopId),
                eq(schema.deliveryCiGateRun.headSha, currentHeadSha),
              ),
              orderBy: [
                desc(schema.deliveryCiGateRun.updatedAt),
                desc(schema.deliveryCiGateRun.createdAt),
              ],
            })
            .then((run) => run ?? null)
        : Promise.resolve(null),
      currentHeadSha
        ? db.query.deliveryReviewThreadGateRun
            .findFirst({
              where: and(
                eq(schema.deliveryReviewThreadGateRun.loopId, loopId),
                eq(schema.deliveryReviewThreadGateRun.headSha, currentHeadSha),
              ),
              orderBy: [
                desc(schema.deliveryReviewThreadGateRun.updatedAt),
                desc(schema.deliveryReviewThreadGateRun.createdAt),
              ],
            })
            .then((run) => run ?? null)
        : Promise.resolve(null),
      currentHeadSha
        ? db.query.deliveryDeepReviewRun
            .findFirst({
              where: and(
                eq(schema.deliveryDeepReviewRun.loopId, loopId),
                eq(schema.deliveryDeepReviewRun.headSha, currentHeadSha),
              ),
              orderBy: [
                desc(schema.deliveryDeepReviewRun.updatedAt),
                desc(schema.deliveryDeepReviewRun.createdAt),
              ],
            })
            .then((run) => run ?? null)
        : Promise.resolve(null),
      currentHeadSha
        ? db.query.deliveryCarmackReviewRun
            .findFirst({
              where: and(
                eq(schema.deliveryCarmackReviewRun.loopId, loopId),
                eq(schema.deliveryCarmackReviewRun.headSha, currentHeadSha),
              ),
              orderBy: [
                desc(schema.deliveryCarmackReviewRun.updatedAt),
                desc(schema.deliveryCarmackReviewRun.createdAt),
              ],
            })
            .then((run) => run ?? null)
        : Promise.resolve(null),
    ]);

  const implementationArtifactFallbackWhere = currentHeadSha
    ? and(
        eq(schema.deliveryPhaseArtifact.loopId, loopId),
        eq(schema.deliveryPhaseArtifact.phase, "implementing"),
        eq(schema.deliveryPhaseArtifact.headSha, currentHeadSha),
      )
    : and(
        eq(schema.deliveryPhaseArtifact.loopId, loopId),
        eq(schema.deliveryPhaseArtifact.phase, "implementing"),
        isNull(schema.deliveryPhaseArtifact.headSha),
      );

  const [planningArtifact, implementationArtifact] = await Promise.all([
    db.query.deliveryPhaseArtifact.findFirst({
      where: and(
        eq(schema.deliveryPhaseArtifact.loopId, loopId),
        eq(schema.deliveryPhaseArtifact.phase, "planning"),
      ),
      orderBy: [
        desc(schema.deliveryPhaseArtifact.updatedAt),
        desc(schema.deliveryPhaseArtifact.createdAt),
      ],
      columns: {
        id: true,
        status: true,
        updatedAt: true,
        payload: true,
      },
    }),
    db.query.deliveryPhaseArtifact.findFirst({
      where: implementationArtifactFallbackWhere,
      orderBy: [
        desc(schema.deliveryPhaseArtifact.updatedAt),
        desc(schema.deliveryPhaseArtifact.createdAt),
      ],
      columns: {
        id: true,
        status: true,
        headSha: true,
        updatedAt: true,
      },
    }),
  ]);

  const plannedTasks = planningArtifact
    ? await db.query.deliveryPlanTask.findMany({
        where: and(
          eq(schema.deliveryPlanTask.loopId, loopId),
          eq(schema.deliveryPlanTask.artifactId, planningArtifact.id),
        ),
        columns: {
          status: true,
          stableTaskId: true,
          title: true,
          description: true,
          acceptance: true,
        },
      })
    : [];
  const plannedTaskTotal = plannedTasks.length;
  const plannedTaskDone = plannedTasks.filter(
    (task) => task.status === "done" || task.status === "skipped",
  ).length;
  const plannedTaskRemaining = Math.max(0, plannedTaskTotal - plannedTaskDone);

  const unresolvedDeepFindings = currentHeadSha
    ? await getUnresolvedBlockingDeepReviewFindings({
        db,
        loopId,
        headSha: currentHeadSha,
      })
    : [];
  const unresolvedCarmackFindings = currentHeadSha
    ? await getUnresolvedBlockingCarmackReviewFindings({
        db,
        loopId,
        headSha: currentHeadSha,
      })
    : [];

  const checks = buildDeliveryLoopStatusChecks({
    loopSnapshot,
    currentHeadSha,
    ciRun,
    reviewThreadRun,
    deepReviewRun,
    carmackReviewRun,
    unresolvedDeepFindingCount: unresolvedDeepFindings.length,
    unresolvedCarmackFindingCount: unresolvedCarmackFindings.length,
    videoCaptureStatus: "not_started",
    videoFailureMessage: null,
  });
  const phases = buildDeliveryLoopTopProgressPhases({
    loopSnapshot,
    checks,
  });

  const needsAttention = buildNeedsAttention({
    loopSnapshot,
    ciRun,
    reviewThreadRun,
    unresolvedDeepFindingTitles: unresolvedDeepFindings.map((finding) =>
      finding.title.trim(),
    ),
    unresolvedCarmackFindingTitles: unresolvedCarmackFindings.map((finding) =>
      finding.title.trim(),
    ),
  });

  const linkRepoFullName = params.repoFullName;
  const linkPrNumber = params.prNumber;
  const canonicalStatusCommentId = params.canonicalStatusCommentId;
  const canonicalCheckRunId = params.canonicalCheckRunId;

  const pullRequestUrl =
    linkPrNumber === null
      ? null
      : `https://github.com/${linkRepoFullName}/pull/${linkPrNumber}`;

  return {
    ciRun,
    reviewThreadRun,
    checks,
    phases,
    needsAttention,
    pullRequestUrl,
    links: {
      pullRequestUrl,
      statusCommentUrl:
        pullRequestUrl && canonicalStatusCommentId
          ? `${pullRequestUrl}#issuecomment-${canonicalStatusCommentId}`
          : null,
      checkRunUrl:
        pullRequestUrl && canonicalCheckRunId
          ? `https://github.com/${linkRepoFullName}/runs/${canonicalCheckRunId}?check_suite_focus=true`
          : null,
    },
    artifacts: {
      planningArtifact: planningArtifact
        ? {
            id: planningArtifact.id,
            status: planningArtifact.status,
            updatedAtIso: planningArtifact.updatedAt.toISOString(),
            planText:
              typeof planningArtifact.payload === "object" &&
              planningArtifact.payload !== null &&
              "planText" in planningArtifact.payload &&
              typeof planningArtifact.payload.planText === "string"
                ? planningArtifact.payload.planText
                : null,
          }
        : null,
      implementationArtifact: implementationArtifact
        ? {
            id: implementationArtifact.id,
            status: implementationArtifact.status,
            headSha: implementationArtifact.headSha ?? null,
            updatedAtIso: implementationArtifact.updatedAt.toISOString(),
          }
        : null,
      plannedTaskSummary: {
        total: plannedTaskTotal,
        done: plannedTaskDone,
        remaining: plannedTaskRemaining,
      },
      plannedTasks: plannedTasks.map((t) => ({
        stableTaskId: t.stableTaskId,
        title: t.title,
        description: t.description ?? null,
        acceptance:
          Array.isArray(t.acceptance) &&
          t.acceptance.every((item) => typeof item === "string")
            ? t.acceptance
            : [],
        status: t.status ?? "todo",
      })),
    },
  };
}

/**
 * Build the full DeliveryLoopStatus from the active workflow/head pair.
 */
async function buildStatusFromActiveWorkflow(params: {
  workflowRow: ActiveWorkflowForThread["workflow"];
  v3Head: ActiveWorkflowForThread["head"];
}): Promise<DeliveryLoopStatus> {
  const { workflowRow, v3Head } = params;

  const loopSnapshot = buildSnapshotFromHead(v3Head);
  const loopState = loopSnapshot.kind;

  const currentHeadSha = v3Head.headSha ?? workflowRow.currentHeadSha ?? null;

  const assembled = await assembleLoopStatusData({
    loopId: workflowRow.id,
    loopSnapshot,
    currentHeadSha,
    repoFullName: workflowRow.repoFullName,
    prNumber: workflowRow.prNumber ?? null,
    canonicalStatusCommentId: workflowRow.canonicalStatusCommentId ?? null,
    canonicalCheckRunId: workflowRow.canonicalCheckRunId ?? null,
  });

  const stateSummary = getDeliveryLoopSnapshotStateSummary(loopSnapshot);
  const blockedReason = v3Head.blockedReason ?? null;
  const explanation = blockedReason
    ? `${stateSummary.explanation} Reason: ${blockedReason}.`
    : stateSummary.explanation;
  const planApprovalPolicy = normalizePlanApprovalPolicy(
    workflowRow.planApprovalPolicy,
  );

  return {
    loopId: workflowRow.id,
    state: loopState,
    planApprovalPolicy,
    stateLabel: stateSummary.stateLabel,
    explanation,
    progressPercent: stateSummary.progressPercent,
    actions: buildDeliveryLoopActions({
      loopState,
      loopSnapshot,
      planApprovalPolicy,
      planningArtifactStatus:
        assembled.artifacts.planningArtifact?.status ?? null,
    }),
    phases: assembled.phases,
    checks: assembled.checks,
    needsAttention: assembled.needsAttention,
    links: assembled.links,
    artifacts: assembled.artifacts,
    updatedAtIso: v3Head.updatedAt.toISOString(),
  };
}

// Core implementation that can be used by both server actions and ORPC routes
export async function getDeliveryLoopStatusCore(
  userId: string,
  threadId: string,
): Promise<DeliveryLoopStatus | null> {
  const thread = await db.query.thread.findFirst({
    columns: {
      id: true,
      userId: true,
    },
    where: eq(schema.thread.id, threadId),
  });
  if (!thread) {
    throw new UserFacingError("Unauthorized");
  }

  if (thread.userId !== userId) {
    const threadWithPermissions = await getThreadWithUserPermissions({
      userId,
      threadId,
    });
    if (!threadWithPermissions) {
      throw new UserFacingError("Unauthorized");
    }
  }

  const activeWorkflow = await getActiveWorkflowForThread({ db, threadId });
  if (!activeWorkflow) {
    return null;
  }

  const response = await buildStatusFromActiveWorkflow({
    workflowRow: activeWorkflow.workflow,
    v3Head: activeWorkflow.head,
  });
  return deliveryLoopStatusSchema.parse(response) as DeliveryLoopStatus;
}

// Server action wrapper that extracts userId from session
export const getDeliveryLoopStatusAction = userOnlyAction(
  async function getDeliveryLoopStatusAction(
    userId: string,
    threadId: string,
  ): Promise<DeliveryLoopStatus | null> {
    return getDeliveryLoopStatusCore(userId, threadId);
  },
  { defaultErrorMessage: "Failed to get delivery loop status" },
);
