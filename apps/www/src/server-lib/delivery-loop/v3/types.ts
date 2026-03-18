import type { DeliveryEffectKindV3 } from "@terragon/shared/db/types";

export type WorkflowStateV3 =
  | "planning"
  | "implementing"
  | "gating_review"
  | "gating_ci"
  | "awaiting_pr"
  | "awaiting_manual_fix"
  | "awaiting_operator_action"
  | "done"
  | "stopped"
  | "terminated";

export type FailureLane = "agent" | "infra";

export type LoopEventV3 =
  | { type: "bootstrap" }
  | { type: "plan_completed" }
  | { type: "dispatch_sent"; runId: string; ackDeadlineAt: Date }
  | { type: "dispatch_acked"; runId: string }
  | { type: "dispatch_ack_timeout"; runId: string }
  | { type: "run_completed"; runId: string; headSha?: string | null }
  | {
      type: "run_failed";
      runId: string;
      message: string;
      category: string | null;
      lane?: FailureLane;
    }
  | { type: "gate_review_passed"; runId?: string | null }
  | {
      type: "gate_review_failed";
      runId?: string | null;
      reason?: string | null;
    }
  | { type: "gate_ci_passed" }
  | { type: "gate_ci_failed"; reason?: string | null }
  | { type: "resume_requested" }
  | { type: "stop_requested" }
  | { type: "pr_closed"; merged: boolean };

export type EffectKindV3 = DeliveryEffectKindV3;

export type EffectPayloadV3 =
  | { kind: "dispatch_implementing" }
  | { kind: "dispatch_gate_review"; gate: "review" }
  | {
      kind: "ack_timeout_check";
      runId: string;
      workflowVersion: number;
    };

export type EffectSpecV3 = {
  kind: EffectKindV3;
  effectKey: string;
  dueAt: Date;
  maxAttempts?: number;
  payload: EffectPayloadV3;
};

export type WorkflowHeadV3 = {
  workflowId: string;
  threadId: string;
  generation: number;
  version: number;
  state: WorkflowStateV3;
  activeGate: string | null;
  headSha: string | null;
  activeRunId: string | null;
  fixAttemptCount: number;
  infraRetryCount: number;
  maxFixAttempts: number;
  maxInfraRetries: number;
  blockedReason: string | null;
  createdAt: Date;
  updatedAt: Date;
  lastActivityAt: Date | null;
};

export function isTerminalStateV3(state: WorkflowStateV3): boolean {
  return state === "done" || state === "stopped" || state === "terminated";
}

export function classifyFailureLane(params: {
  category: string | null;
  message: string | null;
}): FailureLane {
  const c = (params.category ?? "").toLowerCase();
  const m = (params.message ?? "").toLowerCase();
  if (
    c.includes("dispatch_ack_timeout") ||
    c.includes("runtime_crash") ||
    c.includes("transport") ||
    c.includes("timeout") ||
    c.includes("infra") ||
    m.includes("sandbox-not-found") ||
    m.includes("internal error") ||
    m.includes("acp") ||
    m.includes("couldn't connect to server")
  ) {
    return "infra";
  }
  return "agent";
}
