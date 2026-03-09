import type {
  SdlcCarmackReviewStatus,
  SdlcCiGateStatus,
  SdlcDeepReviewStatus,
  SdlcLoopState,
  SdlcReviewThreadGateStatus,
  SdlcVideoCaptureStatus,
} from "@terragon/shared/db/types";
export type SdlcLoopStatusCheckKey =
  | "ci"
  | "review_threads"
  | "deep_review"
  | "architecture_carmack"
  | "video";

export type SdlcLoopStatusCheckStatus =
  | "passed"
  | "blocked"
  | "pending"
  | "not_started"
  | "degraded";

export type SdlcLoopStatusCheck = {
  key: SdlcLoopStatusCheckKey;
  label: string;
  status: SdlcLoopStatusCheckStatus;
  detail: string;
};

type SdlcLoopStatusCiRun = {
  status: SdlcCiGateStatus;
  failingRequiredChecks: string[];
};

type SdlcLoopStatusReviewThreadRun = {
  status: SdlcReviewThreadGateStatus;
  unresolvedThreadCount: number;
};

type SdlcLoopStatusDeepReviewRun = {
  status: SdlcDeepReviewStatus;
};

type SdlcLoopStatusCarmackReviewRun = {
  status: SdlcCarmackReviewStatus;
};

export type SdlcLoopStatusStateSummary = {
  stateLabel: string;
  explanation: string;
  progressPercent: number;
};

const SDLC_STATE_SUMMARY = {
  planning: {
    stateLabel: "Planning",
    explanation: "Agent is drafting an implementation plan before coding.",
    progressPercent: 10,
  },
  implementing: {
    stateLabel: "Implementing",
    explanation: "Agent is implementing fixes and preparing gate evaluations.",
    progressPercent: 25,
  },
  review_gate: {
    stateLabel: "Review Gate",
    explanation: "Deep and architecture review gates are running.",
    progressPercent: 45,
  },
  ci_gate: {
    stateLabel: "CI Gate",
    explanation: "Required CI checks are running.",
    progressPercent: 55,
  },
  ui_gate: {
    stateLabel: "UI Gate",
    explanation: "Browser smoke testing is validating UI behavior.",
    progressPercent: 65,
  },
  awaiting_pr_link: {
    stateLabel: "Awaiting PR",
    explanation:
      "Quality gates passed. Waiting for PR to be created or linked.",
    progressPercent: 75,
  },
  babysitting: {
    stateLabel: "Babysitting",
    explanation:
      "Monitoring CI and review feedback until all blockers are resolved.",
    progressPercent: 85,
  },
  blocked: {
    stateLabel: "Blocked",
    explanation: "The loop is blocked and waiting for human intervention.",
    progressPercent: 50,
  },
  terminated_pr_closed: {
    stateLabel: "Terminated: PR Closed",
    explanation: "The loop ended because the pull request was closed.",
    progressPercent: 100,
  },
  terminated_pr_merged: {
    stateLabel: "Terminated: PR Merged",
    explanation: "The loop ended because the pull request was merged.",
    progressPercent: 100,
  },
  done: {
    stateLabel: "Done",
    explanation: "The loop completed successfully.",
    progressPercent: 100,
  },
  stopped: {
    stateLabel: "Stopped",
    explanation: "The loop was stopped before completion.",
    progressPercent: 100,
  },
} satisfies Record<SdlcLoopState, SdlcLoopStatusStateSummary>;

export function getSdlcLoopStateSummary(
  state: SdlcLoopState,
): SdlcLoopStatusStateSummary {
  return SDLC_STATE_SUMMARY[state];
}

function inferCiStatusFromLoopState(
  loopState: SdlcLoopState,
): SdlcLoopStatusCheckStatus {
  switch (loopState) {
    case "planning":
    case "implementing":
    case "review_gate":
      return "not_started";
    case "ci_gate":
      return "pending";
    case "blocked":
      return "blocked";
    case "babysitting":
    case "awaiting_pr_link":
    case "done":
    case "terminated_pr_merged":
      return "passed";
    case "terminated_pr_closed":
    case "stopped":
      return "degraded";
    default:
      return "pending";
  }
}

function inferReviewThreadsStatusFromLoopState(
  loopState: SdlcLoopState,
): SdlcLoopStatusCheckStatus {
  switch (loopState) {
    case "planning":
    case "implementing":
    case "review_gate":
    case "ci_gate":
    case "ui_gate":
      return "not_started";
    case "babysitting":
      return "pending";
    case "blocked":
      return "blocked";
    case "awaiting_pr_link":
    case "done":
    case "terminated_pr_merged":
      return "passed";
    case "terminated_pr_closed":
    case "stopped":
      return "degraded";
    default:
      return "pending";
  }
}

function inferDeepReviewStatusFromLoopState(
  loopState: SdlcLoopState,
): SdlcLoopStatusCheckStatus {
  switch (loopState) {
    case "planning":
    case "implementing":
      return "not_started";
    case "review_gate":
      return "pending";
    case "blocked":
      return "blocked";
    case "ci_gate":
    case "ui_gate":
    case "awaiting_pr_link":
    case "babysitting":
    case "done":
    case "terminated_pr_merged":
      return "passed";
    case "terminated_pr_closed":
    case "stopped":
      return "degraded";
    default:
      return "pending";
  }
}

function inferCarmackStatusFromLoopState(
  loopState: SdlcLoopState,
): SdlcLoopStatusCheckStatus {
  switch (loopState) {
    case "planning":
    case "implementing":
      return "not_started";
    case "review_gate":
      return "pending";
    case "blocked":
      return "blocked";
    case "ci_gate":
    case "ui_gate":
    case "awaiting_pr_link":
    case "babysitting":
    case "done":
    case "terminated_pr_merged":
      return "passed";
    case "terminated_pr_closed":
    case "stopped":
      return "degraded";
    default:
      return "pending";
  }
}

export function buildSdlcLoopStatusChecks({
  loopState,
  currentHeadSha,
  ciRun,
  reviewThreadRun,
  deepReviewRun,
  carmackReviewRun,
  unresolvedDeepFindingCount,
  unresolvedCarmackFindingCount,
  videoCaptureStatus,
  videoFailureMessage,
}: {
  loopState: SdlcLoopState;
  currentHeadSha: string | null;
  ciRun: SdlcLoopStatusCiRun | null;
  reviewThreadRun: SdlcLoopStatusReviewThreadRun | null;
  deepReviewRun: SdlcLoopStatusDeepReviewRun | null;
  carmackReviewRun: SdlcLoopStatusCarmackReviewRun | null;
  unresolvedDeepFindingCount: number;
  unresolvedCarmackFindingCount: number;
  videoCaptureStatus: SdlcVideoCaptureStatus;
  videoFailureMessage: string | null;
}): SdlcLoopStatusCheck[] {
  const ciFallbackStatus = inferCiStatusFromLoopState(loopState);
  const reviewThreadsFallbackStatus =
    inferReviewThreadsStatusFromLoopState(loopState);
  const deepReviewFallbackStatus =
    inferDeepReviewStatusFromLoopState(loopState);
  const carmackFallbackStatus = inferCarmackStatusFromLoopState(loopState);

  const ciCheck: SdlcLoopStatusCheck = !currentHeadSha
    ? {
        key: "ci",
        label: "CI",
        status: "not_started",
        detail: "Waiting for the first pushed head SHA.",
      }
    : ciRun?.status === "passed"
      ? {
          key: "ci",
          label: "CI",
          status: "passed",
          detail: "Required checks are passing.",
        }
      : ciRun?.status === "blocked" || ciRun?.status === "capability_error"
        ? {
            key: "ci",
            label: "CI",
            status: "blocked",
            detail:
              ciRun.failingRequiredChecks.length > 0
                ? `${ciRun.failingRequiredChecks.length} required check(s) failing.`
                : "Required checks are currently blocked.",
          }
        : {
            key: "ci",
            label: "CI",
            status: ciFallbackStatus,
            detail:
              ciFallbackStatus === "blocked"
                ? "Loop is blocked on CI."
                : ciFallbackStatus === "passed"
                  ? "Required checks are passing."
                  : ciFallbackStatus === "degraded"
                    ? "Loop ended before CI evaluation completed."
                    : "Awaiting CI evaluation for the current head.",
          };

  const reviewThreadsCheck: SdlcLoopStatusCheck = !currentHeadSha
    ? {
        key: "review_threads",
        label: "Review Threads",
        status: "not_started",
        detail: "Review gate starts after a head SHA is available.",
      }
    : reviewThreadRun?.status === "passed"
      ? {
          key: "review_threads",
          label: "Review Threads",
          status: "passed",
          detail: "No unresolved review threads.",
        }
      : reviewThreadRun?.status === "blocked"
        ? {
            key: "review_threads",
            label: "Review Threads",
            status: "blocked",
            detail: `${reviewThreadRun.unresolvedThreadCount} unresolved review thread(s).`,
          }
        : reviewThreadRun?.status === "transient_error"
          ? {
              key: "review_threads",
              label: "Review Threads",
              status: "degraded",
              detail:
                "Review-thread evaluation had a transient error and will retry.",
            }
          : {
              key: "review_threads",
              label: "Review Threads",
              status: reviewThreadsFallbackStatus,
              detail:
                reviewThreadsFallbackStatus === "blocked"
                  ? "Loop is blocked on unresolved review threads."
                  : reviewThreadsFallbackStatus === "passed"
                    ? "No unresolved review threads."
                    : reviewThreadsFallbackStatus === "degraded"
                      ? "Loop ended before review-thread evaluation completed."
                      : "Awaiting review thread evaluation.",
            };

  const deepReviewCheck: SdlcLoopStatusCheck = !currentHeadSha
    ? {
        key: "deep_review",
        label: "Deep Review",
        status: "not_started",
        detail: "Deep review starts after CI and review-thread signals.",
      }
    : deepReviewRun?.status === "passed"
      ? {
          key: "deep_review",
          label: "Deep Review",
          status: "passed",
          detail: "No blocking deep review findings.",
        }
      : deepReviewRun
        ? {
            key: "deep_review",
            label: "Deep Review",
            status: "blocked",
            detail:
              unresolvedDeepFindingCount > 0
                ? `${unresolvedDeepFindingCount} unresolved blocking finding(s).`
                : "Deep review reported blocking output.",
          }
        : {
            key: "deep_review",
            label: "Deep Review",
            status: deepReviewFallbackStatus,
            detail:
              deepReviewFallbackStatus === "blocked"
                ? "Loop is blocked on deep review output."
                : deepReviewFallbackStatus === "passed"
                  ? "No blocking deep review findings."
                  : deepReviewFallbackStatus === "degraded"
                    ? "Loop ended before deep review completed."
                    : "Awaiting deep review run.",
          };

  const carmackCheck: SdlcLoopStatusCheck = !currentHeadSha
    ? {
        key: "architecture_carmack",
        label: "Architecture/Carmack",
        status: "not_started",
        detail: "Architecture gate starts after deep review pass.",
      }
    : carmackReviewRun?.status === "passed"
      ? {
          key: "architecture_carmack",
          label: "Architecture/Carmack",
          status: "passed",
          detail: "No blocking architecture findings.",
        }
      : carmackReviewRun
        ? {
            key: "architecture_carmack",
            label: "Architecture/Carmack",
            status: "blocked",
            detail:
              unresolvedCarmackFindingCount > 0
                ? `${unresolvedCarmackFindingCount} unresolved blocking finding(s).`
                : "Architecture gate reported blocking output.",
          }
        : {
            key: "architecture_carmack",
            label: "Architecture/Carmack",
            status: carmackFallbackStatus,
            detail:
              carmackFallbackStatus === "blocked"
                ? "Loop is blocked on architecture findings."
                : carmackFallbackStatus === "passed"
                  ? "No blocking architecture findings."
                  : carmackFallbackStatus === "degraded"
                    ? "Loop ended before architecture review completed."
                    : "Awaiting architecture gate run.",
          };

  const videoCheck: SdlcLoopStatusCheck =
    videoCaptureStatus === "captured"
      ? {
          key: "video",
          label: "Video",
          status: "passed",
          detail: "Session artifact captured.",
        }
      : videoCaptureStatus === "failed"
        ? {
            key: "video",
            label: "Video",
            status: "blocked",
            detail: videoFailureMessage || "Video capture failed.",
          }
        : {
            key: "video",
            label: "Video",
            status: "pending",
            detail: "Video capture has not completed yet.",
          };

  return [
    ciCheck,
    reviewThreadsCheck,
    deepReviewCheck,
    carmackCheck,
    videoCheck,
  ];
}

// Delivery Loop aliases for exported symbols
/** @deprecated Use DeliveryLoopStatusCheckKey */
export type DeliveryLoopStatusCheckKey = SdlcLoopStatusCheckKey;
/** @deprecated Use DeliveryLoopStatusCheckStatus */
export type DeliveryLoopStatusCheckStatus = SdlcLoopStatusCheckStatus;
/** @deprecated Use DeliveryLoopStatusCheck */
export type DeliveryLoopStatusCheck = SdlcLoopStatusCheck;
/** @deprecated Use DeliveryLoopStatusStateSummary */
export type DeliveryLoopStatusStateSummary = SdlcLoopStatusStateSummary;
/** @deprecated Use getDeliveryLoopStateSummary */
export const getDeliveryLoopStateSummary = getSdlcLoopStateSummary;
/** @deprecated Use buildDeliveryLoopStatusChecks */
export const buildDeliveryLoopStatusChecks = buildSdlcLoopStatusChecks;
