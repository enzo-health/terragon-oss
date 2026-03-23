import type {
  DeliveryCarmackReviewStatus,
  DeliveryCiGateStatus,
  DeliveryDeepReviewStatus,
  DeliveryLoopState,
  DeliveryReviewThreadGateStatus,
  DeliveryVideoCaptureStatus,
} from "@terragon/shared/db/types";
import type {
  DeliveryLoopBlockedState,
  DeliveryLoopSnapshot,
} from "@terragon/shared/delivery-loop/domain/snapshot-types";
import type {
  DeliveryWorkflow,
  GateKind,
} from "@terragon/shared/delivery-loop/domain/workflow";
export type DeliveryLoopStatusCheckKey =
  | "ci"
  | "review_threads"
  | "deep_review"
  | "architecture_carmack"
  | "video";

export type DeliveryLoopStatusCheckStatus =
  | "passed"
  | "blocked"
  | "pending"
  | "not_started"
  | "degraded";

export type DeliveryLoopStatusCheck = {
  key: DeliveryLoopStatusCheckKey;
  label: string;
  status: DeliveryLoopStatusCheckStatus;
  detail: string;
};

export type DeliveryLoopTopProgressPhaseKey =
  | "planning"
  | "implementing"
  | "reviewing"
  | "ci"
  | "ui_testing";

export type DeliveryLoopTopProgressPhase = {
  key: DeliveryLoopTopProgressPhaseKey;
  label: string;
  status: DeliveryLoopStatusCheckStatus;
};

type DeliveryLoopStatusCiRun = {
  status: DeliveryCiGateStatus;
  failingRequiredChecks: string[];
};

type DeliveryLoopStatusReviewThreadRun = {
  status: DeliveryReviewThreadGateStatus;
  unresolvedThreadCount: number;
};

type DeliveryLoopStatusDeepReviewRun = {
  status: DeliveryDeepReviewStatus;
};

type DeliveryLoopStatusCarmackReviewRun = {
  status: DeliveryCarmackReviewStatus;
};

export type DeliveryLoopStatusStateSummary = {
  stateLabel: string;
  explanation: string;
  progressPercent: number;
};

const TOP_PROGRESS_PHASE_LABELS: Record<
  DeliveryLoopTopProgressPhaseKey,
  string
> = {
  planning: "Planning",
  implementing: "Implementing",
  reviewing: "Reviewing",
  ci: "CI",
  ui_testing: "UI Testing",
};

const DELIVERY_STATE_SUMMARY = {
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
} satisfies Record<DeliveryLoopState, DeliveryLoopStatusStateSummary>;

function getBlockedStateSummary(
  blocked: DeliveryLoopBlockedState,
): DeliveryLoopStatusStateSummary {
  switch (blocked.from) {
    case "planning":
      return {
        stateLabel: "Blocked in Planning",
        explanation:
          "Planning is blocked and waiting for human intervention before implementation can start.",
        progressPercent: 10,
      };
    case "implementing":
      return {
        stateLabel: "Blocked in Implementing",
        explanation:
          "Implementation is blocked and waiting for human intervention before coding can continue.",
        progressPercent: 25,
      };
    case "review_gate":
      return {
        stateLabel: "Blocked in Review Gate",
        explanation:
          "A review gate is blocked and needs intervention before the loop can continue.",
        progressPercent: 45,
      };
    case "ci_gate":
      return {
        stateLabel: "Blocked in CI Gate",
        explanation:
          "CI is blocked and needs intervention before the loop can continue.",
        progressPercent: 55,
      };
    case "ui_gate":
      return {
        stateLabel: "Blocked in UI Gate",
        explanation:
          "UI validation is blocked and needs intervention before the loop can continue.",
        progressPercent: 65,
      };
    case "awaiting_pr_link":
      return {
        stateLabel: "Blocked Awaiting PR",
        explanation:
          "The loop is blocked while waiting for PR linkage or human intervention.",
        progressPercent: 75,
      };
    case "babysitting":
      return {
        stateLabel: "Blocked in Babysitting",
        explanation:
          "The loop is blocked while monitoring PR feedback and CI outcomes.",
        progressPercent: 85,
      };
  }
}

export function getDeliveryLoopBlockedAttentionTitle(
  blocked: DeliveryLoopBlockedState,
): string {
  switch (blocked.from) {
    case "planning":
      return "Planning is blocked and needs human feedback";
    case "implementing":
      return "Implementation is blocked and needs human feedback";
    case "review_gate":
      return "Review gate is blocked and needs human feedback";
    case "ci_gate":
      return "CI gate is blocked and needs human feedback";
    case "ui_gate":
      return "UI gate is blocked and needs human feedback";
    case "awaiting_pr_link":
      return "Awaiting PR linkage or human intervention";
    case "babysitting":
      return "Babysitting is blocked and needs human feedback";
  }
}

export function getDeliveryLoopSnapshotStateSummary(
  snapshot: DeliveryLoopSnapshot,
): DeliveryLoopStatusStateSummary {
  switch (snapshot.kind) {
    case "blocked":
      return getBlockedStateSummary(snapshot);
    case "planning":
    case "implementing":
    case "review_gate":
    case "ci_gate":
    case "ui_gate":
    case "awaiting_pr_link":
    case "babysitting":
    case "done":
    case "stopped":
    case "terminated_pr_closed":
    case "terminated_pr_merged":
      return DELIVERY_STATE_SUMMARY[snapshot.kind];
  }
}

function getEffectiveLoopStateForChecks(
  snapshot: DeliveryLoopSnapshot,
):
  | Exclude<DeliveryLoopSnapshot["kind"], "blocked">
  | DeliveryLoopBlockedState["from"] {
  if (snapshot.kind === "blocked") {
    return snapshot.from;
  }
  return snapshot.kind;
}

function inferCiStatusFromLoopState(
  snapshot: DeliveryLoopSnapshot,
): DeliveryLoopStatusCheckStatus {
  const loopState = getEffectiveLoopStateForChecks(snapshot);
  switch (loopState) {
    case "planning":
    case "implementing":
    case "review_gate":
      return "not_started";
    case "ci_gate":
      return "pending";
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
  snapshot: DeliveryLoopSnapshot,
): DeliveryLoopStatusCheckStatus {
  const loopState = getEffectiveLoopStateForChecks(snapshot);
  switch (loopState) {
    case "planning":
    case "implementing":
    case "review_gate":
    case "ci_gate":
    case "ui_gate":
      return "not_started";
    case "babysitting":
      return "pending";
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

function inferReviewGateStatusFromLoopState(
  snapshot: DeliveryLoopSnapshot,
): DeliveryLoopStatusCheckStatus {
  const loopState = getEffectiveLoopStateForChecks(snapshot);
  switch (loopState) {
    case "planning":
    case "implementing":
      return "not_started";
    case "review_gate":
      return "pending";
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

function aggregateTopProgressStatuses(
  statuses: readonly DeliveryLoopStatusCheckStatus[],
): DeliveryLoopStatusCheckStatus {
  if (statuses.length === 0) {
    return "not_started";
  }
  if (statuses.some((status) => status === "blocked")) {
    return "blocked";
  }
  if (statuses.some((status) => status === "pending")) {
    return "pending";
  }
  const hasNotStarted = statuses.some((status) => status === "not_started");
  const hasPassedLike = statuses.some(
    (status) => status === "passed" || status === "degraded",
  );
  if (hasNotStarted && hasPassedLike) {
    return "pending";
  }
  if (hasNotStarted) {
    return "not_started";
  }
  if (statuses.some((status) => status === "degraded")) {
    return "degraded";
  }
  return "passed";
}

function getCheckStatusOrDefault(
  checks: readonly DeliveryLoopStatusCheck[],
  key: DeliveryLoopStatusCheckKey,
): DeliveryLoopStatusCheckStatus {
  return checks.find((check) => check.key === key)?.status ?? "not_started";
}

export function buildDeliveryLoopTopProgressPhases({
  loopSnapshot,
  checks,
}: {
  loopSnapshot: DeliveryLoopSnapshot;
  checks: readonly DeliveryLoopStatusCheck[];
}): DeliveryLoopTopProgressPhase[] {
  const effectiveState = getEffectiveLoopStateForChecks(loopSnapshot);
  const reviewStatuses = [
    getCheckStatusOrDefault(checks, "review_threads"),
    getCheckStatusOrDefault(checks, "deep_review"),
    getCheckStatusOrDefault(checks, "architecture_carmack"),
  ];
  const reviewStatus = aggregateTopProgressStatuses(reviewStatuses);
  const ciStatus = getCheckStatusOrDefault(checks, "ci");
  const uiStatus = getCheckStatusOrDefault(checks, "video");

  const planningStatus: DeliveryLoopStatusCheckStatus =
    effectiveState === "planning" ? "pending" : "passed";

  const implementingStatus: DeliveryLoopStatusCheckStatus =
    effectiveState === "planning"
      ? "not_started"
      : effectiveState === "implementing"
        ? "pending"
        : effectiveState === "stopped" ||
            effectiveState === "terminated_pr_closed"
          ? "degraded"
          : "passed";

  const normalizedReviewStatus: DeliveryLoopStatusCheckStatus =
    effectiveState === "planning" || effectiveState === "implementing"
      ? "not_started"
      : effectiveState === "stopped" ||
          effectiveState === "terminated_pr_closed"
        ? "degraded"
        : effectiveState === "review_gate" && reviewStatus === "not_started"
          ? "pending"
          : effectiveState === "ci_gate" ||
              effectiveState === "ui_gate" ||
              effectiveState === "awaiting_pr_link" ||
              effectiveState === "babysitting" ||
              effectiveState === "done" ||
              effectiveState === "terminated_pr_merged"
            ? reviewStatus === "not_started"
              ? "pending"
              : reviewStatus
            : reviewStatus;

  const normalizedCiStatus: DeliveryLoopStatusCheckStatus =
    effectiveState === "planning" ||
    effectiveState === "implementing" ||
    effectiveState === "review_gate"
      ? "not_started"
      : effectiveState === "stopped" ||
          effectiveState === "terminated_pr_closed"
        ? "degraded"
        : effectiveState === "ci_gate" && ciStatus === "not_started"
          ? "pending"
          : effectiveState === "babysitting" ||
              effectiveState === "awaiting_pr_link" ||
              effectiveState === "done" ||
              effectiveState === "terminated_pr_merged"
            ? ciStatus === "not_started"
              ? "pending"
              : ciStatus
            : ciStatus;

  const normalizedUiStatus: DeliveryLoopStatusCheckStatus =
    effectiveState === "planning" ||
    effectiveState === "implementing" ||
    effectiveState === "review_gate" ||
    effectiveState === "ci_gate"
      ? "not_started"
      : effectiveState === "stopped" ||
          effectiveState === "terminated_pr_closed"
        ? "degraded"
        : effectiveState === "ui_gate" && uiStatus === "not_started"
          ? "pending"
          : effectiveState === "awaiting_pr_link" ||
              effectiveState === "babysitting" ||
              effectiveState === "done" ||
              effectiveState === "terminated_pr_merged"
            ? uiStatus === "not_started"
              ? "pending"
              : uiStatus
            : uiStatus;

  return [
    {
      key: "planning",
      label: TOP_PROGRESS_PHASE_LABELS.planning,
      status: planningStatus,
    },
    {
      key: "implementing",
      label: TOP_PROGRESS_PHASE_LABELS.implementing,
      status: implementingStatus,
    },
    {
      key: "reviewing",
      label: TOP_PROGRESS_PHASE_LABELS.reviewing,
      status: normalizedReviewStatus,
    },
    {
      key: "ci",
      label: TOP_PROGRESS_PHASE_LABELS.ci,
      status: normalizedCiStatus,
    },
    {
      key: "ui_testing",
      label: TOP_PROGRESS_PHASE_LABELS.ui_testing,
      status: normalizedUiStatus,
    },
  ];
}

export function buildDeliveryLoopStatusChecks({
  loopSnapshot,
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
  loopSnapshot: DeliveryLoopSnapshot;
  currentHeadSha: string | null;
  ciRun: DeliveryLoopStatusCiRun | null;
  reviewThreadRun: DeliveryLoopStatusReviewThreadRun | null;
  deepReviewRun: DeliveryLoopStatusDeepReviewRun | null;
  carmackReviewRun: DeliveryLoopStatusCarmackReviewRun | null;
  unresolvedDeepFindingCount: number;
  unresolvedCarmackFindingCount: number;
  videoCaptureStatus: DeliveryVideoCaptureStatus;
  videoFailureMessage: string | null;
}): DeliveryLoopStatusCheck[] {
  const ciFallbackStatus = inferCiStatusFromLoopState(loopSnapshot);
  const reviewThreadsFallbackStatus =
    inferReviewThreadsStatusFromLoopState(loopSnapshot);
  const deepReviewFallbackStatus =
    inferReviewGateStatusFromLoopState(loopSnapshot);
  const carmackFallbackStatus =
    inferReviewGateStatusFromLoopState(loopSnapshot);

  const ciCheck: DeliveryLoopStatusCheck = !currentHeadSha
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

  const reviewThreadsCheck: DeliveryLoopStatusCheck = !currentHeadSha
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

  const deepReviewCheck: DeliveryLoopStatusCheck = !currentHeadSha
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

  const carmackCheck: DeliveryLoopStatusCheck = !currentHeadSha
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

  const videoCheck: DeliveryLoopStatusCheck =
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

// ---------------------------------------------------------------------------
// V2 workflow -> V1 DeliveryLoopSnapshot adapter
// ---------------------------------------------------------------------------

const V2_GATE_TO_V1_STATE: Record<GateKind, DeliveryLoopSnapshot["kind"]> = {
  review: "review_gate",
  ci: "ci_gate",
  ui: "ui_gate",
};

const V2_RESUMABLE_TO_V1: Record<string, DeliveryLoopBlockedState["from"]> = {
  planning: "planning",
  implementing: "implementing",
  gating: "review_gate", // overridden by gate subfield when available
  awaiting_pr: "awaiting_pr_link",
  babysitting: "babysitting",
};

function mapResumableKindToV1(
  resumableKind: string,
  gate?: GateKind,
): DeliveryLoopBlockedState["from"] {
  if (resumableKind === "gating" && gate) {
    return V2_GATE_TO_V1_STATE[gate] as DeliveryLoopBlockedState["from"];
  }
  return V2_RESUMABLE_TO_V1[resumableKind] ?? "implementing";
}

/**
 * Maps a v2 DeliveryWorkflow aggregate to the v1 DeliveryLoopSnapshot
 * shape consumed by the UI status builder functions.
 */
export function buildSnapshotFromV2Workflow(
  workflow: DeliveryWorkflow,
): DeliveryLoopSnapshot {
  switch (workflow.kind) {
    case "planning":
      return {
        kind: "planning",
        selectedAgent: null,
        nextPhaseTarget: null,
        dispatchStatus: null,
        dispatchAttemptCount: 0,
        activeRunId: null,
        lastFailureCategory: null,
      };

    case "implementing": {
      const dispatch = (workflow as Record<string, unknown>).dispatch as
        | { kind?: string; failure?: { kind?: string } }
        | null
        | undefined;
      return {
        kind: "implementing",
        execution: {
          kind: "implementation",
          selectedAgent: null,
          dispatchStatus: dispatch
            ? dispatch.kind === "queued"
              ? "prepared"
              : dispatch.kind === "sent"
                ? "dispatched"
                : dispatch.kind === "acknowledged"
                  ? "acknowledged"
                  : dispatch.kind === "failed"
                    ? "failed"
                    : null
            : null,
          dispatchAttemptCount: 0,
          activeRunId: null,
          lastFailureCategory:
            dispatch?.kind === "failed"
              ? (dispatch.failure?.kind ?? null)
              : null,
        },
      };
    }

    case "gating": {
      const gate = (workflow as Record<string, unknown>).gate as
        | { kind?: GateKind; runId?: string; status?: string }
        | null
        | undefined;
      if (!gate?.kind) {
        // Malformed stateJson — fall back to implementing snapshot
        return {
          kind: "implementing",
          execution: {
            kind: "implementation",
            selectedAgent: null,
            dispatchStatus: null,
            dispatchAttemptCount: 0,
            activeRunId: null,
            lastFailureCategory: null,
          },
        };
      }
      return {
        kind: V2_GATE_TO_V1_STATE[gate.kind] as
          | "review_gate"
          | "ci_gate"
          | "ui_gate",
        gate: {
          gateRunId: gate.runId ?? null,
          lastFailureCategory:
            gate.status === "blocked" ? "gate_blocked" : null,
        },
      };
    }

    case "awaiting_pr":
      return {
        kind: "awaiting_pr_link",
        selectedAgent: null,
        lastFailureCategory: null,
      };

    case "babysitting":
      return {
        kind: "babysitting",
        selectedAgent: null,
        lastFailureCategory: null,
      };

    case "awaiting_plan_approval":
      return {
        kind: "blocked",
        from: "planning",
        reason: "human_required",
        selectedAgent: null,
        dispatchStatus: null,
        dispatchAttemptCount: 0,
        activeRunId: null,
        activeGateRunId: null,
        lastFailureCategory: null,
      };

    case "awaiting_manual_fix": {
      const resumable = (workflow as Record<string, unknown>).resumableFrom as
        | { kind?: string; gate?: GateKind }
        | null
        | undefined;
      const from = resumable?.kind
        ? mapResumableKindToV1(resumable.kind, resumable.gate)
        : "implementing";
      return {
        kind: "blocked",
        from,
        reason: "runtime_failure",
        selectedAgent: null,
        dispatchStatus: null,
        dispatchAttemptCount: 0,
        activeRunId: null,
        activeGateRunId: null,
        lastFailureCategory: null,
      };
    }

    case "awaiting_operator_action": {
      const resumable = (workflow as Record<string, unknown>).resumableFrom as
        | { kind?: string; gate?: GateKind }
        | null
        | undefined;
      const from = resumable?.kind
        ? mapResumableKindToV1(resumable.kind, resumable.gate)
        : "implementing";
      return {
        kind: "blocked",
        from,
        reason: "external_dependency",
        selectedAgent: null,
        dispatchStatus: null,
        dispatchAttemptCount: 0,
        activeRunId: null,
        activeGateRunId: null,
        lastFailureCategory: null,
      };
    }

    case "done":
      return { kind: "done" };

    case "stopped":
      return { kind: "stopped" };

    case "terminated": {
      const reason = (workflow as Record<string, unknown>).reason as
        | { kind?: string }
        | null
        | undefined;
      return reason?.kind === "pr_merged"
        ? { kind: "terminated_pr_merged" }
        : { kind: "terminated_pr_closed" };
    }
  }
}

/**
 * Maps a v2 workflow kind to the v1 DeliveryLoopState string used by the
 * status response shape. Gating states expand to review_gate/ci_gate/ui_gate.
 */
export function mapV2KindToDeliveryLoopState(
  workflow: DeliveryWorkflow,
): DeliveryLoopState {
  switch (workflow.kind) {
    case "planning":
      return "planning";
    case "implementing":
      return "implementing";
    case "gating": {
      const gate = (workflow as Record<string, unknown>).gate as
        | { kind?: GateKind }
        | null
        | undefined;
      return gate?.kind
        ? (V2_GATE_TO_V1_STATE[gate.kind] as DeliveryLoopState)
        : "implementing";
    }
    case "awaiting_pr":
      return "awaiting_pr_link";
    case "babysitting":
      return "babysitting";
    case "awaiting_plan_approval":
    case "awaiting_manual_fix":
    case "awaiting_operator_action":
      return "blocked";
    case "done":
      return "done";
    case "stopped":
      return "stopped";
    case "terminated": {
      const reason = (workflow as Record<string, unknown>).reason as
        | { kind?: string }
        | null
        | undefined;
      return reason?.kind === "pr_merged"
        ? "terminated_pr_merged"
        : "terminated_pr_closed";
    }
  }
}

/**
 * @deprecated v2 fallback only — v3 stores stop reasons in `blockedReason` on
 * the workflow head row. Only caller (get-delivery-loop-status.ts:612) already
 * prefers `v3Head.blockedReason`; this remains as a null-coalesce fallback for
 * rows that pre-date the v3 migration. Remove once all legacy rows are drained.
 */
export function getV2StopReason(workflow: DeliveryWorkflow): string | null {
  if (workflow.kind === "stopped") {
    const reason = (workflow as Record<string, unknown>).reason as
      | { kind?: string; newerWorkflowId?: string }
      | null
      | undefined;
    if (!reason?.kind) return "Stopped";
    return reason.kind === "user_requested"
      ? "Stopped by user"
      : `Superseded by workflow ${reason.newerWorkflowId ?? "unknown"}`;
  }
  if (workflow.kind === "terminated") {
    const reason = (workflow as Record<string, unknown>).reason as
      | { kind?: string; code?: string; subject?: string; system?: string }
      | null
      | undefined;
    if (!reason?.kind) return "Terminated";
    switch (reason.kind) {
      case "pr_closed":
        return "Pull request was closed";
      case "pr_merged":
        return "Pull request was merged";
      case "invariant_violation":
        return `Invariant violation: ${reason.code ?? "unknown"}`;
      case "retry_exhausted":
        return `Retry budget exhausted for ${reason.subject ?? "unknown"}`;
      case "fatal_external_failure":
        return `Fatal failure in ${reason.system ?? "unknown"}`;
      default:
        return "Terminated";
    }
  }
  return null;
}
