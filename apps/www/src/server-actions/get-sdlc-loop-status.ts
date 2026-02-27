"use server";

import { userOnlyAction } from "@/lib/auth-server";
import { db } from "@/lib/db";
import {
  buildSdlcLoopStatusChecks,
  getSdlcLoopStateSummary,
  type SdlcLoopStatusCheck,
  type SdlcLoopStatusCheckKey,
} from "@/lib/sdlc-loop-status";
import { UserFacingError } from "@/lib/server-actions";
import { getThreadWithUserPermissions } from "@/server-actions/get-thread";
import * as schema from "@terragon/shared/db/schema";
import type { SdlcLoopState } from "@terragon/shared/db/types";
import {
  getUnresolvedBlockingCarmackReviewFindings,
  getUnresolvedBlockingDeepReviewFindings,
} from "@terragon/shared/model/sdlc-loop";
import { and, desc, eq } from "drizzle-orm";

type SdlcCiGateRun = typeof schema.sdlcCiGateRun.$inferSelect;
type SdlcReviewThreadGateRun =
  typeof schema.sdlcReviewThreadGateRun.$inferSelect;
type SdlcLoopStatusBlocker = {
  title: string;
  source: SdlcLoopStatusCheckKey | "human_feedback";
};
type SdlcLoopStatus = {
  loopId: string;
  state: SdlcLoopState;
  stateLabel: string;
  explanation: string;
  progressPercent: number;
  checks: SdlcLoopStatusCheck[];
  needsAttention: {
    isBlocked: boolean;
    blockerCount: number;
    topBlockers: SdlcLoopStatusBlocker[];
  };
  links: {
    pullRequestUrl: string;
    statusCommentUrl: string | null;
    checkRunUrl: string | null;
  };
  updatedAtIso: string;
};

type NeedsAttentionInput = {
  loopState: (typeof schema.sdlcLoop.$inferSelect)["state"];
  ciRun: SdlcCiGateRun | null;
  reviewThreadRun: SdlcReviewThreadGateRun | null;
  unresolvedDeepFindingTitles: string[];
  unresolvedCarmackFindingTitles: string[];
  videoCaptureStatus: (typeof schema.sdlcLoop.$inferSelect)["videoCaptureStatus"];
  videoFailureMessage: string | null;
};

function buildNeedsAttention({
  loopState,
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
    ...(videoCaptureStatus === "failed" && loopState !== "video_degraded_ready"
      ? [
          {
            title: videoFailureMessage ?? "Video capture failed",
            source: "video" as const,
          },
        ]
      : []),
    ...(loopState === "blocked_on_human_feedback"
      ? [
          {
            title: "Awaiting human feedback",
            source: "human_feedback" as const,
          },
        ]
      : []),
  ];

  if (blockers.length === 0) {
    if (loopState === "blocked_on_agent_fixes") {
      blockers.push({
        title: "Blocking findings still require agent fixes",
        source: "deep_review",
      });
    } else if (loopState === "blocked_on_ci") {
      blockers.push({
        title: "Required CI checks are still blocking the loop",
        source: "ci",
      });
    } else if (loopState === "blocked_on_review_threads") {
      blockers.push({
        title: "Unresolved review threads are still blocking the loop",
        source: "review_threads",
      });
    } else if (loopState === "blocked_on_human_feedback") {
      blockers.push({
        title: "Awaiting human feedback",
        source: "human_feedback",
      });
    }
  }

  return {
    isBlocked: blockers.length > 0,
    blockerCount: blockers.length,
    topBlockers: blockers.slice(0, 3),
  };
}

export const getSdlcLoopStatusAction = userOnlyAction(
  async function getSdlcLoopStatusAction(
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

    const loop = await db.query.sdlcLoop.findFirst({
      where: eq(schema.sdlcLoop.threadId, threadId),
      orderBy: [desc(schema.sdlcLoop.updatedAt)],
    });
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

    const checks = buildSdlcLoopStatusChecks({
      loopState: loop.state,
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

    const needsAttention = buildNeedsAttention({
      loopState: loop.state,
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

    const pullRequestUrl = `https://github.com/${loop.repoFullName}/pull/${loop.prNumber}`;
    const stateSummary = getSdlcLoopStateSummary(loop.state);
    const explanation =
      loop.state === "stopped" && loop.stopReason
        ? `${stateSummary.explanation} Reason: ${loop.stopReason}.`
        : stateSummary.explanation;

    return {
      loopId: loop.id,
      state: loop.state,
      stateLabel: stateSummary.stateLabel,
      explanation,
      progressPercent: stateSummary.progressPercent,
      checks,
      needsAttention,
      links: {
        pullRequestUrl,
        statusCommentUrl: loop.canonicalStatusCommentId
          ? `${pullRequestUrl}#issuecomment-${loop.canonicalStatusCommentId}`
          : null,
        checkRunUrl: loop.canonicalCheckRunId
          ? `https://github.com/${loop.repoFullName}/runs/${loop.canonicalCheckRunId}?check_suite_focus=true`
          : null,
      },
      updatedAtIso: loop.updatedAt.toISOString(),
    };
  },
  { defaultErrorMessage: "Failed to get SDLC loop status" },
);
