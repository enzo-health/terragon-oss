import { getDaemonTokenAuthContextOrNull } from "@/lib/auth-server";
import { db } from "@/lib/db";
import { z } from "zod";
import {
  getLatestAcceptedArtifact,
  markPlanTasksCompletedByAgent,
} from "@terragon/shared/delivery-loop/store/artifact-store";
import type { DeliveryPlanTaskCompletionEvidence } from "@terragon/shared/db/types";
import { getActiveWorkflowForThread } from "@/server-lib/delivery-loop/v3/store";

const completedTaskSchema = z.object({
  stableTaskId: z.string().min(1),
  status: z.enum(["done", "skipped", "blocked"]).optional(),
  note: z.string().nullable().optional(),
});

const markTasksRequestSchema = z.object({
  threadId: z.string().min(1),
  threadChatId: z.string().min(1),
  headSha: z.string().nullable().optional(),
  completedTasks: z.array(completedTaskSchema).min(1),
});

export async function POST(request: Request) {
  const authContext = await getDaemonTokenAuthContextOrNull(request);
  if (!authContext || !authContext.claims) {
    return new Response("Unauthorized", { status: 401 });
  }

  const parsedBody = markTasksRequestSchema.safeParse(await request.json());
  if (!parsedBody.success) {
    return Response.json(
      { success: false, error: "missing_required_fields" },
      { status: 400 },
    );
  }
  const { threadId, threadChatId, headSha, completedTasks } = parsedBody.data;

  if (
    authContext.claims.threadId !== threadId ||
    authContext.claims.threadChatId !== threadChatId
  ) {
    return Response.json(
      { success: false, error: "token_thread_mismatch" },
      { status: 403 },
    );
  }

  const activeWorkflow = await getActiveWorkflowForThread({ db, threadId });
  if (!activeWorkflow) {
    return Response.json(
      { success: false, error: "no_active_loop" },
      { status: 404 },
    );
  }
  const loopId = activeWorkflow.workflow.id;

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
