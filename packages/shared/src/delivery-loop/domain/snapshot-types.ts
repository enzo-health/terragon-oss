/**
 * Snapshot types for the Delivery Loop domain.
 *
 * These are the canonical type definitions for the discriminated-union snapshot
 * shape consumed by the UI status adapter (`delivery-loop-status.ts`).
 *
 * Aliases for backwards compatibility:
 *   `DeliveryLoopSelectedAgent`  → alias of `SelectedAgent`  (dispatch-types.ts)
 *   `DeliveryLoopDispatchStatus` → alias of `DispatchIntentStatus` (dispatch-types.ts)
 */

import type { SelectedAgent, DispatchIntentStatus } from "./dispatch-types";

// ---------------------------------------------------------------------------
// Re-export primitives under legacy names for backwards compatibility.
// ---------------------------------------------------------------------------

/** @alias SelectedAgent */
export type DeliveryLoopSelectedAgent = SelectedAgent;

/** @alias DispatchIntentStatus */
export type DeliveryLoopDispatchStatus = DispatchIntentStatus;

// ---------------------------------------------------------------------------
// Additional snapshot types.
// ---------------------------------------------------------------------------

export type DeliveryLoopResumableState =
  | "planning"
  | "implementing"
  | "review_gate"
  | "ci_gate"
  | "awaiting_pr_link"
  | "babysitting";

export type DeliveryLoopBlockedReasonCategory =
  | "human_required"
  | "runtime_failure"
  | "gate_failure"
  | "config_error"
  | "external_dependency"
  | "unknown";

export type DeliveryLoopImplementationExecution = {
  kind: "implementation";
  selectedAgent: DeliveryLoopSelectedAgent | null;
  dispatchStatus: DeliveryLoopDispatchStatus | null;
  dispatchAttemptCount: number;
  activeRunId: string | null;
  lastFailureCategory: string | null;
};

export type DeliveryLoopGateExecution = {
  gateRunId: string | null;
  lastFailureCategory: string | null;
};

export type DeliveryLoopBlockedState = {
  kind: "blocked";
  from: DeliveryLoopResumableState;
  reason: DeliveryLoopBlockedReasonCategory;
  selectedAgent: DeliveryLoopSelectedAgent | null;
  dispatchStatus: DeliveryLoopDispatchStatus | null;
  dispatchAttemptCount: number;
  activeRunId: string | null;
  activeGateRunId: string | null;
  lastFailureCategory: string | null;
};

export type DeliveryLoopSnapshot =
  | {
      kind: "planning";
      selectedAgent: DeliveryLoopSelectedAgent | null;
      nextPhaseTarget: ("implementing" | "review_gate" | "ci_gate") | null;
      dispatchStatus: DeliveryLoopDispatchStatus | null;
      dispatchAttemptCount: number;
      activeRunId: string | null;
      lastFailureCategory: string | null;
    }
  | {
      kind: "implementing";
      execution: DeliveryLoopImplementationExecution;
    }
  | {
      kind: "review_gate";
      gate: DeliveryLoopGateExecution;
    }
  | {
      kind: "ci_gate";
      gate: DeliveryLoopGateExecution;
    }
  | {
      kind: "awaiting_pr_link";
      selectedAgent: DeliveryLoopSelectedAgent | null;
      lastFailureCategory: string | null;
    }
  | {
      kind: "babysitting";
      selectedAgent: DeliveryLoopSelectedAgent | null;
      lastFailureCategory: string | null;
    }
  | DeliveryLoopBlockedState
  | { kind: "done" }
  | { kind: "stopped" }
  | { kind: "terminated_pr_closed" }
  | { kind: "terminated_pr_merged" };
