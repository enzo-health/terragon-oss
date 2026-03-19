import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { unwrapResult } from "@/lib/server-actions";
import {
  createTestThread,
  createTestUser,
} from "@terragon/shared/model/test-helpers";
import { mockLoggedInUser, mockLoggedOutUser } from "@/test-helpers/mock-next";
import { createWorkflow } from "@terragon/shared/delivery-loop/store/workflow-store";
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

  it("resumes a v2 workflow blocked on human feedback", async () => {
    const { user, session } = await createTestUser({ db });
    const { threadId } = await createTestThread({
      db,
      userId: user.id,
      overrides: { githubRepoFullName: "owner/repo" },
    });
    await mockLoggedInUser(session);

    await createWorkflow({
      db,
      threadId,
      generation: 1,
      kind: "awaiting_manual_fix",
      stateJson: {},
      userId: user.id,
      repoFullName: "owner/repo",
    });

    // Should not throw — workflow is in a blocked kind
    await resumeFromBlocked({ threadId, threadChatId: null });
  });

  it("accepts bypass request for a v2 workflow in implementing state", async () => {
    const { user, session } = await createTestUser({ db });
    const { threadId } = await createTestThread({
      db,
      userId: user.id,
      overrides: { githubRepoFullName: "owner/repo" },
    });
    await mockLoggedInUser(session);

    await createWorkflow({
      db,
      threadId,
      generation: 1,
      kind: "implementing",
      stateJson: {},
      userId: user.id,
      repoFullName: "owner/repo",
    });

    // Should not throw — workflow is in a bypassable kind
    await bypassOnce({ threadId, threadChatId: null });
  });

  it("accepts bypass request for a v2 workflow in gating state", async () => {
    const { user, session } = await createTestUser({ db });
    const { threadId } = await createTestThread({
      db,
      userId: user.id,
      overrides: { githubRepoFullName: "owner/repo" },
    });
    await mockLoggedInUser(session);

    await createWorkflow({
      db,
      threadId,
      generation: 1,
      kind: "gating",
      stateJson: {
        headSha: "sha-test",
        gate: { kind: "ci", status: "waiting", runId: null, snapshot: {} },
      },
      userId: user.id,
      repoFullName: "owner/repo",
    });

    // Should not throw — workflow is in a bypassable kind
    await bypassOnce({ threadId, threadChatId: null });
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

  it("rejects resume when v2 workflow is not in a blocked kind", async () => {
    const { user, session } = await createTestUser({ db });
    const { threadId } = await createTestThread({
      db,
      userId: user.id,
      overrides: { githubRepoFullName: "owner/repo" },
    });
    await mockLoggedInUser(session);

    await createWorkflow({
      db,
      threadId,
      generation: 1,
      kind: "implementing",
      stateJson: {},
      userId: user.id,
      repoFullName: "owner/repo",
    });

    await expect(
      resumeFromBlocked({ threadId, threadChatId: null }),
    ).rejects.toThrow("Delivery Loop is not blocked on human feedback");
  });
});
