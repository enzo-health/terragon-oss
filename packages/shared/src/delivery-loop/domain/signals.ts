import type { DispatchId, GateKind } from "./workflow";

// Daemon completion/failure types
export type DaemonCompletionResult =
  | { kind: "success"; headSha: string; summary: string }
  | {
      kind: "partial";
      headSha: string;
      summary: string;
      remainingTasks: number;
    };

export type DaemonFailure =
  | { kind: "runtime_crash"; exitCode: number | null; message: string }
  | { kind: "timeout"; durationMs: number }
  | { kind: "oom"; durationMs: number }
  | { kind: "config_error"; message: string };

export type DaemonProgress = {
  completedTasks: number;
  totalTasks: number;
  currentTask: string | null;
};

// CI/Review evaluation results
export type CiEvaluation = {
  passed: boolean;
  requiredChecks: readonly string[];
  failingChecks: readonly string[];
};

export type ReviewEvaluation = {
  passed: boolean;
  unresolvedThreadCount: number;
  approvalCount: number;
  requiredApprovals: number;
};

// Two-level signal nesting
export type DaemonSignal =
  | { kind: "run_completed"; runId: string; result: DaemonCompletionResult }
  | { kind: "run_failed"; runId: string; failure: DaemonFailure }
  | { kind: "progress_reported"; runId: string; progress: DaemonProgress }
  | {
      kind: "gate_completed";
      runId: string;
      gate: GateKind;
      passed: boolean;
      headSha: string;
    };

export type GitHubSignal =
  | {
      kind: "ci_changed";
      prNumber: number;
      result: CiEvaluation;
      /** Head SHA the signal pertains to, used for stale-signal rejection. */
      headSha?: string;
    }
  | {
      kind: "review_changed";
      prNumber: number;
      result: ReviewEvaluation;
      /** Head SHA the signal pertains to, used for stale-signal rejection. */
      headSha?: string;
    }
  | { kind: "pr_closed"; prNumber: number; merged: boolean }
  | { kind: "pr_synchronized"; prNumber: number; headSha: string };

export type HumanSignal =
  | { kind: "resume_requested"; actorUserId: string }
  | { kind: "bypass_requested"; actorUserId: string; target: GateKind }
  | { kind: "stop_requested"; actorUserId: string }
  | { kind: "mark_done_requested"; actorUserId: string }
  | { kind: "plan_approved"; artifactId: string };

export type TimerSignal =
  | {
      kind: "dispatch_ack_expired";
      dispatchId: DispatchId;
      consecutiveFailures?: number;
    }
  | { kind: "babysit_due" }
  | { kind: "heartbeat_check" };

export type BabysitSignal =
  | { kind: "babysit_gates_passed"; headSha: string }
  | { kind: "babysit_gates_blocked"; headSha: string };

export type DeliverySignal =
  | { source: "daemon"; event: DaemonSignal }
  | { source: "github"; event: GitHubSignal }
  | { source: "human"; event: HumanSignal }
  | { source: "timer"; event: TimerSignal }
  | { source: "babysit"; event: BabysitSignal };
