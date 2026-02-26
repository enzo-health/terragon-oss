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
  enrolled: {
    stateLabel: "Enrolled",
    explanation: "Loop is enrolled and waiting for implementation progress.",
    progressPercent: 10,
  },
  implementing: {
    stateLabel: "Implementing",
    explanation: "Agent is implementing fixes and preparing gate evaluations.",
    progressPercent: 25,
  },
  gates_running: {
    stateLabel: "Gates Running",
    explanation: "Automated quality gates are evaluating the current head.",
    progressPercent: 55,
  },
  blocked_on_agent_fixes: {
    stateLabel: "Blocked: Agent Fixes",
    explanation:
      "Blocking findings need code changes before the loop can continue.",
    progressPercent: 45,
  },
  blocked_on_ci: {
    stateLabel: "Blocked: CI",
    explanation: "Required CI checks need to pass before moving forward.",
    progressPercent: 65,
  },
  blocked_on_review_threads: {
    stateLabel: "Blocked: Review Threads",
    explanation: "Review threads still need resolution on the pull request.",
    progressPercent: 75,
  },
  video_pending: {
    stateLabel: "Video Pending",
    explanation: "Capturing the session artifact before final handoff.",
    progressPercent: 88,
  },
  human_review_ready: {
    stateLabel: "Human Review Ready",
    explanation:
      "Automated gates passed and the change is ready for human review.",
    progressPercent: 100,
  },
  video_degraded_ready: {
    stateLabel: "Review Ready (No Video)",
    explanation:
      "Loop is review-ready, but video capture could not be completed.",
    progressPercent: 100,
  },
  blocked_on_human_feedback: {
    stateLabel: "Blocked: Human Feedback",
    explanation: "Waiting for human feedback before continuing the loop.",
    progressPercent: 95,
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
    case "blocked_on_ci":
      return "blocked";
    case "human_review_ready":
    case "video_degraded_ready":
    case "blocked_on_human_feedback":
    case "done":
    case "terminated_pr_merged":
      return "passed";
    case "terminated_pr_closed":
    case "stopped":
      return "degraded";
    case "enrolled":
    case "implementing":
      return "not_started";
    default:
      return "pending";
  }
}

function inferReviewThreadsStatusFromLoopState(
  loopState: SdlcLoopState,
): SdlcLoopStatusCheckStatus {
  switch (loopState) {
    case "blocked_on_review_threads":
      return "blocked";
    case "human_review_ready":
    case "video_pending":
    case "video_degraded_ready":
    case "blocked_on_human_feedback":
    case "done":
    case "terminated_pr_merged":
      return "passed";
    case "terminated_pr_closed":
    case "stopped":
      return "degraded";
    case "enrolled":
    case "implementing":
      return "not_started";
    default:
      return "pending";
  }
}

function inferDeepReviewStatusFromLoopState(
  loopState: SdlcLoopState,
): SdlcLoopStatusCheckStatus {
  switch (loopState) {
    case "blocked_on_agent_fixes":
      return "blocked";
    case "human_review_ready":
    case "video_pending":
    case "video_degraded_ready":
    case "blocked_on_human_feedback":
    case "done":
    case "terminated_pr_merged":
      return "passed";
    case "terminated_pr_closed":
    case "stopped":
      return "degraded";
    case "enrolled":
    case "implementing":
    case "blocked_on_ci":
    case "blocked_on_review_threads":
      return "not_started";
    default:
      return "pending";
  }
}

function inferCarmackStatusFromLoopState(
  loopState: SdlcLoopState,
): SdlcLoopStatusCheckStatus {
  switch (loopState) {
    case "blocked_on_agent_fixes":
      return "blocked";
    case "human_review_ready":
    case "video_pending":
    case "video_degraded_ready":
    case "blocked_on_human_feedback":
    case "done":
    case "terminated_pr_merged":
      return "passed";
    case "terminated_pr_closed":
    case "stopped":
      return "degraded";
    case "enrolled":
    case "implementing":
    case "blocked_on_ci":
    case "blocked_on_review_threads":
      return "not_started";
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
            status:
              loopState === "video_degraded_ready" ? "degraded" : "blocked",
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
