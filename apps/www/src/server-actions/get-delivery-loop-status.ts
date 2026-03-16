"use server";

import { userOnlyAction } from "@/lib/auth-server";
import { db } from "@/lib/db";
import {
  buildDeliveryLoopTopProgressPhases,
  buildSdlcLoopStatusChecks,
  type DeliveryLoopTopProgressPhase,
  getDeliveryLoopBlockedAttentionTitle,
  getDeliveryLoopSnapshotStateSummary,
  type SdlcLoopStatusCheck,
  type SdlcLoopStatusCheckKey,
} from "@/lib/delivery-loop-status";
import { UserFacingError } from "@/lib/server-actions";
import { getThreadWithUserPermissions } from "@/server-actions/get-thread";
import * as schema from "@terragon/shared/db/schema";
import type { SdlcLoopState } from "@terragon/shared/db/types";
import {
  activeSdlcLoopStateSet,
  buildPersistedDeliveryLoopSnapshot,
  getUnresolvedBlockingCarmackReviewFindings,
  getUnresolvedBlockingDeepReviewFindings,
} from "@terragon/shared/model/delivery-loop";
import { and, desc, eq, isNull } from "drizzle-orm";
import * as z from "zod/v4";
import { waitUntil } from "@vercel/functions";

type SdlcCiGateRun = typeof schema.sdlcCiGateRun.$inferSelect;
type SdlcReviewThreadGateRun =
  typeof schema.sdlcReviewThreadGateRun.$inferSelect;
type SdlcLoopStatusBlocker = {
  title: string;
  source: SdlcLoopStatusCheckKey | "human_feedback";
};
type SdlcPlannedTask = {
  stableTaskId: string;
  title: string;
  description: string | null;
  acceptance: string[];
  status: "todo" | "in_progress" | "done" | "blocked" | "skipped";
};

type SdlcLoopStatus = {
  loopId: string;
  state: SdlcLoopState;
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
  checks: SdlcLoopStatusCheck[];
  needsAttention: {
    isBlocked: boolean;
    blockerCount: number;
    topBlockers: SdlcLoopStatusBlocker[];
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
    plannedTasks: SdlcPlannedTask[];
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
  loopSnapshot: ReturnType<typeof buildPersistedDeliveryLoopSnapshot>;
  ciRun: SdlcCiGateRun | null;
  reviewThreadRun: SdlcReviewThreadGateRun | null;
  unresolvedDeepFindingTitles: string[];
  unresolvedCarmackFindingTitles: string[];
  videoCaptureStatus: (typeof schema.sdlcLoop.$inferSelect)["videoCaptureStatus"];
  videoFailureMessage: string | null;
};

function buildDeliveryLoopActions({
  loopState,
  loopSnapshot,
  planApprovalPolicy,
  planningArtifactStatus,
}: {
  loopState: SdlcLoopState;
  loopSnapshot: ReturnType<typeof buildPersistedDeliveryLoopSnapshot>;
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
    canBypassOnce:
      loopSnapshot.kind === "blocked" || loopSnapshot.kind === "implementing",
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
  videoCaptureStatus,
  videoFailureMessage,
}: NeedsAttentionInput): {
  isBlocked: boolean;
  blockerCount: number;
  topBlockers: SdlcLoopStatusBlocker[];
} {
  const blockers: SdlcLoopStatusBlocker[] = [
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
    ...(videoCaptureStatus === "failed"
      ? [
          {
            title: videoFailureMessage ?? "Video capture failed",
            source: "video" as const,
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

  if (blockers.length === 0 && loopSnapshot.kind === "blocked") {
    blockers.push({
      title: getDeliveryLoopBlockedAttentionTitle(loopSnapshot),
      source: "human_feedback",
    });
  }

  return {
    isBlocked: blockers.length > 0,
    blockerCount: blockers.length,
    topBlockers: blockers.slice(0, 3),
  };
}

export const getDeliveryLoopStatusAction = userOnlyAction(
  async function getDeliveryLoopStatusAction(
    userId: string,
    threadId: string,
  ): Promise<SdlcLoopStatus | null> {
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

    const threadLoops = await db.query.sdlcLoop.findMany({
      where: eq(schema.sdlcLoop.threadId, threadId),
      orderBy: [desc(schema.sdlcLoop.updatedAt), desc(schema.sdlcLoop.id)],
      limit: 20,
    });
    const loop =
      threadLoops.find((candidate) =>
        activeSdlcLoopStateSet.has(candidate.state),
      ) ??
      threadLoops[0] ??
      null;
    if (!loop) {
      return null;
    }

    const currentHeadSha = loop.currentHeadSha ?? null;

    const [ciRun, reviewThreadRun, deepReviewRun, carmackReviewRun] =
      await Promise.all([
        currentHeadSha
          ? db.query.sdlcCiGateRun
              .findFirst({
                where: and(
                  eq(schema.sdlcCiGateRun.loopId, loop.id),
                  eq(schema.sdlcCiGateRun.headSha, currentHeadSha),
                ),
                orderBy: [
                  desc(schema.sdlcCiGateRun.updatedAt),
                  desc(schema.sdlcCiGateRun.createdAt),
                ],
              })
              .then((run) => run ?? null)
          : Promise.resolve(null),
        currentHeadSha
          ? db.query.sdlcReviewThreadGateRun
              .findFirst({
                where: and(
                  eq(schema.sdlcReviewThreadGateRun.loopId, loop.id),
                  eq(schema.sdlcReviewThreadGateRun.headSha, currentHeadSha),
                ),
                orderBy: [
                  desc(schema.sdlcReviewThreadGateRun.updatedAt),
                  desc(schema.sdlcReviewThreadGateRun.createdAt),
                ],
              })
              .then((run) => run ?? null)
          : Promise.resolve(null),
        currentHeadSha
          ? db.query.sdlcDeepReviewRun
              .findFirst({
                where: and(
                  eq(schema.sdlcDeepReviewRun.loopId, loop.id),
                  eq(schema.sdlcDeepReviewRun.headSha, currentHeadSha),
                ),
                orderBy: [
                  desc(schema.sdlcDeepReviewRun.updatedAt),
                  desc(schema.sdlcDeepReviewRun.createdAt),
                ],
              })
              .then((run) => run ?? null)
          : Promise.resolve(null),
        currentHeadSha
          ? db.query.sdlcCarmackReviewRun
              .findFirst({
                where: and(
                  eq(schema.sdlcCarmackReviewRun.loopId, loop.id),
                  eq(schema.sdlcCarmackReviewRun.headSha, currentHeadSha),
                ),
                orderBy: [
                  desc(schema.sdlcCarmackReviewRun.updatedAt),
                  desc(schema.sdlcCarmackReviewRun.createdAt),
                ],
              })
              .then((run) => run ?? null)
          : Promise.resolve(null),
      ]);

    const implementationArtifactFallbackWhere = currentHeadSha
      ? and(
          eq(schema.sdlcPhaseArtifact.loopId, loop.id),
          eq(schema.sdlcPhaseArtifact.phase, "implementing"),
          eq(schema.sdlcPhaseArtifact.headSha, currentHeadSha),
        )
      : and(
          eq(schema.sdlcPhaseArtifact.loopId, loop.id),
          eq(schema.sdlcPhaseArtifact.phase, "implementing"),
          isNull(schema.sdlcPhaseArtifact.headSha),
        );

    const [planningArtifact, implementationArtifact] = await Promise.all([
      loop.activePlanArtifactId
        ? db.query.sdlcPhaseArtifact.findFirst({
            where: and(
              eq(schema.sdlcPhaseArtifact.id, loop.activePlanArtifactId),
              eq(schema.sdlcPhaseArtifact.loopId, loop.id),
            ),
            columns: {
              id: true,
              status: true,
              updatedAt: true,
              payload: true,
            },
          })
        : db.query.sdlcPhaseArtifact.findFirst({
            where: and(
              eq(schema.sdlcPhaseArtifact.loopId, loop.id),
              eq(schema.sdlcPhaseArtifact.phase, "planning"),
            ),
            orderBy: [
              desc(schema.sdlcPhaseArtifact.updatedAt),
              desc(schema.sdlcPhaseArtifact.createdAt),
            ],
            columns: {
              id: true,
              status: true,
              updatedAt: true,
              payload: true,
            },
          }),
      loop.activeImplementationArtifactId
        ? db.query.sdlcPhaseArtifact.findFirst({
            where: and(
              eq(
                schema.sdlcPhaseArtifact.id,
                loop.activeImplementationArtifactId,
              ),
              eq(schema.sdlcPhaseArtifact.loopId, loop.id),
            ),
            columns: {
              id: true,
              status: true,
              headSha: true,
              updatedAt: true,
            },
          })
        : db.query.sdlcPhaseArtifact.findFirst({
            where: implementationArtifactFallbackWhere,
            orderBy: [
              desc(schema.sdlcPhaseArtifact.updatedAt),
              desc(schema.sdlcPhaseArtifact.createdAt),
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
      ? await db.query.sdlcPlanTask.findMany({
          where: and(
            eq(schema.sdlcPlanTask.loopId, loop.id),
            eq(schema.sdlcPlanTask.artifactId, planningArtifact.id),
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
    const plannedTaskRemaining = Math.max(
      0,
      plannedTaskTotal - plannedTaskDone,
    );

    const unresolvedDeepFindings = currentHeadSha
      ? await getUnresolvedBlockingDeepReviewFindings({
          db,
          loopId: loop.id,
          headSha: currentHeadSha,
        })
      : [];
    const unresolvedCarmackFindings = currentHeadSha
      ? await getUnresolvedBlockingCarmackReviewFindings({
          db,
          loopId: loop.id,
          headSha: currentHeadSha,
        })
      : [];

    const loopSnapshot = buildPersistedDeliveryLoopSnapshot({
      state: loop.state,
      blockedFromState: loop.blockedFromState,
    });

    const checks = buildSdlcLoopStatusChecks({
      loopSnapshot,
      currentHeadSha,
      ciRun,
      reviewThreadRun,
      deepReviewRun,
      carmackReviewRun,
      unresolvedDeepFindingCount: unresolvedDeepFindings.length,
      unresolvedCarmackFindingCount: unresolvedCarmackFindings.length,
      videoCaptureStatus: loop.videoCaptureStatus,
      videoFailureMessage: loop.latestVideoFailureMessage ?? null,
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
      videoCaptureStatus: loop.videoCaptureStatus,
      videoFailureMessage: loop.latestVideoFailureMessage ?? null,
    });

    const pullRequestUrl =
      loop.prNumber === null
        ? null
        : `https://github.com/${loop.repoFullName}/pull/${loop.prNumber}`;
    const stateSummary = getDeliveryLoopSnapshotStateSummary(loopSnapshot);
    const explanation =
      loop.state === "stopped" && loop.stopReason
        ? `${stateSummary.explanation} Reason: ${loop.stopReason}.`
        : stateSummary.explanation;

    const response: SdlcLoopStatus = {
      loopId: loop.id,
      state: loop.state as SdlcLoopState,
      planApprovalPolicy: loop.planApprovalPolicy,
      stateLabel: stateSummary.stateLabel,
      explanation,
      progressPercent: stateSummary.progressPercent,
      actions: buildDeliveryLoopActions({
        loopState: loop.state,
        loopSnapshot,
        planApprovalPolicy: loop.planApprovalPolicy,
        planningArtifactStatus: planningArtifact?.status ?? null,
      }),
      phases,
      checks,
      needsAttention,
      links: {
        pullRequestUrl,
        statusCommentUrl:
          pullRequestUrl && loop.canonicalStatusCommentId
            ? `${pullRequestUrl}#issuecomment-${loop.canonicalStatusCommentId}`
            : null,
        checkRunUrl:
          pullRequestUrl && loop.canonicalCheckRunId
            ? `https://github.com/${loop.repoFullName}/runs/${loop.canonicalCheckRunId}?check_suite_focus=true`
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
      updatedAtIso: loop.updatedAt.toISOString(),
    };

    // Fire-and-forget: if the loop is babysitting, trigger a background
    // v2 coordinator tick to process any pending signals. Debounced via
    // Redis SET NX to avoid stampeding on polling UI.
    if (
      loop.state === "babysitting" &&
      activeSdlcLoopStateSet.has(loop.state)
    ) {
      waitUntil(
        (async () => {
          try {
            const { redis } = await import("@/lib/redis");
            const debounceKey = `babysit-tick-debounce:${loop.id}`;
            const acquired = await redis.set(debounceKey, "1", {
              nx: true,
              ex: 30,
            });
            if (!acquired) return;

            const { getActiveWorkflowForThread } = await import(
              "@terragon/shared/delivery-loop/store/workflow-store"
            );
            let workflow = await getActiveWorkflowForThread({
              db,
              threadId: loop.threadId,
            });
            // Backfill v2 workflow for orphaned v1 loops so idle
            // babysitting loops don't stay stuck after v1 removal.
            if (!workflow) {
              const { ensureV2WorkflowExists } = await import(
                "@/server-lib/delivery-loop/coordinator/enrollment-bridge"
              );
              const result = await ensureV2WorkflowExists({
                db,
                threadId: loop.threadId,
                sdlcLoopId: loop.id,
                sdlcLoopState: loop.state,
              });
              if (result.created) {
                workflow = await getActiveWorkflowForThread({
                  db,
                  threadId: loop.threadId,
                });
              }
            }
            if (workflow) {
              const { runCoordinatorTick } = await import(
                "@/server-lib/delivery-loop/coordinator/tick"
              );
              await runCoordinatorTick({
                db,
                workflowId:
                  workflow.id as import("@terragon/shared/delivery-loop/domain/workflow").WorkflowId,
                correlationId:
                  `babysit-recheck:${loop.id}:${Date.now()}` as import("@terragon/shared/delivery-loop/domain/workflow").CorrelationId,
                loopId: loop.id,
              });
            }
          } catch (error) {
            console.warn("[babysit-recheck] background v2 tick failed", {
              loopId: loop.id,
              error,
            });
          }
        })(),
      );
    }

    return deliveryLoopStatusSchema.parse(response) as SdlcLoopStatus;
  },
  { defaultErrorMessage: "Failed to get delivery loop status" },
);
