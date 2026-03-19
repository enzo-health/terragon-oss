"use server";

import { userOnlyAction } from "@/lib/auth-server";
import { db } from "@/lib/db";
import { UserFacingError } from "@/lib/server-actions";
import { queueFollowUpInternal } from "@/server-lib/follow-up";
import { DBUserMessage } from "@terragon/shared";
import { getActiveWorkflowForThread } from "@terragon/shared/delivery-loop/store/workflow-store";
import { handleHumanAction } from "@/server-lib/delivery-loop/adapters/ingress/human-interventions";
import type { WorkflowId } from "@terragon/shared/delivery-loop/domain/workflow";

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

    const blockedKinds = new Set([
      "awaiting_plan_approval",
      "awaiting_manual_fix",
      "awaiting_operator_action",
    ]);
    if (!blockedKinds.has(v2Row.kind)) {
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

    const bypassableKinds = new Set([
      "implementing",
      "gating",
      "awaiting_manual_fix",
      "awaiting_operator_action",
    ]);
    if (!bypassableKinds.has(v2Row.kind)) {
      throw new UserFacingError(
        "Delivery Loop bypass is only available while implementing or blocked",
      );
    }

    // Determine gate target from v2 state
    const stateJson = v2Row.stateJson as Record<string, unknown> | null;
    const gate =
      v2Row.kind === "gating" && stateJson
        ? (((stateJson as { gate?: { kind?: string } }).gate?.kind as
            | import("@terragon/shared/delivery-loop/domain/workflow").GateKind
            | undefined) ?? "ci")
        : "ci";

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
