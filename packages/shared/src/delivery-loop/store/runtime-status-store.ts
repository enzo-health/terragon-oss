import { eq } from "drizzle-orm";
import type { DB } from "../../db";
import * as schema from "../../db/schema";

export async function upsertRuntimeStatus(params: {
  db: Pick<DB, "insert" | "update">;
  workflowId: string;
  state: string;
  gate?: string | null;
  pendingActionKind?: string | null;
  health: string;
  lastSignalAt?: Date | null;
  lastTransitionAt?: Date | null;
  lastDispatchAt?: Date | null;
  oldestUnprocessedSignalAgeMs?: number | null;
  fixAttemptCount?: number | null;
  openIncidentCount?: number | null;
}) {
  const values = {
    workflowId: params.workflowId,
    state: params.state,
    gate: params.gate ?? null,
    pendingActionKind: params.pendingActionKind ?? null,
    health: params.health,
    lastSignalAt: params.lastSignalAt ?? null,
    lastTransitionAt: params.lastTransitionAt ?? null,
    lastDispatchAt: params.lastDispatchAt ?? null,
    oldestUnprocessedSignalAgeMs: params.oldestUnprocessedSignalAgeMs ?? null,
    fixAttemptCount: params.fixAttemptCount ?? null,
    openIncidentCount: params.openIncidentCount ?? null,
  };

  await params.db
    .insert(schema.deliveryLoopRuntimeStatus)
    .values(values)
    .onConflictDoUpdate({
      target: schema.deliveryLoopRuntimeStatus.workflowId,
      set: {
        state: params.state,
        gate: values.gate,
        pendingActionKind: values.pendingActionKind,
        health: params.health,
        lastSignalAt: values.lastSignalAt,
        lastTransitionAt: values.lastTransitionAt,
        lastDispatchAt: values.lastDispatchAt,
        oldestUnprocessedSignalAgeMs: values.oldestUnprocessedSignalAgeMs,
        fixAttemptCount: values.fixAttemptCount,
        openIncidentCount: values.openIncidentCount,
        updatedAt: new Date(),
      },
    });
}

export async function getRuntimeStatus(params: {
  db: Pick<DB, "query">;
  workflowId: string;
}) {
  return params.db.query.deliveryLoopRuntimeStatus.findFirst({
    where: eq(schema.deliveryLoopRuntimeStatus.workflowId, params.workflowId),
  });
}
