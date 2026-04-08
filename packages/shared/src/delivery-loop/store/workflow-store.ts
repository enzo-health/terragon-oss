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

export async function createWorkflow(params: {
  db: Pick<DB, "insert">;
  threadId: string;
  generation: number;
  kind: string;
  stateJson: Record<string, unknown>;
  maxFixAttempts?: number;
  repoFullName?: string;
  prNumber?: number | null;
  userId?: string;
  planApprovalPolicy?: string;
  currentHeadSha?: string | null;
  blockedReason?: string | null;
}) {
  const [row] = await params.db
    .insert(schema.deliveryWorkflow)
    .values({
      threadId: params.threadId,
      generation: params.generation,
      kind: params.kind,
      stateJson: params.stateJson,
      maxFixAttempts: params.maxFixAttempts ?? 6,
      repoFullName: params.repoFullName ?? "",
      prNumber: params.prNumber ?? null,
      userId: params.userId ?? "",
      planApprovalPolicy: params.planApprovalPolicy ?? "auto",
      currentHeadSha: params.currentHeadSha ?? null,
      blockedReason: params.blockedReason ?? null,
    })
    .returning();
  return row!;
}

export async function getActiveWorkflowForGithubPR(params: {
  db: Pick<DB, "query">;
  repoFullName: string;
  prNumber: number;
}) {
  return params.db.query.deliveryWorkflow.findMany({
    where: and(
      eq(schema.deliveryWorkflow.repoFullName, params.repoFullName),
      eq(schema.deliveryWorkflow.prNumber, params.prNumber),
      notInArray(schema.deliveryWorkflow.kind, [...TERMINAL_KINDS]),
    ),
  });
}

export async function updateWorkflowPR(params: {
  db: Pick<DB, "update">;
  workflowId: string;
  prNumber: number;
  now?: Date;
}): Promise<boolean> {
  const now = params.now ?? new Date();
  const result = await params.db
    .update(schema.deliveryWorkflow)
    .set({
      prNumber: params.prNumber,
      updatedAt: now,
    })
    .where(eq(schema.deliveryWorkflow.id, params.workflowId))
    .returning({ id: schema.deliveryWorkflow.id });
  return result.length > 0;
}
