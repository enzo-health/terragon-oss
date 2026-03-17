import type { SdlcLoopState, SdlcPhase } from "../../db/types";

const activeSdlcLoopStates = [
  "planning",
  "implementing",
  "review_gate",
  "ci_gate",
  "ui_gate",
  "awaiting_pr_link",
  "babysitting",
  "blocked",
] as const satisfies readonly SdlcLoopState[];
export const activeSdlcLoopStateList: SdlcLoopState[] = [
  ...activeSdlcLoopStates,
];
export const activeSdlcLoopStateSet: ReadonlySet<SdlcLoopState> = new Set(
  activeSdlcLoopStateList,
);

const terminalSdlcLoopStates = [
  "terminated_pr_closed",
  "terminated_pr_merged",
  "done",
  "stopped",
] as const satisfies readonly SdlcLoopState[];
export const terminalSdlcLoopStateList: SdlcLoopState[] = [
  ...terminalSdlcLoopStates,
];
export const terminalSdlcLoopStateSet: ReadonlySet<SdlcLoopState> = new Set(
  terminalSdlcLoopStateList,
);

// Re-export from v2 domain — canonical definitions now live there.
import type { DeliveryLoopFailureCategory as _DeliveryLoopFailureCategory } from "../../delivery-loop/domain/failure";
export type { _DeliveryLoopFailureCategory as DeliveryLoopFailureCategory };
export {
  type DeliveryLoopRetryAction,
  DELIVERY_LOOP_FAILURE_ACTION_TABLE,
} from "../../delivery-loop/domain/failure";
// Local alias for use in this file's type definitions.
type DeliveryLoopFailureCategory = _DeliveryLoopFailureCategory;

/**
 * Execution class determines which runtime handles the dispatch.
 */
export type DeliveryLoopExecutionClass =
  | "implementation_runtime"
  | "gate_runtime";

/**
 * Mechanism used to dispatch work to the sandbox daemon.
 */
export type DeliveryLoopDispatchMechanism = "self_dispatch" | "queue_fallback";

/**
 * A durable record of a dispatch intent. Persisted before any dispatch
 * so that failed dispatches are recoverable. Stored in Redis with a TTL;
 * DB migration comes later.
 */
export type DeliveryLoopDispatchIntent = {
  id: string;
  loopId: string;
  threadId: string;
  threadChatId: string;
  targetPhase: import("./types").DeliveryLoopDispatchablePhase;
  selectedAgent: import("./types").DeliveryLoopSelectedAgent;
  executionClass: DeliveryLoopExecutionClass;
  dispatchMechanism: DeliveryLoopDispatchMechanism;
  runId: string;
  status: import("./types").DeliveryLoopDispatchStatus;
  retryCount: number;
  maxRetries: number;
  createdAt: Date;
  updatedAt: Date;
  lastError: string | null;
  lastFailureCategory: DeliveryLoopFailureCategory | null;
  gate?: string;
  headSha?: string;
};

export type SdlcLoopTransitionEvent =
  | "plan_completed"
  | "plan_gate_blocked"
  | "implementation_gate_blocked"
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
  | "blocked_resume_requested"
  | "blocked_bypass_once_requested"
  | "pr_closed_unmerged"
  | "pr_merged"
  | "manual_stop"
  | "mark_done";

import type { SdlcPlanTaskStatus } from "../../db/types";

const sdlcPlanTaskNonBlockingTerminalStatusSet = new Set<SdlcPlanTaskStatus>([
  "done",
  "skipped",
]);

const sdlcPlanTaskIncompleteStatusSet = new Set<SdlcPlanTaskStatus>([
  "todo",
  "in_progress",
  "blocked",
]);

export function isIncompletePlanTaskStatus(
  status: SdlcPlanTaskStatus,
): boolean {
  return sdlcPlanTaskIncompleteStatusSet.has(status);
}

export function isNonBlockingTerminalPlanTaskStatus(
  status: SdlcPlanTaskStatus,
): boolean {
  return sdlcPlanTaskNonBlockingTerminalStatusSet.has(status);
}

export type SdlcLoopArtifactPointerField =
  | "activePlanArtifactId"
  | "activeImplementationArtifactId"
  | "activeReviewArtifactId"
  | "activeUiArtifactId"
  | "activeBabysitArtifactId";

export const phaseToLoopPointerColumn: Record<
  SdlcPhase,
  SdlcLoopArtifactPointerField | null
> = {
  planning: "activePlanArtifactId",
  implementing: "activeImplementationArtifactId",
  review_gate: "activeReviewArtifactId",
  ci_gate: null,
  ui_gate: "activeUiArtifactId",
  awaiting_pr_link: null,
  babysitting: "activeBabysitArtifactId",
};

export function isSdlcLoopTerminalState(state: SdlcLoopState): boolean {
  return terminalSdlcLoopStateSet.has(state);
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
