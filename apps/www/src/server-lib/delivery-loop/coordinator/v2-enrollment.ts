/**
 * V2-native enrollment: creates a delivery_workflow as the PRIMARY path,
 * with a v1 sdlcLoop record as a compat shim for daemon/UI consumers
 * that still read it.
 *
 * Idempotent: if a workflow already exists for the thread, returns it.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import type { DB } from "@terragon/shared/db";
import * as schema from "@terragon/shared/db/schema";
import type { SdlcPlanApprovalPolicy } from "@terragon/shared/db/types";
import {
  createWorkflow,
  getActiveWorkflowForThread,
} from "@terragon/shared/delivery-loop/store/workflow-store";
import {
  activeSdlcLoopStateList,
  enrollSdlcLoopForThread,
} from "@terragon/shared/model/delivery-loop";

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
}): Promise<{ workflowId: string; sdlcLoopId: string }> {
  // 1. Idempotency: if a v2 workflow already exists for this thread, return it
  const existing = await getActiveWorkflowForThread({
    db: params.db,
    threadId: params.threadId,
  });
  if (existing) {
    return {
      workflowId: existing.id,
      sdlcLoopId: existing.sdlcLoopId ?? "",
    };
  }

  // 2. Create v1 sdlcLoop compat shim — daemon and some UI code still reads it
  const sdlcLoop = await enrollSdlcLoopForThread({
    db: params.db,
    userId: params.userId,
    repoFullName: params.repoFullName,
    threadId: params.threadId,
    planApprovalPolicy: params.planApprovalPolicy ?? "auto",
    initialState: "planning",
  });
  if (!sdlcLoop) {
    throw new Error(
      `[v2-enrollment] failed to create v1 sdlcLoop compat shim for thread ${params.threadId}`,
    );
  }

  // 3. Compute next generation
  let generation = params.generation;
  if (generation === undefined) {
    const latest = await params.db.query.deliveryWorkflow.findFirst({
      where: eq(schema.deliveryWorkflow.threadId, params.threadId),
      orderBy: [desc(schema.deliveryWorkflow.generation)],
      columns: { generation: true },
    });
    generation = (latest?.generation ?? 0) + 1;
  }

  // 4. Create v2 workflow directly in planning state
  try {
    const workflow = await createWorkflow({
      db: params.db,
      threadId: params.threadId,
      generation,
      kind: "planning",
      stateJson: { planVersion: null },
      sdlcLoopId: sdlcLoop.id,
      repoFullName: params.repoFullName,
      userId: params.userId,
      planApprovalPolicy: params.planApprovalPolicy ?? "auto",
    });

    return { workflowId: workflow.id, sdlcLoopId: sdlcLoop.id };
  } catch (err) {
    // Race: concurrent caller may have inserted between our check and insert.
    // Re-query and return if a workflow now exists.
    const raceWinner = await getActiveWorkflowForThread({
      db: params.db,
      threadId: params.threadId,
    });
    if (raceWinner) {
      let winnerLoopId = raceWinner.sdlcLoopId;
      if (!winnerLoopId) {
        // Winner's sdlcLoopId is null — re-query for the active sdlcLoop
        // linked to this thread instead of returning the loser's orphan id
        console.warn(
          `[v2-enrollment] race winner workflow ${raceWinner.id} has null sdlcLoopId; ` +
            `loser's orphan sdlcLoop ${sdlcLoop.id} will NOT be returned. Re-querying.`,
        );
        const activeLoop = await params.db.query.sdlcLoop.findFirst({
          where: and(
            eq(schema.sdlcLoop.threadId, params.threadId),
            inArray(schema.sdlcLoop.state, activeSdlcLoopStateList),
          ),
          orderBy: [desc(schema.sdlcLoop.updatedAt)],
          columns: { id: true },
        });
        winnerLoopId = activeLoop?.id ?? "";
      }

      // Terminate the orphan sdlcLoop created by this (losing) caller
      try {
        await params.db
          .update(schema.sdlcLoop)
          .set({ state: "stopped", updatedAt: new Date() })
          .where(eq(schema.sdlcLoop.id, sdlcLoop.id));
      } catch (cleanupErr) {
        console.warn("[v2-enrollment] failed to cleanup orphan sdlcLoop", {
          orphanLoopId: sdlcLoop.id,
          error:
            cleanupErr instanceof Error
              ? cleanupErr.message
              : String(cleanupErr),
        });
      }

      return {
        workflowId: raceWinner.id,
        sdlcLoopId: winnerLoopId,
      };
    }
    throw err;
  }
}
