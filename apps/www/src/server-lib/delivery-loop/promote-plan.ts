import type { DB } from "@terragon/shared/db";
import * as schema from "@terragon/shared/db/schema";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  approvePlanArtifactForLoop,
  createPlanArtifactForLoop,
  replacePlanTasksForArtifact,
  transitionSdlcLoopStateWithArtifact,
  type SdlcTransitionWithArtifactOutcome,
} from "@terragon/shared/model/delivery-loop";
import type { ParsedPlanSpec } from "./parse-plan-spec";

type PlanningLoopContext = {
  id: string;
  loopVersion: number;
  planApprovalPolicy: "auto" | "human_required";
};

type PromotePlanMode = "checkpoint" | "approve";
type PlanSpecSource = "exit_plan_mode" | "write_tool" | "agent_text" | "system";

export type PromotePlanToImplementingResult =
  | {
      outcome: "awaiting_human_approval";
      artifactId: string;
      loopVersion: number;
    }
  | {
      outcome: "promoted";
      artifactId: string;
      loopVersion: number;
    }
  | {
      outcome: "promotion_blocked";
      artifactId: string;
      loopVersion: number;
      transitionOutcome: SdlcTransitionWithArtifactOutcome;
    };

function nextLoopVersion(loopVersion: number): number {
  return Number.isFinite(loopVersion) ? Math.max(loopVersion, 0) + 1 : 1;
}

function getPlanSourceFromParsedPlan(
  parsedPlan: ParsedPlanSpec & { source?: unknown },
): PlanSpecSource {
  if (
    parsedPlan.source === "exit_plan_mode" ||
    parsedPlan.source === "write_tool" ||
    parsedPlan.source === "agent_text" ||
    parsedPlan.source === "system"
  ) {
    return parsedPlan.source;
  }
  return "system";
}

function normalizePlanTaskForComparison(task: {
  stableTaskId: string;
  title: string;
  description: string | null;
  acceptance: string[];
}) {
  return {
    stableTaskId: task.stableTaskId.trim(),
    title: task.title.trim(),
    description:
      typeof task.description === "string" && task.description.trim().length > 0
        ? task.description.trim()
        : null,
    acceptance: task.acceptance
      .map((criterion) => criterion.trim())
      .filter((criterion) => criterion.length > 0),
  };
}

function buildPlanComparisonKey(parsedPlan: ParsedPlanSpec): string {
  return JSON.stringify({
    planText: parsedPlan.planText.trim(),
    tasks: parsedPlan.tasks.map(normalizePlanTaskForComparison),
  });
}

function toComparablePlanTask(
  task: unknown,
): ParsedPlanSpec["tasks"][number] | null {
  if (!task || typeof task !== "object") {
    return null;
  }
  const typedTask = task as {
    stableTaskId?: unknown;
    title?: unknown;
    description?: unknown;
    acceptance?: unknown;
  };
  if (
    typeof typedTask.stableTaskId !== "string" ||
    typedTask.stableTaskId.trim().length === 0 ||
    typeof typedTask.title !== "string" ||
    typedTask.title.trim().length === 0
  ) {
    return null;
  }

  const acceptance = Array.isArray(typedTask.acceptance)
    ? typedTask.acceptance
        .filter(
          (criterion): criterion is string =>
            typeof criterion === "string" && criterion.trim().length > 0,
        )
        .map((criterion) => criterion.trim())
    : [];

  return {
    stableTaskId: typedTask.stableTaskId.trim(),
    title: typedTask.title.trim(),
    description:
      typeof typedTask.description === "string" &&
      typedTask.description.trim().length > 0
        ? typedTask.description.trim()
        : null,
    acceptance,
  };
}

function buildPlanComparisonKeyFromArtifactPayload(
  payload: unknown,
): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const typedPayload = payload as {
    planText?: unknown;
    tasks?: unknown;
  };
  if (
    typeof typedPayload.planText !== "string" ||
    !Array.isArray(typedPayload.tasks)
  ) {
    return null;
  }

  const normalizedTasks: ParsedPlanSpec["tasks"] = [];
  for (const task of typedPayload.tasks) {
    const normalizedTask = toComparablePlanTask(task);
    if (!normalizedTask) {
      return null;
    }
    normalizedTasks.push(normalizedTask);
  }

  return buildPlanComparisonKey({
    planText: typedPayload.planText,
    tasks: normalizedTasks,
  });
}

async function transitionPlanningArtifactToImplementing(params: {
  db: DB;
  loopId: string;
  artifactId: string;
  loopVersion: number;
}): Promise<PromotePlanToImplementingResult> {
  const transitionOutcome = await transitionSdlcLoopStateWithArtifact({
    db: params.db,
    loopId: params.loopId,
    artifactId: params.artifactId,
    expectedPhase: "planning",
    transitionEvent: "plan_completed",
    loopVersion: params.loopVersion,
  });

  if (transitionOutcome !== "updated") {
    return {
      outcome: "promotion_blocked",
      artifactId: params.artifactId,
      loopVersion: params.loopVersion,
      transitionOutcome,
    };
  }

  return {
    outcome: "promoted",
    artifactId: params.artifactId,
    loopVersion: params.loopVersion,
  };
}

async function createPlanningArtifactFromParsedPlan(params: {
  db: DB;
  loopId: string;
  loopVersion: number;
  parsedPlan: ParsedPlanSpec & { source?: PlanSpecSource };
  status: "generated" | "accepted";
}) {
  const planArtifact = await createPlanArtifactForLoop({
    db: params.db,
    loopId: params.loopId,
    loopVersion: params.loopVersion,
    status: params.status,
    generatedBy: "agent",
    payload: {
      planText: params.parsedPlan.planText,
      tasks: params.parsedPlan.tasks,
      source: getPlanSourceFromParsedPlan(params.parsedPlan),
    },
  });

  await replacePlanTasksForArtifact({
    db: params.db,
    loopId: params.loopId,
    artifactId: planArtifact.id,
    tasks: params.parsedPlan.tasks,
  });

  return planArtifact;
}

async function getPromotablePlanningArtifacts(params: {
  db: DB;
  loopId: string;
}) {
  return await params.db.query.sdlcPhaseArtifact.findMany({
    where: and(
      eq(schema.sdlcPhaseArtifact.loopId, params.loopId),
      eq(schema.sdlcPhaseArtifact.phase, "planning"),
      eq(schema.sdlcPhaseArtifact.artifactType, "plan_spec"),
      inArray(schema.sdlcPhaseArtifact.status, [
        "generated",
        "accepted",
        "approved",
      ]),
    ),
    orderBy: [
      desc(schema.sdlcPhaseArtifact.loopVersion),
      desc(schema.sdlcPhaseArtifact.updatedAt),
      desc(schema.sdlcPhaseArtifact.createdAt),
      desc(schema.sdlcPhaseArtifact.id),
    ],
  });
}

type PromotablePlanningArtifact = Awaited<
  ReturnType<typeof getPromotablePlanningArtifacts>
>[number];

function selectPromotablePlanningArtifact(params: {
  artifacts: PromotablePlanningArtifact[];
  parsedPlan: ParsedPlanSpec;
}): PromotablePlanningArtifact | null {
  if (params.artifacts.length === 0) {
    return null;
  }

  const parsedPlanKey = buildPlanComparisonKey(params.parsedPlan);
  const matchingArtifacts = params.artifacts.filter((artifact) => {
    const artifactPlanKey = buildPlanComparisonKeyFromArtifactPayload(
      artifact.payload,
    );
    return artifactPlanKey !== null && artifactPlanKey === parsedPlanKey;
  });

  const matchingApprovedArtifact = matchingArtifacts.find(
    (artifact) => artifact.status === "approved",
  );
  if (matchingApprovedArtifact) {
    return matchingApprovedArtifact;
  }

  if (matchingArtifacts.length > 0) {
    return matchingArtifacts[0] ?? null;
  }

  return null;
}

function selectFallbackApprovedArtifact(params: {
  artifacts: PromotablePlanningArtifact[];
  expectedArtifactId: string;
  parsedPlan: ParsedPlanSpec;
}): PromotablePlanningArtifact | null {
  const sameArtifact = params.artifacts.find(
    (artifact) =>
      artifact.status === "approved" &&
      artifact.artifactType === "plan_spec" &&
      artifact.id === params.expectedArtifactId,
  );
  if (sameArtifact) {
    return sameArtifact;
  }

  const parsedPlanKey = buildPlanComparisonKey(params.parsedPlan);
  return (
    params.artifacts.find((artifact) => {
      if (
        artifact.status !== "approved" ||
        artifact.artifactType !== "plan_spec"
      ) {
        return false;
      }
      const artifactPlanKey = buildPlanComparisonKeyFromArtifactPayload(
        artifact.payload,
      );
      return artifactPlanKey !== null && artifactPlanKey === parsedPlanKey;
    }) ?? null
  );
}

export async function promotePlanToImplementing(params: {
  db: DB;
  loop: PlanningLoopContext;
  parsedPlan: ParsedPlanSpec & { source?: PlanSpecSource };
  mode: PromotePlanMode;
  approvedByUserId?: string;
}): Promise<PromotePlanToImplementingResult> {
  if (params.mode === "checkpoint") {
    const loopVersion = nextLoopVersion(params.loop.loopVersion);
    const artifactStatus =
      params.loop.planApprovalPolicy === "human_required"
        ? "generated"
        : "accepted";
    const planArtifact = await createPlanningArtifactFromParsedPlan({
      db: params.db,
      loopId: params.loop.id,
      loopVersion,
      parsedPlan: params.parsedPlan,
      status: artifactStatus,
    });

    if (params.loop.planApprovalPolicy === "human_required") {
      return {
        outcome: "awaiting_human_approval",
        artifactId: planArtifact.id,
        loopVersion,
      };
    }

    return await transitionPlanningArtifactToImplementing({
      db: params.db,
      loopId: params.loop.id,
      artifactId: planArtifact.id,
      loopVersion,
    });
  }

  if (params.loop.planApprovalPolicy === "human_required") {
    const promotableArtifacts = await getPromotablePlanningArtifacts({
      db: params.db,
      loopId: params.loop.id,
    });
    let artifact = selectPromotablePlanningArtifact({
      artifacts: promotableArtifacts,
      parsedPlan: params.parsedPlan,
    });

    if (!artifact) {
      const created = await createPlanningArtifactFromParsedPlan({
        db: params.db,
        loopId: params.loop.id,
        loopVersion: nextLoopVersion(params.loop.loopVersion),
        parsedPlan: params.parsedPlan,
        status: "generated",
      });
      artifact = created;
    }

    let artifactId = artifact.id;
    let loopVersion =
      typeof artifact.loopVersion === "number"
        ? artifact.loopVersion
        : nextLoopVersion(params.loop.loopVersion);

    if (artifact.status !== "approved") {
      if (!params.approvedByUserId) {
        throw new Error(
          "approve mode requires approvedByUserId for human_required loops",
        );
      }
      const approvedArtifact = await approvePlanArtifactForLoop({
        db: params.db,
        loopId: params.loop.id,
        artifactId: artifact.id,
        approvedByUserId: params.approvedByUserId,
      });
      if (!approvedArtifact) {
        const refreshedPromotableArtifacts =
          await getPromotablePlanningArtifacts({
            db: params.db,
            loopId: params.loop.id,
          });
        const fallbackApprovedArtifact = selectFallbackApprovedArtifact({
          artifacts: refreshedPromotableArtifacts,
          expectedArtifactId: artifact.id,
          parsedPlan: params.parsedPlan,
        });
        if (!fallbackApprovedArtifact) {
          throw new Error("Failed to approve plan artifact before promotion");
        }
        artifactId = fallbackApprovedArtifact.id;
        loopVersion =
          typeof fallbackApprovedArtifact.loopVersion === "number"
            ? fallbackApprovedArtifact.loopVersion
            : loopVersion;
      } else {
        artifactId = approvedArtifact.id;
        loopVersion =
          typeof approvedArtifact.loopVersion === "number"
            ? approvedArtifact.loopVersion
            : loopVersion;
      }
    }

    return await transitionPlanningArtifactToImplementing({
      db: params.db,
      loopId: params.loop.id,
      artifactId,
      loopVersion,
    });
  }

  const loopVersion = nextLoopVersion(params.loop.loopVersion);
  const planArtifact = await createPlanningArtifactFromParsedPlan({
    db: params.db,
    loopId: params.loop.id,
    loopVersion,
    parsedPlan: params.parsedPlan,
    status: "accepted",
  });

  return await transitionPlanningArtifactToImplementing({
    db: params.db,
    loopId: params.loop.id,
    artifactId: planArtifact.id,
    loopVersion,
  });
}
