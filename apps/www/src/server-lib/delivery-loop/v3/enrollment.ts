/**
 * V3-native enrollment: creates a delivery_workflow + v3 head row + bootstrap
 * journal event in one shot. No v2 signal inbox or work queue involved.
 *
 * Idempotent: if a workflow already exists for the thread, returns it.
 */
import { desc, eq } from "drizzle-orm";
import type { DB } from "@terragon/shared/db";
import * as schema from "@terragon/shared/db/schema";
import type { DeliveryPlanApprovalPolicy } from "@terragon/shared/db/types";
import {
  createWorkflow,
  getActiveWorkflowForThread,
} from "@terragon/shared/delivery-loop/store/workflow-store";
import { appendEventAndAdvance } from "./kernel";
import { getActiveWorkflowForThreadV3 } from "./store";

export async function enrollWorkflow(params: {
  db: DB;
  threadId: string;
  userId: string;
  repoFullName: string;
  generation?: number;
  planApprovalPolicy?: DeliveryPlanApprovalPolicy;
}): Promise<{ workflowId: string }> {
  // 1. Idempotency: if a workflow already exists for this thread, return it
  const existing = await getActiveWorkflowForThreadV3({
    db: params.db,
    threadId: params.threadId,
  });
  if (existing) {
    return { workflowId: existing.workflow.id };
  }

  const orphanedLegacyWorkflow = await getActiveWorkflowForThread({
    db: params.db,
    threadId: params.threadId,
  });
  if (orphanedLegacyWorkflow?.kind === "planning") {
    await appendEventAndAdvance({
      db: params.db,
      workflowId: orphanedLegacyWorkflow.id,
      source: "system",
      idempotencyKey: `${orphanedLegacyWorkflow.id}:bootstrap`,
      event: { type: "bootstrap" },
    });
    const healed = await getActiveWorkflowForThreadV3({
      db: params.db,
      threadId: params.threadId,
    });
    if (healed) {
      return { workflowId: healed.workflow.id };
    }
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

  // 3. Create the legacy workflow row (needed for FK refs from threads, artifacts, etc.)
  let workflowId: string | null = null;
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
    workflowId = workflow.id;

    // 4. Create v3 head row + insert bootstrap journal event.
    //    The kernel reducer handles bootstrap: stays in planning + dispatches planning run.
    await appendEventAndAdvance({
      db: params.db,
      workflowId,
      source: "system",
      idempotencyKey: `${workflowId}:bootstrap`,
      event: { type: "bootstrap" },
    });

    return { workflowId };
  } catch (err) {
    if (workflowId) {
      try {
        await appendEventAndAdvance({
          db: params.db,
          workflowId,
          source: "system",
          idempotencyKey: `${workflowId}:bootstrap`,
          event: { type: "bootstrap" },
        });
        const recovered = await getActiveWorkflowForThreadV3({
          db: params.db,
          threadId: params.threadId,
        });
        if (recovered?.workflow.id === workflowId) {
          return { workflowId };
        }
      } catch {
        // Fall through to race-winner detection so transient bootstrap failures
        // do not create duplicate workflows on the next enroll attempt.
      }
    }
    // Race: concurrent caller may have inserted between our check and insert.
    const raceWinner = await getActiveWorkflowForThreadV3({
      db: params.db,
      threadId: params.threadId,
    });
    if (raceWinner) {
      return { workflowId: raceWinner.workflow.id };
    }
    throw err;
  }
}
