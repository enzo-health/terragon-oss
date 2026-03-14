import { and, desc, eq, inArray, notInArray } from "drizzle-orm";
import { DB } from "../../db";
import * as schema from "../../db/schema";
import type { SdlcPlanApprovalPolicy } from "../../db/types";
import type { SdlcLoopTransitionEvent } from "./state-constants";
import { activeSdlcLoopStateList } from "./state-constants";
import { transitionSdlcLoopState } from "./guarded-state";

export async function getActiveSdlcLoopForGithubPRAndUser({
  db,
  userId,
  repoFullName,
  prNumber,
}: {
  db: DB;
  userId: string;
  repoFullName: string;
  prNumber: number;
}) {
  return await getPreferredActiveSdlcLoopForGithubPRAndUser({
    db,
    userId,
    repoFullName,
    prNumber,
  });
}

export async function getActiveSdlcLoopsForGithubPR({
  db,
  repoFullName,
  prNumber,
}: {
  db: DB;
  repoFullName: string;
  prNumber: number;
}) {
  return await db.query.sdlcLoop.findMany({
    where: and(
      eq(schema.sdlcLoop.repoFullName, repoFullName),
      eq(schema.sdlcLoop.prNumber, prNumber),
      inArray(schema.sdlcLoop.state, activeSdlcLoopStateList),
    ),
    orderBy: [desc(schema.sdlcLoop.updatedAt), desc(schema.sdlcLoop.id)],
  });
}

export async function getPreferredActiveSdlcLoopForGithubPRAndUser({
  db,
  userId,
  repoFullName,
  prNumber,
}: {
  db: DB;
  userId: string;
  repoFullName: string;
  prNumber: number;
}) {
  const loops = await getActiveSdlcLoopsForGithubPR({
    db,
    repoFullName,
    prNumber,
  });
  const userLoops = loops.filter((loop) => loop.userId === userId);
  if (userLoops.length === 0) {
    return undefined;
  }

  const canonicalPr = await db.query.githubPR.findFirst({
    where: and(
      eq(schema.githubPR.repoFullName, repoFullName),
      eq(schema.githubPR.number, prNumber),
    ),
    columns: {
      threadId: true,
    },
  });
  if (canonicalPr?.threadId) {
    const canonicalLoop = userLoops.find(
      (loop) => loop.threadId === canonicalPr.threadId,
    );
    if (canonicalLoop) {
      return canonicalLoop;
    }
  }

  return userLoops[0];
}

export async function getActiveSdlcLoopForGithubPR({
  db,
  repoFullName,
  prNumber,
}: {
  db: DB;
  repoFullName: string;
  prNumber: number;
}) {
  const activeLoops = await getActiveSdlcLoopsForGithubPR({
    db,
    repoFullName,
    prNumber,
  });
  return activeLoops[0];
}

export async function transitionActiveSdlcLoopsForGithubPREvent({
  db,
  repoFullName,
  prNumber,
  transitionEvent,
  now = new Date(),
}: {
  db: DB;
  repoFullName: string;
  prNumber: number;
  transitionEvent: SdlcLoopTransitionEvent;
  now?: Date;
}) {
  const loops = await getActiveSdlcLoopsForGithubPR({
    db,
    repoFullName,
    prNumber,
  });

  let updatedCount = 0;
  for (const loop of loops) {
    const result = await transitionSdlcLoopState({
      db,
      loopId: loop.id,
      transitionEvent,
      now,
    });
    if (result === "updated") {
      updatedCount += 1;
    }
  }

  return {
    totalLoops: loops.length,
    updatedCount,
  };
}

export async function enrollSdlcLoopForGithubPR({
  db,
  userId,
  repoFullName,
  prNumber,
  threadId,
  currentHeadSha,
  planApprovalPolicy,
}: {
  db: DB;
  userId: string;
  repoFullName: string;
  prNumber: number;
  threadId: string;
  currentHeadSha?: string | null;
  planApprovalPolicy?: SdlcPlanApprovalPolicy;
}) {
  const enrolled = await enrollSdlcLoopForThread({
    db,
    userId,
    repoFullName,
    threadId,
    currentHeadSha,
    planApprovalPolicy,
  });
  if (!enrolled) {
    return enrolled;
  }

  return await linkSdlcLoopToGithubPRForThread({
    db,
    userId,
    repoFullName,
    threadId,
    prNumber,
    currentHeadSha,
  });
}

export async function enrollSdlcLoopForThread({
  db,
  userId,
  repoFullName,
  threadId,
  currentHeadSha,
  planApprovalPolicy,
  initialState,
}: {
  db: DB;
  userId: string;
  repoFullName: string;
  threadId: string;
  currentHeadSha?: string | null;
  planApprovalPolicy?: SdlcPlanApprovalPolicy;
  initialState?: "planning" | "implementing";
}) {
  const effectiveInitialState = initialState ?? "planning";
  const now = new Date();
  const inserted = await db
    .insert(schema.sdlcLoop)
    .values({
      userId,
      repoFullName,
      threadId,
      state: effectiveInitialState,
      currentHeadSha: currentHeadSha ?? null,
      planApprovalPolicy: planApprovalPolicy ?? "auto",
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning();

  if (inserted[0]) {
    return inserted[0];
  }

  const activeLoop = await getActiveSdlcLoopForThread({
    db,
    userId,
    threadId,
  });
  if (activeLoop) {
    return activeLoop;
  }

  const reactivationSet: {
    state: "planning" | "implementing";
    stopReason: null;
    updatedAt: Date;
    currentHeadSha?: string | null;
    planApprovalPolicy?: SdlcPlanApprovalPolicy;
  } = {
    state: effectiveInitialState,
    stopReason: null,
    updatedAt: now,
  };
  if (currentHeadSha !== undefined) {
    reactivationSet.currentHeadSha = currentHeadSha;
  }
  if (planApprovalPolicy !== undefined) {
    reactivationSet.planApprovalPolicy = planApprovalPolicy;
  }

  const [reactivated] = await db
    .update(schema.sdlcLoop)
    .set(reactivationSet)
    .where(
      and(
        eq(schema.sdlcLoop.threadId, threadId),
        eq(schema.sdlcLoop.userId, userId),
        eq(schema.sdlcLoop.repoFullName, repoFullName),
        notInArray(schema.sdlcLoop.state, activeSdlcLoopStateList),
      ),
    )
    .returning();
  if (reactivated) {
    return reactivated;
  }

  return await getActiveSdlcLoopForThread({
    db,
    userId,
    threadId,
  });
}

export async function linkSdlcLoopToGithubPRForThread({
  db,
  userId,
  repoFullName,
  threadId,
  prNumber,
  currentHeadSha,
}: {
  db: DB;
  userId: string;
  repoFullName: string;
  threadId: string;
  prNumber: number;
  currentHeadSha?: string | null;
}) {
  const now = new Date();
  const activeLoop =
    (await getActiveSdlcLoopForThread({
      db,
      userId,
      threadId,
    })) ??
    (await enrollSdlcLoopForThread({
      db,
      userId,
      repoFullName,
      threadId,
      currentHeadSha,
    }));
  if (!activeLoop) {
    return undefined;
  }

  const nextValues: {
    prNumber: number;
    updatedAt: Date;
    currentHeadSha?: string | null;
  } = {
    prNumber,
    updatedAt: now,
  };
  if (currentHeadSha !== undefined) {
    nextValues.currentHeadSha = currentHeadSha;
  }

  const [updated] = await db
    .update(schema.sdlcLoop)
    .set(nextValues)
    .where(
      and(
        eq(schema.sdlcLoop.id, activeLoop.id),
        eq(schema.sdlcLoop.userId, userId),
        eq(schema.sdlcLoop.threadId, threadId),
        eq(schema.sdlcLoop.repoFullName, repoFullName),
      ),
    )
    .returning();
  if (updated) {
    return updated;
  }

  return await getPreferredActiveSdlcLoopForGithubPRAndUser({
    db,
    userId,
    repoFullName,
    prNumber,
  });
}

export async function getActiveSdlcLoopForThread({
  db,
  userId,
  threadId,
}: {
  db: DB;
  userId: string;
  threadId: string;
}) {
  return await db.query.sdlcLoop.findFirst({
    where: and(
      eq(schema.sdlcLoop.userId, userId),
      eq(schema.sdlcLoop.threadId, threadId),
      inArray(schema.sdlcLoop.state, activeSdlcLoopStateList),
    ),
  });
}
