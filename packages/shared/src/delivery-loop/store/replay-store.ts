import { eq } from "drizzle-orm";
import type { DB } from "../../db";
import * as schema from "../../db/schema";
import type { ReplayEntry } from "../domain/observability";

/**
 * Build a chronological replay stream for debugging a workflow.
 * Merges workflow events, work items, and incidents into a single timeline.
 */
export async function buildWorkflowReplay(params: {
  db: DB;
  workflowId: string;
}): Promise<ReplayEntry[]> {
  const { db, workflowId } = params;

  const [events, workItems, incidents] = await Promise.all([
    db.query.deliveryWorkflowEvent.findMany({
      where: eq(schema.deliveryWorkflowEvent.workflowId, workflowId),
      orderBy: [schema.deliveryWorkflowEvent.seq],
    }),
    db.query.deliveryWorkItem.findMany({
      where: eq(schema.deliveryWorkItem.workflowId, workflowId),
      orderBy: [schema.deliveryWorkItem.scheduledAt],
    }),
    db.query.deliveryLoopIncident.findMany({
      where: eq(schema.deliveryLoopIncident.workflowId, workflowId),
      orderBy: [schema.deliveryLoopIncident.openedAt],
    }),
  ]);

  const entries: ReplayEntry[] = [];
  for (const e of events) {
    entries.push({
      timestamp: e.occurredAt,
      source: "workflow_event",
      summary: e.eventKind,
      detail: e as unknown as Record<string, unknown>,
    });
  }
  for (const w of workItems) {
    entries.push({
      timestamp: w.scheduledAt,
      source: "work_item",
      summary: `${w.kind} [${w.status}]`,
      detail: w as unknown as Record<string, unknown>,
    });
  }
  for (const i of incidents) {
    entries.push({
      timestamp: i.openedAt,
      source: "incident",
      summary: `${i.incidentType} [${i.status}]`,
      detail: i as unknown as Record<string, unknown>,
    });
  }

  // Sort chronologically
  entries.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

  return entries;
}
