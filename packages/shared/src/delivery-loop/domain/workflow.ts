// Branded IDs — prevent silent ID swaps at compile time
export type WorkflowId = string & { readonly __brand: "WorkflowId" };
export type SignalId = string & { readonly __brand: "SignalId" };
export type CorrelationId = string & { readonly __brand: "CorrelationId" };
export type DispatchId = string & { readonly __brand: "DispatchId" };
export type GitSha = string & { readonly __brand: "GitSha" };
export type ThreadId = string & { readonly __brand: "ThreadId" };
export type PlanVersion = number & { readonly __brand: "PlanVersion" };

// Gating substate — which gate is active
export type GateKind = "review" | "ci" | "ui";

export type ExecutionClass =
  | "implementation_runtime"
  | "implementation_runtime_fallback"
  | "gate_runtime";
export type DispatchMechanism = "self_dispatch" | "queue_fallback";
export type DispatchFailure =
  | { kind: "ack_timeout" }
  | { kind: "transport_error"; message: string };

// Review surface abstraction — decoupled from GitHub
export type ReviewSurfaceRef =
  | { kind: "github_pr"; prNumber: number | null }
  | { kind: "other"; externalId: string };

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
