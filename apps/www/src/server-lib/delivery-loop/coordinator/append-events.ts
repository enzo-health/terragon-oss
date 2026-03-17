import type {
  DeliveryWorkflow,
  GateKind,
  GitSha,
} from "@terragon/shared/delivery-loop/domain/workflow";
import type {
  LoopEvent,
  LoopEventContext,
  DeliveryWorkflowEvent,
} from "@terragon/shared/delivery-loop/domain/events";

export function buildWorkflowEvent(params: {
  previousWorkflow: DeliveryWorkflow;
  newWorkflow: DeliveryWorkflow;
  event: LoopEvent;
  context: LoopEventContext;
}): DeliveryWorkflowEvent {
  const { previousWorkflow, newWorkflow, event, context } = params;

  switch (event) {
    case "plan_completed":
      return {
        kind: "plan_approved",
        planVersion:
          newWorkflow.kind === "implementing"
            ? newWorkflow.planVersion
            : (1 as import("@terragon/shared/delivery-loop/domain/workflow").PlanVersion),
      };

    case "implementation_completed":
      return {
        kind: "implementation_succeeded",
        headSha:
          newWorkflow.kind === "gating"
            ? newWorkflow.headSha
            : ("unknown" as GitSha),
      };

    case "redispatch_requested":
      return {
        kind: "dispatch_enqueued",
        dispatchId:
          newWorkflow.kind === "implementing"
            ? newWorkflow.dispatch.dispatchId
            : (`d-redispatch-${newWorkflow.version}` as import("@terragon/shared/delivery-loop/domain/workflow").DispatchId),
      };

    case "gate_passed":
      return {
        kind: "gate_evaluated",
        gate: (context.gate ?? extractGateKind(previousWorkflow)) as GateKind,
        passed: true,
        runId: context.runId ?? null,
        headSha: extractHeadSha(previousWorkflow),
      };

    case "gate_blocked":
      return {
        kind: "gate_evaluated",
        gate: (context.gate ?? extractGateKind(previousWorkflow)) as GateKind,
        passed: false,
        runId: context.runId ?? null,
        headSha: extractHeadSha(previousWorkflow),
      };

    case "pr_linked":
      return {
        kind: "review_surface_attached",
        surface: { kind: "github_pr", prNumber: context.prNumber ?? null },
        headSha: extractHeadSha(previousWorkflow),
      };

    case "babysit_passed":
      return { kind: "workflow_completed", outcome: "completed" };

    case "babysit_blocked":
      return {
        kind: "gate_evaluated",
        gate: "ci" as GateKind,
        passed: false,
        runId: context.runId ?? null,
        headSha: extractHeadSha(previousWorkflow),
      };

    case "blocked_resume":
      return buildResumeEvent(params);

    case "manual_stop":
      return {
        kind: "workflow_stopped",
        reason: { kind: "user_requested" },
      };

    case "pr_closed":
      return {
        kind: "workflow_terminated",
        reason: { kind: "pr_closed" },
      };

    case "pr_merged":
      return {
        kind: "workflow_terminated",
        reason: { kind: "pr_merged" },
      };

    case "mark_done":
      return { kind: "workflow_completed", outcome: "completed" };

    case "exhausted_retries":
      return {
        kind: "manual_fix_required",
        reason: {
          description: "Retry budget exhausted",
          suggestedAction: "Review failures and manually fix the issue",
        },
      };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildResumeEvent(params: {
  previousWorkflow: DeliveryWorkflow;
  newWorkflow: DeliveryWorkflow;
}): DeliveryWorkflowEvent {
  const { previousWorkflow, newWorkflow } = params;

  // Resuming from plan approval back to planning
  if (
    previousWorkflow.kind === "awaiting_plan_approval" &&
    newWorkflow.kind === "planning"
  ) {
    return {
      kind: "plan_approved",
      planVersion: previousWorkflow.planVersion,
    };
  }

  // Resuming from manual fix or operator action
  if (newWorkflow.kind === "implementing") {
    return {
      kind: "dispatch_enqueued",
      dispatchId: newWorkflow.dispatch.dispatchId,
    };
  }

  if (newWorkflow.kind === "gating") {
    return {
      kind: "gate_entered",
      gate: newWorkflow.gate.kind,
      headSha: newWorkflow.headSha,
    };
  }

  // Fallback: record as a generic implementation event
  return {
    kind: "dispatch_enqueued",
    dispatchId:
      `d-resume-${newWorkflow.version}` as import("@terragon/shared/delivery-loop/domain/workflow").DispatchId,
  };
}

function extractGateKind(workflow: DeliveryWorkflow): GateKind {
  if (workflow.kind === "gating") return workflow.gate.kind;
  return "ci"; // safe fallback
}

function extractHeadSha(workflow: DeliveryWorkflow): GitSha {
  if (
    workflow.kind === "gating" ||
    workflow.kind === "awaiting_pr" ||
    workflow.kind === "babysitting"
  ) {
    return workflow.headSha;
  }
  return "unknown" as GitSha;
}
