import { eq } from "drizzle-orm";
import type { DB } from "../../db";
import * as schema from "../../db/schema";

export async function persistWorkflowStatusCommentReference(params: {
  db: DB;
  workflowId: string;
  commentId: string;
  commentNodeId: string;
}) {
  const now = new Date();
  const [updated] = await params.db
    .update(schema.deliveryWorkflow)
    .set({
      canonicalStatusCommentId: params.commentId,
      canonicalStatusCommentNodeId: params.commentNodeId,
      canonicalStatusCommentUpdatedAt: now,
      updatedAt: now,
    })
    .where(eq(schema.deliveryWorkflow.id, params.workflowId))
    .returning();

  return updated;
}

export async function clearWorkflowStatusCommentReference(params: {
  db: DB;
  workflowId: string;
}) {
  const now = new Date();
  const [updated] = await params.db
    .update(schema.deliveryWorkflow)
    .set({
      canonicalStatusCommentId: null,
      canonicalStatusCommentNodeId: null,
      canonicalStatusCommentUpdatedAt: now,
      updatedAt: now,
    })
    .where(eq(schema.deliveryWorkflow.id, params.workflowId))
    .returning();

  return updated;
}

export async function persistWorkflowCheckRunReference(params: {
  db: DB;
  workflowId: string;
  checkRunId: number;
}) {
  const now = new Date();
  const [updated] = await params.db
    .update(schema.deliveryWorkflow)
    .set({
      canonicalCheckRunId: params.checkRunId,
      canonicalCheckRunUpdatedAt: now,
      updatedAt: now,
    })
    .where(eq(schema.deliveryWorkflow.id, params.workflowId))
    .returning();

  return updated;
}
