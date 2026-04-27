import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server-lib/new-threads-multi-model", async () => {
  const actual = await vi.importActual<
    typeof import("@/server-lib/new-threads-multi-model")
  >("@/server-lib/new-threads-multi-model");
  return {
    ...actual,
    newThreadsMultiModel: vi.fn().mockResolvedValue({
      createdThreads: [],
      failedModels: [],
    }),
  };
});

import { execSync } from "node:child_process";
import { DBUserMessage, Session, User } from "@terragon/shared";
import { createTestUser } from "@terragon/shared/model/test-helpers";
import { getThread } from "@terragon/shared/model/threads";
import { db } from "@/lib/db";
import { unwrapResult } from "@/lib/server-actions";
import { newThreadsMultiModel } from "@/server-lib/new-threads-multi-model";
import {
  mockLoggedInUser,
  mockWaitUntil,
  waitUntilResolved,
} from "@/test-helpers/mock-next";
import { newThread } from "./new-thread";

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

describe("newThread", { timeout: 30_000 }, () => {
  let user: User;
  let session: Session;

  beforeAll(() => {
    execSync("docker restart terragon_redis_http_test", { stdio: "ignore" });
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(newThreadsMultiModel).mockResolvedValue({
      createdThreads: [],
      failedModels: [],
    });
    const testUserResult = await createTestUser({ db });
    user = testUserResult.user;
    session = testUserResult.session;
  });

  describe("createNewBranch parameter behavior", () => {
    it("should create thread with baseBranchName when createNewBranch=true", async () => {
      await mockWaitUntil();
      await mockLoggedInUser(session);

      const result = await newThread({
        message: mockMessage,
        githubRepoFullName: repoFullName,
        branchName: "develop",
        createNewBranch: true,
      });
      const { threadId } = unwrapResult(result);
      await waitUntilResolvedBestEffort();

      const thread = await getThread({ db, userId: user.id, threadId });
      expect(thread).toBeDefined();
      expect(thread!.repoBaseBranchName).toBe("develop");
      expect(thread!.branchName).toBeNull();
    });

    it("should create thread with headBranchName when createNewBranch=false", async () => {
      await mockWaitUntil();
      await mockLoggedInUser(session);

      const result = await newThread({
        message: mockMessage,
        githubRepoFullName: repoFullName,
        branchName: "feature/test-branch",
        createNewBranch: false,
      });
      const { threadId } = unwrapResult(result);
      await waitUntilResolvedBestEffort();

      const thread = await getThread({ db, userId: user.id, threadId });
      expect(thread).toBeDefined();
      expect(thread!.repoBaseBranchName).toBe("DEFAULT_BRANCH_NAME_FOR_TESTS");
      expect(thread!.branchName).toBe("feature/test-branch");
    });

    it("should default to createNewBranch=true when not specified", async () => {
      await mockWaitUntil();
      await mockLoggedInUser(session);

      const result = await newThread({
        message: mockMessage,
        githubRepoFullName: repoFullName,
        branchName: "main",
      });
      const { threadId } = unwrapResult(result);
      await waitUntilResolvedBestEffort();

      const thread = await getThread({ db, userId: user.id, threadId });
      expect(thread).toBeDefined();
      expect(thread!.repoBaseBranchName).toBe("main");
      expect(thread!.branchName).toBeNull();
    });

    it("stores minimal source metadata for new dashboard tasks", async () => {
      await mockWaitUntil();
      await mockLoggedInUser(session);

      const result = await newThread({
        message: mockMessage,
        githubRepoFullName: repoFullName,
        branchName: "main",
      });
      const { threadId } = unwrapResult(result);
      await waitUntilResolvedBestEffort();

      const thread = await getThread({ db, userId: user.id, threadId });
      expect(thread).toBeDefined();
      expect(thread!.sourceType).toBe("www");
      expect(thread!.sourceMetadata).toEqual({
        type: "www",
      });
    });

    it("returns created thread summaries for optimistic reconciliation", async () => {
      await mockWaitUntil();
      await mockLoggedInUser(session);

      const result = await newThread({
        message: mockMessage,
        githubRepoFullName: repoFullName,
        branchName: "main",
      });
      const data = unwrapResult(result);

      expect(data.createdThreads).toEqual([
        {
          threadId: data.threadId,
          threadChatId: data.threadChatId,
          model: "sonnet",
        },
      ]);
      expect(data.failedModels).toEqual([]);
    });

    it("preserves the primary thread when additional model creation partially fails", async () => {
      await mockWaitUntil();
      await mockLoggedInUser(session);
      vi.mocked(newThreadsMultiModel).mockResolvedValue({
        createdThreads: [
          {
            threadId: "thread-additional",
            threadChatId: "thread-chat-additional",
            model: "gpt-5.4",
          },
        ],
        failedModels: [
          {
            model: "gemini-2.5-pro",
            errorMessage: "rate limited",
          },
        ],
      });

      const result = await newThread({
        message: mockMessage,
        githubRepoFullName: repoFullName,
        branchName: "main",
        selectedModels: {
          sonnet: 1,
          "gpt-5.4": 1,
          "gemini-2.5-pro": 1,
        },
      });
      const data = unwrapResult(result);

      expect(data.createdThreads).toEqual([
        {
          threadId: data.threadId,
          threadChatId: data.threadChatId,
          model: "sonnet",
        },
        {
          threadId: "thread-additional",
          threadChatId: "thread-chat-additional",
          model: "gpt-5.4",
        },
      ]);
      expect(data.failedModels).toEqual([
        {
          model: "gemini-2.5-pro",
          errorMessage: "rate limited",
        },
      ]);
    });
  });
});
