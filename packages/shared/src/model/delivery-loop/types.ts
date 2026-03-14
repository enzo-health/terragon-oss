import { SdlcLoopState } from "../../db/types";

// ---------------------------------------------------------------------------
// Delivery Loop v2: canonical state machine types
// ---------------------------------------------------------------------------

/**
 * Canonical Delivery Loop states. This is the forward-looking state enum;
 * `SdlcLoopState` is the backwards-compatible superset that also includes
 * legacy migration states.
 */
export type DeliveryLoopState =
  | "planning"
  | "implementing"
  | "review_gate"
  | "ci_gate"
  | "ui_gate"
  | "awaiting_pr_link"
  | "babysitting"
  | "blocked"
  | "done"
  | "stopped"
  | "terminated_pr_closed"
  | "terminated_pr_merged";

/** Backwards-compatible alias. */
export type { SdlcLoopState };

export type DeliveryLoopSelectedAgent = "codex" | "claudeCode";

export type DeliveryLoopDispatchablePhase =
  | "implementing"
  | "review_gate"
  | "ci_gate"
  | "ui_gate";

export type DeliveryLoopResumableState =
  | "planning"
  | "implementing"
  | "review_gate"
  | "ci_gate"
  | "ui_gate"
  | "awaiting_pr_link"
  | "babysitting";

export type DeliveryLoopDispatchStatus =
  | "prepared"
  | "dispatched"
  | "acknowledged"
  | "failed"
  | "completed";

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
      nextPhaseTarget: DeliveryLoopDispatchablePhase | null;
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
      kind: "ui_gate";
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
  | {
      kind: "done";
    }
  | {
      kind: "stopped";
    }
  | {
      kind: "terminated_pr_closed";
    }
  | {
      kind: "terminated_pr_merged";
    };

type DeliveryLoopPlanningSnapshot = Extract<
  DeliveryLoopSnapshot,
  { kind: "planning" }
>;
type DeliveryLoopImplementingSnapshot = Extract<
  DeliveryLoopSnapshot,
  { kind: "implementing" }
>;
type DeliveryLoopReviewGateSnapshot = Extract<
  DeliveryLoopSnapshot,
  { kind: "review_gate" }
>;
type DeliveryLoopCiGateSnapshot = Extract<
  DeliveryLoopSnapshot,
  { kind: "ci_gate" }
>;
type DeliveryLoopUiGateSnapshot = Extract<
  DeliveryLoopSnapshot,
  { kind: "ui_gate" }
>;
type DeliveryLoopAwaitingPrLinkSnapshot = Extract<
  DeliveryLoopSnapshot,
  { kind: "awaiting_pr_link" }
>;
type DeliveryLoopBabysittingSnapshot = Extract<
  DeliveryLoopSnapshot,
  { kind: "babysitting" }
>;
type DeliveryLoopDoneSnapshot = Extract<DeliveryLoopSnapshot, { kind: "done" }>;
type DeliveryLoopStoppedSnapshot = Extract<
  DeliveryLoopSnapshot,
  { kind: "stopped" }
>;
type DeliveryLoopPrClosedSnapshot = Extract<
  DeliveryLoopSnapshot,
  { kind: "terminated_pr_closed" }
>;
type DeliveryLoopPrMergedSnapshot = Extract<
  DeliveryLoopSnapshot,
  { kind: "terminated_pr_merged" }
>;

/**
 * Companion fields for Delivery Loop v2 state tracking.
 * These will be added to the DB schema in a later migration; for now they
 * exist as a TypeScript-only contract so downstream code can program against
 * the shape before the column migration lands.
 */
export type DeliveryLoopCompanionFields = {
  selectedAgent: DeliveryLoopSelectedAgent | null;
  nextPhaseTarget: DeliveryLoopDispatchablePhase | null;
  dispatchStatus: DeliveryLoopDispatchStatus | null;
  dispatchAttemptCount: number;
  blockedReasonCategory: string | null;
  blockedFromState: DeliveryLoopResumableState | null;
  activeRunId: string | null;
  activeGateRunId: string | null;
  lastFailureCategory: string | null;
};

export const deliveryLoopCompanionFieldDefaults: DeliveryLoopCompanionFields = {
  selectedAgent: null,
  nextPhaseTarget: null,
  dispatchStatus: null,
  dispatchAttemptCount: 0,
  blockedReasonCategory: null,
  blockedFromState: null,
  activeRunId: null,
  activeGateRunId: null,
  lastFailureCategory: null,
};

function normalizeDeliveryLoopCompanionFields(
  companionFields?: Partial<DeliveryLoopCompanionFields> | null,
): DeliveryLoopCompanionFields {
  return {
    ...deliveryLoopCompanionFieldDefaults,
    ...(companionFields ?? {}),
  };
}

export function assertNever(value: never): never {
  throw new Error(`Unhandled Delivery Loop variant: ${String(value)}`);
}

export function normalizeBlockedReasonCategory(
  value: string | null | undefined,
): DeliveryLoopBlockedReasonCategory {
  switch (value) {
    case "human_required":
    case "runtime_failure":
    case "gate_failure":
    case "config_error":
    case "external_dependency":
      return value;
    default:
      return "unknown";
  }
}

export function resolveBlockedResumeTarget(
  blockedFromState: DeliveryLoopResumableState | null | undefined,
): DeliveryLoopResumableState {
  return blockedFromState ?? "implementing";
}

export function coerceDeliveryLoopResumableState(
  value: string | null | undefined,
): DeliveryLoopResumableState | null {
  if (!value) {
    return null;
  }

  const mappedState = legacyStateMapping[value];
  switch (mappedState) {
    case "planning":
    case "implementing":
    case "review_gate":
    case "ci_gate":
    case "ui_gate":
    case "awaiting_pr_link":
    case "babysitting":
      return mappedState;
    default:
      return null;
  }
}

export function createPlanningSnapshot(
  fields?: Partial<Omit<DeliveryLoopPlanningSnapshot, "kind">> | null,
): DeliveryLoopPlanningSnapshot {
  return {
    kind: "planning",
    selectedAgent: fields?.selectedAgent ?? null,
    nextPhaseTarget: fields?.nextPhaseTarget ?? null,
    dispatchStatus: fields?.dispatchStatus ?? null,
    dispatchAttemptCount: fields?.dispatchAttemptCount ?? 0,
    activeRunId: fields?.activeRunId ?? null,
    lastFailureCategory: fields?.lastFailureCategory ?? null,
  };
}

export function createImplementingSnapshot(
  execution?: Partial<Omit<DeliveryLoopImplementationExecution, "kind">> | null,
): DeliveryLoopImplementingSnapshot {
  return {
    kind: "implementing",
    execution: {
      kind: "implementation",
      selectedAgent: execution?.selectedAgent ?? null,
      dispatchStatus: execution?.dispatchStatus ?? null,
      dispatchAttemptCount: execution?.dispatchAttemptCount ?? 0,
      activeRunId: execution?.activeRunId ?? null,
      lastFailureCategory: execution?.lastFailureCategory ?? null,
    },
  };
}

export function createReviewGateSnapshot(
  gate?: Partial<DeliveryLoopGateExecution> | null,
): DeliveryLoopReviewGateSnapshot {
  return {
    kind: "review_gate",
    gate: {
      gateRunId: gate?.gateRunId ?? null,
      lastFailureCategory: gate?.lastFailureCategory ?? null,
    },
  };
}

export function createCiGateSnapshot(
  gate?: Partial<DeliveryLoopGateExecution> | null,
): DeliveryLoopCiGateSnapshot {
  return {
    kind: "ci_gate",
    gate: {
      gateRunId: gate?.gateRunId ?? null,
      lastFailureCategory: gate?.lastFailureCategory ?? null,
    },
  };
}

export function createUiGateSnapshot(
  gate?: Partial<DeliveryLoopGateExecution> | null,
): DeliveryLoopUiGateSnapshot {
  return {
    kind: "ui_gate",
    gate: {
      gateRunId: gate?.gateRunId ?? null,
      lastFailureCategory: gate?.lastFailureCategory ?? null,
    },
  };
}

export function createAwaitingPrLinkSnapshot(
  fields?: Partial<Omit<DeliveryLoopAwaitingPrLinkSnapshot, "kind">> | null,
): DeliveryLoopAwaitingPrLinkSnapshot {
  return {
    kind: "awaiting_pr_link",
    selectedAgent: fields?.selectedAgent ?? null,
    lastFailureCategory: fields?.lastFailureCategory ?? null,
  };
}

export function createBabysittingSnapshot(
  fields?: Partial<Omit<DeliveryLoopBabysittingSnapshot, "kind">> | null,
): DeliveryLoopBabysittingSnapshot {
  return {
    kind: "babysitting",
    selectedAgent: fields?.selectedAgent ?? null,
    lastFailureCategory: fields?.lastFailureCategory ?? null,
  };
}

export function createBlockedSnapshot(
  fields?: Partial<
    Omit<DeliveryLoopBlockedState, "kind" | "from" | "reason">
  > & {
    from?: DeliveryLoopResumableState | null;
    reason?: string | null;
  },
): DeliveryLoopBlockedState {
  return {
    kind: "blocked",
    from: resolveBlockedResumeTarget(fields?.from),
    reason: normalizeBlockedReasonCategory(fields?.reason),
    selectedAgent: fields?.selectedAgent ?? null,
    dispatchStatus: fields?.dispatchStatus ?? null,
    dispatchAttemptCount: fields?.dispatchAttemptCount ?? 0,
    activeRunId: fields?.activeRunId ?? null,
    activeGateRunId: fields?.activeGateRunId ?? null,
    lastFailureCategory: fields?.lastFailureCategory ?? null,
  };
}

export function createDoneSnapshot(): DeliveryLoopDoneSnapshot {
  return { kind: "done" };
}

export function createStoppedSnapshot(): DeliveryLoopStoppedSnapshot {
  return { kind: "stopped" };
}

export function createTerminatedPrClosedSnapshot(): DeliveryLoopPrClosedSnapshot {
  return { kind: "terminated_pr_closed" };
}

export function createTerminatedPrMergedSnapshot(): DeliveryLoopPrMergedSnapshot {
  return { kind: "terminated_pr_merged" };
}

export function buildDeliveryLoopSnapshot(params: {
  state: DeliveryLoopState;
  companionFields?: Partial<DeliveryLoopCompanionFields> | null;
}): DeliveryLoopSnapshot;
export function buildDeliveryLoopSnapshot(params: {
  state: DeliveryLoopState;
  companionFields?: Partial<DeliveryLoopCompanionFields> | null;
}): DeliveryLoopSnapshot {
  const companionFields = normalizeDeliveryLoopCompanionFields(
    params.companionFields,
  );

  switch (params.state) {
    case "planning":
      return createPlanningSnapshot({
        selectedAgent: companionFields.selectedAgent,
        nextPhaseTarget: companionFields.nextPhaseTarget,
        dispatchStatus: companionFields.dispatchStatus,
        dispatchAttemptCount: companionFields.dispatchAttemptCount,
        activeRunId: companionFields.activeRunId,
        lastFailureCategory: companionFields.lastFailureCategory,
      });
    case "implementing":
      return createImplementingSnapshot({
        selectedAgent: companionFields.selectedAgent,
        dispatchStatus: companionFields.dispatchStatus,
        dispatchAttemptCount: companionFields.dispatchAttemptCount,
        activeRunId: companionFields.activeRunId,
        lastFailureCategory: companionFields.lastFailureCategory,
      });
    case "review_gate":
      return createReviewGateSnapshot({
        gateRunId: companionFields.activeGateRunId,
        lastFailureCategory: companionFields.lastFailureCategory,
      });
    case "ci_gate":
      return createCiGateSnapshot({
        gateRunId: companionFields.activeGateRunId,
        lastFailureCategory: companionFields.lastFailureCategory,
      });
    case "ui_gate":
      return createUiGateSnapshot({
        gateRunId: companionFields.activeGateRunId,
        lastFailureCategory: companionFields.lastFailureCategory,
      });
    case "awaiting_pr_link":
      return createAwaitingPrLinkSnapshot({
        selectedAgent: companionFields.selectedAgent,
        lastFailureCategory: companionFields.lastFailureCategory,
      });
    case "babysitting":
      return createBabysittingSnapshot({
        selectedAgent: companionFields.selectedAgent,
        lastFailureCategory: companionFields.lastFailureCategory,
      });
    case "blocked":
      return createBlockedSnapshot({
        from: companionFields.blockedFromState,
        reason: companionFields.blockedReasonCategory,
        selectedAgent: companionFields.selectedAgent,
        dispatchStatus: companionFields.dispatchStatus,
        dispatchAttemptCount: companionFields.dispatchAttemptCount,
        activeRunId: companionFields.activeRunId,
        activeGateRunId: companionFields.activeGateRunId,
        lastFailureCategory: companionFields.lastFailureCategory,
      });
    case "done":
      return createDoneSnapshot();
    case "stopped":
      return createStoppedSnapshot();
    case "terminated_pr_closed":
      return createTerminatedPrClosedSnapshot();
    case "terminated_pr_merged":
      return createTerminatedPrMergedSnapshot();
  }
  return assertNever(params.state);
}

export function buildDeliveryLoopCompanionFields(
  snapshot: DeliveryLoopSnapshot,
): DeliveryLoopCompanionFields {
  switch (snapshot.kind) {
    case "planning":
      return {
        ...deliveryLoopCompanionFieldDefaults,
        selectedAgent: snapshot.selectedAgent,
        nextPhaseTarget: snapshot.nextPhaseTarget,
        dispatchStatus: snapshot.dispatchStatus,
        dispatchAttemptCount: snapshot.dispatchAttemptCount,
        activeRunId: snapshot.activeRunId,
        lastFailureCategory: snapshot.lastFailureCategory,
      };
    case "implementing":
      return {
        ...deliveryLoopCompanionFieldDefaults,
        selectedAgent: snapshot.execution.selectedAgent,
        dispatchStatus: snapshot.execution.dispatchStatus,
        dispatchAttemptCount: snapshot.execution.dispatchAttemptCount,
        activeRunId: snapshot.execution.activeRunId,
        lastFailureCategory: snapshot.execution.lastFailureCategory,
      };
    case "review_gate":
    case "ci_gate":
    case "ui_gate":
      return {
        ...deliveryLoopCompanionFieldDefaults,
        activeGateRunId: snapshot.gate.gateRunId,
        lastFailureCategory: snapshot.gate.lastFailureCategory,
      };
    case "awaiting_pr_link":
    case "babysitting":
      return {
        ...deliveryLoopCompanionFieldDefaults,
        selectedAgent: snapshot.selectedAgent,
        lastFailureCategory: snapshot.lastFailureCategory,
      };
    case "blocked":
      return {
        ...deliveryLoopCompanionFieldDefaults,
        selectedAgent: snapshot.selectedAgent,
        dispatchStatus: snapshot.dispatchStatus,
        dispatchAttemptCount: snapshot.dispatchAttemptCount,
        blockedReasonCategory: snapshot.reason,
        blockedFromState: snapshot.from,
        activeRunId: snapshot.activeRunId,
        activeGateRunId: snapshot.activeGateRunId,
        lastFailureCategory: snapshot.lastFailureCategory,
      };
    case "done":
    case "stopped":
    case "terminated_pr_closed":
    case "terminated_pr_merged":
      return {
        ...deliveryLoopCompanionFieldDefaults,
      };
  }
  return assertNever(snapshot);
}

export function buildPersistedDeliveryLoopSnapshot(params: {
  state: DeliveryLoopState;
  blockedFromState?: string | null;
}): DeliveryLoopSnapshot {
  return buildDeliveryLoopSnapshot({
    state: params.state,
    companionFields: {
      blockedFromState:
        coerceDeliveryLoopResumableState(params.blockedFromState) ??
        "implementing",
    },
  });
}

/** All canonical (non-legacy) DeliveryLoopState values. */
export const DELIVERY_LOOP_CANONICAL_STATES: readonly DeliveryLoopState[] = [
  "planning",
  "implementing",
  "review_gate",
  "ci_gate",
  "ui_gate",
  "awaiting_pr_link",
  "babysitting",
  "blocked",
  "done",
  "stopped",
  "terminated_pr_closed",
  "terminated_pr_merged",
] as const;

/** Set for O(1) membership checks. */
export const DELIVERY_LOOP_CANONICAL_STATE_SET: ReadonlySet<DeliveryLoopState> =
  new Set(DELIVERY_LOOP_CANONICAL_STATES);

/**
 * Maps legacy SDLC state string values (that may still exist in the DB)
 * to their canonical DeliveryLoopState equivalents. Used by the migration
 * backfill to translate any persisted legacy state values.
 */
export const legacyStateMapping: Record<string, DeliveryLoopState> = {
  // Canonical — identity mappings.
  planning: "planning",
  implementing: "implementing",
  review_gate: "review_gate",
  ci_gate: "ci_gate",
  ui_gate: "ui_gate",
  awaiting_pr_link: "awaiting_pr_link",
  babysitting: "babysitting",
  blocked: "blocked",
  done: "done",
  stopped: "stopped",
  terminated_pr_closed: "terminated_pr_closed",
  terminated_pr_merged: "terminated_pr_merged",
  // Legacy → canonical.
  reviewing: "review_gate",
  ui_testing: "ui_gate",
  pr_babysitting: "babysitting",
  enrolled: "planning",
  gates_running: "review_gate",
  video_pending: "ui_gate",
  human_review_ready: "awaiting_pr_link",
  video_degraded_ready: "awaiting_pr_link",
  blocked_on_agent_fixes: "blocked",
  blocked_on_ci: "blocked",
  blocked_on_review_threads: "blocked",
  blocked_on_human_feedback: "blocked",
};
