import type {
  GateKind,
  GitSha,
  PlanVersion,
  DispatchId,
  CompletionOutcome,
  StopReason,
  TerminationReason,
  ReviewSurfaceRef,
  ManualFixIssue,
  OperatorActionReason,
  ResumableWorkflowState,
  SignalId,
} from "./workflow";
import type { DaemonFailure } from "./signals";

// Transition events (14 events, down from 50+)
export type LoopEvent =
  | "plan_completed"
  | "implementation_completed"
  | "gate_passed"
  | "gate_blocked"
  | "pr_linked"
  | "babysit_passed"
  | "babysit_blocked"
  | "blocked_resume"
  | "manual_stop"
  | "mark_done"
  | "exhausted_retries"
  | "pr_closed"
  | "pr_merged";

// Context for gate-specific events
export type LoopEventContext = {
  gate?: GateKind;
  hasPrLink?: boolean;
  resumeTo?: ResumableWorkflowState;
  headSha?: string;
  runId?: string | null;
  prNumber?: number | null;
};

// Publication targets
export type PublicationTarget =
  | { kind: "status_comment" }
  | { kind: "check_run_summary" }
  | { kind: "operator_annotation" };

// Workflow events (immutable audit facts)
export type DeliveryWorkflowEvent =
  | { kind: "workflow_enrolled"; threadId: string; repoFullName: string }
  | { kind: "plan_approved"; planVersion: PlanVersion }
  | { kind: "dispatch_enqueued"; dispatchId: DispatchId }
  | { kind: "dispatch_sent"; dispatchId: DispatchId; ackDeadlineAt: Date }
  | { kind: "dispatch_acknowledged"; dispatchId: DispatchId }
  | { kind: "implementation_succeeded"; headSha: GitSha }
  | { kind: "implementation_failed"; failure: DaemonFailure }
  | {
      kind: "gate_entered";
      gate: GateKind;
      headSha: GitSha;
    }
  | {
      kind: "gate_evaluated";
      gate: GateKind;
      passed: boolean;
      runId: string | null;
      headSha: GitSha;
    }
  | { kind: "review_surface_requested"; headSha: GitSha }
  | {
      kind: "review_surface_attached";
      surface: ReviewSurfaceRef;
      headSha: GitSha;
    }
  | { kind: "babysit_scheduled"; nextCheckAt: Date }
  | { kind: "plan_approval_required"; planVersion: PlanVersion }
  | { kind: "manual_fix_required"; reason: ManualFixIssue }
  | {
      kind: "operator_action_required";
      reason: OperatorActionReason;
      incidentId: string;
    }
  | { kind: "publication_delivered"; target: PublicationTarget }
  | { kind: "workflow_completed"; outcome: CompletionOutcome }
  | { kind: "workflow_stopped"; reason: StopReason }
  | { kind: "workflow_terminated"; reason: TerminationReason }
  | { kind: "signal_dead_lettered"; signalId: SignalId; reason: string }
  | { kind: "incident_opened"; incidentType: string; detail: string }
  | { kind: "incident_resolved"; incidentId: string };

// Gate verdict — returned by gate persistence, consumed by coordinator
export type GateVerdict = {
  gate: GateKind;
  passed: boolean;
  event: Extract<LoopEvent, "gate_passed" | "gate_blocked">;
  runId: string;
  headSha: GitSha;
  loopVersion: number;
  findingCount?: number;
};
