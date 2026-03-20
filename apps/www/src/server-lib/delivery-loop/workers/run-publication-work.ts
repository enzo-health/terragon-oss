import type { DB } from "@terragon/shared/db";
import {
  completeWorkItem,
  failWorkItem,
} from "@terragon/shared/delivery-loop/store/work-queue-store";
import { getWorkflow } from "@terragon/shared/delivery-loop/store/workflow-store";
import { stringifyError } from "./resolve-loop";
import {
  upsertDeliveryCanonicalStatusComment,
  upsertDeliveryCanonicalCheckSummary,
  classifyDeliveryPublicationFailure,
} from "../publication";

export type PublicationWorkPayload = {
  target: { kind: "status_comment" } | { kind: "check_run_summary" };
  workflowState: string;
  loopId?: string;
};

/** Map v2 workflow state to a human-readable status body for PR comments. */
function formatStatusBody(workflowState: string): string {
  const stateLabels: Record<string, string> = {
    planning: "Planning phase in progress",
    implementing: "Implementation in progress",
    gating: "Waiting on gate checks (review / CI / UI)",
    awaiting_pr: "Awaiting PR creation",
    babysitting: "Babysitting — monitoring CI and reviews",
    awaiting_plan_approval: "Awaiting plan approval from human",
    awaiting_manual_fix: "Awaiting manual fix from human",
    awaiting_operator_action: "Awaiting operator action",
    done: "Delivery loop completed",
    stopped: "Delivery loop stopped",
    terminated: "Delivery loop terminated",
  };
  const label = stateLabels[workflowState] ?? `State: ${workflowState}`;
  return `Terragon Delivery Loop v2 status update.\n\n- Current state: \`${workflowState}\`\n- ${label}`;
}

/**
 * Execute a publication work item: supersede stale publications,
 * look up the delivery workflow for repo/PR info, then publish a status comment
 * or check run summary to GitHub.
 */
export async function runPublicationWork(params: {
  db: DB;
  workItemId: string;
  claimToken: string;
  workflowId: string;
  payload: PublicationWorkPayload;
}): Promise<void> {
  try {
    // 1. Load workflow — it now holds repo/PR info and GitHub references directly
    const workflow = await getWorkflow({
      db: params.db,
      workflowId: params.workflowId,
    });
    if (!workflow) {
      await failWorkItem({
        db: params.db,
        workItemId: params.workItemId,
        claimToken: params.claimToken,
        errorCode: "workflow_not_found",
        errorMessage: `Workflow ${params.workflowId} not found`,
      });
      return;
    }

    // 2. Only publish if the workflow has a PR number.
    //    Always publish the *current* workflow state, not the payload snapshot.
    //    A retried work item's payload may be stale if the workflow advanced
    //    since the item was first scheduled.
    if (typeof workflow.prNumber === "number") {
      const currentState = workflow.kind;
      const body = formatStatusBody(currentState);
      const targetKind = params.payload.target.kind;

      try {
        if (targetKind === "check_run_summary") {
          await upsertDeliveryCanonicalCheckSummary({
            db: params.db,
            workflowId: workflow.id,
            payload: {
              repoFullName: workflow.repoFullName,
              prNumber: workflow.prNumber,
              title: "Terragon Delivery Loop",
              summary: body,
              status:
                currentState === "done" ||
                currentState === "stopped" ||
                currentState === "terminated"
                  ? "completed"
                  : "in_progress",
              conclusion:
                currentState === "done"
                  ? "success"
                  : currentState === "stopped" || currentState === "terminated"
                    ? "cancelled"
                    : undefined,
            },
          });
        } else {
          // Default: status_comment
          await upsertDeliveryCanonicalStatusComment({
            db: params.db,
            workflowId: workflow.id,
            repoFullName: workflow.repoFullName,
            prNumber: workflow.prNumber,
            body,
          });
        }
      } catch (pubErr) {
        const classified = classifyDeliveryPublicationFailure(pubErr);
        if (!classified.retriable) {
          console.warn(
            "[publication-worker] non-retriable publication error, failing work item",
            { workflowId: workflow.id, errorCode: classified.errorCode },
          );
          await failWorkItem({
            db: params.db,
            workItemId: params.workItemId,
            claimToken: params.claimToken,
            errorCode: classified.errorCode ?? "publication_non_retriable",
            errorMessage:
              classified.message ?? "Non-retriable publication failure",
            terminal: true,
          });
          return;
        } else {
          throw pubErr; // Let the outer catch handle retry
        }
      }
    }

    // 4. Complete work item
    await completeWorkItem({
      db: params.db,
      workItemId: params.workItemId,
      claimToken: params.claimToken,
    });
  } catch (err) {
    const retryAt = new Date(Date.now() + 15_000); // 15s backoff
    await failWorkItem({
      db: params.db,
      workItemId: params.workItemId,
      claimToken: params.claimToken,
      errorCode: "publication_failed",
      errorMessage: stringifyError(err),
      retryAt,
    });
  }
}
