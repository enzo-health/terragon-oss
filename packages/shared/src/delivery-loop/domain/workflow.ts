// Branded IDs — prevent silent ID swaps at compile time
export type WorkflowId = string & { readonly __brand: "WorkflowId" };
export type SignalId = string & { readonly __brand: "SignalId" };
export type CorrelationId = string & { readonly __brand: "CorrelationId" };
export type DispatchId = string & { readonly __brand: "DispatchId" };
export type GitSha = string & { readonly __brand: "GitSha" };
export type ThreadId = string & { readonly __brand: "ThreadId" };
export type PlanVersion = number & { readonly __brand: "PlanVersion" };

// Top-level states (11, replacing 12 with better semantics)
export type WorkflowState =
  | "planning"
  | "implementing"
  | "gating"
  | "awaiting_pr"
  | "babysitting"
  | "awaiting_plan_approval"
  | "awaiting_manual_fix"
  | "awaiting_operator_action"
  | "done"
  | "stopped"
  | "terminated";

// Gating substate — which gate is active
export type GateKind = "review" | "ci" | "ui";

// Dispatch sub-state
export type DispatchSubState =
  | {
      kind: "queued";
      dispatchId: DispatchId;
      executionClass: ExecutionClass;
    }
  | {
      kind: "sent";
      dispatchId: DispatchId;
      executionClass: ExecutionClass;
      sentAt: Date;
      ackDeadlineAt: Date;
      dispatchMechanism: DispatchMechanism;
    }
  | {
      kind: "acknowledged";
      dispatchId: DispatchId;
      executionClass: ExecutionClass;
      sentAt: Date;
      acknowledgedAt: Date;
    }
  | {
      kind: "failed";
      dispatchId: DispatchId;
      executionClass: ExecutionClass;
      failure: DispatchFailure;
      failedAt: Date;
    };

export type ExecutionClass = "implementation_runtime" | "gate_runtime";
export type DispatchMechanism = "self_dispatch" | "queue_fallback";
export type DispatchFailure =
  | { kind: "ack_timeout" }
  | { kind: "transport_error"; message: string };

// Review surface abstraction — decoupled from GitHub
export type ReviewSurfaceRef =
  | { kind: "github_pr"; prNumber: number | null }
  | { kind: "other"; externalId: string };

// Resumable state — what to return to after human wait resolves
export type ResumableWorkflowState =
  | { kind: "planning"; planVersion: PlanVersion | null }
  | { kind: "implementing"; dispatchId: DispatchId }
  | { kind: "gating"; gate: GateKind; headSha: GitSha }
  | { kind: "awaiting_pr"; headSha: GitSha }
  | { kind: "babysitting"; headSha: GitSha };

// Termination reason
export type TerminationReason =
  | { kind: "pr_closed" }
  | { kind: "pr_merged" }
  | { kind: "invariant_violation"; code: string }
  | { kind: "retry_exhausted"; subject: "dispatch" | "publication" | "signal" }
  | { kind: "fatal_external_failure"; system: "daemon" | "github" };

// Stop reason
export type StopReason =
  | { kind: "user_requested" }
  | { kind: "superseded_by_newer_workflow"; newerWorkflowId: WorkflowId };

// Completion outcome
export type CompletionOutcome = "completed" | "merged" | "closed_without_merge";

// Human wait reasons
export type ManualFixIssue = {
  description: string;
  suggestedAction: string | null;
};
export type OperatorActionReason = { description: string; system: string };
export type HumanWaitReason =
  | { kind: "plan_approval"; planVersion: PlanVersion }
  | { kind: "manual_fix"; issue: ManualFixIssue }
  | {
      kind: "operator_action";
      reason: OperatorActionReason;
      incidentId: string;
    };

// PendingAction — DERIVED from workflow variant, not stored independently
export type PendingAction =
  | { kind: "dispatch_ack"; dispatchId: DispatchId; deadlineAt: Date }
  | { kind: "gate_result"; gate: GateKind }
  | { kind: "human_input"; reason: HumanWaitReason }
  | { kind: "review_surface_link" }
  | { kind: "babysit_recheck"; nextCheckAt: Date };

// Gate sub-state — per-gate snapshots with real domain data
export type GateSubState =
  | {
      kind: "review";
      status: "waiting" | "passed" | "blocked";
      runId: string | null;
      snapshot: ReviewGateSnapshot;
    }
  | {
      kind: "ci";
      status: "waiting" | "passed" | "blocked";
      runId: string | null;
      snapshot: CiGateSnapshot;
    }
  | {
      kind: "ui";
      status: "waiting" | "passed" | "blocked";
      runId: string | null;
      snapshot: UiGateSnapshot;
    };

export type ReviewGateSnapshot = {
  requiredApprovals: number;
  approvalsReceived: number;
  blockers: readonly string[];
};
export type CiGateSnapshot = {
  checkSuites: readonly string[];
  failingRequiredChecks: readonly string[];
};
export type UiGateSnapshot = {
  artifactUrl: string | null;
  blockers: readonly string[];
};

// Workflow aggregate — common fields
export type WorkflowCommon = {
  workflowId: WorkflowId;
  threadId: ThreadId;
  generation: number;
  version: number;
  fixAttemptCount: number;
  maxFixAttempts: number;
  createdAt: Date;
  updatedAt: Date;
  lastActivityAt: Date | null;
};

// Discriminated union of all workflow states
export type DeliveryWorkflow =
  | (WorkflowCommon & { kind: "planning"; planVersion: PlanVersion | null })
  | (WorkflowCommon & {
      kind: "implementing";
      planVersion: PlanVersion;
      dispatch: DispatchSubState;
    })
  | (WorkflowCommon & {
      kind: "gating";
      headSha: GitSha;
      gate: GateSubState;
    })
  | (WorkflowCommon & { kind: "awaiting_pr"; headSha: GitSha })
  | (WorkflowCommon & {
      kind: "babysitting";
      headSha: GitSha;
      reviewSurface: ReviewSurfaceRef;
      nextCheckAt: Date;
    })
  | (WorkflowCommon & {
      kind: "awaiting_plan_approval";
      planVersion: PlanVersion;
      resumableFrom: Extract<ResumableWorkflowState, { kind: "planning" }>;
    })
  | (WorkflowCommon & {
      kind: "awaiting_manual_fix";
      reason: ManualFixIssue;
      resumableFrom: Exclude<ResumableWorkflowState, { kind: "planning" }>;
    })
  | (WorkflowCommon & {
      kind: "awaiting_operator_action";
      incidentId: string;
      reason: OperatorActionReason;
      resumableFrom: ResumableWorkflowState;
    })
  | (WorkflowCommon & {
      kind: "done";
      outcome: CompletionOutcome;
      completedAt: Date;
    })
  | (WorkflowCommon & { kind: "stopped"; reason: StopReason })
  | (WorkflowCommon & { kind: "terminated"; reason: TerminationReason });

// Terminal state check
const TERMINAL_STATES: ReadonlySet<WorkflowState> = new Set([
  "done",
  "stopped",
  "terminated",
]);
export function isTerminalState(state: WorkflowState): boolean {
  return TERMINAL_STATES.has(state);
}

// Active state check
const ACTIVE_STATES: ReadonlySet<WorkflowState> = new Set([
  "planning",
  "implementing",
  "gating",
  "awaiting_pr",
  "babysitting",
  "awaiting_plan_approval",
  "awaiting_manual_fix",
  "awaiting_operator_action",
]);
export function isActiveState(state: WorkflowState): boolean {
  return ACTIVE_STATES.has(state);
}

// Human wait state check
const HUMAN_WAIT_STATES: ReadonlySet<WorkflowState> = new Set([
  "awaiting_plan_approval",
  "awaiting_manual_fix",
  "awaiting_operator_action",
]);
export function isHumanWaitState(state: WorkflowState): boolean {
  return HUMAN_WAIT_STATES.has(state);
}
