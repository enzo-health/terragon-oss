"use server";

import { userOnlyAction } from "@/lib/auth-server";
import { db } from "@/lib/db";
import { UserFacingError } from "@/lib/server-actions";
import { queueFollowUpInternal } from "@/server-lib/follow-up";
import { DBUserMessage } from "@terragon/shared";
import { handleHumanAction } from "@/server-lib/delivery-loop/adapters/ingress/human-interventions";
import { getActiveWorkflowForThread } from "@/server-lib/delivery-loop/v3/store";
import type { WorkflowId } from "@terragon/shared/delivery-loop/domain/workflow";
import { getThreadWithUserPermissions } from "@/server-actions/get-thread";
import * as schema from "@terragon/shared/db/schema";
import { eq } from "drizzle-orm";

function buildResumeFollowUpMessage(): DBUserMessage {
  return {
    type: "user",
    model: null,
    permissionMode: "allowAll",
    parts: [
      {
        type: "text",
        text: "Resume implementation and continue with the Delivery Loop.",
      },
    ],
  };
}

export const requestDeliveryLoopResumeFromBlocked = userOnlyAction(
  async function requestDeliveryLoopResumeFromBlocked(
    userId: string,
    {
      threadId,
      threadChatId,
    }: { threadId: string; threadChatId: string | null },
  ) {
    const thread = await db.query.thread.findFirst({
      columns: {
        id: true,
        userId: true,
      },
      where: eq(schema.thread.id, threadId),
    });
    if (!thread) {
      throw new UserFacingError("Unauthorized");
    }

    if (thread.userId !== userId) {
      const threadWithPermissions = await getThreadWithUserPermissions({
        userId,
        threadId,
      });
      if (!threadWithPermissions) {
        throw new UserFacingError("Unauthorized");
      }
    }

    const activeWorkflow = await getActiveWorkflowForThread({ db, threadId });
    if (!activeWorkflow) {
      throw new UserFacingError(
        "No active Delivery Loop found for this thread",
      );
    }

    const { workflow: v2Row, head: v3Head } = activeWorkflow;
    const currentState = v3Head.state;
    const blockedStates = new Set([
      "awaiting_manual_fix",
      "awaiting_operator_action",
    ]);
    if (!blockedStates.has(currentState)) {
      throw new UserFacingError(
        "Delivery Loop is not blocked on human feedback",
      );
    }
    await handleHumanAction({
      db,
      action: "resume",
      actorUserId: userId,
      workflowId: v2Row.id as WorkflowId,
      inboxPartitionKey: v2Row.id,
    });

    if (threadChatId) {
      try {
        await queueFollowUpInternal({
          userId,
          threadId,
          threadChatId,
          source: "www",
          appendOrReplace: "append",
          messages: [buildResumeFollowUpMessage()],
        });
      } catch (error) {
        console.warn(
          "[delivery-loop-interventions] failed to enqueue resume follow-up",
          { threadId, error },
        );
      }
    }
  },
  { defaultErrorMessage: "Failed to resume Delivery Loop" },
);

export const requestDeliveryLoopBypassCurrentGateOnce = userOnlyAction(
  async function requestDeliveryLoopBypassCurrentGateOnce(
    userId: string,
    { threadId }: { threadId: string; threadChatId: string | null },
  ) {
    throw new UserFacingError(
      "Delivery Loop bypass is not supported in the v3 workflow. Resume instead.",
    );
  },
  { defaultErrorMessage: "Failed to bypass delivery loop gate" },
);
