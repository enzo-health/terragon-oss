import { beforeEach, describe, expect, it, vi } from "vitest";
import { routeGithubFeedbackOrSpawnThread } from "./route-feedback";
import {
  getGithubPR,
  getThreadForGithubPRAndUser,
  getThreadsForGithubPR,
} from "@terragon/shared/model/github";
import { queueFollowUpInternal } from "@/server-lib/follow-up";
import { maybeBatchThreads } from "@/lib/batch-threads";
import { newThreadInternal } from "@/server-lib/new-thread-internal";
import { getUserIdByGitHubAccountId } from "@terragon/shared/model/user";
import { getOctokitForApp } from "@/lib/github";

const postHogCapture = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {},
}));

vi.mock("@terragon/shared/model/github", () => ({
  getGithubPR: vi.fn(),
  getThreadForGithubPRAndUser: vi.fn(),
  getThreadsForGithubPR: vi.fn(),
}));

vi.mock("@/server-lib/follow-up", () => ({
  queueFollowUpInternal: vi.fn(),
}));

vi.mock("@/lib/batch-threads", () => ({
  maybeBatchThreads: vi.fn(),
}));

vi.mock("@/server-lib/new-thread-internal", () => ({
  newThreadInternal: vi.fn(),
}));

vi.mock("@terragon/shared/model/user", () => ({
  getUserIdByGitHubAccountId: vi.fn(),
}));

vi.mock("@/lib/github", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/github")>("@/lib/github");
  return {
    ...actual,
    getOctokitForApp: vi.fn(),
  };
});

vi.mock("@/lib/posthog-server", () => ({
  getPostHogServer: () => ({
    capture: postHogCapture,
  }),
}));

describe("routeGithubFeedbackOrSpawnThread", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getGithubPR).mockResolvedValue(undefined);
    vi.mocked(getThreadsForGithubPR).mockResolvedValue([]);
    vi.mocked(getThreadForGithubPRAndUser).mockResolvedValue(null);
    vi.mocked(getUserIdByGitHubAccountId).mockResolvedValue(undefined);
    vi.mocked(queueFollowUpInternal).mockResolvedValue(undefined);
    vi.mocked(newThreadInternal).mockResolvedValue({
      threadId: "new-thread-id",
      threadChatId: "new-thread-chat-id",
    });
    vi.mocked(maybeBatchThreads).mockImplementation(
      async ({ createNewThread }) => {
        const created = await createNewThread();
        return {
          ...created,
          didCreateNewThread: true,
        };
      },
    );
    vi.mocked(getOctokitForApp).mockResolvedValue({
      rest: {
        pulls: {
          get: vi.fn().mockResolvedValue({
            data: {
              base: { ref: "main" },
              head: { ref: "feature/feedback" },
              user: { id: 12345 },
            },
          }),
        },
      },
    } as unknown as Awaited<ReturnType<typeof getOctokitForApp>>);
  });

  it("reuses existing thread chat when available", async () => {
    vi.mocked(getThreadsForGithubPR).mockResolvedValue([
      { id: "thread-1", userId: "user-1", archived: false },
    ]);
    vi.mocked(getThreadForGithubPRAndUser).mockResolvedValue({
      id: "thread-1",
      threadChats: [{ id: "chat-1" }],
    } as NonNullable<Awaited<ReturnType<typeof getThreadForGithubPRAndUser>>>);

    const result = await routeGithubFeedbackOrSpawnThread({
      repoFullName: "owner/repo",
      prNumber: 42,
      eventType: "pull_request_review.submitted",
      reviewBody: "Please use the shared helper.",
      baseBranchName: "main",
      headBranchName: "feature/feedback",
    });

    expect(result).toEqual({
      threadId: "thread-1",
      threadChatId: "chat-1",
      mode: "reused_existing",
      reason: "existing-unarchived-thread",
    });
    expect(queueFollowUpInternal).toHaveBeenCalledTimes(1);
    expect(maybeBatchThreads).not.toHaveBeenCalled();
  });

  it("spawns a new thread when no resumable thread exists", async () => {
    vi.mocked(getUserIdByGitHubAccountId).mockResolvedValue("user-1");

    const result = await routeGithubFeedbackOrSpawnThread({
      repoFullName: "owner/repo",
      prNumber: 42,
      eventType: "check_run.completed",
      checkSummary: "CI failed",
      failureDetails: "2 tests failed.",
    });

    expect(result).toEqual({
      threadId: "new-thread-id",
      threadChatId: "new-thread-chat-id",
      mode: "spawned_new",
      reason: "pr-author-fallback",
    });
    expect(newThreadInternal).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        githubRepoFullName: "owner/repo",
        githubPRNumber: 42,
        baseBranchName: "main",
        headBranchName: "feature/feedback",
        sourceType: "automation",
      }),
    );
  });

  it("uses provided PR author id when branch names are supplied", async () => {
    vi.mocked(getUserIdByGitHubAccountId).mockResolvedValue("user-1");

    await routeGithubFeedbackOrSpawnThread({
      repoFullName: "owner/repo",
      prNumber: 42,
      eventType: "pull_request_review_comment.created",
      reviewBody: "please update this logic",
      baseBranchName: "main",
      headBranchName: "feature/feedback",
      authorGitHubAccountId: 98765,
    });

    expect(getUserIdByGitHubAccountId).toHaveBeenCalledWith({
      db: expect.any(Object),
      accountId: "98765",
    });
    expect(getOctokitForApp).not.toHaveBeenCalled();
  });

  it("falls back to spawn when queueing follow-up fails", async () => {
    vi.mocked(getThreadsForGithubPR).mockResolvedValue([
      { id: "thread-1", userId: "user-1", archived: false },
    ]);
    vi.mocked(getThreadForGithubPRAndUser).mockResolvedValue({
      id: "thread-1",
      threadChats: [{ id: "chat-1" }],
    } as NonNullable<Awaited<ReturnType<typeof getThreadForGithubPRAndUser>>>);
    vi.mocked(queueFollowUpInternal).mockRejectedValue(
      new Error("Thread chat not found"),
    );

    const result = await routeGithubFeedbackOrSpawnThread({
      repoFullName: "owner/repo",
      prNumber: 42,
      eventType: "pull_request_review_comment.created",
      reviewBody: "nit: can we simplify this block?",
      commentId: 999,
      baseBranchName: "main",
      headBranchName: "feature/feedback",
    });

    expect(result.mode).toBe("spawned_new");
    expect(result.threadId).toBe("new-thread-id");
    expect(maybeBatchThreads).toHaveBeenCalledTimes(1);
    expect(maybeBatchThreads).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        batchKey: "github-feedback:owner/repo:42",
        maxWaitTimeMs: 5000,
      }),
    );
  });

  it("returns reused_existing when batching reuses another request's thread", async () => {
    vi.mocked(getUserIdByGitHubAccountId).mockResolvedValue("user-1");
    vi.mocked(maybeBatchThreads).mockResolvedValue({
      threadId: "shared-thread-id",
      threadChatId: "shared-thread-chat-id",
      didCreateNewThread: false,
    });

    const result = await routeGithubFeedbackOrSpawnThread({
      repoFullName: "owner/repo",
      prNumber: 42,
      eventType: "check_run.completed",
      checkSummary: "CI failed",
      failureDetails: "2 tests failed.",
    });

    expect(result).toEqual({
      threadId: "shared-thread-id",
      threadChatId: "shared-thread-chat-id",
      mode: "reused_existing",
      reason: "batched-existing-thread",
    });
    expect(newThreadInternal).not.toHaveBeenCalled();
  });

  it("throws when queue miss and spawn fallback both fail", async () => {
    vi.mocked(getThreadsForGithubPR).mockResolvedValue([
      { id: "thread-1", userId: "user-1", archived: false },
    ]);
    vi.mocked(getThreadForGithubPRAndUser).mockResolvedValue({
      id: "thread-1",
      threadChats: [{ id: "chat-1" }],
    } as NonNullable<Awaited<ReturnType<typeof getThreadForGithubPRAndUser>>>);
    vi.mocked(queueFollowUpInternal).mockRejectedValue(
      new Error("Thread chat not found"),
    );
    vi.mocked(maybeBatchThreads).mockRejectedValue(
      new Error("Failed to create thread"),
    );

    await expect(
      routeGithubFeedbackOrSpawnThread({
        repoFullName: "owner/repo",
        prNumber: 42,
        eventType: "check_run.completed",
        checkSummary: "CI failed",
        failureDetails: "Failed to create thread",
        baseBranchName: "main",
        headBranchName: "feature/feedback",
      }),
    ).rejects.toThrow(
      "Failed to route GitHub feedback for owner/repo#42: Failed to create thread",
    );
    expect(postHogCapture).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "github_feedback_routing_failed",
        properties: expect.objectContaining({
          reason: "spawn-failed",
          eventType: "check_run.completed",
          repoFullName: "owner/repo",
          prNumber: 42,
        }),
      }),
    );
  });
});
