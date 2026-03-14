/**
 * Seed and cleanup helpers for the replay runner.
 *
 * Creates test user, thread, thread_chat, and SDLC loop from fixture config.
 * Follows the inline creation pattern from test-delivery-loop-e2e.ts to
 * avoid transitive broadcast-server imports.
 */

import type { EvalFixture } from "../types";
import type { SharedModules, DB } from "./shared-loader";

export type SeededState = {
  userId: string;
  threadId: string;
  threadChatId: string;
  loopId: string;
};

export async function seedFromFixture({
  db,
  shared,
  fixture,
}: {
  db: DB;
  shared: SharedModules;
  fixture: EvalFixture;
}): Promise<SeededState> {
  const { schema, nanoid } = shared;

  // 1. Create user
  const userId = nanoid();
  const email = `eval-${userId}@terragon.com`;
  const [user] = await db
    .insert(schema.user)
    .values({
      id: userId,
      email,
      name: "Eval Replay User",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning();
  if (!user) throw new Error("Failed to create test user");

  // userFlags row
  await db.insert(schema.userFlags).values({ userId }).onConflictDoNothing();

  // account
  const accountId = Math.floor(Math.random() * 10000000).toString();
  await db.insert(schema.account).values({
    id: accountId,
    accountId,
    providerId: "github",
    userId,
    accessToken: "123",
    refreshToken: "123",
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  // subscription
  await db.insert(schema.subscription).values({
    id: nanoid(),
    plan: "core",
    status: "active",
    periodStart: new Date(Date.now() - 30 * 86400_000),
    periodEnd: new Date(Date.now() + 30 * 86400_000),
    referenceId: userId,
  });

  // session
  await db.insert(schema.session).values({
    id: nanoid(),
    userId,
    expiresAt: new Date(Date.now() + 30 * 86400_000),
    createdAt: new Date(),
    updatedAt: new Date(),
    token: nanoid(),
  });

  // 2. Create thread
  const threadId = nanoid();
  const threadChatId = nanoid();

  await db.insert(schema.thread).values({
    id: threadId,
    userId,
    name: fixture.thread.name ?? "Eval Replay Thread",
    githubRepoFullName: fixture.thread.githubRepoFullName,
    repoBaseBranchName: fixture.thread.repoBaseBranchName,
    sandboxProvider: fixture.thread.sandboxProvider as "e2b" | "docker",
  });

  await db.insert(schema.threadChat).values({
    id: threadChatId,
    userId,
    threadId,
    agent: (fixture.threadChat.agent ?? "claudeCode") as "claudeCode",
  });

  // 3. Enroll SDLC loop
  const loop = await shared.enrollSdlcLoopForThread({
    db,
    userId,
    repoFullName: fixture.thread.githubRepoFullName,
    threadId,
    planApprovalPolicy: fixture.loop.planApprovalPolicy as "auto" | "manual",
  });
  if (!loop) throw new Error("Failed to enroll SDLC loop");

  // 4. Seed plan if present
  if (fixture.plan) {
    const planPayload = {
      planText: fixture.plan.planText,
      tasks: fixture.plan.tasks.map((t) => ({
        stableTaskId: t.stableTaskId,
        title: t.title,
        acceptance: t.acceptanceCriteria,
      })),
      source: "agent_text" as const,
    };

    const artifact = await shared.createPlanArtifactForLoop({
      db,
      loopId: loop.id,
      loopVersion: 0,
      payload: planPayload,
    });

    await shared.replacePlanTasksForArtifact({
      db,
      loopId: loop.id,
      artifactId: artifact.id,
      tasks: planPayload.tasks,
    });

    await shared.approvePlanArtifactForLoop({
      db,
      loopId: loop.id,
      artifactId: artifact.id,
      approvedByUserId: userId,
    });

    // Transition: planning -> implementing
    await shared.transitionSdlcLoopState({
      db,
      loopId: loop.id,
      transitionEvent: "plan_completed",
      loopVersion: 0,
    });
  }

  return {
    userId,
    threadId,
    threadChatId,
    loopId: loop.id,
  };
}

export async function cleanupSeededState({
  db,
  shared,
  state,
}: {
  db: DB;
  shared: SharedModules;
  state: SeededState;
}): Promise<void> {
  const { schema, eq } = shared;

  // sdlcLoop cascade-deletes artifacts, tasks, signals, outbox
  if (state.loopId) {
    await db
      .delete(schema.sdlcLoop)
      .where(eq(schema.sdlcLoop.id, state.loopId));
  }
  if (state.threadId) {
    await db
      .delete(schema.threadChat)
      .where(eq(schema.threadChat.threadId, state.threadId));
    await db.delete(schema.thread).where(eq(schema.thread.id, state.threadId));
  }
  if (state.userId) {
    await db
      .delete(schema.session)
      .where(eq(schema.session.userId, state.userId));
    await db
      .delete(schema.subscription)
      .where(eq(schema.subscription.referenceId, state.userId));
    await db
      .delete(schema.account)
      .where(eq(schema.account.userId, state.userId));
    await db
      .delete(schema.userFlags)
      .where(eq(schema.userFlags.userId, state.userId));
    await db.delete(schema.user).where(eq(schema.user.id, state.userId));
  }
}
