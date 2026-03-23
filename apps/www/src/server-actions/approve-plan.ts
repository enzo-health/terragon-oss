"use server";

import { userOnlyAction } from "@/lib/auth-server";
import { DBUserMessage } from "@terragon/shared";
import { queueFollowUpInternal } from "@/server-lib/follow-up";
import { getThreadChat } from "@terragon/shared/model/threads";
import { db } from "@/lib/db";
import { UserFacingError } from "@/lib/server-actions";
import { getActiveWorkflowForThread } from "@terragon/shared/delivery-loop/store/workflow-store";
import { getWorkflowHead } from "@/server-lib/delivery-loop/v3/store";
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

    const v2Row = await getActiveWorkflowForThread({ db, threadId });
    if (!v2Row) {
      throw new UserFacingError(
        "No active Delivery Loop found for this thread",
      );
    }

    // Validate state — plan approval only valid in planning
    const v3Head = await getWorkflowHead({ db, workflowId: v2Row.id });
    if (!v3Head) {
      throw new Error(`No v3 head for workflow ${v2Row.id}`);
    }
    const currentState = v3Head.state;
    if (currentState !== "planning") {
      throw new UserFacingError(
        "Plan can only be approved while the Delivery Loop is in planning phase",
      );
    }

    const loopId = v2Row.id;
    const loopVersion = v2Row.version;
    const planApprovalPolicy = v2Row.planApprovalPolicy as
      | "auto"
      | "human_required";

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
