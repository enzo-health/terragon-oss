import {
  type DeliveryLoopState,
  type DeliveryLoopSnapshot,
  type DeliveryLoopBlockedState,
  type DeliveryLoopResumableState,
  type DeliveryLoopCompanionFields,
  assertNever,
  resolveBlockedResumeTarget,
  createBlockedSnapshot,
  buildDeliveryLoopSnapshot,
  buildDeliveryLoopCompanionFields,
  buildPersistedDeliveryLoopSnapshot,
} from "./types";
import type { SdlcLoopTransitionEvent } from "./state-constants";

export function getEffectiveDeliveryLoopPhase(
  snapshot: DeliveryLoopSnapshot,
):
  | Exclude<DeliveryLoopSnapshot["kind"], "blocked">
  | DeliveryLoopBlockedState["from"] {
  if (snapshot.kind === "blocked") {
    return snapshot.from;
  }
  return snapshot.kind;
}

export function reducePersistedDeliveryLoopState(params: {
  state: DeliveryLoopState;
  event: DeliveryLoopTransitionEvent;
  blockedFromState?: DeliveryLoopResumableState | null;
}): DeliveryLoopTransitionResult | null {
  return reduceDeliveryLoopSnapshot({
    snapshot: buildPersistedDeliveryLoopSnapshot({
      state: params.state,
      blockedFromState: params.blockedFromState,
    }),
    event: params.event,
  });
}

/**
 * Canonical Delivery Loop v2 transition event types.
 * These map to the primary transitions defined in the architecture RFC.
 */
export type DeliveryLoopTransitionEvent =
  | "plan_completed"
  | "plan_gate_blocked"
  | "implementation_completed"
  | "implementation_gate_blocked"
  | "review_gate_passed"
  | "review_gate_blocked"
  | "ci_gate_passed"
  | "ci_gate_blocked"
  | "ui_gate_passed_with_pr"
  | "ui_gate_passed_without_pr"
  | "ui_gate_blocked"
  | "pr_linked"
  | "babysit_passed"
  | "babysit_blocked"
  | "exhausted_retryable_failure"
  | "blocked_resume"
  | "manual_stop"
  | "pr_closed_unmerged"
  | "pr_merged"
  | "mark_done";

export type DeliveryLoopTransitionResult = {
  state: DeliveryLoopState;
  snapshot: DeliveryLoopSnapshot;
  companionFields: DeliveryLoopCompanionFields;
};

export function mapSdlcTransitionEventToDeliveryLoopTransition(
  event: SdlcLoopTransitionEvent,
  options?: {
    hasPrLink?: boolean;
  },
): DeliveryLoopTransitionEvent | null {
  switch (event) {
    case "plan_completed":
    case "plan_gate_blocked":
    case "implementation_completed":
    case "implementation_gate_blocked":
    case "ci_gate_passed":
    case "ci_gate_blocked":
    case "pr_linked":
    case "babysit_passed":
    case "babysit_blocked":
    case "manual_stop":
    case "pr_closed_unmerged":
    case "pr_merged":
    case "mark_done":
      return event;
    case "review_passed":
      return "review_gate_passed";
    case "review_blocked":
      return "review_gate_blocked";
    case "ui_smoke_passed":
    case "video_capture_succeeded":
      return options?.hasPrLink === false
        ? "ui_gate_passed_without_pr"
        : "ui_gate_passed_with_pr";
    case "ui_smoke_failed":
    case "video_capture_failed":
      return "ui_gate_blocked";
    case "blocked_resume_requested":
    case "blocked_bypass_once_requested":
      return "blocked_resume";
    case "human_feedback_requested":
      return "exhausted_retryable_failure";
    case "implementation_progress":
    case "review_threads_gate_passed":
    case "review_threads_gate_blocked":
    case "deep_review_gate_passed":
    case "deep_review_gate_blocked":
    case "carmack_review_gate_passed":
    case "carmack_review_gate_blocked":
    case "video_capture_started":
      return null;
  }
  return assertNever(event);
}

/**
 * Resolves the next canonical DeliveryLoopState given a current state and
 * transition event. Returns null if the transition is invalid.
 */
export function resolveDeliveryLoopNextState({
  currentState,
  event,
  blockedFromState,
}: {
  currentState: DeliveryLoopState;
  event: DeliveryLoopTransitionEvent;
  blockedFromState?: DeliveryLoopResumableState | null;
}): DeliveryLoopState | null {
  // Terminal states accept no transitions.
  if (
    currentState === "done" ||
    currentState === "stopped" ||
    currentState === "terminated_pr_closed" ||
    currentState === "terminated_pr_merged"
  ) {
    // Allow idempotent mark_done on done.
    if (currentState === "done" && event === "mark_done") {
      return "done";
    }
    return null;
  }

  // Global transitions from any active state.
  switch (event) {
    case "pr_closed_unmerged":
      return "terminated_pr_closed";
    case "pr_merged":
      return "terminated_pr_merged";
    case "manual_stop":
      return "stopped";
    case "exhausted_retryable_failure":
      return "blocked";
    default:
      break;
  }

  // Per-state transitions.
  switch (currentState) {
    case "planning":
      if (event === "plan_completed") return "implementing";
      if (event === "plan_gate_blocked") return "planning";
      return null;

    case "implementing":
      if (event === "implementation_completed") return "review_gate";
      if (event === "implementation_gate_blocked") return "implementing";
      return null;

    case "review_gate":
      if (event === "review_gate_passed") return "ci_gate";
      if (event === "review_gate_blocked") return "implementing";
      return null;

    case "ci_gate":
      if (event === "ci_gate_passed") return "ui_gate";
      if (event === "ci_gate_blocked") return "implementing";
      return null;

    case "ui_gate":
      if (event === "ui_gate_passed_with_pr") return "babysitting";
      if (event === "ui_gate_passed_without_pr") return "awaiting_pr_link";
      if (event === "ui_gate_blocked") return "implementing";
      return null;

    case "awaiting_pr_link":
      if (event === "pr_linked") return "babysitting";
      return null;

    case "babysitting":
      if (event === "babysit_passed" || event === "mark_done") return "done";
      if (event === "babysit_blocked") return "implementing";
      return null;

    case "blocked":
      if (event === "blocked_resume") {
        return resolveBlockedResumeTarget(blockedFromState);
      }
      if (event === "mark_done") return "done";
      return null;
  }
  return assertNever(currentState);
}

function getResumableStateFromSnapshot(
  snapshot: DeliveryLoopSnapshot,
): DeliveryLoopResumableState | null {
  switch (snapshot.kind) {
    case "planning":
    case "implementing":
    case "review_gate":
    case "ci_gate":
    case "ui_gate":
    case "awaiting_pr_link":
    case "babysitting":
      return snapshot.kind;
    case "blocked":
      return snapshot.from;
    case "done":
    case "stopped":
    case "terminated_pr_closed":
    case "terminated_pr_merged":
      return null;
  }
  return assertNever(snapshot);
}

export function reduceDeliveryLoopSnapshot(params: {
  snapshot: DeliveryLoopSnapshot;
  event: DeliveryLoopTransitionEvent;
}): DeliveryLoopTransitionResult | null {
  const nextState = resolveDeliveryLoopNextState({
    currentState: params.snapshot.kind,
    event: params.event,
    blockedFromState:
      params.snapshot.kind === "blocked" ? params.snapshot.from : null,
  });

  if (!nextState) {
    return null;
  }

  const baseCompanionFields = buildDeliveryLoopCompanionFields(params.snapshot);
  const nextSnapshot =
    nextState === "blocked"
      ? createBlockedSnapshot({
          from: getResumableStateFromSnapshot(params.snapshot),
          reason:
            params.event === "exhausted_retryable_failure"
              ? "runtime_failure"
              : "human_required",
          selectedAgent: baseCompanionFields.selectedAgent,
          dispatchStatus: baseCompanionFields.dispatchStatus,
          dispatchAttemptCount: baseCompanionFields.dispatchAttemptCount,
          activeRunId: baseCompanionFields.activeRunId,
          activeGateRunId: baseCompanionFields.activeGateRunId,
          lastFailureCategory: baseCompanionFields.lastFailureCategory,
        })
      : buildDeliveryLoopSnapshot({
          state: nextState,
          companionFields: {
            ...baseCompanionFields,
            nextPhaseTarget: null,
          },
        });

  return {
    state: nextState,
    snapshot: nextSnapshot,
    companionFields: buildDeliveryLoopCompanionFields(nextSnapshot),
  };
}
