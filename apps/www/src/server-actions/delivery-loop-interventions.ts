"use server";

import { userOnlyAction } from "@/lib/auth-server";
import { db } from "@/lib/db";
import { UserFacingError } from "@/lib/server-actions";
import { queueFollowUpInternal } from "@/server-lib/follow-up";
import { DBUserMessage } from "@terragon/shared";
import * as schema from "@terragon/shared/db/schema";
import {
  buildPersistedDeliveryLoopSnapshot,
  coerceDeliveryLoopResumableState,
  getActiveSdlcLoopForThread,
  resolveBlockedResumeTarget,
} from "@terragon/shared/model/delivery-loop";
import { getActiveWorkflowForThread } from "@terragon/shared/delivery-loop/store/workflow-store";
import { handleHumanAction } from "@/server-lib/delivery-loop/adapters/ingress/human-interventions";
import type { WorkflowId } from "@terragon/shared/delivery-loop/domain/workflow";
import { runCoordinatorTick } from "@/server-lib/delivery-loop/coordinator/tick";
import type { CorrelationId } from "@terragon/shared/delivery-loop/domain/workflow";
import { type DB } from "@terragon/shared/db";
import { and, desc, eq, sql } from "drizzle-orm";

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

function canBypassDeliveryLoopOnce(params: {
  state: typeof schema.sdlcLoop.$inferSelect.state;
  blockedFromState?: string | null;
}): boolean {
  const snapshot = buildPersistedDeliveryLoopSnapshot({
    state: params.state,
    blockedFromState: params.blockedFromState,
  });
  return snapshot.kind === "blocked" || snapshot.kind === "implementing";
}

export const requestDeliveryLoopResumeFromBlocked = userOnlyAction(
  async function requestDeliveryLoopResumeFromBlocked(
    userId: string,
    {
      threadId,
      threadChatId,
    }: { threadId: string; threadChatId: string | null },
  ) {
    // ── V2 fast-path: route as a v2 human signal ──
    const v2Row = await getActiveWorkflowForThread({ db, threadId });
    if (v2Row && v2Row.sdlcLoopId) {
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
            correlationId:
              `human-resume:${wfId}:${Date.now()}` as CorrelationId,
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
      return;
    }

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
    if (activeLoop.state !== "blocked") {
      throw new UserFacingError(
        "Delivery Loop is not blocked on human feedback",
      );
    }

    const resumeTarget = await db.transaction(async (tx) => {
      const resumeTarget = await transitionBlockedLoopToResumeTarget({
        tx,
        loopId: activeLoop.id,
      });

      await tx.insert(schema.sdlcPhaseArtifact).values({
        loopId: activeLoop.id,
        phase: resumeTarget,
        artifactType: "human_intervention",
        loopVersion: activeLoop.loopVersion,
        status: "accepted",
        generatedBy: "human",
        payload: {
          kind: "resume",
          actorUserId: userId,
          loopVersion: activeLoop.loopVersion,
          requestedAt: new Date().toISOString(),
        },
      });

      return resumeTarget;
    });

    if (threadChatId) {
      try {
        await queueFollowUpInternal({
          userId,
          threadId,
          threadChatId,
          source: "www",
          appendOrReplace: "append",
          messages: [buildResumeFollowUpMessage(resumeTarget)],
        });
      } catch (error) {
        console.warn(
          "[delivery-loop-interventions] failed to enqueue resume follow-up",
          {
            threadId,
            loopId: activeLoop.id,
            error,
          },
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
    // ── V2 fast-path: route as a v2 human bypass signal ──
    const v2Row = await getActiveWorkflowForThread({ db, threadId });
    if (v2Row && v2Row.sdlcLoopId) {
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
            correlationId:
              `human-bypass:${wfId}:${Date.now()}` as CorrelationId,
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
      return;
    }

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
    if (
      !canBypassDeliveryLoopOnce({
        state: activeLoop.state,
        blockedFromState: activeLoop.blockedFromState,
      })
    ) {
      throw new UserFacingError(
        "Delivery Loop bypass is only available while implementing or blocked",
      );
    }

    await db.transaction(async (tx) => {
      const bypassLockKey = `sdlc-bypass-once:${activeLoop.id}`;
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${bypassLockKey}), 0)`,
      );
      const lockedLoop = await tx.query.sdlcLoop.findFirst({
        where: eq(schema.sdlcLoop.id, activeLoop.id),
        columns: {
          id: true,
          state: true,
          blockedFromState: true,
          loopVersion: true,
          currentHeadSha: true,
        },
      });
      if (!lockedLoop) {
        throw new UserFacingError(
          "No active Delivery Loop found for this thread",
        );
      }
      if (
        !canBypassDeliveryLoopOnce({
          state: lockedLoop.state,
          blockedFromState: lockedLoop.blockedFromState,
        })
      ) {
        throw new UserFacingError(
          "Delivery Loop bypass is only available while implementing or blocked",
        );
      }
      if (lockedLoop.state === "blocked") {
        await transitionBlockedLoopToResumeTarget({
          tx,
          loopId: lockedLoop.id,
        });
      }

      const existingBypasses = await tx.query.sdlcPhaseArtifact.findMany({
        where: and(
          eq(schema.sdlcPhaseArtifact.loopId, lockedLoop.id),
          eq(schema.sdlcPhaseArtifact.phase, "implementing"),
          eq(schema.sdlcPhaseArtifact.artifactType, "human_intervention"),
          eq(schema.sdlcPhaseArtifact.generatedBy, "human"),
          eq(schema.sdlcPhaseArtifact.status, "generated"),
        ),
        orderBy: [
          desc(schema.sdlcPhaseArtifact.updatedAt),
          desc(schema.sdlcPhaseArtifact.createdAt),
        ],
        limit: 10,
        columns: {
          id: true,
          payload: true,
        },
      });
      const hasMatchingBypass = existingBypasses.some((candidate) => {
        const payload = candidate.payload as {
          kind?: unknown;
          gate?: unknown;
          actorUserId?: unknown;
          loopVersion?: unknown;
        };
        return (
          payload.kind === "bypass_once" &&
          payload.gate === "quality" &&
          payload.actorUserId === userId &&
          payload.loopVersion === lockedLoop.loopVersion
        );
      });
      if (hasMatchingBypass) {
        return;
      }

      await tx.insert(schema.sdlcPhaseArtifact).values({
        loopId: lockedLoop.id,
        phase: "implementing",
        artifactType: "human_intervention",
        loopVersion: lockedLoop.loopVersion,
        status: "generated",
        generatedBy: "human",
        payload: {
          kind: "bypass_once",
          gate: "quality",
          actorUserId: userId,
          loopVersion: lockedLoop.loopVersion,
          headSha: lockedLoop.currentHeadSha ?? undefined,
          requestedAt: new Date().toISOString(),
        },
      });
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
          {
            threadId,
            loopId: activeLoop.id,
            error,
          },
        );
      }
    }
  },
  { defaultErrorMessage: "Failed to bypass delivery loop gate" },
);
