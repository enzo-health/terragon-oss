import { and, desc, eq, notInArray } from "drizzle-orm";
import type { DB } from "../../db";
import * as schema from "../../db/schema";

const TERMINAL_KINDS = ["done", "stopped", "terminated"] as const;

export async function getWorkflow(params: {
  db: Pick<DB, "query">;
  workflowId: string;
}) {
  return params.db.query.deliveryWorkflow.findFirst({
    where: eq(schema.deliveryWorkflow.id, params.workflowId),
  });
}

export async function getActiveWorkflowForThread(params: {
  db: Pick<DB, "query">;
  threadId: string;
}) {
  return params.db.query.deliveryWorkflow.findFirst({
    where: and(
      eq(schema.deliveryWorkflow.threadId, params.threadId),
      notInArray(schema.deliveryWorkflow.kind, [...TERMINAL_KINDS]),
    ),
    orderBy: [desc(schema.deliveryWorkflow.generation)],
  });
}

export async function listActiveWorkflowIds(params: {
  db: Pick<DB, "query">;
  limit?: number;
}) {
  const rows = await params.db.query.deliveryWorkflow.findMany({
    where: notInArray(schema.deliveryWorkflow.kind, [...TERMINAL_KINDS]),
    columns: { id: true, threadId: true, sdlcLoopId: true },
    limit: params.limit ?? 50,
  });
  return rows;
}

export async function createWorkflow(params: {
  db: Pick<DB, "insert">;
  threadId: string;
  generation: number;
  kind: string;
  stateJson: Record<string, unknown>;
  maxFixAttempts?: number;
  sdlcLoopId?: string;
}) {
  const [row] = await params.db
    .insert(schema.deliveryWorkflow)
    .values({
      threadId: params.threadId,
      generation: params.generation,
      kind: params.kind,
      stateJson: params.stateJson,
      maxFixAttempts: params.maxFixAttempts ?? 6,
      sdlcLoopId: params.sdlcLoopId ?? null,
    })
    .returning();
  return row!;
}

export async function updateWorkflowState(params: {
  db: Pick<DB, "update">;
  workflowId: string;
  expectedVersion: number;
  kind: string;
  stateJson: Record<string, unknown>;
  fixAttemptCount?: number;
  headSha?: string | null;
  reviewSurfaceJson?: Record<string, unknown> | null;
  now?: Date;
}): Promise<
  | { updated: true; newVersion: number }
  | { updated: false; reason: "version_conflict" }
> {
  const now = params.now ?? new Date();
  const newVersion = params.expectedVersion + 1;

  const result = await params.db
    .update(schema.deliveryWorkflow)
    .set({
      kind: params.kind,
      version: newVersion,
      stateJson: params.stateJson,
      ...(params.fixAttemptCount !== undefined && {
        fixAttemptCount: params.fixAttemptCount,
      }),
      ...(params.headSha !== undefined && { headSha: params.headSha }),
      ...(params.reviewSurfaceJson !== undefined && {
        reviewSurfaceJson: params.reviewSurfaceJson,
      }),
      updatedAt: now,
      lastActivityAt: now,
    })
    .where(
      and(
        eq(schema.deliveryWorkflow.id, params.workflowId),
        eq(schema.deliveryWorkflow.version, params.expectedVersion),
      ),
    )
    .returning({ version: schema.deliveryWorkflow.version });

  if (result[0]) {
    return { updated: true, newVersion: result[0].version };
  }
  return { updated: false, reason: "version_conflict" };
}
