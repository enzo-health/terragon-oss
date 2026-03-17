/**
 * V2-native enrollment: creates a delivery_workflow as the sole source
 * of truth. No v1 sdlcLoop is created.
 *
 * Idempotent: if a workflow already exists for the thread, returns it.
 */
import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import type { DB } from "@terragon/shared/db";
import * as schema from "@terragon/shared/db/schema";
import type { SdlcPlanApprovalPolicy } from "@terragon/shared/db/types";
import {
  createWorkflow,
  getActiveWorkflowForThread,
} from "@terragon/shared/delivery-loop/store/workflow-store";
import { enqueueWorkItem } from "@terragon/shared/delivery-loop/store/work-queue-store";

// ---------------------------------------------------------------------------
// V2-native enrollment
// ---------------------------------------------------------------------------

export async function enrollV2Workflow(params: {
  db: DB;
  threadId: string;
  userId: string;
  repoFullName: string;
  generation?: number;
  planApprovalPolicy?: SdlcPlanApprovalPolicy;
}): Promise<{ workflowId: string; sdlcLoopId: string | null }> {
  // 1. Idempotency: if a v2 workflow already exists for this thread, return it
  const existing = await getActiveWorkflowForThread({
    db: params.db,
    threadId: params.threadId,
  });
  if (existing) {
    return {
      workflowId: existing.id,
      sdlcLoopId: existing.sdlcLoopId ?? null,
    };
  }

  // 2. Compute next generation
  let generation = params.generation;
  if (generation === undefined) {
    const latest = await params.db.query.deliveryWorkflow.findFirst({
      where: eq(schema.deliveryWorkflow.threadId, params.threadId),
      orderBy: [desc(schema.deliveryWorkflow.generation)],
      columns: { generation: true },
    });
    generation = (latest?.generation ?? 0) + 1;
  }

  // 3. Create v2 workflow directly in planning state (no v1 sdlcLoop)
  try {
    const workflow = await createWorkflow({
      db: params.db,
      threadId: params.threadId,
      generation,
      kind: "planning",
      stateJson: { planVersion: null },
      repoFullName: params.repoFullName,
      userId: params.userId,
      planApprovalPolicy: params.planApprovalPolicy ?? "auto",
    });

    await enqueueWorkItem({
      db: params.db,
      workflowId: workflow.id,
      correlationId: randomUUID(),
      kind: "dispatch",
      payloadJson: {
        executionClass: "implementation_runtime",
        workflowId: workflow.id,
        bootstrap: true,
      },
    });

    return { workflowId: workflow.id, sdlcLoopId: null };
  } catch (err) {
    // Race: concurrent caller may have inserted between our check and insert.
    // Re-query and return if a workflow now exists.
    const raceWinner = await getActiveWorkflowForThread({
      db: params.db,
      threadId: params.threadId,
    });
    if (raceWinner) {
      return {
        workflowId: raceWinner.id,
        sdlcLoopId: raceWinner.sdlcLoopId ?? null,
      };
    }
    throw err;
  }
}
