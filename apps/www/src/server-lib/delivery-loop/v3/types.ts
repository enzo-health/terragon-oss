import type { DeliveryEffectKindV3 } from "@terragon/shared/db/types";
import {
  type FailureLane,
  classifyFailureLane as classifyFailureLaneShared,
} from "@terragon/shared/delivery-loop/domain/failure-signature";

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
  | {
      type: "gate_ci_passed";
      runId?: string | null;
      headSha?: string | null;
    }
  | {
      type: "gate_ci_failed";
      runId?: string | null;
      headSha?: string | null;
      reason?: string | null;
    }
  | { type: "resume_requested" }
  | { type: "stop_requested" }
  | { type: "pr_closed"; merged: boolean };

export type EffectKindV3 = DeliveryEffectKindV3;

export type EffectPayloadV3 =
  | {
      kind: "dispatch_implementing";
      executionClass:
        | "implementation_runtime"
        | "implementation_runtime_fallback";
    }
  | { kind: "dispatch_gate_review"; gate: "review" }
  | {
      kind: "ack_timeout_check";
      runId: string;
      workflowVersion: number;
    }
  | { kind: "create_plan_artifact" }
  | { kind: "publish_status" };

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
  return classifyFailureLaneShared({
    category: params.category,
    message: params.message,
  });
}
