import { eq, sql } from "drizzle-orm";
import type { DB } from "../../db";
import * as schema from "../../db/schema";

const MAX_SEQ_RETRIES = 3;

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
  for (let attempt = 1; attempt <= MAX_SEQ_RETRIES; attempt++) {
    try {
      const [row] = await params.db
        .insert(schema.deliveryWorkflowEvent)
        .values({
          workflowId: params.workflowId,
          seq: sql`COALESCE((SELECT MAX(${schema.deliveryWorkflowEvent.seq}) FROM ${schema.deliveryWorkflowEvent} WHERE ${schema.deliveryWorkflowEvent.workflowId} = ${params.workflowId}), 0) + 1`,
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
    } catch (error: unknown) {
      const isUniqueViolation =
        error instanceof Error &&
        "code" in error &&
        (error as { code: string }).code === "23505";
      if (!isUniqueViolation || attempt === MAX_SEQ_RETRIES) {
        throw error;
      }
      // Unique violation on seq — retry with fresh MAX query
    }
  }
  // Unreachable: loop always returns or throws
  throw new Error("appendWorkflowEvent: exhausted retries");
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
