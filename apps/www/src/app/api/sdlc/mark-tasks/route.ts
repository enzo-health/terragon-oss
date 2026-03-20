import { getDaemonTokenAuthContextOrNull } from "@/lib/auth-server";
import { db } from "@/lib/db";
import {
  getLatestAcceptedArtifact,
  markPlanTasksCompletedByAgent,
} from "@terragon/shared/delivery-loop/store/artifact-store";
import { getActiveWorkflowForThread } from "@terragon/shared/delivery-loop/store/workflow-store";
import type { DeliveryPlanTaskCompletionEvidence } from "@terragon/shared/db/types";

export async function POST(request: Request) {
  const authContext = await getDaemonTokenAuthContextOrNull(request);
  if (!authContext) {
    return new Response("Unauthorized", { status: 401 });
  }

  const body = await request.json();
  const { threadId, threadChatId, headSha, completedTasks } = body as {
    threadId?: string;
    threadChatId?: string;
    headSha?: string | null;
    completedTasks?: Array<{
      stableTaskId: string;
      status?: "done" | "skipped" | "blocked";
      note?: string | null;
    }>;
  };

  if (
    !threadId ||
    !threadChatId ||
    !Array.isArray(completedTasks) ||
    completedTasks.length === 0
  ) {
    return Response.json(
      { success: false, error: "missing_required_fields" },
      { status: 400 },
    );
  }

  const v2Row = await getActiveWorkflowForThread({ db, threadId });
  if (!v2Row) {
    return Response.json(
      { success: false, error: "no_active_loop" },
      { status: 404 },
    );
  }
  const loopId = v2Row.id;

  const acceptedPlanArtifact = await getLatestAcceptedArtifact({
    db,
    loopId,
    phase: "planning",
    includeApprovedForPlanning: true,
  });

  if (!acceptedPlanArtifact) {
    return Response.json(
      { success: false, error: "no_accepted_plan" },
      { status: 404 },
    );
  }

  const result = await markPlanTasksCompletedByAgent({
    db,
    loopId,
    artifactId: acceptedPlanArtifact.id,
    completions: completedTasks.map((t) => ({
      stableTaskId: t.stableTaskId,
      status: t.status ?? "done",
      evidence: {
        headSha: headSha ?? "",
        note: t.note ?? null,
      } satisfies DeliveryPlanTaskCompletionEvidence,
    })),
  });

  return Response.json({
    success: true,
    updatedTaskCount: result.updatedTaskCount,
  });
}
