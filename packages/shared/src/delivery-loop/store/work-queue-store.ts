import { and, eq, lte, sql } from "drizzle-orm";
import type { DB } from "../../db";
import * as schema from "../../db/schema";

export async function enqueueWorkItem(params: {
  db: Pick<DB, "insert">;
  workflowId: string;
  correlationId: string;
  kind: string;
  payloadJson: Record<string, unknown>;
  scheduledAt?: Date;
  maxAttempts?: number;
}) {
  const [row] = await params.db
    .insert(schema.deliveryWorkItem)
    .values({
      workflowId: params.workflowId,
      correlationId: params.correlationId,
      kind: params.kind,
      payloadJson: params.payloadJson,
      scheduledAt: params.scheduledAt ?? new Date(),
      maxAttempts: params.maxAttempts ?? 5,
    })
    .returning();
  return row!;
}

export async function claimNextWorkItem(params: {
  db: DB;
  kind?: string;
  claimToken: string;
  now?: Date;
}) {
  const now = params.now ?? new Date();

  const conditions = [
    eq(schema.deliveryWorkItem.status, "pending"),
    lte(schema.deliveryWorkItem.scheduledAt, now),
  ];
  if (params.kind) {
    conditions.push(eq(schema.deliveryWorkItem.kind, params.kind));
  }

  const item = await params.db.query.deliveryWorkItem.findFirst({
    where: and(...conditions),
    orderBy: [schema.deliveryWorkItem.scheduledAt],
  });
  if (!item) return null;

  const [claimed] = await params.db
    .update(schema.deliveryWorkItem)
    .set({
      status: "claimed",
      claimedAt: now,
      claimToken: params.claimToken,
      attemptCount: sql`${schema.deliveryWorkItem.attemptCount} + 1`,
    })
    .where(
      and(
        eq(schema.deliveryWorkItem.id, item.id),
        eq(schema.deliveryWorkItem.status, "pending"),
      ),
    )
    .returning();

  return claimed ?? null;
}

export async function completeWorkItem(params: {
  db: Pick<DB, "update">;
  workItemId: string;
  claimToken: string;
  now?: Date;
}) {
  const now = params.now ?? new Date();
  const [row] = await params.db
    .update(schema.deliveryWorkItem)
    .set({
      status: "completed",
      completedAt: now,
    })
    .where(
      and(
        eq(schema.deliveryWorkItem.id, params.workItemId),
        eq(schema.deliveryWorkItem.claimToken, params.claimToken),
        eq(schema.deliveryWorkItem.status, "claimed"),
      ),
    )
    .returning({ id: schema.deliveryWorkItem.id });
  return Boolean(row);
}

export async function failWorkItem(params: {
  db: Pick<DB, "update">;
  workItemId: string;
  claimToken: string;
  errorCode?: string;
  errorMessage?: string;
  retryAt?: Date;
  now?: Date;
}) {
  const now = params.now ?? new Date();

  // Use a raw SQL expression to conditionally dead-letter or re-queue
  const [row] = await params.db
    .update(schema.deliveryWorkItem)
    .set({
      status: sql`CASE WHEN ${schema.deliveryWorkItem.attemptCount} >= ${schema.deliveryWorkItem.maxAttempts} THEN 'dead_lettered' ELSE 'pending' END`,
      claimToken: null,
      claimedAt: null,
      lastErrorCode: params.errorCode ?? null,
      lastErrorMessage: params.errorMessage ?? null,
      scheduledAt: params.retryAt ?? now,
    })
    .where(
      and(
        eq(schema.deliveryWorkItem.id, params.workItemId),
        eq(schema.deliveryWorkItem.claimToken, params.claimToken),
        eq(schema.deliveryWorkItem.status, "claimed"),
      ),
    )
    .returning({
      id: schema.deliveryWorkItem.id,
      status: schema.deliveryWorkItem.status,
    });
  return row ?? null;
}

export async function supersedePendingWorkItems(params: {
  db: Pick<DB, "update">;
  workflowId: string;
  kind: string;
  excludeItemId?: string;
  now?: Date;
}) {
  const now = params.now ?? new Date();
  const conditions = [
    eq(schema.deliveryWorkItem.workflowId, params.workflowId),
    eq(schema.deliveryWorkItem.kind, params.kind),
    eq(schema.deliveryWorkItem.status, "pending"),
  ];

  // Build the where clause, conditionally excluding an item
  const whereClause = params.excludeItemId
    ? and(
        ...conditions,
        sql`${schema.deliveryWorkItem.id} != ${params.excludeItemId}`,
      )
    : and(...conditions);

  const result = await params.db
    .update(schema.deliveryWorkItem)
    .set({
      status: "completed",
      completedAt: now,
      lastErrorMessage: "superseded",
    })
    .where(whereClause)
    .returning({ id: schema.deliveryWorkItem.id });

  return result.length;
}
