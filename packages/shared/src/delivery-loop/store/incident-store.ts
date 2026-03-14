import { and, eq, inArray } from "drizzle-orm";
import type { DB } from "../../db";
import * as schema from "../../db/schema";

export async function openIncident(params: {
  db: Pick<DB, "insert">;
  workflowId: string;
  incidentType: string;
  severity: "warning" | "critical";
  detail?: string;
  now?: Date;
}) {
  const now = params.now ?? new Date();
  const [row] = await params.db
    .insert(schema.deliveryLoopIncident)
    .values({
      workflowId: params.workflowId,
      incidentType: params.incidentType,
      severity: params.severity,
      detail: params.detail ?? null,
      openedAt: now,
      createdAt: now,
    })
    .returning();
  return row!;
}

export async function acknowledgeIncident(params: {
  db: Pick<DB, "update">;
  incidentId: string;
  now?: Date;
}) {
  const [row] = await params.db
    .update(schema.deliveryLoopIncident)
    .set({
      status: "acknowledged",
      updatedAt: params.now ?? new Date(),
    })
    .where(eq(schema.deliveryLoopIncident.id, params.incidentId))
    .returning({ id: schema.deliveryLoopIncident.id });
  return Boolean(row);
}

export async function resolveIncident(params: {
  db: Pick<DB, "update">;
  incidentId: string;
  now?: Date;
}) {
  const now = params.now ?? new Date();
  const [row] = await params.db
    .update(schema.deliveryLoopIncident)
    .set({
      status: "resolved",
      resolvedAt: now,
      updatedAt: now,
    })
    .where(eq(schema.deliveryLoopIncident.id, params.incidentId))
    .returning({ id: schema.deliveryLoopIncident.id });
  return Boolean(row);
}

export async function getOpenIncidents(params: {
  db: Pick<DB, "query">;
  workflowId: string;
}) {
  return params.db.query.deliveryLoopIncident.findMany({
    where: and(
      eq(schema.deliveryLoopIncident.workflowId, params.workflowId),
      inArray(schema.deliveryLoopIncident.status, ["open", "acknowledged"]),
    ),
  });
}
