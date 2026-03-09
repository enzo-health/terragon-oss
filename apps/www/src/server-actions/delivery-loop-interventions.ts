"use server";

import { userOnlyAction } from "@/lib/auth-server";
import { db } from "@/lib/db";
import { UserFacingError } from "@/lib/server-actions";
import { queueFollowUpInternal } from "@/server-lib/follow-up";
import { DBUserMessage } from "@terragon/shared";
import * as schema from "@terragon/shared/db/schema";
import { getActiveSdlcLoopForThread } from "@terragon/shared/model/delivery-loop";
import { type DB } from "@terragon/shared/db";
import { and, desc, eq, sql } from "drizzle-orm";

async function transitionBlockedLoopToImplementing({
  tx,
  loopId,
}: {
  tx: Pick<DB, "update">;
  loopId: string;
}): Promise<void> {
  const now = new Date();
  const [updated] = await tx
    .update(schema.sdlcLoop)
    .set({
      state: "implementing",
      fixAttemptCount: 0,
      phaseEnteredAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.sdlcLoop.id, loopId),
        eq(schema.sdlcLoop.state, "blocked_on_human_feedback"),
      ),
    )
    .returning({ id: schema.sdlcLoop.id });
  if (!updated) {
    throw new UserFacingError(
      "Failed to transition Delivery Loop from blocked to implementing",
    );
  }
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

export const requestSdlcResumeFromBlocked = userOnlyAction(
  async function requestSdlcResumeFromBlocked(
    userId: string,
    {
      threadId,
      threadChatId,
    }: { threadId: string; threadChatId: string | null },
  ) {
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
    if (activeLoop.state !== "blocked_on_human_feedback") {
      throw new UserFacingError(
        "Delivery Loop is not blocked on human feedback",
      );
    }

    await db.transaction(async (tx) => {
      await transitionBlockedLoopToImplementing({
        tx,
        loopId: activeLoop.id,
      });

      await tx.insert(schema.sdlcPhaseArtifact).values({
        loopId: activeLoop.id,
        phase: "implementing",
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
    });

    if (threadChatId) {
      try {
        await queueFollowUpInternal({
          userId,
          threadId,
          threadChatId,
          source: "www",
          appendOrReplace: "append",
          messages: [
            {
              type: "user",
              model: null,
              permissionMode: "allowAll",
              parts: [
                {
                  type: "text",
                  text: "Resume implementation and continue with the Delivery Loop.",
                },
              ],
            },
          ],
        });
      } catch (error) {
        console.warn(
          "[sdlc-interventions] failed to enqueue resume follow-up",
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

export const requestSdlcBypassCurrentGateOnce = userOnlyAction(
  async function requestSdlcBypassCurrentGateOnce(
    userId: string,
    {
      threadId,
      threadChatId,
    }: { threadId: string; threadChatId: string | null },
  ) {
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
    const stateAllowsBypass =
      activeLoop.state === "blocked_on_human_feedback" ||
      activeLoop.state === "implementing";
    if (!stateAllowsBypass) {
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
          loopVersion: true,
          currentHeadSha: true,
        },
      });
      if (!lockedLoop) {
        throw new UserFacingError(
          "No active Delivery Loop found for this thread",
        );
      }
      const stateAllowsBypassInTx =
        lockedLoop.state === "blocked_on_human_feedback" ||
        lockedLoop.state === "implementing";
      if (!stateAllowsBypassInTx) {
        throw new UserFacingError(
          "Delivery Loop bypass is only available while implementing or blocked",
        );
      }
      if (lockedLoop.state === "blocked_on_human_feedback") {
        await transitionBlockedLoopToImplementing({
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
          "[sdlc-interventions] failed to enqueue bypass follow-up",
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

// Delivery Loop aliases
/** @deprecated Use requestDeliveryLoopResumeFromBlocked */
export const requestDeliveryLoopResumeFromBlocked =
  requestSdlcResumeFromBlocked;
/** @deprecated Use requestDeliveryLoopBypassCurrentGateOnce */
export const requestDeliveryLoopBypassCurrentGateOnce =
  requestSdlcBypassCurrentGateOnce;
