import { execSync } from "node:child_process";
import { DBUserMessage, User } from "@terragon/shared";
import { createTestUser } from "@terragon/shared/model/test-helpers";
import { getThread } from "@terragon/shared/model/threads";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { mockWaitUntil, waitUntilResolved } from "@/test-helpers/mock-next";
import { createNewThread } from "./new-thread-shared";

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
  });
});
