import { describe, it, vi, beforeEach, beforeAll, expect } from "vitest";
import { newThreadInternal } from "./new-thread-internal";
import { db } from "@/lib/db";
import { createTestUser } from "@leo/shared/model/test-helpers";
import { User, DBUserMessage } from "@leo/shared";
import { mockWaitUntil, waitUntilResolved } from "@/test-helpers/mock-next";
import { getThread } from "@leo/shared/model/threads";
import { execSync } from "node:child_process";

const repoFullName = "leo/test-repo";
const mockMessage: DBUserMessage = {
  type: "user",
  parts: [{ type: "text", text: "Internal task message" }],
  model: "sonnet",
};

async function waitUntilResolvedBestEffort() {
  await Promise.race([
    waitUntilResolved(),
    new Promise((resolve) => setTimeout(resolve, 1_000)),
  ]);
}

describe("newThreadInternal", { timeout: 30_000 }, () => {
  let user: User;

  beforeAll(() => {
    execSync("docker restart leo_redis_http_test", { stdio: "ignore" });
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    const testUserResult = await createTestUser({ db });
    user = testUserResult.user;
  });

  describe("basic thread creation", () => {
    it("should create thread with baseBranchName", async () => {
      await mockWaitUntil();
      const { threadId } = await newThreadInternal({
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

    it("should create thread with headBranchName", async () => {
      await mockWaitUntil();
      const { threadId } = await newThreadInternal({
        userId: user.id,
        message: mockMessage,
        githubRepoFullName: repoFullName,
        baseBranchName: "main",
        headBranchName: "feature/webhook",
        sourceType: "www",
      });
      await waitUntilResolvedBestEffort();

      const thread = await getThread({ db, userId: user.id, threadId });
      expect(thread).toBeDefined();
      expect(thread!.repoBaseBranchName).toBe("main");
      expect(thread!.branchName).toBe("feature/webhook");
    });

    it("should use default branch when baseBranchName is undefined", async () => {
      await mockWaitUntil();
      const { threadId } = await newThreadInternal({
        userId: user.id,
        message: mockMessage,
        githubRepoFullName: repoFullName,
        sourceType: "www",
      });
      await waitUntilResolvedBestEffort();
      const thread = await getThread({ db, userId: user.id, threadId });
      expect(thread!.repoBaseBranchName).toBe("DEFAULT_BRANCH_NAME_FOR_TESTS");
    });
  });
});
