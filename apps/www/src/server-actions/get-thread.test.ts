import { describe, it, vi, beforeEach, expect } from "vitest";
import { getThreadAction as getThreadActionServerAction } from "./get-thread";
import { db } from "@/lib/db";
import {
  createTestUser,
  createTestThread,
} from "@leo/shared/model/test-helpers";
import { mockLoggedInUser, mockLoggedOutUser } from "@/test-helpers/mock-next";
import { User, Session } from "@leo/shared";
import { getOctokitForUser } from "@/lib/github";
import { unwrapResult } from "@/lib/server-actions";
import { updateThreadVisibility } from "@leo/shared/model/thread-visibility";

const getThreadAction = async (threadId: string) => {
  return unwrapResult(await getThreadActionServerAction(threadId));
};

describe("getThreadAction", () => {
  let user: User;
  let session: Session;
  let otherUserSession: Session;
  let threadId: string;

  beforeEach(async () => {
    vi.clearAllMocks();

    const [testUserResult, otherUserResult] = await Promise.all([
      createTestUser({ db }),
      createTestUser({ db }),
    ]);
    user = testUserResult.user;
    session = testUserResult.session;
    const createTestThreadResult = await createTestThread({
      db,
      userId: user.id,
    });
    threadId = createTestThreadResult.threadId;
    otherUserSession = otherUserResult.session;
  });

  it("should throw error when user is not authenticated", async () => {
    await mockLoggedOutUser();
    await expect(getThreadAction(threadId)).rejects.toThrow("Unauthorized");
  });

  describe("task sharing behavior", () => {
    describe("private visibility", () => {
      it("should return thread for owner", async () => {
        await mockLoggedInUser(session);
        const result = await getThreadAction(threadId);
        expect(result).toBeDefined();
        expect(result!.id).toBe(threadId);
      });

      it("should throw error for non-owner", async () => {
        await mockLoggedInUser(otherUserSession);
        await expect(getThreadAction(threadId)).rejects.toThrow("Unauthorized");
      });
    });

    describe("link visibility", () => {
      it("should return thread for any authenticated user", async () => {
        await updateThreadVisibility({
          db,
          userId: user.id,
          threadId,
          visibility: "link",
        });
        await mockLoggedInUser(otherUserSession);
        const result = await getThreadAction(threadId);
        expect(result).toBeDefined();
        expect(result!.id).toBe(threadId);
      });

      it("should return thread for owner", async () => {
        await mockLoggedInUser(session);
        const result = await getThreadAction(threadId);
        expect(result).toBeDefined();
        expect(result!.id).toBe(threadId);
      });
    });

    describe("repo visibility", () => {
      const mockOctokit = {
        rest: {
          repos: {
            get: vi.fn(),
          },
        },
      };
      it("should return thread for user with repo access", async () => {
        await updateThreadVisibility({
          db,
          userId: user.id,
          threadId,
          visibility: "repo",
        });
        await mockLoggedInUser(otherUserSession);
        vi.mocked(getOctokitForUser).mockResolvedValue(mockOctokit as any);
        mockOctokit.rest.repos.get.mockResolvedValue({
          data: {
            permissions: {
              admin: true,
              push: true,
              pull: true,
            },
          },
        });

        const result = await getThreadAction(threadId);
        expect(result).toBeDefined();
        expect(result!.id).toBe(threadId);
        expect(mockOctokit.rest.repos.get).toHaveBeenCalledWith({
          owner: "leo",
          repo: "test-repo",
        });
      });

      it("should throw error when user has no octokit", async () => {
        await mockLoggedInUser(otherUserSession);
        vi.mocked(getOctokitForUser).mockResolvedValue(null);
        await expect(getThreadAction(threadId)).rejects.toThrow("Unauthorized");
      });

      it("should throw error when user has no permissions", async () => {
        await mockLoggedInUser(otherUserSession);
        vi.mocked(getOctokitForUser).mockResolvedValue(mockOctokit as any);
        mockOctokit.rest.repos.get.mockResolvedValue({
          data: {
            permissions: null,
          },
        });
        await expect(getThreadAction(threadId)).rejects.toThrow("Unauthorized");
      });
    });

    it("should throw error when thread is not found", async () => {
      await mockLoggedInUser(session);
      await expect(getThreadAction("non-existent-thread-id")).rejects.toThrow(
        "Unauthorized",
      );
    });
  });
});
