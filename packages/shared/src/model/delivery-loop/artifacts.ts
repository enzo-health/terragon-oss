import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { DB } from "../../db";
import * as schema from "../../db/schema";
import type {
  SdlcPhase,
  SdlcArtifactType,
  SdlcArtifactStatus,
  SdlcArtifactGeneratedBy,
  SdlcPlanApprovalPolicy,
  SdlcPlanSpecPayload,
  SdlcImplementationSnapshotPayload,
  SdlcReviewBundlePayload,
  SdlcUiSmokePayload,
  SdlcPrLinkPayload,
  SdlcBabysitEvaluationPayload,
  SdlcPlanTask,
  SdlcPlanTaskStatus,
  SdlcPlanTaskCompletedBy,
  SdlcPlanTaskCompletionEvidence,
} from "../../db/types";
import type { DeliveryLoopResumableState } from "./types";
import type { SdlcLoopTransitionEvent } from "./state-constants";
import {
  isIncompletePlanTaskStatus,
  isNonBlockingTerminalPlanTaskStatus,
  phaseToLoopPointerColumn,
} from "./state-constants";
import type { SdlcGateLoopUpdateOutcome } from "./guarded-state";
import { persistGuardedGateLoopState } from "./guarded-state";

type SdlcArtifactPayload =
  | SdlcPlanSpecPayload
  | SdlcImplementationSnapshotPayload
  | SdlcReviewBundlePayload
  | SdlcUiSmokePayload
  | SdlcPrLinkPayload
  | SdlcBabysitEvaluationPayload
  | Record<string, unknown>;

function buildLoopArtifactPointerUpdate({
  phase,
  artifactId,
}: {
  phase: SdlcPhase;
  artifactId: string;
}): Partial<typeof schema.sdlcLoop.$inferInsert> {
  const pointer = phaseToLoopPointerColumn[phase];
  if (!pointer) {
    return {};
  }
  return {
    [pointer]: artifactId,
  };
}

function getPlanArtifactRequiredStatus(
  policy: SdlcPlanApprovalPolicy,
): SdlcArtifactStatus {
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
  phase: SdlcPhase;
  headSha?: string | null;
  includeApprovedForPlanning?: boolean;
}) {
  const acceptedStatuses: SdlcArtifactStatus[] =
    includeApprovedForPlanning && phase === "planning"
      ? ["accepted", "approved"]
      : ["accepted"];

  const whereClauses = [
    eq(schema.sdlcPhaseArtifact.loopId, loopId),
    eq(schema.sdlcPhaseArtifact.phase, phase),
    inArray(schema.sdlcPhaseArtifact.status, acceptedStatuses),
  ];
  if (headSha !== undefined) {
    if (headSha === null) {
      whereClauses.push(isNull(schema.sdlcPhaseArtifact.headSha));
    } else {
      whereClauses.push(eq(schema.sdlcPhaseArtifact.headSha, headSha));
    }
  }

  return await db.query.sdlcPhaseArtifact.findFirst({
    where: and(...whereClauses),
    orderBy: [
      desc(schema.sdlcPhaseArtifact.createdAt),
      desc(schema.sdlcPhaseArtifact.id),
    ],
  });
}

export async function createPlanArtifactForLoop({
  db,
  loopId,
  loopVersion,
  payload,
  generatedBy = "agent",
  status = "generated",
  now = new Date(),
}: {
  db: DB;
  loopId: string;
  loopVersion: number;
  payload: SdlcPlanSpecPayload;
  generatedBy?: SdlcArtifactGeneratedBy;
  status?: SdlcArtifactStatus;
  now?: Date;
}) {
  return await db.transaction(async (tx) => {
    await tx
      .update(schema.sdlcPhaseArtifact)
      .set({
        status: "superseded",
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.sdlcPhaseArtifact.loopId, loopId),
          eq(schema.sdlcPhaseArtifact.phase, "planning"),
          inArray(schema.sdlcPhaseArtifact.status, [
            "generated",
            "approved",
            "accepted",
          ]),
        ),
      );

    const [artifact] = await tx
      .insert(schema.sdlcPhaseArtifact)
      .values({
        loopId,
        phase: "planning",
        artifactType: "plan_spec",
        headSha: null,
        loopVersion,
        status,
        generatedBy,
        payload,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    if (!artifact) {
      throw new Error("Failed to create SDLC plan artifact");
    }

    await tx
      .update(schema.sdlcLoop)
      .set({
        ...buildLoopArtifactPointerUpdate({
          phase: "planning",
          artifactId: artifact.id,
        }),
        updatedAt: now,
      })
      .where(eq(schema.sdlcLoop.id, loopId));

    return artifact;
  });
}

export async function approvePlanArtifactForLoop({
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
    .update(schema.sdlcPhaseArtifact)
    .set({
      status: "approved",
      approvedByUserId,
      approvedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.sdlcPhaseArtifact.id, artifactId),
        eq(schema.sdlcPhaseArtifact.loopId, loopId),
        eq(schema.sdlcPhaseArtifact.phase, "planning"),
        eq(schema.sdlcPhaseArtifact.artifactType, "plan_spec"),
        inArray(schema.sdlcPhaseArtifact.status, ["generated", "accepted"]),
      ),
    )
    .returning();

  if (!artifact) {
    return undefined;
  }

  await db
    .update(schema.sdlcLoop)
    .set({
      activePlanArtifactId: artifact.id,
      updatedAt: now,
    })
    .where(eq(schema.sdlcLoop.id, loopId));

  return artifact;
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
    const artifact = await tx.query.sdlcPhaseArtifact.findFirst({
      where: and(
        eq(schema.sdlcPhaseArtifact.id, artifactId),
        eq(schema.sdlcPhaseArtifact.loopId, loopId),
        eq(schema.sdlcPhaseArtifact.phase, "planning"),
        eq(schema.sdlcPhaseArtifact.artifactType, "plan_spec"),
      ),
    });
    if (!artifact) {
      throw new Error("Plan artifact not found for loop");
    }

    await tx
      .delete(schema.sdlcPlanTask)
      .where(eq(schema.sdlcPlanTask.artifactId, artifactId));

    if (tasks.length === 0) {
      return [] as SdlcPlanTask[];
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
      return [] as SdlcPlanTask[];
    }

    const taskRows: Array<typeof schema.sdlcPlanTask.$inferInsert> =
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

    return await tx.insert(schema.sdlcPlanTask).values(taskRows).returning();
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
    status?: Extract<SdlcPlanTaskStatus, "done" | "skipped" | "blocked">;
    evidence: SdlcPlanTaskCompletionEvidence;
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
    const completedBy: SdlcPlanTaskCompletedBy | null =
      nextStatus === "done" || nextStatus === "skipped" ? "agent" : null;

    const [updated] = await db
      .update(schema.sdlcPlanTask)
      .set({
        status: nextStatus,
        completedAt,
        completedBy,
        completionEvidence: completion.evidence,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.sdlcPlanTask.loopId, loopId),
          eq(schema.sdlcPlanTask.artifactId, artifactId),
          eq(schema.sdlcPlanTask.stableTaskId, stableTaskId),
        ),
      )
      .returning({ id: schema.sdlcPlanTask.id });
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
  headSha,
}: {
  db: DB;
  loopId: string;
  artifactId: string;
  headSha: string;
}) {
  const tasks = await db.query.sdlcPlanTask.findMany({
    where: and(
      eq(schema.sdlcPlanTask.loopId, loopId),
      eq(schema.sdlcPlanTask.artifactId, artifactId),
    ),
  });

  const incompleteTasks = tasks.filter((task) =>
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
      task.completionEvidence as SdlcPlanTaskCompletionEvidence | null;
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
    incompleteTaskIds: incompleteTasks.map((task) => task.stableTaskId),
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
  now = new Date(),
}: {
  db: DB;
  loopId: string;
  phase: SdlcPhase;
  artifactType: SdlcArtifactType;
  headSha: string;
  loopVersion: number;
  payload: SdlcArtifactPayload;
  generatedBy?: SdlcArtifactGeneratedBy;
  status?: SdlcArtifactStatus;
  now?: Date;
}) {
  return await db.transaction(async (tx) => {
    await tx
      .update(schema.sdlcPhaseArtifact)
      .set({
        status: "superseded",
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.sdlcPhaseArtifact.loopId, loopId),
          eq(schema.sdlcPhaseArtifact.phase, phase),
          eq(schema.sdlcPhaseArtifact.headSha, headSha),
          inArray(schema.sdlcPhaseArtifact.status, [
            "generated",
            "approved",
            "accepted",
          ]),
        ),
      );

    const [artifact] = await tx
      .insert(schema.sdlcPhaseArtifact)
      .values({
        loopId,
        phase,
        artifactType,
        headSha,
        loopVersion,
        status,
        generatedBy,
        payload,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!artifact) {
      throw new Error("Failed to create SDLC phase artifact");
    }

    await tx
      .update(schema.sdlcLoop)
      .set({
        ...buildLoopArtifactPointerUpdate({
          phase,
          artifactId: artifact.id,
        }),
        updatedAt: now,
      })
      .where(eq(schema.sdlcLoop.id, loopId));

    return artifact;
  });
}

export async function createImplementationArtifactForHead({
  db,
  loopId,
  headSha,
  loopVersion,
  payload,
  generatedBy = "system",
  status = "accepted",
  now = new Date(),
}: {
  db: DB;
  loopId: string;
  headSha: string;
  loopVersion: number;
  payload: SdlcImplementationSnapshotPayload;
  generatedBy?: SdlcArtifactGeneratedBy;
  status?: SdlcArtifactStatus;
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
    now,
  });
}

export async function createReviewBundleArtifactForHead({
  db,
  loopId,
  headSha,
  loopVersion,
  payload,
  generatedBy = "system",
  status = "accepted",
  now = new Date(),
}: {
  db: DB;
  loopId: string;
  headSha: string;
  loopVersion: number;
  payload: SdlcReviewBundlePayload;
  generatedBy?: SdlcArtifactGeneratedBy;
  status?: SdlcArtifactStatus;
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
    now,
  });
}

export async function createUiSmokeArtifactForHead({
  db,
  loopId,
  headSha,
  loopVersion,
  payload,
  generatedBy = "system",
  status = "accepted",
  now = new Date(),
}: {
  db: DB;
  loopId: string;
  headSha: string;
  loopVersion: number;
  payload: SdlcUiSmokePayload;
  generatedBy?: SdlcArtifactGeneratedBy;
  status?: SdlcArtifactStatus;
  now?: Date;
}) {
  return await createHeadScopedArtifact({
    db,
    loopId,
    phase: "ui_gate",
    artifactType: "ui_smoke_result",
    headSha,
    loopVersion,
    payload,
    generatedBy,
    status,
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
  now = new Date(),
}: {
  db: DB;
  loopId: string;
  loopVersion: number;
  payload: SdlcPrLinkPayload;
  generatedBy?: SdlcArtifactGeneratedBy;
  status?: SdlcArtifactStatus;
  now?: Date;
}) {
  return await db.transaction(async (tx) => {
    await tx
      .update(schema.sdlcPhaseArtifact)
      .set({
        status: "superseded",
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.sdlcPhaseArtifact.loopId, loopId),
          eq(schema.sdlcPhaseArtifact.phase, "awaiting_pr_link"),
          inArray(schema.sdlcPhaseArtifact.status, [
            "generated",
            "approved",
            "accepted",
          ]),
        ),
      );

    const [artifact] = await tx
      .insert(schema.sdlcPhaseArtifact)
      .values({
        loopId,
        phase: "awaiting_pr_link",
        artifactType: "pr_link",
        headSha: null,
        loopVersion,
        status,
        generatedBy,
        payload,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!artifact) {
      throw new Error("Failed to create SDLC PR link artifact");
    }

    return artifact;
  });
}

export async function createBabysitEvaluationArtifactForHead({
  db,
  loopId,
  headSha,
  loopVersion,
  payload,
  generatedBy = "system",
  status = "accepted",
  now = new Date(),
}: {
  db: DB;
  loopId: string;
  headSha: string;
  loopVersion: number;
  payload: SdlcBabysitEvaluationPayload;
  generatedBy?: SdlcArtifactGeneratedBy;
  status?: SdlcArtifactStatus;
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
    now,
  });
}

export type SdlcTransitionWithArtifactOutcome =
  | SdlcGateLoopUpdateOutcome
  | "artifact_not_found"
  | "artifact_gate_failed";

export async function transitionSdlcLoopStateWithArtifact({
  db,
  loopId,
  artifactId,
  transitionEvent,
  headSha,
  loopVersion,
  expectedPhase,
  blockedFromState,
  now = new Date(),
}: {
  db: DB;
  loopId: string;
  artifactId: string;
  transitionEvent: SdlcLoopTransitionEvent;
  headSha?: string | null;
  loopVersion?: number;
  expectedPhase: SdlcPhase;
  blockedFromState?: DeliveryLoopResumableState | null;
  now?: Date;
}): Promise<SdlcTransitionWithArtifactOutcome> {
  return await db.transaction(async (tx) => {
    const [loop, artifact] = await Promise.all([
      tx.query.sdlcLoop.findFirst({
        where: eq(schema.sdlcLoop.id, loopId),
      }),
      tx.query.sdlcPhaseArtifact.findFirst({
        where: and(
          eq(schema.sdlcPhaseArtifact.id, artifactId),
          eq(schema.sdlcPhaseArtifact.loopId, loopId),
          eq(schema.sdlcPhaseArtifact.phase, expectedPhase),
        ),
      }),
    ]);

    if (!loop || !artifact) {
      return "artifact_not_found";
    }

    const requiredStatus =
      transitionEvent === "plan_completed"
        ? getPlanArtifactRequiredStatus(loop.planApprovalPolicy)
        : "accepted";
    if (artifact.status !== requiredStatus) {
      return "artifact_gate_failed";
    }

    if (headSha !== undefined) {
      if (headSha === null) {
        if (artifact.headSha !== null) {
          return "artifact_gate_failed";
        }
      } else if (artifact.headSha !== headSha) {
        return "artifact_gate_failed";
      }
    }

    if (
      loopVersion !== undefined &&
      Number.isFinite(loopVersion) &&
      artifact.loopVersion > loopVersion
    ) {
      return "artifact_gate_failed";
    }

    const transitionResult = await persistGuardedGateLoopState({
      tx,
      loopId,
      transitionEvent,
      headSha,
      loopVersion,
      blockedFromState,
      now,
    });
    if (transitionResult !== "updated") {
      return transitionResult;
    }

    const loopPointerUpdate = buildLoopArtifactPointerUpdate({
      phase: expectedPhase,
      artifactId: artifact.id,
    });
    if (Object.keys(loopPointerUpdate).length > 0) {
      await tx
        .update(schema.sdlcLoop)
        .set({
          ...loopPointerUpdate,
          updatedAt: now,
        })
        .where(eq(schema.sdlcLoop.id, loopId));
    }

    return transitionResult;
  });
}
