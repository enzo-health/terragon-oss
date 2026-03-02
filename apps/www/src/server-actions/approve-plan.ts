"use server";

import { userOnlyAction } from "@/lib/auth-server";
import { DBUserMessage } from "@terragon/shared";
import { queueFollowUpInternal } from "@/server-lib/follow-up";
import { getThreadChat } from "@terragon/shared/model/threads";
import { db } from "@/lib/db";
import { UserFacingError } from "@/lib/server-actions";
import {
  approvePlanArtifactForLoop,
  createPlanArtifactForLoop,
  getActiveSdlcLoopForThread,
  replacePlanTasksForArtifact,
  transitionSdlcLoopStateWithArtifact,
} from "@terragon/shared/model/sdlc-loop";
import { parsePlanSpec } from "@/server-lib/sdlc-loop/parse-plan-spec";
import { extractLatestPlanText } from "@/server-lib/checkpoint-thread-internal";

export const approvePlan = userOnlyAction(
  async function approvePlan(
    userId: string,
    {
      threadId,
      threadChatId,
    }: {
      threadId: string;
      threadChatId: string;
    },
  ) {
    console.log("approvePlan", { threadId, threadChatId });
    const threadChat = await getThreadChat({
      db,
      threadId,
      userId,
      threadChatId,
    });
    if (!threadChat) {
      throw new UserFacingError("Task not found");
    }
    const activeLoop = await getActiveSdlcLoopForThread({
      db,
      userId,
      threadId,
    });
    if (!activeLoop) {
      throw new UserFacingError("No active SDLC loop found for this thread");
    }
    if (activeLoop.state !== "planning") {
      throw new UserFacingError(
        "Plan can only be approved while the SDLC loop is in planning phase",
      );
    }

    const extracted = extractLatestPlanText(threadChat.messages ?? []);
    if (!extracted) {
      throw new UserFacingError(
        "No plan artifact found. Generate a plan before approval.",
      );
    }

    const parseResult = parsePlanSpec(extracted.text);
    if (!parseResult.ok) {
      throw new UserFacingError(
        `Plan artifact is invalid: ${parseResult.diagnostic}`,
      );
    }
    const parsedPlan = parseResult.plan;

    const artifactStatus =
      activeLoop.planApprovalPolicy === "human_required"
        ? "generated"
        : "accepted";
    const nextLoopVersion =
      typeof activeLoop.loopVersion === "number" &&
      Number.isFinite(activeLoop.loopVersion)
        ? Math.max(activeLoop.loopVersion, 0) + 1
        : 1;
    const planArtifact = await createPlanArtifactForLoop({
      db,
      loopId: activeLoop.id,
      loopVersion: nextLoopVersion,
      status: artifactStatus,
      generatedBy: "agent",
      payload: {
        planText: parsedPlan.planText,
        tasks: parsedPlan.tasks,
        source: "system",
      },
    });
    await replacePlanTasksForArtifact({
      db,
      loopId: activeLoop.id,
      artifactId: planArtifact.id,
      tasks: parsedPlan.tasks,
    });

    let approvedArtifact = planArtifact;
    if (activeLoop.planApprovalPolicy === "human_required") {
      const maybeApproved = await approvePlanArtifactForLoop({
        db,
        loopId: activeLoop.id,
        artifactId: planArtifact.id,
        approvedByUserId: userId,
      });
      if (!maybeApproved) {
        throw new UserFacingError(
          "Failed to approve plan artifact for this SDLC loop",
        );
      }
      approvedArtifact = maybeApproved;
    }

    const transitionOutcome = await transitionSdlcLoopStateWithArtifact({
      db,
      loopId: activeLoop.id,
      artifactId: approvedArtifact.id,
      expectedPhase: "planning",
      transitionEvent: "plan_completed",
      loopVersion: nextLoopVersion,
    });
    if (transitionOutcome !== "updated") {
      throw new UserFacingError(
        "Plan approval gate failed. Refresh and try approving again.",
      );
    }

    const message: DBUserMessage = {
      type: "user",
      model: null,
      parts: [{ type: "text", text: "Please proceed with the plan" }],
      permissionMode: "allowAll",
    };
    await queueFollowUpInternal({
      userId,
      threadId,
      threadChatId,
      messages: [message],
      source: "www",
      appendOrReplace: "append",
    });
  },
  { defaultErrorMessage: "Failed to approve plan" },
);
