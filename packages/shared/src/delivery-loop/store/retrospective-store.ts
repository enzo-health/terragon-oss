import { eq } from "drizzle-orm";
import type { DB } from "../../db";
import * as schema from "../../db/schema";
import { getWorkflow } from "./workflow-store";
import { getWorkflowEvents } from "./event-store";
import { computeRetrospective } from "../domain/retrospective";

export async function computeAndStoreRetrospective(params: {
  db: DB;
  workflowId: string;
  now?: Date;
}) {
  const now = params.now ?? new Date();

  const workflow = await getWorkflow({
    db: params.db,
    workflowId: params.workflowId,
  });
  if (!workflow) {
    throw new Error(
      `Workflow ${params.workflowId} not found for retrospective`,
    );
  }

  const terminalKinds = ["done", "stopped", "terminated"] as const;
  if (
    !terminalKinds.includes(workflow.kind as (typeof terminalKinds)[number])
  ) {
    throw new Error(
      `Workflow ${params.workflowId} is not in a terminal state (current: ${workflow.kind})`,
    );
  }

  const events = await getWorkflowEvents({
    db: params.db,
    workflowId: params.workflowId,
  });

  const outcome = workflow.kind as "done" | "stopped" | "terminated";

  const retro = computeRetrospective({
    workflowId: params.workflowId,
    events,
    outcome,
    now,
  });

  const [row] = await params.db
    .insert(schema.deliveryWorkflowRetrospective)
    .values({
      workflowId: params.workflowId,
      outcome: retro.outcome,
      e2eDurationMs: retro.e2eDurationMs,
      phaseMetrics: retro.phaseMetrics,
      gateMetrics: retro.gateMetrics,
      failurePatterns: retro.failurePatterns,
      retryMetrics: retro.retryMetrics,
      dispatchCount: retro.dispatchCount,
    })
    .onConflictDoUpdate({
      target: schema.deliveryWorkflowRetrospective.workflowId,
      set: {
        outcome: retro.outcome,
        e2eDurationMs: retro.e2eDurationMs,
        phaseMetrics: retro.phaseMetrics,
        gateMetrics: retro.gateMetrics,
        failurePatterns: retro.failurePatterns,
        retryMetrics: retro.retryMetrics,
        dispatchCount: retro.dispatchCount,
      },
    })
    .returning();

  return row!;
}

export async function getRetrospective(params: {
  db: Pick<DB, "query">;
  workflowId: string;
}) {
  return params.db.query.deliveryWorkflowRetrospective.findFirst({
    where: eq(
      schema.deliveryWorkflowRetrospective.workflowId,
      params.workflowId,
    ),
  });
}
