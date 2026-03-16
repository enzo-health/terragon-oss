import { describe, it, vi, beforeEach, expect } from "vitest";
import { createNewThread } from "./new-thread-shared";
import { db } from "@/lib/db";
import { createTestUser } from "@terragon/shared/model/test-helpers";
import { User, DBUserMessage } from "@terragon/shared";
import { mockWaitUntil, waitUntilResolved } from "@/test-helpers/mock-next";
import { getThread } from "@terragon/shared/model/threads";
import { getActiveWorkflowForThread } from "@terragon/shared/delivery-loop/store/workflow-store";

const repoFullName = "terragon/test-repo";
const mockMessage: DBUserMessage = {
  type: "user",
  parts: [{ type: "text", text: "Test task message" }],
  model: "sonnet",
};

describe("createNewThread", () => {
  let user: User;

  beforeEach(async () => {
    vi.clearAllMocks();
    const testUserResult = await createTestUser({ db });
    user = testUserResult.user;
  });

  describe("branch handling", () => {
    it("should create thread with baseBranchName when provided", async () => {
      await mockWaitUntil();
      const { threadId } = await createNewThread({
        userId: user.id,
        message: mockMessage,
        githubRepoFullName: repoFullName,
        baseBranchName: "develop",
        headBranchName: null,
        sourceType: "www",
      });
      await waitUntilResolved();

      const thread = await getThread({ db, userId: user.id, threadId });
      expect(thread).toBeDefined();
      expect(thread!.repoBaseBranchName).toBe("develop");
      expect(thread!.branchName).toBeNull();
    });

    it("should create thread with headBranchName when provided", async () => {
      await mockWaitUntil();
      const { threadId } = await createNewThread({
        userId: user.id,
        message: mockMessage,
        githubRepoFullName: repoFullName,
        baseBranchName: "main",
        headBranchName: "feature/test-branch",
        sourceType: "www",
      });
      await waitUntilResolved();

      const thread = await getThread({ db, userId: user.id, threadId });
      expect(thread).toBeDefined();
      expect(thread!.repoBaseBranchName).toBe("main");
      expect(thread!.branchName).toBe("feature/test-branch");
    });

    it("enrolls v2 workflow immediately for opted-in web threads and applies human-required plan policy", async () => {
      await mockWaitUntil();
      const { threadId } = await createNewThread({
        userId: user.id,
        message: mockMessage,
        githubRepoFullName: repoFullName,
        baseBranchName: "main",
        sourceType: "www",
        sourceMetadata: {
          type: "www",
          sdlcLoopOptIn: true,
          sdlcPlanApprovalPolicy: "human_required",
        },
      });
      await waitUntilResolved();

      const workflow = await getActiveWorkflowForThread({ db, threadId });
      expect(workflow).toBeDefined();
      expect(workflow?.kind).toBe("planning");
      expect(workflow?.planApprovalPolicy).toBe("human_required");
      // No v1 sdlcLoop should be created
      expect(workflow?.sdlcLoopId).toBeNull();
    });

    it("auto-enrolls v2 workflow for automation threads without explicit opt-in", async () => {
      await mockWaitUntil();
      const { threadId } = await createNewThread({
        userId: user.id,
        message: mockMessage,
        githubRepoFullName: repoFullName,
        baseBranchName: "main",
        sourceType: "automation",
      });
      await waitUntilResolved();

      const workflow = await getActiveWorkflowForThread({ db, threadId });
      expect(workflow).toBeDefined();
      expect(workflow?.kind).toBe("planning");
      expect(workflow?.planApprovalPolicy).toBe("auto");
      // No v1 sdlcLoop should be created
      expect(workflow?.sdlcLoopId).toBeNull();
    });
  });
});
