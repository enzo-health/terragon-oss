"use server";

import { userOnlyAction } from "@/lib/auth-server";
import { db } from "@/lib/db";
import { UserFacingError } from "@/lib/server-actions";
import { queueFollowUpInternal } from "@/server-lib/follow-up";
import { DBUserMessage } from "@terragon/shared";
import * as schema from "@terragon/shared/db/schema";
import {
  coerceDeliveryLoopResumableState,
  resolveBlockedResumeTarget,
} from "@terragon/shared/model/delivery-loop";
import { getActiveWorkflowForThread } from "@terragon/shared/delivery-loop/store/workflow-store";
import { handleHumanAction } from "@/server-lib/delivery-loop/adapters/ingress/human-interventions";
import type { WorkflowId } from "@terragon/shared/delivery-loop/domain/workflow";
import { runCoordinatorTick } from "@/server-lib/delivery-loop/coordinator/tick";
import type { CorrelationId } from "@terragon/shared/delivery-loop/domain/workflow";
import { type DB } from "@terragon/shared/db";
import { and, eq } from "drizzle-orm";

async function transitionBlockedLoopToResumeTarget({
  tx,
  loopId,
}: {
  tx: Pick<DB, "query" | "update">;
  loopId: string;
}): Promise<ReturnType<typeof resolveBlockedResumeTarget>> {
  const blockedLoop = await tx.query.sdlcLoop.findFirst({
    where: and(
      eq(schema.sdlcLoop.id, loopId),
      eq(schema.sdlcLoop.state, "blocked"),
    ),
    columns: {
      blockedFromState: true,
    },
  });
  if (!blockedLoop) {
    throw new UserFacingError(
      "Failed to transition Delivery Loop from blocked to its resume phase",
    );
  }

  const resumeTarget = resolveBlockedResumeTarget(
    coerceDeliveryLoopResumableState(blockedLoop.blockedFromState),
  );
  const now = new Date();
  const [updated] = await tx
    .update(schema.sdlcLoop)
    .set({
      state: resumeTarget,
      blockedFromState: null,
      fixAttemptCount: 0,
      phaseEnteredAt: now,
      updatedAt: now,
    })
    .where(
      and(eq(schema.sdlcLoop.id, loopId), eq(schema.sdlcLoop.state, "blocked")),
    )
    .returning({ id: schema.sdlcLoop.id });
  if (!updated) {
    throw new UserFacingError(
      "Failed to transition Delivery Loop from blocked to its resume phase",
    );
  }
  return resumeTarget;
}

function buildResumeFollowUpMessage(
  resumeTarget: ReturnType<typeof resolveBlockedResumeTarget>,
): DBUserMessage {
  const textByPhase: Record<
    ReturnType<typeof resolveBlockedResumeTarget>,
    string
  > = {
    planning: "Resume planning and continue with the Delivery Loop.",
    implementing: "Resume implementation and continue with the Delivery Loop.",
    review_gate: "Resume the review gate and continue with the Delivery Loop.",
    ci_gate: "Resume the CI gate and continue with the Delivery Loop.",
    ui_gate: "Resume UI testing and continue with the Delivery Loop.",
    awaiting_pr_link: "Resume PR linking and continue with the Delivery Loop.",
    babysitting: "Resume PR babysitting and continue with the Delivery Loop.",
  };

  return {
    type: "user",
    model: null,
    permissionMode: "allowAll",
    parts: [{ type: "text", text: textByPhase[resumeTarget] }],
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
    if (!v2Row?.sdlcLoopId) {
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
      inboxPartitionKey: v2Row.sdlcLoopId,
      wakeCoordinator: async (wfId) => {
        await runCoordinatorTick({
          db,
          workflowId: wfId,
          correlationId: `human-resume:${wfId}:${Date.now()}` as CorrelationId,
          loopId: v2Row.sdlcLoopId!,
        });
      },
    });

    // Also transition v1 loop for compat (best-effort)
    try {
      await db.transaction(async (tx) => {
        await transitionBlockedLoopToResumeTarget({
          tx,
          loopId: v2Row.sdlcLoopId!,
        });
      });
    } catch {
      // v1 loop may not be in blocked state; non-fatal
    }

    if (threadChatId) {
      try {
        await queueFollowUpInternal({
          userId,
          threadId,
          threadChatId,
          source: "www",
          appendOrReplace: "append",
          messages: [buildResumeFollowUpMessage("implementing")],
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
    if (!v2Row?.sdlcLoopId) {
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
      inboxPartitionKey: v2Row.sdlcLoopId,
      gate,
      wakeCoordinator: async (wfId) => {
        await runCoordinatorTick({
          db,
          workflowId: wfId,
          correlationId: `human-bypass:${wfId}:${Date.now()}` as CorrelationId,
          loopId: v2Row.sdlcLoopId!,
        });
      },
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
