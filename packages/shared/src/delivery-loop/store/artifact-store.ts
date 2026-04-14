import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { DB } from "../../db";
import * as schema from "../../db/schema";
import type {
  DeliveryPhase,
  DeliveryArtifactType,
  DeliveryArtifactStatus,
  DeliveryArtifactGeneratedBy,
  DeliveryPlanApprovalPolicy,
  DeliveryPlanSpecPayload,
  DeliveryImplementationSnapshotPayload,
  DeliveryReviewBundlePayload,
  DeliveryUiSmokePayload,
  DeliveryPrLinkPayload,
  DeliveryBabysitEvaluationPayload,
  DeliveryPlanTask,
  DeliveryPlanTaskStatus,
  DeliveryPlanTaskCompletedBy,
  DeliveryPlanTaskCompletionEvidence,
  DeliveryPhaseArtifact,
} from "../../db/types";
const deliveryPlanTaskIncompleteStatusSet = new Set<DeliveryPlanTaskStatus>([
  "todo",
  "in_progress",
  "blocked",
]);

const deliveryPlanTaskNonBlockingTerminalStatusSet =
  new Set<DeliveryPlanTaskStatus>(["done", "skipped"]);

function isIncompletePlanTaskStatus(status: DeliveryPlanTaskStatus): boolean {
  return deliveryPlanTaskIncompleteStatusSet.has(status);
}

function isNonBlockingTerminalPlanTaskStatus(
  status: DeliveryPlanTaskStatus,
): boolean {
  return deliveryPlanTaskNonBlockingTerminalStatusSet.has(status);
}

type DeliveryArtifactPayload =
  | DeliveryPlanSpecPayload
  | DeliveryImplementationSnapshotPayload
  | DeliveryReviewBundlePayload
  | DeliveryUiSmokePayload
  | DeliveryPrLinkPayload
  | DeliveryBabysitEvaluationPayload
  | Record<string, unknown>;

function getPlanArtifactRequiredStatus(
  policy: DeliveryPlanApprovalPolicy,
): DeliveryArtifactStatus {
  return policy === "human_required" ? "approved" : "accepted";
}

export async function getLatestAcceptedArtifact({
  db,
  loopId,
  phase,
  headSha,
  includeApprovedForPlanning = true,
}: {
  db: DB;
  loopId: string;
  phase: DeliveryPhase;
  headSha?: string | null;
  includeApprovedForPlanning?: boolean;
}) {
  const acceptedStatuses: DeliveryArtifactStatus[] =
    includeApprovedForPlanning && phase === "planning"
      ? ["accepted", "approved"]
      : ["accepted"];

  const whereClauses = [
    eq(schema.deliveryPhaseArtifact.loopId, loopId),
    eq(schema.deliveryPhaseArtifact.phase, phase),
    inArray(schema.deliveryPhaseArtifact.status, acceptedStatuses),
  ];
  if (headSha !== undefined) {
    if (headSha === null) {
      whereClauses.push(isNull(schema.deliveryPhaseArtifact.headSha));
    } else {
      whereClauses.push(eq(schema.deliveryPhaseArtifact.headSha, headSha));
    }
  }

  return await db.query.deliveryPhaseArtifact.findFirst({
    where: and(...whereClauses),
    orderBy: [
      desc(schema.deliveryPhaseArtifact.createdAt),
      desc(schema.deliveryPhaseArtifact.id),
    ],
  });
}

export async function createPlanArtifact({
  db,
  loopId,
  loopVersion,
  payload,
  generatedBy = "agent",
  status = "generated",
  workflowId,
  now = new Date(),
}: {
  db: DB;
  loopId: string;
  loopVersion: number;
  payload: DeliveryPlanSpecPayload;
  generatedBy?: DeliveryArtifactGeneratedBy;
  status?: DeliveryArtifactStatus;
  workflowId?: string | null;
  now?: Date;
}) {
  return await db.transaction(async (tx) => {
    await tx
      .update(schema.deliveryPhaseArtifact)
      .set({
        status: "superseded",
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.deliveryPhaseArtifact.loopId, loopId),
          eq(schema.deliveryPhaseArtifact.phase, "planning"),
          inArray(schema.deliveryPhaseArtifact.status, [
            "generated",
            "approved",
            "accepted",
          ]),
        ),
      );

    const [artifact] = await tx
      .insert(schema.deliveryPhaseArtifact)
      .values({
        loopId,
        phase: "planning",
        artifactType: "plan_spec",
        headSha: null,
        loopVersion,
        status,
        generatedBy,
        payload,
        workflowId: workflowId ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    if (!artifact) {
      throw new Error("Failed to create delivery plan artifact");
    }

    return artifact;
  });
}

export async function approvePlanArtifact({
  db,
  loopId,
  artifactId,
  approvedByUserId,
  now = new Date(),
}: {
  db: DB;
  loopId: string;
  artifactId: string;
  approvedByUserId: string;
  now?: Date;
}) {
  const [artifact] = await db
    .update(schema.deliveryPhaseArtifact)
    .set({
      status: "approved",
      approvedByUserId,
      approvedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.deliveryPhaseArtifact.id, artifactId),
        eq(schema.deliveryPhaseArtifact.loopId, loopId),
        eq(schema.deliveryPhaseArtifact.phase, "planning"),
        eq(schema.deliveryPhaseArtifact.artifactType, "plan_spec"),
        inArray(schema.deliveryPhaseArtifact.status, ["generated", "accepted"]),
      ),
    )
    .returning();

  return artifact ?? undefined;
}

export async function replacePlanTasksForArtifact({
  db,
  loopId,
  artifactId,
  tasks,
  now = new Date(),
}: {
  db: DB;
  loopId: string;
  artifactId: string;
  tasks: Array<{
    stableTaskId: string;
    title: string;
    description?: string | null;
    acceptance: string[];
  }>;
  now?: Date;
}) {
  return await db.transaction(async (tx) => {
    const artifact = await tx.query.deliveryPhaseArtifact.findFirst({
      where: and(
        eq(schema.deliveryPhaseArtifact.id, artifactId),
        eq(schema.deliveryPhaseArtifact.loopId, loopId),
        eq(schema.deliveryPhaseArtifact.phase, "planning"),
        eq(schema.deliveryPhaseArtifact.artifactType, "plan_spec"),
      ),
    });
    if (!artifact) {
      throw new Error("Plan artifact not found for loop");
    }

    await tx
      .delete(schema.deliveryPlanTask)
      .where(eq(schema.deliveryPlanTask.artifactId, artifactId));

    if (tasks.length === 0) {
      return [] as DeliveryPlanTask[];
    }

    const dedupedTasks = new Map<
      string,
      {
        stableTaskId: string;
        title: string;
        description?: string | null;
        acceptance: string[];
      }
    >();
    for (const task of tasks) {
      const stableTaskId = task.stableTaskId.trim();
      if (!stableTaskId) {
        continue;
      }
      dedupedTasks.set(stableTaskId, {
        stableTaskId,
        title: task.title.trim(),
        description: task.description?.trim() || null,
        acceptance: task.acceptance,
      });
    }

    const preparedTasks = [...dedupedTasks.values()].filter(
      (task) => task.title.length > 0,
    );
    if (preparedTasks.length === 0) {
      return [] as DeliveryPlanTask[];
    }

    const taskRows: Array<typeof schema.deliveryPlanTask.$inferInsert> =
      preparedTasks.map((task) => ({
        artifactId,
        loopId,
        stableTaskId: task.stableTaskId,
        title: task.title,
        description: task.description ?? null,
        acceptance: task.acceptance,
        status: "todo",
        createdAt: now,
        updatedAt: now,
      }));

    return await tx
      .insert(schema.deliveryPlanTask)
      .values(taskRows)
      .returning();
  });
}

export async function markPlanTasksCompletedByAgent({
  db,
  loopId,
  artifactId,
  completions,
  now = new Date(),
}: {
  db: DB;
  loopId: string;
  artifactId: string;
  completions: Array<{
    stableTaskId: string;
    status?: Extract<DeliveryPlanTaskStatus, "done" | "skipped" | "blocked">;
    evidence: DeliveryPlanTaskCompletionEvidence;
  }>;
  now?: Date;
}) {
  if (completions.length === 0) {
    return {
      updatedTaskCount: 0,
    };
  }

  let updatedTaskCount = 0;
  for (const completion of completions) {
    const stableTaskId = completion.stableTaskId.trim();
    if (!stableTaskId) {
      continue;
    }
    const nextStatus = completion.status ?? "done";
    const completedAt =
      nextStatus === "done" || nextStatus === "skipped" ? now : null;
    const completedBy: DeliveryPlanTaskCompletedBy | null =
      nextStatus === "done" || nextStatus === "skipped" ? "agent" : null;

    const [updated] = await db
      .update(schema.deliveryPlanTask)
      .set({
        status: nextStatus,
        completedAt,
        completedBy,
        completionEvidence: completion.evidence,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.deliveryPlanTask.loopId, loopId),
          eq(schema.deliveryPlanTask.artifactId, artifactId),
          eq(schema.deliveryPlanTask.stableTaskId, stableTaskId),
        ),
      )
      .returning({ id: schema.deliveryPlanTask.id });
    if (updated) {
      updatedTaskCount += 1;
    }
  }

  return {
    updatedTaskCount,
  };
}

export async function verifyPlanTaskCompletionForHead({
  db,
  loopId,
  artifactId,
}: {
  db: DB;
  loopId: string;
  artifactId: string;
  headSha?: string;
}) {
  const tasks = await db.query.deliveryPlanTask.findMany({
    where: and(
      eq(schema.deliveryPlanTask.loopId, loopId),
      eq(schema.deliveryPlanTask.artifactId, artifactId),
    ),
  });

  const incompleteTasks = tasks.filter((task: DeliveryPlanTask) =>
    isIncompletePlanTaskStatus(task.status),
  );

  const invalidEvidenceTaskIds: string[] = [];
  for (const task of tasks) {
    if (!isNonBlockingTerminalPlanTaskStatus(task.status)) {
      continue;
    }
    if (task.status === "skipped") {
      continue;
    }
    const evidence =
      task.completionEvidence as DeliveryPlanTaskCompletionEvidence | null;
    if (!evidence) {
      invalidEvidenceTaskIds.push(task.stableTaskId);
    }
  }

  return {
    gatePassed:
      tasks.length > 0 &&
      incompleteTasks.length === 0 &&
      invalidEvidenceTaskIds.length === 0,
    totalTasks: tasks.length,
    incompleteTaskIds: incompleteTasks.map(
      (task: DeliveryPlanTask) => task.stableTaskId,
    ),
    invalidEvidenceTaskIds,
  };
}

async function createHeadScopedArtifact({
  db,
  loopId,
  phase,
  artifactType,
  headSha,
  loopVersion,
  payload,
  generatedBy = "system",
  status = "accepted",
  workflowId,
  now = new Date(),
}: {
  db: DB;
  loopId: string;
  phase: DeliveryPhase;
  artifactType: DeliveryArtifactType;
  headSha: string;
  loopVersion: number;
  payload: DeliveryArtifactPayload;
  generatedBy?: DeliveryArtifactGeneratedBy;
  status?: DeliveryArtifactStatus;
  workflowId?: string | null;
  now?: Date;
}) {
  return await db.transaction(async (tx) => {
    await tx
      .update(schema.deliveryPhaseArtifact)
      .set({
        status: "superseded",
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.deliveryPhaseArtifact.loopId, loopId),
          eq(schema.deliveryPhaseArtifact.phase, phase),
          eq(schema.deliveryPhaseArtifact.headSha, headSha),
          inArray(schema.deliveryPhaseArtifact.status, [
            "generated",
            "approved",
            "accepted",
          ]),
        ),
      );

    const [artifact] = await tx
      .insert(schema.deliveryPhaseArtifact)
      .values({
        loopId,
        phase,
        artifactType,
        headSha,
        loopVersion,
        status,
        generatedBy,
        payload,
        workflowId: workflowId ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!artifact) {
      throw new Error("Failed to create delivery phase artifact");
    }

    return artifact;
  });
}

export async function createImplementationArtifact({
  db,
  loopId,
  headSha,
  loopVersion,
  payload,
  generatedBy = "system",
  status = "accepted",
  workflowId,
  now = new Date(),
}: {
  db: DB;
  loopId: string;
  headSha: string;
  loopVersion: number;
  payload: DeliveryImplementationSnapshotPayload;
  generatedBy?: DeliveryArtifactGeneratedBy;
  status?: DeliveryArtifactStatus;
  workflowId?: string | null;
  now?: Date;
}) {
  return await createHeadScopedArtifact({
    db,
    loopId,
    phase: "implementing",
    artifactType: "implementation_snapshot",
    headSha,
    loopVersion,
    payload,
    generatedBy,
    status,
    workflowId,
    now,
  });
}

export async function createReviewBundleArtifact({
  db,
  loopId,
  headSha,
  loopVersion,
  payload,
  generatedBy = "system",
  status = "accepted",
  workflowId,
  now = new Date(),
}: {
  db: DB;
  loopId: string;
  headSha: string;
  loopVersion: number;
  payload: DeliveryReviewBundlePayload;
  generatedBy?: DeliveryArtifactGeneratedBy;
  status?: DeliveryArtifactStatus;
  workflowId?: string | null;
  now?: Date;
}) {
  return await createHeadScopedArtifact({
    db,
    loopId,
    phase: "review_gate",
    artifactType: "review_bundle",
    headSha,
    loopVersion,
    payload,
    generatedBy,
    status,
    workflowId,
    now,
  });
}

export async function createPrLinkArtifact({
  db,
  loopId,
  loopVersion,
  payload,
  generatedBy = "system",
  status = "accepted",
  workflowId,
  now = new Date(),
}: {
  db: DB;
  loopId: string;
  loopVersion: number;
  payload: DeliveryPrLinkPayload;
  generatedBy?: DeliveryArtifactGeneratedBy;
  status?: DeliveryArtifactStatus;
  workflowId?: string | null;
  now?: Date;
}) {
  return await db.transaction(async (tx) => {
    await tx
      .update(schema.deliveryPhaseArtifact)
      .set({
        status: "superseded",
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.deliveryPhaseArtifact.loopId, loopId),
          eq(schema.deliveryPhaseArtifact.phase, "awaiting_pr_link"),
          inArray(schema.deliveryPhaseArtifact.status, [
            "generated",
            "approved",
            "accepted",
          ]),
        ),
      );

    const [artifact] = await tx
      .insert(schema.deliveryPhaseArtifact)
      .values({
        loopId,
        phase: "awaiting_pr_link",
        artifactType: "pr_link",
        headSha: null,
        loopVersion,
        status,
        generatedBy,
        payload,
        workflowId: workflowId ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!artifact) {
      throw new Error("Failed to create delivery PR link artifact");
    }

    return artifact;
  });
}

export async function createBabysitEvaluationArtifact({
  db,
  loopId,
  headSha,
  loopVersion,
  payload,
  generatedBy = "system",
  status = "accepted",
  workflowId,
  now = new Date(),
}: {
  db: DB;
  loopId: string;
  headSha: string;
  loopVersion: number;
  payload: DeliveryBabysitEvaluationPayload;
  generatedBy?: DeliveryArtifactGeneratedBy;
  status?: DeliveryArtifactStatus;
  workflowId?: string | null;
  now?: Date;
}) {
  return await createHeadScopedArtifact({
    db,
    loopId,
    phase: "babysitting",
    artifactType: "babysit_evaluation",
    headSha,
    loopVersion,
    payload,
    generatedBy,
    status,
    workflowId,
    now,
  });
}

export async function getArtifactsForWorkflow(params: {
  db: DB;
  workflowId: string;
  phase?: string;
  status?: string;
}): Promise<DeliveryPhaseArtifact[]> {
  const conditions = [
    eq(schema.deliveryPhaseArtifact.workflowId, params.workflowId),
  ];
  if (params.phase)
    conditions.push(
      eq(schema.deliveryPhaseArtifact.phase, params.phase as any),
    );
  if (params.status)
    conditions.push(
      eq(schema.deliveryPhaseArtifact.status, params.status as any),
    );
  return params.db
    .select()
    .from(schema.deliveryPhaseArtifact)
    .where(and(...conditions))
    .orderBy(desc(schema.deliveryPhaseArtifact.createdAt));
}

export { getPlanArtifactRequiredStatus };
