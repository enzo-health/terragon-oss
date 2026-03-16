import type { DeliveryWorkflow } from "@terragon/shared/delivery-loop/domain/workflow";
import type { LoopEvent } from "@terragon/shared/delivery-loop/domain/events";

export type ScheduledWorkItem = {
  kind: "dispatch" | "publication" | "retry" | "babysit";
  payloadJson: Record<string, unknown>;
  scheduledAt: Date;
};

export function resolveWorkItems(params: {
  previousWorkflow: DeliveryWorkflow;
  newWorkflow: DeliveryWorkflow;
  event: LoopEvent;
  loopId?: string;
  now?: Date;
}): ScheduledWorkItem[] {
  const items: ScheduledWorkItem[] = [];
  const now = params.now ?? new Date();

  // Always schedule status publication on state change
  if (params.previousWorkflow.kind !== params.newWorkflow.kind) {
    items.push({
      kind: "publication",
      payloadJson: {
        target: { kind: "status_comment" },
        workflowState: params.newWorkflow.kind,
      },
      scheduledAt: now,
    });
    items.push({
      kind: "publication",
      payloadJson: {
        target: { kind: "check_run_summary" },
        workflowState: params.newWorkflow.kind,
      },
      scheduledAt: now,
    });
  }

  // State-specific work items
  switch (params.newWorkflow.kind) {
    case "implementing":
      // Schedule dispatch when entering implementing — including self-retries
      // (e.g. gate_blocked in implementing keeps the state but needs a new run)
      if (
        params.previousWorkflow.kind !== "implementing" ||
        params.newWorkflow.version !== params.previousWorkflow.version
      ) {
        items.push({
          kind: "dispatch",
          payloadJson: {
            executionClass: "implementation_runtime",
            workflowId: params.newWorkflow.workflowId,
            loopId: params.loopId,
          },
          scheduledAt: now,
        });
      }
      break;

    case "gating":
      // Schedule gate runtime dispatch
      items.push({
        kind: "dispatch",
        payloadJson: {
          executionClass: "gate_runtime",
          gate: params.newWorkflow.gate.kind,
          workflowId: params.newWorkflow.workflowId,
          loopId: params.loopId,
          headSha: params.newWorkflow.headSha,
        },
        scheduledAt: now,
      });
      break;

    case "babysitting":
      // Schedule babysit recheck
      items.push({
        kind: "babysit",
        payloadJson: {
          workflowId: params.newWorkflow.workflowId,
          loopId: params.loopId,
        },
        scheduledAt: params.newWorkflow.nextCheckAt,
      });
      break;

    case "awaiting_plan_approval":
    case "awaiting_manual_fix":
    case "awaiting_operator_action":
      // No automatic work — waiting for human
      break;

    case "done":
    case "stopped":
    case "terminated":
      // Final status publication already handled above
      break;
  }

  return items;
}
