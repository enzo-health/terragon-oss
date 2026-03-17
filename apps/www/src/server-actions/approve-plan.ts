"use server";

import { userOnlyAction } from "@/lib/auth-server";
import { DBUserMessage } from "@terragon/shared";
import { queueFollowUpInternal } from "@/server-lib/follow-up";
import { getThreadChat } from "@terragon/shared/model/threads";
import { db } from "@/lib/db";
import { UserFacingError } from "@/lib/server-actions";
import { getActiveSdlcLoopForThread } from "@terragon/shared/model/delivery-loop";
import { getActiveWorkflowForThread } from "@terragon/shared/delivery-loop/store/workflow-store";
import { parsePlanSpec } from "@/server-lib/delivery-loop/parse-plan-spec";
import { extractLatestPlanText } from "@/server-lib/checkpoint-thread-internal";
import { promotePlanToImplementing } from "@/server-lib/delivery-loop/promote-plan";

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

    // ── V2 fast-path: prefer delivery_workflow ──
    const v2Row = await getActiveWorkflowForThread({ db, threadId });
    let loopId: string;
    let loopVersion: number;
    let planApprovalPolicy: "auto" | "human_required";

    if (v2Row && v2Row.sdlcLoopId) {
      // Validate v2 state — plan approval only valid in planning or awaiting_plan_approval
      if (
        v2Row.kind !== "planning" &&
        v2Row.kind !== "awaiting_plan_approval"
      ) {
        throw new UserFacingError(
          "Plan can only be approved while the Delivery Loop is in planning phase",
        );
      }
      // Fetch the associated v1 loop for artifact operations
      const { eq } = await import("drizzle-orm");
      const sdlcLoopSchema = await import("@terragon/shared/db/schema");
      const loop = await db.query.sdlcLoop.findFirst({
        where: eq(sdlcLoopSchema.sdlcLoop.id, v2Row.sdlcLoopId),
      });
      if (!loop) {
        throw new UserFacingError(
          "No active Delivery Loop found for this thread",
        );
      }
      loopId = loop.id;
      loopVersion = loop.loopVersion;
      planApprovalPolicy = v2Row.planApprovalPolicy as
        | "auto"
        | "human_required";
    } else {
      // ── V1 fallback ──
      const activeLoop = await getActiveSdlcLoopForThread({
        db,
        userId,
        threadId,
      });
      if (!activeLoop) {
        throw new UserFacingError(
          "No active Delivery Loop found for this thread",
        );
      }
      if (activeLoop.state !== "planning") {
        throw new UserFacingError(
          "Plan can only be approved while the Delivery Loop is in planning phase",
        );
      }
      loopId = activeLoop.id;
      loopVersion = activeLoop.loopVersion;
      planApprovalPolicy = activeLoop.planApprovalPolicy;
    }

    const extracted = extractLatestPlanText(threadChat.messages ?? []);
    if (!extracted) {
      throw new UserFacingError(
        "No plan artifact found. Generate a plan before approval.",
      );
    }

    const parseResult = parsePlanSpec(extracted.text);
    if (!parseResult.ok) {
      console.warn("Plan parse failed", { diagnostic: parseResult.diagnostic });
      throw new UserFacingError(
        "Plan artifact could not be parsed. Please regenerate the plan.",
      );
    }
    const parsedPlan = {
      ...parseResult.plan,
      source: extracted.source,
    };

    const promotionResult = await promotePlanToImplementing({
      db,
      loop: {
        id: loopId,
        loopVersion,
        planApprovalPolicy,
      },
      parsedPlan,
      mode: "approve",
      approvedByUserId: userId,
      threadId,
    });
    if (promotionResult.outcome !== "promoted") {
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
