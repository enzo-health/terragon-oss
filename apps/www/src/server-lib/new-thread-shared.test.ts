import { describe, it, vi, beforeEach, beforeAll, expect } from "vitest";
import { createNewThread } from "./new-thread-shared";
import { db } from "@/lib/db";
import { createTestUser } from "@terragon/shared/model/test-helpers";
import { User, DBUserMessage } from "@terragon/shared";
import { mockWaitUntil, waitUntilResolved } from "@/test-helpers/mock-next";
import { getThread } from "@terragon/shared/model/threads";
import { getActiveWorkflowForThread } from "@terragon/shared/delivery-loop/store/workflow-store";
import { execSync } from "node:child_process";

const repoFullName = "terragon/test-repo";
const mockMessage: DBUserMessage = {
  type: "user",
  parts: [{ type: "text", text: "Test task message" }],
  model: "sonnet",
};

async function waitUntilResolvedBestEffort() {
  await Promise.race([
    waitUntilResolved(),
    new Promise((resolve) => setTimeout(resolve, 1_000)),
  ]);
}

describe("createNewThread", { timeout: 30_000 }, () => {
  let user: User;

  beforeAll(() => {
    execSync("docker restart terragon_redis_http_test", { stdio: "ignore" });
  });

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
      await waitUntilResolvedBestEffort();

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
      await waitUntilResolvedBestEffort();

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
          deliveryLoopOptIn: true,
          deliveryPlanApprovalPolicy: "human_required",
        },
      });
      await waitUntilResolvedBestEffort();

      const workflow = await getActiveWorkflowForThread({ db, threadId });
      expect(workflow).toBeDefined();
      expect(workflow?.kind).toBe("planning");
      expect(workflow?.planApprovalPolicy).toBe("human_required");
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
      await waitUntilResolvedBestEffort();

      const workflow = await getActiveWorkflowForThread({ db, threadId });
      expect(workflow).toBeDefined();
      expect(workflow?.kind).toBe("planning");
      expect(workflow?.planApprovalPolicy).toBe("auto");
    });

    it("enrolls workflow for opted-in linear threads and applies plan approval policy", async () => {
      await mockWaitUntil();
      const { threadId } = await createNewThread({
        userId: user.id,
        message: mockMessage,
        githubRepoFullName: repoFullName,
        baseBranchName: "main",
        sourceType: "linear-mention",
        sourceMetadata: {
          type: "linear-mention",
          organizationId: "org-123",
          issueId: "issue-123",
          issueIdentifier: "ENG-123",
          issueUrl: "https://linear.app/org/issue/ENG-123/test",
          agentSessionId: "session-123",
          deliveryLoopOptIn: true,
          deliveryPlanApprovalPolicy: "human_required",
        },
      });
      await waitUntilResolvedBestEffort();

      const workflow = await getActiveWorkflowForThread({ db, threadId });
      expect(workflow).toBeDefined();
      expect(workflow?.kind).toBe("planning");
      expect(workflow?.planApprovalPolicy).toBe("human_required");
    });

    it("does not enroll workflow for linear threads when delivery loop is off", async () => {
      await mockWaitUntil();
      const { threadId } = await createNewThread({
        userId: user.id,
        message: mockMessage,
        githubRepoFullName: repoFullName,
        baseBranchName: "main",
        sourceType: "linear-mention",
        sourceMetadata: {
          type: "linear-mention",
          organizationId: "org-123",
          issueId: "issue-124",
          issueIdentifier: "ENG-124",
          issueUrl: "https://linear.app/org/issue/ENG-124/test",
          agentSessionId: "session-124",
        },
      });
      await waitUntilResolvedBestEffort();

      const workflow = await getActiveWorkflowForThread({ db, threadId });
      expect(workflow).toBeUndefined();
    });
  });
});
