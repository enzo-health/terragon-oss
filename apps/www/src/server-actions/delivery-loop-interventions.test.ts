import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { unwrapResult } from "@/lib/server-actions";
import {
  createTestThread,
  createTestUser,
} from "@terragon/shared/model/test-helpers";
import { mockLoggedInUser, mockLoggedOutUser } from "@/test-helpers/mock-next";
import { createWorkflow } from "@terragon/shared/delivery-loop/store/workflow-store";
import { ensureWorkflowHead } from "@/server-lib/delivery-loop/v3/store";
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

    const loopBlocked = await createWorkflow({
      db,
      threadId,
      generation: 1,
      kind: "awaiting_manual_fix",
      stateJson: {},
      userId: user.id,
      repoFullName: "owner/repo",
    });
    await ensureWorkflowHead({ db, workflowId: loopBlocked.id });

    // Should not throw — workflow is in a blocked kind
    await resumeFromBlocked({ threadId, threadChatId: null });
  });

  it("rejects bypass request for a v3 workflow in implementing state", async () => {
    const { user, session } = await createTestUser({ db });
    const { threadId } = await createTestThread({
      db,
      userId: user.id,
      overrides: { githubRepoFullName: "owner/repo" },
    });
    await mockLoggedInUser(session);

    const loopImplementing = await createWorkflow({
      db,
      threadId,
      generation: 1,
      kind: "implementing",
      stateJson: {},
      userId: user.id,
      repoFullName: "owner/repo",
    });
    await ensureWorkflowHead({ db, workflowId: loopImplementing.id });

    await expect(bypassOnce({ threadId, threadChatId: null })).rejects.toThrow(
      "Delivery Loop bypass is not supported in the v3 workflow. Resume instead.",
    );
  });

  it("rejects bypass request for a v3 workflow in gating state", async () => {
    const { user, session } = await createTestUser({ db });
    const { threadId } = await createTestThread({
      db,
      userId: user.id,
      overrides: { githubRepoFullName: "owner/repo" },
    });
    await mockLoggedInUser(session);

    const loopGating = await createWorkflow({
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
    await ensureWorkflowHead({ db, workflowId: loopGating.id });

    await expect(bypassOnce({ threadId, threadChatId: null })).rejects.toThrow(
      "Delivery Loop bypass is not supported in the v3 workflow. Resume instead.",
    );
  });

  it("returns the unsupported bypass error when no active workflow exists", async () => {
    const { user, session } = await createTestUser({ db });
    const { threadId } = await createTestThread({
      db,
      userId: user.id,
      overrides: { githubRepoFullName: "owner/repo" },
    });
    await mockLoggedInUser(session);

    await expect(bypassOnce({ threadId, threadChatId: null })).rejects.toThrow(
      "Delivery Loop bypass is not supported in the v3 workflow. Resume instead.",
    );
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

    const loopNotBlocked = await createWorkflow({
      db,
      threadId,
      generation: 1,
      kind: "implementing",
      stateJson: {},
      userId: user.id,
      repoFullName: "owner/repo",
    });
    await ensureWorkflowHead({ db, workflowId: loopNotBlocked.id });

    await expect(
      resumeFromBlocked({ threadId, threadChatId: null }),
    ).rejects.toThrow("Delivery Loop is not blocked on human feedback");
  });
});
