"use server";

import { userOnlyAction } from "@/lib/auth-server";
import { db } from "@/lib/db";
import { UserFacingError } from "@/lib/server-actions";
import { queueFollowUpInternal } from "@/server-lib/follow-up";
import { DBUserMessage } from "@terragon/shared";
import { getActiveWorkflowForThread } from "@terragon/shared/delivery-loop/store/workflow-store";
import { handleHumanAction } from "@/server-lib/delivery-loop/adapters/ingress/human-interventions";
import { getWorkflowHead } from "@/server-lib/delivery-loop/v3/store";
import type {
  GateKind,
  WorkflowId,
} from "@terragon/shared/delivery-loop/domain/workflow";

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

function buildBypassFollowUpMessage(): DBUserMessage {
  return {
    type: "user",
    model: null,
    permissionMode: "allowAll",
    parts: [
      {
        type: "text",
        text: "Bypass the quality-check gate once and continue Delivery Loop progression. Signal phaseComplete: true when ready.",
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
    const v2Row = await getActiveWorkflowForThread({ db, threadId });
    if (!v2Row) {
      throw new UserFacingError(
        "No active Delivery Loop found for this thread",
      );
    }

    const v3Head = await getWorkflowHead({ db, workflowId: v2Row.id });
    if (!v3Head) {
      throw new Error(`No v3 head for workflow ${v2Row.id}`);
    }
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
    {
      threadId,
      threadChatId,
    }: { threadId: string; threadChatId: string | null },
  ) {
    const v2Row = await getActiveWorkflowForThread({ db, threadId });
    if (!v2Row) {
      throw new UserFacingError(
        "No active Delivery Loop found for this thread",
      );
    }

    const v3Head = await getWorkflowHead({ db, workflowId: v2Row.id });
    if (!v3Head) {
      throw new Error(`No v3 head for workflow ${v2Row.id}`);
    }
    const currentState = v3Head.state;
    const bypassableStates = new Set([
      "implementing",
      "gating_review",
      "gating_ci",
      "awaiting_manual_fix",
      "awaiting_operator_action",
    ]);
    if (!bypassableStates.has(currentState)) {
      throw new UserFacingError(
        "Delivery Loop bypass is only available while implementing or blocked",
      );
    }

    // Gate extraction — use v3 head's activeGate directly
    const gate: GateKind = (v3Head?.activeGate as GateKind | null) ?? "ci";

    await handleHumanAction({
      db,
      action: "bypass",
      actorUserId: userId,
      workflowId: v2Row.id as WorkflowId,
      inboxPartitionKey: v2Row.id,
      gate,
    });

    if (threadChatId) {
      try {
        await queueFollowUpInternal({
          userId,
          threadId,
          threadChatId,
          source: "www",
          appendOrReplace: "append",
          messages: [buildBypassFollowUpMessage()],
        });
      } catch (error) {
        console.warn(
          "[delivery-loop-interventions] failed to enqueue bypass follow-up",
          { threadId, error },
        );
      }
    }
  },
  { defaultErrorMessage: "Failed to bypass delivery loop gate" },
);
