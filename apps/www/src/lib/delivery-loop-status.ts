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
import type { ThreadStatus } from "@terragon/shared";
import type { BroadcastThreadPatch } from "@terragon/types/broadcast";
import type { WorkflowHead } from "@/server-lib/delivery-loop/v3/types";

export const DELIVERY_LOOP_LIVENESS_WINDOW_MS = 2 * 60 * 1000;

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

function assertNever(value: never, context: string): never {
  throw new Error(`Unhandled ${context}: ${String(value)}`);
}

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
    case "awaiting_pr_link":
    case "babysitting":
    case "done":
    case "stopped":
    case "terminated_pr_closed":
    case "terminated_pr_merged":
      return DELIVERY_STATE_SUMMARY[snapshot.kind];
  }
}

export function isDeliveryLoopStateActivelyWorking(
  state: DeliveryLoopState | null | undefined,
): boolean {
  if (state === null || state === undefined) {
    return false;
  }
  switch (state) {
    case "planning":
    case "implementing":
    case "review_gate":
    case "ci_gate":
    case "babysitting":
      return true;
    case "awaiting_pr_link":
    case "blocked":
    case "terminated_pr_closed":
    case "terminated_pr_merged":
    case "done":
    case "stopped":
      return false;
    default:
      return assertNever(state, "delivery loop state");
  }
}

function parseDateLike(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value : null;
  }
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

export type LivenessEvidence =
  | {
      kind: "fresh";
      latestEvidenceAt: Date;
      ageMs: number;
    }
  | {
      kind: "stale";
      latestEvidenceAt: Date;
      ageMs: number;
    }
  | {
      kind: "unknown";
    };

export function classifyLivenessEvidence(params: {
  now: Date;
  threadChatUpdatedAt?: Date | string | null;
  deliveryLoopUpdatedAtIso?: string | null;
  windowMs?: number;
}): LivenessEvidence {
  const windowMs = params.windowMs ?? DELIVERY_LOOP_LIVENESS_WINDOW_MS;
  const chatUpdatedAt = parseDateLike(params.threadChatUpdatedAt);
  const loopUpdatedAt = parseDateLike(params.deliveryLoopUpdatedAtIso ?? null);
  const candidates = [chatUpdatedAt, loopUpdatedAt].filter(
    (value): value is Date => value !== null,
  );
  if (candidates.length === 0) {
    return { kind: "unknown" };
  }
  const latestEvidenceAt = candidates.reduce((latest, current) =>
    current.getTime() > latest.getTime() ? current : latest,
  );
  const ageMs = params.now.getTime() - latestEvidenceAt.getTime();
  if (ageMs <= windowMs) {
    return { kind: "fresh", latestEvidenceAt, ageMs };
  }
  return { kind: "stale", latestEvidenceAt, ageMs };
}

export function shouldUseDeliveryLoopHeadOverride(params: {
  now: Date;
  deliveryLoopUpdatedAtIso?: string | null;
  threadChatUpdatedAt?: Date | string | null;
  windowMs?: number;
}): boolean {
  const windowMs = params.windowMs ?? DELIVERY_LOOP_LIVENESS_WINDOW_MS;
  const loopUpdatedAt = parseDateLike(params.deliveryLoopUpdatedAtIso ?? null);
  if (!loopUpdatedAt) {
    return false;
  }
  const ageMs = params.now.getTime() - loopUpdatedAt.getTime();
  if (ageMs > windowMs) {
    return false;
  }

  const chatUpdatedAt = parseDateLike(params.threadChatUpdatedAt ?? null);
  if (!chatUpdatedAt) {
    return true;
  }

  // Relative freshness: the delivery-loop head can only override chat evidence
  // when it is strictly newer than chat.
  return loopUpdatedAt.getTime() > chatUpdatedAt.getTime();
}

export type WorkingFooterFreshness =
  | { kind: "fresh" }
  | { kind: "uncertain"; message: string };

export function getWorkingFooterFreshness(params: {
  now: Date;
  isWorkingCandidate: boolean;
  threadChatUpdatedAt?: Date | string | null;
  deliveryLoopUpdatedAtIso?: string | null;
  windowMs?: number;
  uncertainMessage?: string;
}): WorkingFooterFreshness {
  if (!params.isWorkingCandidate) {
    return { kind: "fresh" };
  }

  const evidence = classifyLivenessEvidence({
    now: params.now,
    threadChatUpdatedAt: params.threadChatUpdatedAt,
    deliveryLoopUpdatedAtIso: params.deliveryLoopUpdatedAtIso ?? null,
    windowMs: params.windowMs,
  });

  if (evidence.kind === "fresh") {
    return { kind: "fresh" };
  }

  return {
    kind: "uncertain",
    message: params.uncertainMessage ?? "Waiting for updates",
  };
}

export function getDeliveryLoopAwareThreadStatus(params: {
  threadStatus: ThreadStatus | null;
  deliveryLoopState: DeliveryLoopState | null | undefined;
  deliveryLoopUpdatedAtIso?: string | null;
  threadChatUpdatedAt?: Date | string | null;
  now?: Date;
  windowMs?: number;
}): ThreadStatus | null {
  if (!isDeliveryLoopStateActivelyWorking(params.deliveryLoopState)) {
    return params.threadStatus;
  }

  const now = params.now ?? new Date();
  if (
    !shouldUseDeliveryLoopHeadOverride({
      now,
      deliveryLoopUpdatedAtIso: params.deliveryLoopUpdatedAtIso ?? null,
      threadChatUpdatedAt: params.threadChatUpdatedAt ?? null,
      windowMs: params.windowMs,
    })
  ) {
    return params.threadStatus;
  }

  if (params.threadStatus === null) {
    return "working";
  }

  switch (params.threadStatus) {
    case "queued":
    case "queued-blocked":
    case "queued-sandbox-creation-rate-limit":
    case "queued-tasks-concurrency":
    case "queued-agent-rate-limit":
    case "working":
    case "stopping":
    case "working-stopped":
    case "working-error":
    case "working-done":
    case "checkpointing":
      return params.threadStatus;
    case "booting":
    case "draft":
    case "scheduled":
    case "stopped":
    case "complete":
    case "error":
      return "working";
    default:
      return assertNever(params.threadStatus, "thread status");
  }
}

function isAgentMessageLike(message: unknown): boolean {
  return (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    (message as { type?: unknown }).type === "agent"
  );
}

export function shouldRefreshDeliveryLoopStatusFromThreadPatch(
  patch: BroadcastThreadPatch,
): boolean {
  if (patch.op === "delete" || patch.op === "delta") {
    return false;
  }

  if (patch.op === "refetch") {
    return true;
  }

  if ((patch.refetch ?? []).some((target) => target === "shell")) {
    return true;
  }

  // Status and URL changes that affect PR link visibility
  if (patch.shell !== undefined) {
    // Refresh for PR status changes that might transition delivery loop phases
    if (patch.shell.prStatus !== undefined) {
      return true;
    }
    // Refresh for PR number field changes
    if (patch.shell.githubPRNumber !== undefined) {
      return true;
    }
    // Refresh for PR checks status changes
    if (patch.shell.prChecksStatus !== undefined) {
      return true;
    }
    return false;
  }

  // Chat status changes indicate delivery loop phase transitions
  if (patch.chat?.status !== undefined || patch.chat?.updatedAt !== undefined) {
    return true;
  }

  // Agent messages indicate active work that may affect delivery loop state
  return (patch.appendMessages ?? []).some(isAgentMessageLike);
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

/**
 * Pipeline ordering of non-terminal delivery loop states.
 * Each phase becomes "pending" at the state matching its key in
 * PHASE_PENDING_AT; states earlier in the pipeline are "not_started",
 * states later are "passed". Terminal states are handled separately.
 */
const STATE_PIPELINE = [
  "planning",
  "implementing",
  "review_gate",
  "ci_gate",
  "babysitting",
  "awaiting_pr_link",
  "done",
] as const;

type PhaseKey = "ci" | "reviewThreads" | "reviewGate";

const PHASE_PENDING_AT: Record<PhaseKey, (typeof STATE_PIPELINE)[number]> = {
  ci: "ci_gate",
  reviewThreads: "babysitting",
  reviewGate: "review_gate",
};

function inferPhaseStatusFromLoopState(
  snapshot: DeliveryLoopSnapshot,
  phase: PhaseKey,
): DeliveryLoopStatusCheckStatus {
  const loopState = getEffectiveLoopStateForChecks(snapshot);

  // Terminal states always map to a fixed result
  switch (loopState) {
    case "terminated_pr_closed":
    case "stopped":
      return "degraded";
    case "terminated_pr_merged":
      return "passed";
    default:
      break;
  }

  const pendingState = PHASE_PENDING_AT[phase];
  const pendingIndex = STATE_PIPELINE.indexOf(pendingState);
  const currentIndex = STATE_PIPELINE.indexOf(loopState);

  if (currentIndex === -1) {
    // Exhaustiveness: if a new state is added but not to STATE_PIPELINE,
    // this will fire at runtime.
    return assertNever(
      loopState as never,
      `loop state for ${phase} phase fallback`,
    );
  }

  if (currentIndex < pendingIndex) {
    return "not_started";
  }
  if (currentIndex === pendingIndex) {
    return "pending";
  }
  return "passed";
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

/** Shared builder for gate-style status checks (CI, review, deep review, etc.) */
function buildGateCheck({
  key,
  label,
  currentHeadSha,
  runStatus,
  fallbackStatus,
  blockedDetail,
  transientErrorDetail,
  details,
}: {
  key: DeliveryLoopStatusCheckKey;
  label: string;
  currentHeadSha: string | null;
  runStatus: string | null;
  fallbackStatus: DeliveryLoopStatusCheckStatus;
  blockedDetail: string | null;
  transientErrorDetail?: string | null;
  details: {
    notStarted: string;
    passed: string;
    pending: string;
    degraded: string;
    blocked: string;
  };
}): DeliveryLoopStatusCheck {
  if (!currentHeadSha) {
    return { key, label, status: "not_started", detail: details.notStarted };
  }
  if (runStatus === "passed") {
    return { key, label, status: "passed", detail: details.passed };
  }
  if (transientErrorDetail) {
    return { key, label, status: "degraded", detail: transientErrorDetail };
  }
  if (blockedDetail) {
    return { key, label, status: "blocked", detail: blockedDetail };
  }
  const detail =
    fallbackStatus === "blocked"
      ? details.blocked
      : fallbackStatus === "passed"
        ? details.passed
        : fallbackStatus === "degraded"
          ? details.degraded
          : details.pending;
  return { key, label, status: fallbackStatus, detail };
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
  const ciFallbackStatus = inferPhaseStatusFromLoopState(loopSnapshot, "ci");
  const reviewThreadsFallbackStatus = inferPhaseStatusFromLoopState(
    loopSnapshot,
    "reviewThreads",
  );
  const deepReviewFallbackStatus = inferPhaseStatusFromLoopState(
    loopSnapshot,
    "reviewGate",
  );
  const carmackFallbackStatus = inferPhaseStatusFromLoopState(
    loopSnapshot,
    "reviewGate",
  );

  // --- Build individual checks using shared helper ---

  const ciCheck = buildGateCheck({
    key: "ci",
    label: "CI",
    currentHeadSha,
    runStatus: ciRun?.status ?? null,
    fallbackStatus: ciFallbackStatus,
    blockedDetail:
      ciRun?.status === "blocked" || ciRun?.status === "capability_error"
        ? ciRun.failingRequiredChecks.length > 0
          ? `${ciRun.failingRequiredChecks.length} required check(s) failing.`
          : "Required checks are currently blocked."
        : null,
    details: {
      notStarted: "Waiting for the first pushed head SHA.",
      passed: "Required checks are passing.",
      pending: "Awaiting CI evaluation for the current head.",
      degraded: "Loop ended before CI evaluation completed.",
      blocked: "Loop is blocked on CI.",
    },
  });

  const reviewThreadsCheck = buildGateCheck({
    key: "review_threads",
    label: "Review Threads",
    currentHeadSha,
    runStatus: reviewThreadRun?.status ?? null,
    fallbackStatus: reviewThreadsFallbackStatus,
    blockedDetail:
      reviewThreadRun?.status === "blocked"
        ? `${reviewThreadRun.unresolvedThreadCount} unresolved review thread(s).`
        : null,
    transientErrorDetail:
      reviewThreadRun?.status === "transient_error"
        ? "Review-thread evaluation had a transient error and will retry."
        : null,
    details: {
      notStarted: "Review gate starts after a head SHA is available.",
      passed: "No unresolved review threads.",
      pending: "Awaiting review thread evaluation.",
      degraded: "Loop ended before review-thread evaluation completed.",
      blocked: "Loop is blocked on unresolved review threads.",
    },
  });

  const deepReviewCheck = buildGateCheck({
    key: "deep_review",
    label: "Deep Review",
    currentHeadSha,
    runStatus: deepReviewRun?.status ?? null,
    fallbackStatus: deepReviewFallbackStatus,
    blockedDetail:
      deepReviewRun && deepReviewRun.status !== "passed"
        ? unresolvedDeepFindingCount > 0
          ? `${unresolvedDeepFindingCount} unresolved blocking finding(s).`
          : "Deep review reported blocking output."
        : null,
    details: {
      notStarted: "Deep review starts after CI and review-thread signals.",
      passed: "No blocking deep review findings.",
      pending: "Awaiting deep review run.",
      degraded: "Loop ended before deep review completed.",
      blocked: "Loop is blocked on deep review output.",
    },
  });

  const carmackCheck = buildGateCheck({
    key: "architecture_carmack",
    label: "Architecture/Carmack",
    currentHeadSha,
    runStatus: carmackReviewRun?.status ?? null,
    fallbackStatus: carmackFallbackStatus,
    blockedDetail:
      carmackReviewRun && carmackReviewRun.status !== "passed"
        ? unresolvedCarmackFindingCount > 0
          ? `${unresolvedCarmackFindingCount} unresolved blocking finding(s).`
          : "Architecture gate reported blocking output."
        : null,
    details: {
      notStarted: "Architecture gate starts after deep review pass.",
      passed: "No blocking architecture findings.",
      pending: "Awaiting architecture gate run.",
      degraded: "Loop ended before architecture review completed.",
      blocked: "Loop is blocked on architecture findings.",
    },
  });

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
// V3 workflow head -> DeliveryLoopSnapshot adapter
// ---------------------------------------------------------------------------

/**
 * Maps a v3 WorkflowHead to the DeliveryLoopSnapshot shape consumed by
 * the UI status builder functions.
 */
export function buildSnapshotFromHead(
  head: WorkflowHead,
): DeliveryLoopSnapshot {
  switch (head.state) {
    case "planning":
      return {
        kind: "planning",
        selectedAgent: null,
        nextPhaseTarget: null,
        dispatchStatus: null,
        dispatchAttemptCount: 0,
        activeRunId: head.activeRunId ?? null,
        lastFailureCategory: null,
      };

    case "implementing":
      return {
        kind: "implementing",
        execution: {
          kind: "implementation",
          selectedAgent: null,
          dispatchStatus: null,
          dispatchAttemptCount: 0,
          activeRunId: head.activeRunId ?? null,
          lastFailureCategory: null,
        },
      };

    case "awaiting_implementation_acceptance":
      return {
        kind: "implementing",
        execution: {
          kind: "implementation",
          selectedAgent: null,
          dispatchStatus: null,
          dispatchAttemptCount: 0,
          activeRunId: head.activeRunId ?? null,
          lastFailureCategory: null,
        },
      };

    case "gating_review":
      return {
        kind: "review_gate",
        gate: {
          gateRunId: head.activeRunId ?? null,
          lastFailureCategory: null,
        },
      };

    case "gating_ci":
      return {
        kind: "ci_gate",
        gate: {
          gateRunId: head.activeRunId ?? null,
          lastFailureCategory: null,
        },
      };

    case "awaiting_pr_creation":
    case "awaiting_pr_lifecycle":
      return {
        kind: "awaiting_pr_link",
        selectedAgent: null,
        lastFailureCategory: null,
      };

    case "awaiting_manual_fix":
      return {
        kind: "blocked",
        from: "implementing",
        reason: "runtime_failure",
        selectedAgent: null,
        dispatchStatus: null,
        dispatchAttemptCount: 0,
        activeRunId: head.activeRunId ?? null,
        activeGateRunId: null,
        lastFailureCategory: null,
      };

    case "awaiting_operator_action":
      return {
        kind: "blocked",
        from: "implementing",
        reason: "external_dependency",
        selectedAgent: null,
        dispatchStatus: null,
        dispatchAttemptCount: 0,
        activeRunId: head.activeRunId ?? null,
        activeGateRunId: null,
        lastFailureCategory: null,
      };

    case "done":
      return { kind: "done" };

    case "stopped":
      return { kind: "stopped" };

    case "terminated":
      return isMergedTerminationReason(head.blockedReason)
        ? { kind: "terminated_pr_merged" }
        : { kind: "terminated_pr_closed" };
  }
}

function isMergedTerminationReason(blockedReason: string | null): boolean {
  if (!blockedReason) {
    return false;
  }

  return /\bmerged\b/i.test(blockedReason.trim());
}
