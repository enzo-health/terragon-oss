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

  // Schedule status publication when externally visible state changes:
  // top-level kind change OR gate sub-state change (review→ci→ui).
  const externallyChanged =
    params.previousWorkflow.kind !== params.newWorkflow.kind ||
    (params.previousWorkflow.kind === "gating" &&
      params.newWorkflow.kind === "gating" &&
      params.previousWorkflow.gate.kind !== params.newWorkflow.gate.kind);

  if (externallyChanged) {
    items.push({
      kind: "publication",
      payloadJson: {
        target: { kind: "status_comment" },
        workflowState: params.newWorkflow.kind,
        ...(params.loopId ? { loopId: params.loopId } : {}),
        ...(params.newWorkflow.kind === "gating"
          ? { gate: params.newWorkflow.gate.kind }
          : {}),
      },
      scheduledAt: now,
    });
    items.push({
      kind: "publication",
      payloadJson: {
        target: { kind: "check_run_summary" },
        workflowState: params.newWorkflow.kind,
        ...(params.loopId ? { loopId: params.loopId } : {}),
        ...(params.newWorkflow.kind === "gating"
          ? { gate: params.newWorkflow.gate.kind }
          : {}),
      },
      scheduledAt: now,
    });
  }

  // State-specific work items
  switch (params.newWorkflow.kind) {
    case "planning":
      // Schedule dispatch when (re-)entering planning — e.g. after plan
      // approval or operator action resume. Planning uses the same daemon
      // runtime as implementation; the daemon inspects the workflow state
      // to determine whether to plan or implement.
      if (params.previousWorkflow.kind !== "planning") {
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

    case "implementing":
      // Schedule dispatch when entering implementing — including self-retries
      // and partial completions (redispatch_requested).
      // Note: threadChatId is intentionally omitted — the dispatch worker
      // resolves the correct chat at execution time since the active chat
      // may change between scheduling and dispatch (multi-chat threads).
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
      // CI gates are evaluated via GitHub webhooks — no dispatch needed.
      // Review and UI gates require a daemon dispatch to run the gate
      // evaluation logic (deep review, UI smoke test, etc.).
      if (
        params.newWorkflow.gate.kind !== "ci" &&
        (params.previousWorkflow.kind !== "gating" ||
          params.previousWorkflow.gate.kind !== params.newWorkflow.gate.kind)
      ) {
        items.push({
          kind: "dispatch",
          payloadJson: {
            executionClass: "gate_runtime",
            workflowId: params.newWorkflow.workflowId,
            gate: params.newWorkflow.gate.kind,
            loopId: params.loopId,
          },
          scheduledAt: now,
        });
      }
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
