import type { DB } from "@terragon/shared/db";
import {
  completeWorkItem,
  failWorkItem,
} from "@terragon/shared/delivery-loop/store/work-queue-store";
import { getWorkflow } from "@terragon/shared/delivery-loop/store/workflow-store";
import { eq, desc } from "drizzle-orm";
import * as schema from "@terragon/shared/db/schema";
import {
  upsertSdlcCanonicalStatusComment,
  upsertSdlcCanonicalCheckSummary,
  classifySdlcPublicationFailure,
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
 * look up the sdlcLoop for repo/PR info, then publish a status comment
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
    // 1. Load workflow to get threadId, then look up sdlcLoop
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

    let loop;
    if (params.payload.loopId) {
      loop = await params.db.query.sdlcLoop.findFirst({
        where: eq(schema.sdlcLoop.id, params.payload.loopId),
      });
    } else {
      loop = await params.db.query.sdlcLoop.findFirst({
        where: eq(schema.sdlcLoop.threadId, workflow.threadId),
        orderBy: [desc(schema.sdlcLoop.createdAt)],
      });
    }
    if (!loop) {
      await failWorkItem({
        db: params.db,
        workItemId: params.workItemId,
        claimToken: params.claimToken,
        errorCode: "loop_not_found",
        errorMessage: `No sdlcLoop found for threadId ${workflow.threadId}`,
      });
      return;
    }

    // 3. Only publish if the loop has a PR number.
    //    Always publish the *current* workflow state, not the payload snapshot.
    //    A retried work item's payload may be stale if the workflow advanced
    //    since the item was first scheduled.
    if (typeof loop.prNumber === "number") {
      const currentState = workflow.kind;
      const body = formatStatusBody(currentState);
      const targetKind = params.payload.target.kind;

      try {
        if (targetKind === "check_run_summary") {
          await upsertSdlcCanonicalCheckSummary({
            db: params.db,
            loopId: loop.id,
            payload: {
              repoFullName: loop.repoFullName,
              prNumber: loop.prNumber,
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
          await upsertSdlcCanonicalStatusComment({
            db: params.db,
            loopId: loop.id,
            repoFullName: loop.repoFullName,
            prNumber: loop.prNumber,
            body,
          });
        }
      } catch (pubErr) {
        const classified = classifySdlcPublicationFailure(pubErr);
        if (!classified.retriable) {
          console.warn(
            "[publication-worker] non-retriable publication error, failing work item",
            { loopId: loop.id, errorCode: classified.errorCode },
          );
          await failWorkItem({
            db: params.db,
            workItemId: params.workItemId,
            claimToken: params.claimToken,
            errorCode: classified.errorCode ?? "publication_non_retriable",
            errorMessage:
              classified.message ?? "Non-retriable publication failure",
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
      errorMessage: err instanceof Error ? err.message : String(err),
      retryAt,
    });
  }
}
