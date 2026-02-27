import { describe, it, vi, beforeEach, expect } from "vitest";
import { newThread } from "./new-thread";
import { db } from "@/lib/db";
import { createTestUser } from "@terragon/shared/model/test-helpers";
import { User, Session, DBUserMessage } from "@terragon/shared";
import {
  mockLoggedInUser,
  mockWaitUntil,
  waitUntilResolved,
} from "@/test-helpers/mock-next";
import { getThread } from "@terragon/shared/model/threads";
import { unwrapResult } from "@/lib/server-actions";

const repoFullName = "terragon/test-repo";
const mockMessage: DBUserMessage = {
  type: "user",
  parts: [{ type: "text", text: "Test task message" }],
  model: "sonnet",
};

describe("newThread", () => {
  let user: User;
  let session: Session;

  beforeEach(async () => {
    vi.clearAllMocks();
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
      await waitUntilResolved();

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
      await waitUntilResolved();

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
      await waitUntilResolved();

      const thread = await getThread({ db, userId: user.id, threadId });
      expect(thread).toBeDefined();
      expect(thread!.repoBaseBranchName).toBe("main");
      expect(thread!.branchName).toBeNull();
    });

    it("should default SDLC loop opt-in metadata to true for new dashboard tasks", async () => {
      await mockWaitUntil();
      await mockLoggedInUser(session);

      const result = await newThread({
        message: mockMessage,
        githubRepoFullName: repoFullName,
        branchName: "main",
      });
      const { threadId } = unwrapResult(result);
      await waitUntilResolved();

      const thread = await getThread({ db, userId: user.id, threadId });
      expect(thread).toBeDefined();
      expect(thread!.sourceType).toBe("www");
      expect(thread!.sourceMetadata).toEqual({
        type: "www",
        sdlcLoopOptIn: true,
      });
    });

    it("should persist SDLC loop opt-in metadata for new dashboard tasks", async () => {
      await mockWaitUntil();
      await mockLoggedInUser(session);

      const result = await newThread({
        message: mockMessage,
        githubRepoFullName: repoFullName,
        branchName: "main",
        runInSdlcLoop: true,
      });
      const { threadId } = unwrapResult(result);
      await waitUntilResolved();

      const thread = await getThread({ db, userId: user.id, threadId });
      expect(thread).toBeDefined();
      expect(thread!.sourceType).toBe("www");
      expect(thread!.sourceMetadata).toEqual({
        type: "www",
        sdlcLoopOptIn: true,
      });
    });
  });
});
