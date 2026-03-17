import { eq, sql } from "drizzle-orm";
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
  const t = schema.deliveryLoopRuntimeStatus;

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

  // For timestamp fields, preserve the existing DB value when the caller
  // passes null/undefined (noop ticks). Only overwrite when a real Date
  // is provided. Uses COALESCE(new_value, existing_value) so that:
  //   Date → writes the new Date
  //   null → keeps whatever's already in the row
  await params.db
    .insert(t)
    .values(values)
    .onConflictDoUpdate({
      target: t.workflowId,
      set: {
        state: params.state,
        gate: values.gate,
        pendingActionKind: values.pendingActionKind,
        health: params.health,
        lastSignalAt:
          params.lastSignalAt != null
            ? params.lastSignalAt
            : sql`COALESCE(${t.lastSignalAt}, NULL)`,
        lastTransitionAt:
          params.lastTransitionAt != null
            ? params.lastTransitionAt
            : sql`COALESCE(${t.lastTransitionAt}, NULL)`,
        lastDispatchAt:
          params.lastDispatchAt != null
            ? params.lastDispatchAt
            : sql`COALESCE(${t.lastDispatchAt}, NULL)`,
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
