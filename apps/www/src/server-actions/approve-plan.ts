"use server";

import { userOnlyAction } from "@/lib/auth-server";
import { DBUserMessage } from "@terragon/shared";
import { queueFollowUpInternal } from "@/server-lib/follow-up";
import { getThreadChat } from "@terragon/shared/model/threads";
import { db } from "@/lib/db";
import { UserFacingError } from "@/lib/server-actions";
import { getActiveSdlcLoopForThread } from "@terragon/shared/model/delivery-loop";
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
        id: activeLoop.id,
        loopVersion: activeLoop.loopVersion,
        planApprovalPolicy: activeLoop.planApprovalPolicy,
      },
      parsedPlan,
      mode: "approve",
      approvedByUserId: userId,
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
