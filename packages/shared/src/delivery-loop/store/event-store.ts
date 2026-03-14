import { desc, eq } from "drizzle-orm";
import type { DB } from "../../db";
import * as schema from "../../db/schema";

export async function appendWorkflowEvent(params: {
  db: Pick<DB, "insert" | "query">;
  workflowId: string;
  correlationId: string;
  eventKind: string;
  stateBefore: string;
  stateAfter: string | null;
  gateBefore?: string | null;
  gateAfter?: string | null;
  payloadJson?: Record<string, unknown> | null;
  signalId?: string | null;
  triggerSource: string;
  headSha?: string | null;
  previousPhaseDurationMs?: number | null;
}) {
  // Get next seq number for this workflow
  const latest = await params.db.query.deliveryWorkflowEvent.findFirst({
    where: eq(schema.deliveryWorkflowEvent.workflowId, params.workflowId),
    orderBy: [desc(schema.deliveryWorkflowEvent.seq)],
    columns: { seq: true },
  });
  const nextSeq = (latest?.seq ?? 0) + 1;

  const [row] = await params.db
    .insert(schema.deliveryWorkflowEvent)
    .values({
      workflowId: params.workflowId,
      seq: nextSeq,
      correlationId: params.correlationId,
      eventKind: params.eventKind,
      stateBefore: params.stateBefore,
      stateAfter: params.stateAfter ?? null,
      gateBefore: params.gateBefore ?? null,
      gateAfter: params.gateAfter ?? null,
      payloadJson: params.payloadJson ?? null,
      signalId: params.signalId ?? null,
      triggerSource: params.triggerSource,
      headSha: params.headSha ?? null,
      previousPhaseDurationMs: params.previousPhaseDurationMs ?? null,
    })
    .returning();
  return row!;
}

export async function getWorkflowEvents(params: {
  db: Pick<DB, "query">;
  workflowId: string;
  limit?: number;
}) {
  return params.db.query.deliveryWorkflowEvent.findMany({
    where: eq(schema.deliveryWorkflowEvent.workflowId, params.workflowId),
    orderBy: [schema.deliveryWorkflowEvent.seq],
    limit: params.limit,
  });
}

export async function getEventsByCorrelation(params: {
  db: Pick<DB, "query">;
  correlationId: string;
}) {
  return params.db.query.deliveryWorkflowEvent.findMany({
    where: eq(schema.deliveryWorkflowEvent.correlationId, params.correlationId),
    orderBy: [schema.deliveryWorkflowEvent.seq],
  });
}
