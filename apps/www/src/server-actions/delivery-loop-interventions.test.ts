import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { unwrapResult } from "@/lib/server-actions";
import {
  createTestThread,
  createTestUser,
} from "@terragon/shared/model/test-helpers";
import { mockLoggedInUser, mockLoggedOutUser } from "@/test-helpers/mock-next";
import { enrollSdlcLoopForThread } from "@terragon/shared/model/delivery-loop";
import * as schema from "@terragon/shared/db/schema";
import { and, eq } from "drizzle-orm";
import {
  requestDeliveryLoopBypassCurrentGateOnce,
  requestDeliveryLoopResumeFromBlocked,
} from "./delivery-loop-interventions";

async function resumeFromBlocked(input: {
  threadId: string;
  threadChatId: string | null;
}) {
  return unwrapResult(await requestDeliveryLoopResumeFromBlocked(input));
}

async function bypassOnce(input: {
  threadId: string;
  threadChatId: string | null;
}) {
  return unwrapResult(await requestDeliveryLoopBypassCurrentGateOnce(input));
}

describe("delivery-loop-interventions", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
  });

  it("resumes blocked loops into implementing", async () => {
    const { user, session } = await createTestUser({ db });
    const { threadId } = await createTestThread({
      db,
      userId: user.id,
      overrides: { githubRepoFullName: "owner/repo" },
    });
    await mockLoggedInUser(session);

    const loop = await enrollSdlcLoopForThread({
      db,
      userId: user.id,
      repoFullName: "owner/repo",
      threadId,
    });

    await db
      .update(schema.sdlcLoop)
      .set({ state: "blocked" })
      .where(eq(schema.sdlcLoop.id, loop!.id));

    await resumeFromBlocked({ threadId, threadChatId: null });

    const reloadedLoop = await db.query.sdlcLoop.findFirst({
      where: eq(schema.sdlcLoop.id, loop!.id),
    });
    expect(reloadedLoop?.state).toBe("implementing");

    const intervention = await db.query.sdlcPhaseArtifact.findFirst({
      where: and(
        eq(schema.sdlcPhaseArtifact.loopId, loop!.id),
        eq(schema.sdlcPhaseArtifact.artifactType, "human_intervention"),
        eq(schema.sdlcPhaseArtifact.generatedBy, "human"),
      ),
      orderBy: [schema.sdlcPhaseArtifact.createdAt],
    });
    expect(intervention?.status).toBe("accepted");
  });

  it("creates a generated one-time quality bypass marker", async () => {
    const { user, session } = await createTestUser({ db });
    const { threadId } = await createTestThread({
      db,
      userId: user.id,
      overrides: { githubRepoFullName: "owner/repo" },
    });
    await mockLoggedInUser(session);

    const loop = await enrollSdlcLoopForThread({
      db,
      userId: user.id,
      repoFullName: "owner/repo",
      threadId,
    });

    await db
      .update(schema.sdlcLoop)
      .set({ state: "blocked" })
      .where(eq(schema.sdlcLoop.id, loop!.id));

    await bypassOnce({ threadId, threadChatId: null });

    const marker = await db.query.sdlcPhaseArtifact.findFirst({
      where: and(
        eq(schema.sdlcPhaseArtifact.loopId, loop!.id),
        eq(schema.sdlcPhaseArtifact.artifactType, "human_intervention"),
        eq(schema.sdlcPhaseArtifact.generatedBy, "human"),
        eq(schema.sdlcPhaseArtifact.status, "generated"),
      ),
      orderBy: [schema.sdlcPhaseArtifact.createdAt],
    });
    expect(marker).toBeTruthy();
    expect((marker?.payload as { gate?: string } | null)?.gate).toBe("quality");
    expect(
      (marker?.payload as { loopVersion?: number } | null)?.loopVersion,
    ).toBe(loop?.loopVersion);
  });

  it("does not create duplicate bypass markers for stale pending requests", async () => {
    const { user, session } = await createTestUser({ db });
    const { threadId } = await createTestThread({
      db,
      userId: user.id,
      overrides: { githubRepoFullName: "owner/repo" },
    });
    await mockLoggedInUser(session);

    const loop = await enrollSdlcLoopForThread({
      db,
      userId: user.id,
      repoFullName: "owner/repo",
      threadId,
    });

    await db
      .update(schema.sdlcLoop)
      .set({ state: "blocked" })
      .where(eq(schema.sdlcLoop.id, loop!.id));

    await db.insert(schema.sdlcPhaseArtifact).values({
      loopId: loop!.id,
      phase: "implementing",
      artifactType: "human_intervention",
      loopVersion: loop!.loopVersion,
      generatedBy: "human",
      status: "generated",
      payload: {
        kind: "bypass_once",
        gate: "quality",
        actorUserId: user.id,
        loopVersion: loop!.loopVersion,
        requestedAt: "2000-01-01T00:00:00.000Z",
      },
    });

    await bypassOnce({ threadId, threadChatId: null });

    const markers = await db.query.sdlcPhaseArtifact.findMany({
      where: and(
        eq(schema.sdlcPhaseArtifact.loopId, loop!.id),
        eq(schema.sdlcPhaseArtifact.phase, "implementing"),
        eq(schema.sdlcPhaseArtifact.artifactType, "human_intervention"),
        eq(schema.sdlcPhaseArtifact.generatedBy, "human"),
        eq(schema.sdlcPhaseArtifact.status, "generated"),
      ),
    });
    expect(markers).toHaveLength(1);
  });

  it("rejects intervention when user is logged out", async () => {
    const { user } = await createTestUser({ db });
    const { threadId } = await createTestThread({
      db,
      userId: user.id,
      overrides: { githubRepoFullName: "owner/repo" },
    });

    await mockLoggedOutUser();

    await expect(bypassOnce({ threadId, threadChatId: null })).rejects.toThrow(
      "Unauthorized",
    );
  });

  it("rejects resume when loop is not blocked", async () => {
    const { user, session } = await createTestUser({ db });
    const { threadId } = await createTestThread({
      db,
      userId: user.id,
      overrides: { githubRepoFullName: "owner/repo" },
    });
    await mockLoggedInUser(session);

    await enrollSdlcLoopForThread({
      db,
      userId: user.id,
      repoFullName: "owner/repo",
      threadId,
    });

    await expect(
      resumeFromBlocked({ threadId, threadChatId: null }),
    ).rejects.toThrow("Delivery Loop is not blocked on human feedback");
  });
});
