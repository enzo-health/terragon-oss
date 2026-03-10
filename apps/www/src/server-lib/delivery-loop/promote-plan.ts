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
  parsedPlan: ParsedPlanSpec;
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
      source: "system",
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

async function getLatestPromotablePlanningArtifact(params: {
  db: DB;
  loopId: string;
}) {
  return await params.db.query.sdlcPhaseArtifact.findFirst({
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
      desc(schema.sdlcPhaseArtifact.createdAt),
      desc(schema.sdlcPhaseArtifact.id),
    ],
  });
}

export async function promotePlanToImplementing(params: {
  db: DB;
  loop: PlanningLoopContext;
  parsedPlan: ParsedPlanSpec;
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
    let artifact = await getLatestPromotablePlanningArtifact({
      db: params.db,
      loopId: params.loop.id,
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
        throw new Error("Failed to approve plan artifact before promotion");
      }
      artifactId = approvedArtifact.id;
      loopVersion =
        typeof approvedArtifact.loopVersion === "number"
          ? approvedArtifact.loopVersion
          : loopVersion;
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
