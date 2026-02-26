import { describe, expect, it, vi, beforeEach, beforeAll } from "vitest";
import { NextRequest } from "next/server";
import crypto from "crypto";
import { POST } from "./route";
import { createMockNextRequest } from "@/test-helpers/mock-next";
import { db } from "@/lib/db";
import { getOctokitForApp, updateGitHubPR } from "@/lib/github";
import { handleAppMention } from "./handle-app-mention";
import { routeGithubFeedbackOrSpawnThread } from "./route-feedback";
import {
  createTestUser,
  createTestGitHubPR,
} from "@terragon/shared/model/test-helpers";
import { getActiveSdlcLoopsForGithubPR } from "@terragon/shared/model/sdlc-loop";
import * as schema from "@terragon/shared/db/schema";
import { eq } from "drizzle-orm";
import { env } from "@terragon/env/apps-www";

vi.mock("./handle-app-mention", () => ({
  handleAppMention: vi.fn(),
}));

vi.mock("./route-feedback", () => ({
  routeGithubFeedbackOrSpawnThread: vi.fn().mockResolvedValue({
    threadId: "feedback-thread-id",
    threadChatId: "feedback-thread-chat-id",
    mode: "reused_existing",
  }),
}));

vi.mock("@terragon/shared/model/sdlc-loop", async () => {
  const actual = await vi.importActual<
    typeof import("@terragon/shared/model/sdlc-loop")
  >("@terragon/shared/model/sdlc-loop");
  return {
    ...actual,
    getActiveSdlcLoopsForGithubPR: vi.fn(),
  };
});

function createSignature(payload: string, secret: string): string {
  const hmac = crypto.createHmac("sha256", secret);
  return `sha256=${hmac.update(payload).digest("hex")}`;
}

async function createMockRequest(
  body: any,
  customHeaders: Record<string, string> = {},
): Promise<NextRequest> {
  const payload = JSON.stringify(body);
  const deliveryId = customHeaders["x-github-delivery"] ?? crypto.randomUUID();
  const signature =
    customHeaders["x-hub-signature-256"] ||
    createSignature(payload, env.GITHUB_WEBHOOK_SECRET);
  return await createMockNextRequest(body, {
    "x-github-delivery": deliveryId,
    "x-hub-signature-256": signature,
    "x-github-event": "pull_request",
    ...customHeaders,
  });
}

function createPullRequestBody({
  action,
  repoFullName,
  prNumber,
  githubAccountId = 123,
}: {
  action: string;
  repoFullName: string;
  prNumber: number;
  githubAccountId?: number;
}) {
  return {
    action,
    pull_request: {
      id: 1,
      number: prNumber,
      state: "open",
      draft: false,
      merged: false,
      html_url: `https://github.com/${repoFullName}/pull/${prNumber}`,
      user: { login: "user", id: githubAccountId },
    },
    repository: {
      full_name: repoFullName,
      owner: {
        login: "owner",
        id: githubAccountId,
      },
      name: "repo",
    },
  };
}

describe("GitHub webhook route", () => {
  let githubAccountId: number;

  beforeAll(async () => {
    const testUserResult = await createTestUser({ db });
    githubAccountId = parseInt(testUserResult.githubAccount.id);
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(updateGitHubPR).mockResolvedValue();
    vi.mocked(getOctokitForApp).mockResolvedValue(
      undefined as unknown as Awaited<ReturnType<typeof getOctokitForApp>>,
    );
    vi.mocked(getActiveSdlcLoopsForGithubPR).mockResolvedValue([]);
  });

  describe("webhook validation", () => {
    it("should return 401 for invalid signature", async () => {
      const request = await createMockRequest(
        { action: "opened" },
        { "x-hub-signature-256": "sha256=000" },
      );
      const response = await POST(request);
      const data = await response.json();
      expect(response.status).toBe(401);
      expect(data.error).toBe("Invalid signature");
    });

    it("should accept valid signature", async () => {
      const request = await createMockRequest({
        action: "opened",
        pull_request: { number: 123 },
        repository: { full_name: "owner/repo" },
      });
      const response = await POST(request);
      const data = await response.json();
      expect(response.status).toBe(202);
      expect(data.claimOutcome).toBe("claimed_new");
    });

    it("should return already_completed for duplicate delivery IDs", async () => {
      const body = {
        action: "opened",
        pull_request: { number: 123 },
        repository: { full_name: "owner/repo" },
      };

      const firstRequest = await createMockRequest(body, {
        "x-github-delivery": "duplicate-delivery-id",
      });
      const firstResponse = await POST(firstRequest);
      const firstData = await firstResponse.json();

      const secondRequest = await createMockRequest(body, {
        "x-github-delivery": "duplicate-delivery-id",
      });
      const secondResponse = await POST(secondRequest);
      const secondData = await secondResponse.json();

      expect(firstResponse.status).toBe(202);
      expect(firstData.claimOutcome).toBe("claimed_new");
      expect(secondResponse.status).toBe(200);
      expect(secondData.claimOutcome).toBe("already_completed");
    });

    it("returns accepted no-op while a matching delivery is still in progress", async () => {
      const now = new Date();
      await db.insert(schema.githubWebhookDeliveries).values({
        deliveryId: "delivery-in-progress",
        claimantToken: "claimer-1",
        claimExpiresAt: new Date(now.getTime() + 5 * 60 * 1000),
        eventType: "pull_request.opened",
        createdAt: now,
        updatedAt: now,
      });

      const request = await createMockRequest(
        {
          action: "opened",
          pull_request: { number: 123 },
          repository: { full_name: "owner/repo" },
        },
        {
          "x-github-delivery": "delivery-in-progress",
        },
      );
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(202);
      expect(data).toEqual({
        success: true,
        claimOutcome: "in_progress_fresh",
      });
      expect(updateGitHubPR).not.toHaveBeenCalled();
    });
  });

  describe("PR processing", () => {
    it("should process relevant PR actions", async () => {
      const pr = await createTestGitHubPR({ db });
      const relevantActions = [
        "opened",
        "closed",
        "reopened",
        "ready_for_review",
        "converted_to_draft",
      ];

      for (const action of relevantActions) {
        const body = createPullRequestBody({
          action,
          repoFullName: pr.repoFullName,
          prNumber: pr.number,
        });
        const request = await createMockRequest(body);

        const response = await POST(request);
        const data = await response.json();

        expect(response.status).toBe(202);
        expect(data.success).toBe(true);
        expect(updateGitHubPR).toHaveBeenCalledWith({
          repoFullName: pr.repoFullName,
          prNumber: pr.number,
          createIfNotFound: false,
        });
      }
    });

    it("should handle draft PR being closed", async () => {
      // Create a test PR in the database
      const pr = await createTestGitHubPR({ db });
      const body = createPullRequestBody({
        action: "closed",
        repoFullName: pr.repoFullName,
        prNumber: pr.number,
      });
      const request = await createMockRequest(body);
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(202);
      expect(data.success).toBe(true);
      expect(updateGitHubPR).toHaveBeenCalledWith({
        repoFullName: pr.repoFullName,
        prNumber: pr.number,
        createIfNotFound: false,
      });
    });

    it("should handle PR not found in database", async () => {
      // Don't create a PR in the database to test the not found case
      // Use a different PR number that definitely doesn't exist
      const nonExistentPRBody = createPullRequestBody({
        action: "opened",
        repoFullName: "owner/repo",
        prNumber: 999999,
      });
      const request = await createMockRequest(nonExistentPRBody);
      const response = await POST(request);
      const data = await response.json();
      expect(response.status).toBe(202);
      expect(data.success).toBe(true);
      expect(updateGitHubPR).not.toHaveBeenCalled();
    });

    it("should return 500 for unexpected errors", async () => {
      const pr = await createTestGitHubPR({ db });
      const body = createPullRequestBody({
        action: "opened",
        repoFullName: pr.repoFullName,
        prNumber: pr.number,
      });
      const request = await createMockRequest(body);
      // Mock updateGitHubPR to throw an error instead
      vi.mocked(updateGitHubPR).mockRejectedValue(new Error("Database error"));
      const response = await POST(request);
      const data = await response.json();
      expect(response.status).toBe(500);
      expect(data.error).toBe("Internal server error");
    });

    it("releases failed claims so duplicate delivery retries can process immediately", async () => {
      const pr = await createTestGitHubPR({ db });
      const deliveryId = "retry-after-receive-error";
      const body = createPullRequestBody({
        action: "opened",
        repoFullName: pr.repoFullName,
        prNumber: pr.number,
      });

      vi.mocked(updateGitHubPR)
        .mockRejectedValueOnce(new Error("handler exploded"))
        .mockResolvedValueOnce();

      const firstRequest = await createMockRequest(body, {
        "x-github-delivery": deliveryId,
      });
      const firstResponse = await POST(firstRequest);
      const firstData = await firstResponse.json();
      expect(firstResponse.status).toBe(500);
      expect(firstData.error).toBe("Internal server error");

      const secondRequest = await createMockRequest(body, {
        "x-github-delivery": deliveryId,
      });
      const secondResponse = await POST(secondRequest);
      const secondData = await secondResponse.json();

      expect(secondResponse.status).toBe(202);
      expect(secondData.success).toBe(true);
      expect(secondData.claimOutcome).toBe("stale_stolen");
      expect(updateGitHubPR).toHaveBeenCalledTimes(2);
    });

    it("returns 500 when webhook delivery completion loses claim ownership", async () => {
      const pr = await createTestGitHubPR({ db });
      const deliveryId = "claim-lost-before-complete";
      const body = createPullRequestBody({
        action: "opened",
        repoFullName: pr.repoFullName,
        prNumber: pr.number,
      });

      vi.mocked(updateGitHubPR).mockImplementationOnce(async () => {
        await db
          .update(schema.githubWebhookDeliveries)
          .set({ claimantToken: "different-claimer-token" })
          .where(eq(schema.githubWebhookDeliveries.deliveryId, deliveryId));
      });

      const request = await createMockRequest(body, {
        "x-github-delivery": deliveryId,
      });
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data).toEqual({
        success: false,
        error: "Failed to complete GitHub webhook delivery claim",
        claimOutcome: "claimed_new",
      });
    });
  });

  describe("issue comment events (PR comment flow)", () => {
    function createValidIssueCommentBody({
      action = "created",
      repoFullName = "owner/repo",
      prNumber = 123,
      commentId,
      githubAccountId,
      commentBody,
      isPullRequest = true,
      issueTitle = "Default Issue Title",
      issueBody = "Default issue body description",
    }: {
      action?: "created" | "edited" | "deleted";
      repoFullName?: string;
      prNumber?: number;
      commentId?: number;
      githubAccountId: number | undefined;
      commentBody: string;
      isPullRequest?: boolean;
      issueTitle?: string;
      issueBody?: string | null;
    }) {
      return {
        action,
        issue: {
          number: prNumber,
          title: issueTitle,
          body: issueBody,
          pull_request: isPullRequest
            ? {
                url: `https://api.github.com/repos/${repoFullName}/pulls/${prNumber}`,
              }
            : undefined,
        },
        comment: {
          id: commentId,
          body: commentBody,
          user: {
            login: "commenter",
            id: githubAccountId,
          },
        },
        repository: {
          full_name: repoFullName,
          owner: {
            login: "owner",
            id: githubAccountId,
          },
          name: "repo",
        },
      };
    }

    it("should process app mentions in PR comments", async () => {
      const request = await createMockRequest(
        createValidIssueCommentBody({
          repoFullName: "owner/repo",
          prNumber: 123,
          githubAccountId,
          commentBody: "Hey @test-app, can you help fix this issue?",
        }),
        {
          "x-github-event": "issue_comment",
        },
      );

      const response = await POST(request);
      const data = await response.json();
      expect(response.status).toBe(202);
      expect(data.success).toBe(true);
      expect(handleAppMention).toHaveBeenCalledWith({
        repoFullName: "owner/repo",
        issueOrPrNumber: 123,
        issueOrPrType: "pull_request",
        commentId: undefined,
        commentGitHubUsername: "commenter",
        commentBody: "Hey @test-app, can you help fix this issue?",
        commentGitHubAccountId: githubAccountId,
        commentType: "issue_comment",
        issueContext: undefined,
      });
    });

    it("should ignore comments without app mention", async () => {
      const bodyWithoutMention = createValidIssueCommentBody({
        repoFullName: "owner/repo",
        prNumber: 123,
        githubAccountId,
        commentBody:
          "This is just a regular comment without mentioning the app",
      });

      const request = await createMockRequest(bodyWithoutMention, {
        "x-github-event": "issue_comment",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(202);
      expect(data.success).toBe(true);
      expect(handleAppMention).not.toHaveBeenCalled();
    });

    it("should ignore edited or deleted comments", async () => {
      const editedCommentBody = createValidIssueCommentBody({
        action: "edited",
        commentBody: "Hey @test-app, can you help fix this issue?",
        githubAccountId,
      });
      const request = await createMockRequest(editedCommentBody, {
        "x-github-event": "issue_comment",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(202);
      expect(data.success).toBe(true);
      expect(handleAppMention).not.toHaveBeenCalled();
    });

    it("should handle comments on issues (not PRs)", async () => {
      const issueCommentBody = createValidIssueCommentBody({
        repoFullName: "owner/repo",
        prNumber: 123,
        commentId: 123456,
        githubAccountId,
        commentBody: "Hey @test-app, can you help fix this issue?",
        isPullRequest: false,
      });
      const request = await createMockRequest(issueCommentBody, {
        "x-github-event": "issue_comment",
      });
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(202);
      expect(data.success).toBe(true);
      expect(handleAppMention).toHaveBeenCalledWith({
        repoFullName: "owner/repo",
        issueOrPrNumber: 123,
        issueOrPrType: "issue",
        commentId: 123456,
        commentGitHubUsername: "commenter",
        commentBody: "Hey @test-app, can you help fix this issue?",
        commentGitHubAccountId: githubAccountId,
        commentType: "issue_comment",
        issueContext:
          "**Default Issue Title**\n\nDefault issue body description",
      });
    });

    it("should handle comments without user ID", async () => {
      const commentWithoutUserId = createValidIssueCommentBody({
        repoFullName: "owner/repo",
        prNumber: 123,
        githubAccountId: undefined,
        commentBody: "Hey @test-app, please help!",
      });

      const request = await createMockRequest(commentWithoutUserId, {
        "x-github-event": "issue_comment",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(202);
      expect(data.success).toBe(true);
      expect(handleAppMention).toHaveBeenCalledWith({
        repoFullName: "owner/repo",
        issueOrPrNumber: 123,
        issueOrPrType: "pull_request",
        commentId: undefined,
        commentGitHubUsername: "commenter",
        commentBody: "Hey @test-app, please help!",
        commentGitHubAccountId: undefined,
        commentType: "issue_comment",
        issueContext: undefined,
      });
    });

    it("should handle case-insensitive app mentions", async () => {
      const caseInsensitiveMention = createValidIssueCommentBody({
        repoFullName: "owner/repo",
        prNumber: 123,
        githubAccountId,
        commentBody: "Hey @TEST-APP, can you help?",
      });

      const request = await createMockRequest(caseInsensitiveMention, {
        "x-github-event": "issue_comment",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(202);
      expect(data.success).toBe(true);
      expect(handleAppMention).toHaveBeenCalledWith({
        repoFullName: "owner/repo",
        issueOrPrNumber: 123,
        issueOrPrType: "pull_request",
        commentId: undefined,
        commentGitHubUsername: "commenter",
        commentBody: "Hey @TEST-APP, can you help?",
        commentGitHubAccountId: githubAccountId,
        commentType: "issue_comment",
        issueContext: undefined,
      });
    });

    it("should handle multiple mentions in comment", async () => {
      const multipleMentions = createValidIssueCommentBody({
        repoFullName: "owner/repo",
        prNumber: 123,
        githubAccountId,
        commentBody: "@other-user @test-app please review this @test-app",
      });

      const request = await createMockRequest(multipleMentions, {
        "x-github-event": "issue_comment",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(202);
      expect(data.success).toBe(true);
      expect(handleAppMention).toHaveBeenCalledTimes(1);
      expect(handleAppMention).toHaveBeenCalledWith({
        repoFullName: "owner/repo",
        issueOrPrNumber: 123,
        issueOrPrType: "pull_request",
        commentId: undefined,
        commentGitHubUsername: "commenter",
        commentBody: "@other-user @test-app please review this @test-app",
        commentGitHubAccountId: githubAccountId,
        commentType: "issue_comment",
        issueContext: undefined,
      });
    });

    it("should trigger on partial app name matches when app name is a prefix", async () => {
      const partialMatch = createValidIssueCommentBody({
        repoFullName: "owner/repo",
        prNumber: 123,
        githubAccountId,
        commentBody: "This mentions @test-app-other which should trigger",
      });

      const request = await createMockRequest(partialMatch, {
        "x-github-event": "issue_comment",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(202);
      expect(data.success).toBe(true);
      // This will trigger because the regex only has word boundary at the end
      expect(handleAppMention).toHaveBeenCalledWith({
        repoFullName: "owner/repo",
        issueOrPrNumber: 123,
        issueOrPrType: "pull_request",
        commentId: undefined,
        commentGitHubUsername: "commenter",
        commentBody: "This mentions @test-app-other which should trigger",
        commentGitHubAccountId: githubAccountId,
        commentType: "issue_comment",
        issueContext: undefined,
      });
    });

    it("should not trigger when app name is mentioned without @ prefix", async () => {
      const noAtPrefix = createValidIssueCommentBody({
        repoFullName: "owner/repo",
        prNumber: 123,
        githubAccountId,
        commentBody: "Just mentioning test-app without the @ symbol",
      });

      const request = await createMockRequest(noAtPrefix, {
        "x-github-event": "issue_comment",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(202);
      expect(data.success).toBe(true);
      expect(handleAppMention).not.toHaveBeenCalled();
    });

    it("should handle errors in handleAppMention gracefully", async () => {
      vi.mocked(handleAppMention).mockRejectedValue(
        new Error("Failed to create thread"),
      );
      const request = await createMockRequest(
        createValidIssueCommentBody({
          repoFullName: "owner/repo",
          prNumber: 123,
          githubAccountId,
          commentBody: "Hey @test-app, can you help fix this issue?",
        }),
        {
          "x-github-event": "issue_comment",
        },
      );
      const response = await POST(request);
      const data = await response.json();
      // The route should handle the error and return 500
      expect(response.status).toBe(500);
      expect(data.error).toBe("Internal server error");
    });

    it("should pass issue title and body to handleAppMention", async () => {
      vi.mocked(handleAppMention).mockResolvedValue();

      const issueTitle = "Fix authentication bug in login flow";
      const issueBody = "Users are unable to login when using OAuth provider";

      const request = await createMockRequest(
        createValidIssueCommentBody({
          repoFullName: "owner/repo",
          prNumber: 456,
          githubAccountId,
          commentBody: "Hey @test-app, can you help fix this?",
          issueTitle,
          issueBody,
        }),
        {
          "x-github-event": "issue_comment",
        },
      );
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(202);
      expect(data.success).toBe(true);
      expect(handleAppMention).toHaveBeenCalledWith(
        expect.objectContaining({
          repoFullName: "owner/repo",
          issueOrPrNumber: 456,
          issueOrPrType: "pull_request",
          commentGitHubUsername: "commenter",
          commentBody: "Hey @test-app, can you help fix this?",
          commentGitHubAccountId: githubAccountId,
        }),
      );
    });
  });

  describe("pull request review events", () => {
    function createValidPullRequestReviewBody({
      repoFullName,
      prNumber,
      githubAccountId,
      commentBody,
      action = "submitted",
      state = "commented",
      prTitle = "Default PR Title",
      prBody = "Default PR body description",
    }: {
      repoFullName: string;
      prNumber: number;
      githubAccountId: number | null;
      commentBody: string | null;
      action?: "submitted" | "edited" | "dismissed";
      state?: "commented" | "approved" | "changes_requested";
      prTitle?: string;
      prBody?: string | null;
    }) {
      return {
        action,
        review: {
          body: commentBody,
          user: {
            login: "reviewer",
            id: githubAccountId ?? undefined,
          },
          state,
        },
        pull_request: {
          number: prNumber,
          title: prTitle,
          body: prBody,
          user: {
            id: githubAccountId ?? undefined,
          },
        },
        repository: {
          full_name: repoFullName,
          owner: {
            login: "owner",
          },
          name: "repo",
        },
      };
    }

    it("should process app mentions in PR reviews without duplicate feedback routing when not enrolled", async () => {
      vi.mocked(handleAppMention).mockResolvedValue();

      const githubPR = await createTestGitHubPR({ db });
      const deliveryId = "delivery-pr-review-mention";
      const request = await createMockRequest(
        createValidPullRequestReviewBody({
          repoFullName: githubPR.repoFullName,
          prNumber: githubPR.number,
          githubAccountId,
          commentBody: "@test-app please take a look at this PR",
        }),
        {
          "x-github-event": "pull_request_review",
          "x-github-delivery": deliveryId,
        },
      );

      const response = await POST(request);
      const data = await response.json();
      expect(response.status).toBe(202);
      expect(data.success).toBe(true);
      expect(handleAppMention).toHaveBeenCalledWith({
        repoFullName: githubPR.repoFullName,
        issueOrPrNumber: githubPR.number,
        issueOrPrType: "pull_request",
        commentGitHubUsername: "reviewer",
        commentBody: "@test-app please take a look at this PR",
        commentGitHubAccountId: githubAccountId,
      });
      expect(routeGithubFeedbackOrSpawnThread).not.toHaveBeenCalled();
    });

    it("fans out review feedback routing to each enrolled loop user on the PR", async () => {
      const githubPR = await createTestGitHubPR({ db });
      vi.mocked(getActiveSdlcLoopsForGithubPR).mockResolvedValueOnce([
        { id: "loop-1", userId: "loop-user-a" },
        { id: "loop-2", userId: "loop-user-b" },
      ] as Awaited<ReturnType<typeof getActiveSdlcLoopsForGithubPR>>);
      const request = await createMockRequest(
        createValidPullRequestReviewBody({
          repoFullName: githubPR.repoFullName,
          prNumber: githubPR.number,
          githubAccountId,
          commentBody: "LGTM!",
        }),
        {
          "x-github-event": "pull_request_review",
        },
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(202);
      expect(data.success).toBe(true);
      expect(routeGithubFeedbackOrSpawnThread).toHaveBeenCalledTimes(2);
      expect(routeGithubFeedbackOrSpawnThread).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: "loop-user-a",
          repoFullName: githubPR.repoFullName,
          prNumber: githubPR.number,
          eventType: "pull_request_review.submitted",
        }),
      );
      expect(routeGithubFeedbackOrSpawnThread).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: "loop-user-b",
          repoFullName: githubPR.repoFullName,
          prNumber: githubPR.number,
          eventType: "pull_request_review.submitted",
        }),
      );
      expect(handleAppMention).not.toHaveBeenCalled();
    });

    it("passes authoritative unresolved review-thread count when GraphQL data is available", async () => {
      const graphqlMock = vi.fn().mockResolvedValue({
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: {
                hasNextPage: false,
                endCursor: null,
              },
              nodes: [{ isResolved: true }, { isResolved: true }],
            },
          },
        },
      });
      vi.mocked(getOctokitForApp).mockResolvedValue({
        graphql: graphqlMock,
      } as unknown as Awaited<ReturnType<typeof getOctokitForApp>>);

      const githubPR = await createTestGitHubPR({ db });
      const request = await createMockRequest(
        createValidPullRequestReviewBody({
          repoFullName: githubPR.repoFullName,
          prNumber: githubPR.number,
          githubAccountId,
          commentBody: "LGTM!",
          state: "approved",
        }),
        {
          "x-github-event": "pull_request_review",
        },
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(202);
      expect(data.success).toBe(true);
      expect(routeGithubFeedbackOrSpawnThread).toHaveBeenCalledWith(
        expect.objectContaining({
          repoFullName: githubPR.repoFullName,
          prNumber: githubPR.number,
          eventType: "pull_request_review.submitted",
          unresolvedThreadCount: 0,
          unresolvedThreadCountSource: "github_graphql",
        }),
      );
    });

    it("falls back to review-state heuristic when GraphQL review-thread payload is missing", async () => {
      const graphqlMock = vi.fn().mockResolvedValue({
        repository: {
          pullRequest: null,
        },
      });
      vi.mocked(getOctokitForApp).mockResolvedValue({
        graphql: graphqlMock,
      } as unknown as Awaited<ReturnType<typeof getOctokitForApp>>);

      const githubPR = await createTestGitHubPR({ db });
      const request = await createMockRequest(
        createValidPullRequestReviewBody({
          repoFullName: githubPR.repoFullName,
          prNumber: githubPR.number,
          githubAccountId,
          commentBody: "Please address feedback",
          state: "changes_requested",
        }),
        {
          "x-github-event": "pull_request_review",
        },
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(202);
      expect(data.success).toBe(true);
      expect(routeGithubFeedbackOrSpawnThread).toHaveBeenCalledWith(
        expect.objectContaining({
          repoFullName: githubPR.repoFullName,
          prNumber: githubPR.number,
          eventType: "pull_request_review.submitted",
          unresolvedThreadCount: 1,
          unresolvedThreadCountSource: "review_state_heuristic",
        }),
      );
    });

    it("treats review-thread pagination cap as non-authoritative and falls back to review-state heuristic", async () => {
      let callCount = 0;
      const graphqlMock = vi.fn().mockImplementation(async () => {
        callCount += 1;
        return {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: {
                  hasNextPage: true,
                  endCursor: `cursor-${callCount}`,
                },
                nodes: [{ isResolved: true }],
              },
            },
          },
        };
      });
      vi.mocked(getOctokitForApp).mockResolvedValue({
        graphql: graphqlMock,
      } as unknown as Awaited<ReturnType<typeof getOctokitForApp>>);

      const githubPR = await createTestGitHubPR({ db });
      const request = await createMockRequest(
        createValidPullRequestReviewBody({
          repoFullName: githubPR.repoFullName,
          prNumber: githubPR.number,
          githubAccountId,
          commentBody: "LGTM!",
          state: "approved",
        }),
        {
          "x-github-event": "pull_request_review",
        },
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(202);
      expect(data.success).toBe(true);
      expect(routeGithubFeedbackOrSpawnThread).toHaveBeenCalledWith(
        expect.objectContaining({
          repoFullName: githubPR.repoFullName,
          prNumber: githubPR.number,
          eventType: "pull_request_review.submitted",
          unresolvedThreadCount: 0,
          unresolvedThreadCountSource: "review_state_heuristic",
        }),
      );
    });

    it("should ignore reviews without app mention", async () => {
      const githubPR = await createTestGitHubPR({ db });
      const request = await createMockRequest(
        createValidPullRequestReviewBody({
          repoFullName: githubPR.repoFullName,
          prNumber: githubPR.number,
          githubAccountId,
          commentBody: "LGTM!",
        }),
        {
          "x-github-event": "pull_request_review",
        },
      );

      const response = await POST(request);
      const data = await response.json();
      expect(response.status).toBe(202);
      expect(data.success).toBe(true);
      expect(handleAppMention).not.toHaveBeenCalled();
      expect(routeGithubFeedbackOrSpawnThread).toHaveBeenCalledWith(
        expect.objectContaining({
          repoFullName: githubPR.repoFullName,
          prNumber: githubPR.number,
          eventType: "pull_request_review.submitted",
          reviewBody: "LGTM!",
          sourceType: "automation",
          authorGitHubAccountId: githubAccountId,
        }),
      );
    });

    it("should ignore reviews with null body", async () => {
      const githubPR = await createTestGitHubPR({ db });
      const request = await createMockRequest(
        createValidPullRequestReviewBody({
          repoFullName: githubPR.repoFullName,
          prNumber: githubPR.number,
          githubAccountId,
          commentBody: null,
        }),
        {
          "x-github-event": "pull_request_review",
        },
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(202);
      expect(data.success).toBe(true);
      expect(handleAppMention).not.toHaveBeenCalled();
    });

    it("should ignore edited or dismissed reviews", async () => {
      const githubPR = await createTestGitHubPR({ db });
      const request = await createMockRequest(
        createValidPullRequestReviewBody({
          repoFullName: githubPR.repoFullName,
          prNumber: githubPR.number,
          githubAccountId,
          commentBody: "LGTM!",
          action: "edited",
        }),
        {
          "x-github-event": "pull_request_review",
        },
      );

      const response = await POST(request);
      const data = await response.json();
      expect(response.status).toBe(202);
      expect(data.success).toBe(true);
      expect(handleAppMention).not.toHaveBeenCalled();
    });

    it("should handle different review states with mentions", async () => {
      const githubPR = await createTestGitHubPR({ db });
      const reviewStates = [
        "approved",
        "changes_requested",
        "commented",
      ] as const;
      for (const state of reviewStates) {
        vi.clearAllMocks();
        const body = createValidPullRequestReviewBody({
          repoFullName: githubPR.repoFullName,
          prNumber: githubPR.number,
          githubAccountId,
          commentBody: "@test-app LGTM!",
          state,
        });
        const request = await createMockRequest(body, {
          "x-github-event": "pull_request_review",
        });

        const response = await POST(request);
        const data = await response.json();
        expect(response.status).toBe(202);
        expect(data.success).toBe(true);
        expect(handleAppMention).toHaveBeenCalledWith({
          repoFullName: githubPR.repoFullName,
          issueOrPrNumber: githubPR.number,
          issueOrPrType: "pull_request",
          commentGitHubUsername: "reviewer",
          commentBody: "@test-app LGTM!",
          commentGitHubAccountId: githubAccountId,
        });
      }
    });

    it("should handle reviews without user ID", async () => {
      const githubPR = await createTestGitHubPR({ db });
      const request = await createMockRequest(
        createValidPullRequestReviewBody({
          repoFullName: githubPR.repoFullName,
          prNumber: githubPR.number,
          githubAccountId: null,
          commentBody: "@test-app please take a look at this PR",
        }),
        {
          "x-github-event": "pull_request_review",
        },
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(202);
      expect(data.success).toBe(true);
      expect(handleAppMention).toHaveBeenCalledWith({
        repoFullName: githubPR.repoFullName,
        issueOrPrNumber: githubPR.number,
        issueOrPrType: "pull_request",
        commentGitHubUsername: "reviewer",
        commentBody: "@test-app please take a look at this PR",
        commentGitHubAccountId: undefined,
      });
    });

    it("should handle case-insensitive app mentions in reviews", async () => {
      const githubPR = await createTestGitHubPR({ db });
      const request = await createMockRequest(
        createValidPullRequestReviewBody({
          repoFullName: githubPR.repoFullName,
          prNumber: githubPR.number,
          githubAccountId,
          commentBody: "@TEST-APP needs your attention",
        }),
        {
          "x-github-event": "pull_request_review",
        },
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(202);
      expect(data.success).toBe(true);
      expect(handleAppMention).toHaveBeenCalledWith({
        repoFullName: githubPR.repoFullName,
        issueOrPrNumber: githubPR.number,
        issueOrPrType: "pull_request",
        commentGitHubUsername: "reviewer",
        commentBody: "@TEST-APP needs your attention",
        commentGitHubAccountId: githubAccountId,
      });
    });

    it("should handle errors in handleAppMention for reviews", async () => {
      vi.mocked(handleAppMention).mockRejectedValue(
        new Error("Failed to create thread"),
      );

      await createTestGitHubPR({
        db,
        overrides: {
          repoFullName: "owner/repo",
          number: 123,
          status: "open",
        },
      });
      const request = await createMockRequest(
        createValidPullRequestReviewBody({
          repoFullName: "owner/repo",
          prNumber: 123,
          githubAccountId,
          commentBody: "@test-app please take a look at this PR",
        }),
        {
          "x-github-event": "pull_request_review",
        },
      );

      const response = await POST(request);
      const data = await response.json();
      expect(response.status).toBe(500);
      expect(data.error).toBe("Internal server error");
    });
  });

  describe("pull request review comment events", () => {
    function createValidPullRequestReviewCommentBody({
      repoFullName,
      prNumber,
      githubAccountId,
      commentBody,
      action = "created",
      prTitle = "Default PR Title",
      prBody = "Default PR body description",
    }: {
      repoFullName: string;
      prNumber: number;
      githubAccountId: number | null;
      commentBody: string;
      action?: "created" | "edited" | "deleted";
      prTitle?: string;
      prBody?: string | null;
    }) {
      return {
        action,
        pull_request: {
          number: prNumber,
          title: prTitle,
          body: prBody,
          user: {
            id: githubAccountId ?? undefined,
          },
        },
        comment: {
          body: commentBody,
          user: {
            login: "reviewer",
            id: githubAccountId ?? undefined,
          },
        },
        repository: {
          full_name: repoFullName,
          owner: {
            login: "owner",
          },
          name: "repo",
        },
      };
    }

    it("should process app mentions in PR review comments without duplicate feedback routing when not enrolled", async () => {
      vi.mocked(handleAppMention).mockResolvedValue();

      const githubPR = await createTestGitHubPR({ db });
      const deliveryId = "delivery-pr-review-comment-mention";
      const request = await createMockRequest(
        createValidPullRequestReviewCommentBody({
          repoFullName: githubPR.repoFullName,
          prNumber: githubPR.number,
          commentBody: "@test-app please review this code",
          githubAccountId,
        }),
        {
          "x-github-event": "pull_request_review_comment",
          "x-github-delivery": deliveryId,
        },
      );

      const response = await POST(request);
      const data = await response.json();
      expect(response.status).toBe(202);
      expect(data.success).toBe(true);
      expect(handleAppMention).toHaveBeenCalledWith({
        repoFullName: githubPR.repoFullName,
        issueOrPrNumber: githubPR.number,
        issueOrPrType: "pull_request",
        commentId: undefined,
        commentGitHubUsername: "reviewer",
        commentBody: "@test-app please review this code",
        commentGitHubAccountId: githubAccountId,
        commentType: "review_comment",
        diffContext: "",
        commentContext: undefined,
      });
      expect(routeGithubFeedbackOrSpawnThread).not.toHaveBeenCalled();
    });

    it("fans out review-comment feedback routing to each enrolled loop user on the PR", async () => {
      const githubPR = await createTestGitHubPR({ db });
      vi.mocked(getActiveSdlcLoopsForGithubPR).mockResolvedValueOnce([
        { id: "loop-1", userId: "loop-user-a" },
        { id: "loop-2", userId: "loop-user-b" },
      ] as Awaited<ReturnType<typeof getActiveSdlcLoopsForGithubPR>>);
      const request = await createMockRequest(
        createValidPullRequestReviewCommentBody({
          repoFullName: githubPR.repoFullName,
          prNumber: githubPR.number,
          commentBody: "This code looks good",
          githubAccountId,
        }),
        {
          "x-github-event": "pull_request_review_comment",
        },
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(202);
      expect(data.success).toBe(true);
      expect(routeGithubFeedbackOrSpawnThread).toHaveBeenCalledTimes(2);
      expect(routeGithubFeedbackOrSpawnThread).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: "loop-user-a",
          repoFullName: githubPR.repoFullName,
          prNumber: githubPR.number,
          eventType: "pull_request_review_comment.created",
        }),
      );
      expect(routeGithubFeedbackOrSpawnThread).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: "loop-user-b",
          repoFullName: githubPR.repoFullName,
          prNumber: githubPR.number,
          eventType: "pull_request_review_comment.created",
        }),
      );
      expect(handleAppMention).not.toHaveBeenCalled();
    });

    it("should ignore review comments without app mention", async () => {
      const githubPR = await createTestGitHubPR({ db });
      const request = await createMockRequest(
        createValidPullRequestReviewCommentBody({
          repoFullName: githubPR.repoFullName,
          prNumber: githubPR.number,
          commentBody: "This code looks good",
          githubAccountId,
        }),
        {
          "x-github-event": "pull_request_review_comment",
        },
      );

      const response = await POST(request);
      const data = await response.json();
      expect(response.status).toBe(202);
      expect(data.success).toBe(true);
      expect(handleAppMention).not.toHaveBeenCalled();
      expect(routeGithubFeedbackOrSpawnThread).toHaveBeenCalledWith(
        expect.objectContaining({
          repoFullName: githubPR.repoFullName,
          prNumber: githubPR.number,
          eventType: "pull_request_review_comment.created",
          reviewBody: "This code looks good",
          sourceType: "automation",
          authorGitHubAccountId: githubAccountId,
        }),
      );
    });

    it("should ignore edited or deleted review comments", async () => {
      const githubPR = await createTestGitHubPR({ db });
      const request = await createMockRequest(
        createValidPullRequestReviewCommentBody({
          repoFullName: githubPR.repoFullName,
          prNumber: githubPR.number,
          commentBody: "@test-app please review this code",
          githubAccountId,
          action: "edited",
        }),
        {
          "x-github-event": "pull_request_review_comment",
        },
      );

      const response = await POST(request);
      const data = await response.json();
      expect(response.status).toBe(202);
      expect(data.success).toBe(true);
      expect(handleAppMention).not.toHaveBeenCalled();
    });

    it("should handle review comments without user ID", async () => {
      vi.mocked(handleAppMention).mockResolvedValue();

      const githubPR = await createTestGitHubPR({ db });
      const request = await createMockRequest(
        createValidPullRequestReviewCommentBody({
          repoFullName: githubPR.repoFullName,
          prNumber: githubPR.number,
          commentBody: "@test-app check this",
          githubAccountId: null,
        }),
        {
          "x-github-event": "pull_request_review_comment",
        },
      );
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(202);
      expect(data.success).toBe(true);
      expect(handleAppMention).toHaveBeenCalledWith({
        repoFullName: githubPR.repoFullName,
        issueOrPrNumber: githubPR.number,
        issueOrPrType: "pull_request",
        commentId: undefined,
        commentGitHubUsername: "reviewer",
        commentBody: "@test-app check this",
        commentGitHubAccountId: undefined,
        commentType: "review_comment",
        diffContext: "",
        commentContext: undefined,
      });
    });

    it("should handle case-insensitive app mentions in review comments", async () => {
      vi.mocked(handleAppMention).mockResolvedValue();

      const githubPR = await createTestGitHubPR({ db });
      const request = await createMockRequest(
        createValidPullRequestReviewCommentBody({
          repoFullName: githubPR.repoFullName,
          prNumber: githubPR.number,
          commentBody: "@TEST-APP please check this",
          githubAccountId,
        }),
        {
          "x-github-event": "pull_request_review_comment",
        },
      );
      const response = await POST(request);
      const data = await response.json();
      expect(response.status).toBe(202);
      expect(data.success).toBe(true);
      expect(handleAppMention).toHaveBeenCalledWith({
        repoFullName: githubPR.repoFullName,
        issueOrPrNumber: githubPR.number,
        issueOrPrType: "pull_request",
        commentId: undefined,
        commentGitHubUsername: "reviewer",
        commentBody: "@TEST-APP please check this",
        commentGitHubAccountId: githubAccountId,
        commentType: "review_comment",
        diffContext: "",
        commentContext: undefined,
      });
    });
  });

  describe("check run events", () => {
    function createCheckRunBody({
      action = "completed",
      repoFullName = "owner/repo",
      prNumbers = [123],
      checkRunId = 1,
      headSha = "head-sha-1",
      conclusion = "success",
      status = "completed",
    }: {
      action?: string;
      repoFullName?: string;
      prNumbers?: number[];
      checkRunId?: number;
      headSha?: string;
      conclusion?: string | null;
      status?: string;
    }) {
      return {
        action,
        check_run: {
          id: checkRunId,
          name: "CI / tests",
          status,
          conclusion,
          output: {
            title: "Test suite failed",
            summary: "2 tests failed",
            text: "See failing tests in logs.",
          },
          head_sha: headSha,
          details_url: "https://github.com/owner/repo/actions/runs/1",
          pull_requests: prNumbers.map((num) => ({ number: num })),
        },
        repository: {
          full_name: repoFullName,
          owner: { login: "owner" },
          name: "repo",
        },
      };
    }

    it("should update PR checks when check run is completed", async () => {
      const pr = await createTestGitHubPR({ db });
      const body = createCheckRunBody({
        repoFullName: pr.repoFullName,
        prNumbers: [pr.number],
        conclusion: "success",
      });
      const request = await createMockRequest(body, {
        "x-github-event": "check_run",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(202);
      expect(data.success).toBe(true);
      expect(updateGitHubPR).toHaveBeenCalledWith({
        repoFullName: pr.repoFullName,
        prNumber: pr.number,
        createIfNotFound: false,
      });
      expect(routeGithubFeedbackOrSpawnThread).not.toHaveBeenCalled();
    });

    it("routes successful check runs only when an SDLC loop is enrolled", async () => {
      const pr = await createTestGitHubPR({ db });
      vi.mocked(getActiveSdlcLoopsForGithubPR).mockResolvedValueOnce([
        {
          id: "loop-1",
          userId: "loop-user-id",
        },
      ] as Awaited<ReturnType<typeof getActiveSdlcLoopsForGithubPR>>);
      const deliveryId = "delivery-check-run-success-enrolled";
      const body = createCheckRunBody({
        repoFullName: pr.repoFullName,
        prNumbers: [pr.number],
        checkRunId: 123,
        conclusion: "success",
      });
      const request = await createMockRequest(body, {
        "x-github-event": "check_run",
        "x-github-delivery": deliveryId,
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(202);
      expect(data.success).toBe(true);
      expect(routeGithubFeedbackOrSpawnThread).toHaveBeenCalledTimes(1);
      expect(routeGithubFeedbackOrSpawnThread).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: "loop-user-id",
          repoFullName: pr.repoFullName,
          prNumber: pr.number,
          eventType: "check_run.completed",
          deliveryId,
          sourceType: "automation",
          checkRunId: 123,
          checkSummary: "CI / tests (completed:pass)",
        }),
      );
    });

    it("attaches trusted CI snapshot metadata for successful check runs", async () => {
      const pr = await createTestGitHubPR({ db });
      vi.mocked(getActiveSdlcLoopsForGithubPR).mockResolvedValueOnce([
        {
          id: "loop-1",
          userId: "loop-user-id",
        },
      ] as Awaited<ReturnType<typeof getActiveSdlcLoopsForGithubPR>>);
      vi.mocked(getOctokitForApp).mockResolvedValueOnce({
        rest: {
          checks: {
            listForRef: vi.fn().mockResolvedValue({
              data: {
                check_runs: [
                  {
                    name: "CI / lint",
                    status: "completed",
                    conclusion: "success",
                  },
                  {
                    name: "CI / tests",
                    status: "completed",
                    conclusion: "success",
                  },
                ],
              },
            }),
          },
        },
      } as unknown as Awaited<ReturnType<typeof getOctokitForApp>>);
      const body = createCheckRunBody({
        repoFullName: pr.repoFullName,
        prNumbers: [pr.number],
        checkRunId: 123,
        conclusion: "success",
      });
      const request = await createMockRequest(body, {
        "x-github-event": "check_run",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(202);
      expect(data.success).toBe(true);
      expect(routeGithubFeedbackOrSpawnThread).toHaveBeenCalledWith(
        expect.objectContaining({
          repoFullName: pr.repoFullName,
          prNumber: pr.number,
          eventType: "check_run.completed",
          ciSnapshotSource: "github_check_runs",
          ciSnapshotCheckNames: ["CI / lint", "CI / tests"],
          ciSnapshotFailingChecks: [],
          ciSnapshotComplete: true,
        }),
      );
    });

    it("skips CI snapshot metadata when check-runs response is truncated", async () => {
      const pr = await createTestGitHubPR({ db });
      vi.mocked(getActiveSdlcLoopsForGithubPR).mockResolvedValueOnce([
        {
          id: "loop-1",
          userId: "loop-user-id",
        },
      ] as Awaited<ReturnType<typeof getActiveSdlcLoopsForGithubPR>>);
      vi.mocked(getOctokitForApp).mockResolvedValueOnce({
        rest: {
          checks: {
            listForRef: vi
              .fn()
              .mockResolvedValueOnce({
                data: {
                  total_count: 101,
                  check_runs: Array.from({ length: 100 }, (_value, index) => ({
                    name: `CI / shard-${index}`,
                    status: "completed",
                    conclusion: "success",
                  })),
                },
              })
              .mockResolvedValueOnce({
                data: {
                  check_runs: [],
                },
              }),
          },
        },
      } as unknown as Awaited<ReturnType<typeof getOctokitForApp>>);
      const request = await createMockRequest(
        createCheckRunBody({
          repoFullName: pr.repoFullName,
          prNumbers: [pr.number],
          checkRunId: 321,
          conclusion: "success",
        }),
        {
          "x-github-event": "check_run",
        },
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(202);
      expect(data.success).toBe(true);
      expect(routeGithubFeedbackOrSpawnThread).toHaveBeenCalledTimes(1);
      const routedPayload = vi.mocked(routeGithubFeedbackOrSpawnThread).mock
        .calls[0]?.[0];
      expect(routedPayload?.ciSnapshotSource).toBeUndefined();
      expect(routedPayload?.ciSnapshotCheckNames).toBeUndefined();
      expect(routedPayload?.ciSnapshotFailingChecks).toBeUndefined();
      expect(routedPayload?.ciSnapshotComplete).toBeUndefined();
    });

    it("hydrates CI snapshot metadata across paginated check-runs responses", async () => {
      const pr = await createTestGitHubPR({ db });
      vi.mocked(getActiveSdlcLoopsForGithubPR).mockResolvedValueOnce([
        {
          id: "loop-1",
          userId: "loop-user-id",
        },
      ] as Awaited<ReturnType<typeof getActiveSdlcLoopsForGithubPR>>);
      const listForRef = vi
        .fn()
        .mockResolvedValueOnce({
          data: {
            total_count: 101,
            check_runs: Array.from({ length: 100 }, (_unused, index) => ({
              name: `CI / shard-${index}`,
              status: "completed",
              conclusion: "success",
            })),
          },
        })
        .mockResolvedValueOnce({
          data: {
            check_runs: [
              {
                name: "CI / lint",
                status: "completed",
                conclusion: "success",
              },
              {
                name: "CI / tests",
                status: "completed",
                conclusion: "success",
              },
            ],
          },
        });
      vi.mocked(getOctokitForApp).mockResolvedValueOnce({
        rest: {
          checks: {
            listForRef,
          },
        },
      } as unknown as Awaited<ReturnType<typeof getOctokitForApp>>);
      const request = await createMockRequest(
        createCheckRunBody({
          repoFullName: pr.repoFullName,
          prNumbers: [pr.number],
          checkRunId: 333,
          conclusion: "success",
        }),
        {
          "x-github-event": "check_run",
        },
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(202);
      expect(data.success).toBe(true);
      expect(listForRef).toHaveBeenCalledTimes(2);
      expect(routeGithubFeedbackOrSpawnThread).toHaveBeenCalledWith(
        expect.objectContaining({
          repoFullName: pr.repoFullName,
          prNumber: pr.number,
          eventType: "check_run.completed",
          ciSnapshotSource: "github_check_runs",
          ciSnapshotCheckNames: expect.arrayContaining([
            "CI / lint",
            "CI / tests",
          ]),
          ciSnapshotFailingChecks: [],
          ciSnapshotComplete: true,
        }),
      );
    });

    it("routes successful check runs to each enrolled loop user", async () => {
      const pr = await createTestGitHubPR({ db });
      vi.mocked(getActiveSdlcLoopsForGithubPR).mockResolvedValueOnce([
        {
          id: "loop-1",
          userId: "loop-user-a",
        },
        {
          id: "loop-2",
          userId: "loop-user-b",
        },
      ] as Awaited<ReturnType<typeof getActiveSdlcLoopsForGithubPR>>);
      const deliveryId = "delivery-check-run-success-multi-loop";
      const request = await createMockRequest(
        createCheckRunBody({
          repoFullName: pr.repoFullName,
          prNumbers: [pr.number],
          checkRunId: 222,
          conclusion: "success",
        }),
        {
          "x-github-event": "check_run",
          "x-github-delivery": deliveryId,
        },
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(202);
      expect(data.success).toBe(true);
      expect(routeGithubFeedbackOrSpawnThread).toHaveBeenCalledTimes(2);
      expect(routeGithubFeedbackOrSpawnThread).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: "loop-user-a",
          repoFullName: pr.repoFullName,
          prNumber: pr.number,
          eventType: "check_run.completed",
          deliveryId,
          checkRunId: 222,
        }),
      );
      expect(routeGithubFeedbackOrSpawnThread).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: "loop-user-b",
          repoFullName: pr.repoFullName,
          prNumber: pr.number,
          eventType: "check_run.completed",
          deliveryId,
          checkRunId: 222,
        }),
      );
    });

    it("should handle check runs with multiple PRs", async () => {
      const pr1 = await createTestGitHubPR({ db });
      const pr2 = await createTestGitHubPR({
        db,
        overrides: {
          number: pr1.number + 1,
          repoFullName: pr1.repoFullName,
        },
      });

      const body = createCheckRunBody({
        repoFullName: pr1.repoFullName,
        prNumbers: [pr1.number, pr2.number],
      });
      const request = await createMockRequest(body, {
        "x-github-event": "check_run",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(202);
      expect(data.success).toBe(true);
      expect(updateGitHubPR).toHaveBeenCalledTimes(2);
      expect(updateGitHubPR).toHaveBeenCalledWith({
        repoFullName: pr1.repoFullName,
        prNumber: pr1.number,
        createIfNotFound: false,
      });
      expect(updateGitHubPR).toHaveBeenCalledWith({
        repoFullName: pr2.repoFullName,
        prNumber: pr2.number,
        createIfNotFound: false,
      });
    });

    it("should route actionable failed check runs for each associated PR", async () => {
      const pr1 = await createTestGitHubPR({ db });
      const pr2 = await createTestGitHubPR({
        db,
        overrides: {
          number: pr1.number + 1,
          repoFullName: pr1.repoFullName,
        },
      });
      const body = createCheckRunBody({
        repoFullName: pr1.repoFullName,
        prNumbers: [pr1.number, pr2.number],
        conclusion: "failure",
      });
      const deliveryId = "delivery-check-run-failure";
      const request = await createMockRequest(body, {
        "x-github-event": "check_run",
        "x-github-delivery": deliveryId,
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(202);
      expect(data.success).toBe(true);
      expect(routeGithubFeedbackOrSpawnThread).toHaveBeenCalledTimes(2);
      expect(routeGithubFeedbackOrSpawnThread).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: undefined,
          repoFullName: pr1.repoFullName,
          prNumber: pr1.number,
          eventType: "check_run.completed",
          deliveryId,
          sourceType: "automation",
          checkRunId: 1,
        }),
      );
      expect(routeGithubFeedbackOrSpawnThread).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: undefined,
          repoFullName: pr2.repoFullName,
          prNumber: pr2.number,
          eventType: "check_run.completed",
          deliveryId,
          sourceType: "automation",
          checkRunId: 1,
        }),
      );
    });

    it("should handle check runs with no associated PRs", async () => {
      const body = createCheckRunBody({
        prNumbers: [],
      });
      const request = await createMockRequest(body, {
        "x-github-event": "check_run",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(202);
      expect(data.success).toBe(true);
      expect(updateGitHubPR).not.toHaveBeenCalled();
    });

    it("should handle different check run actions", async () => {
      const pr = await createTestGitHubPR({ db });
      const actions = ["created", "completed", "rerequested"];

      for (const action of actions) {
        vi.clearAllMocks();
        const body = createCheckRunBody({
          action,
          repoFullName: pr.repoFullName,
          prNumbers: [pr.number],
        });
        const request = await createMockRequest(body, {
          "x-github-event": "check_run",
        });

        const response = await POST(request);
        const data = await response.json();

        expect(response.status).toBe(202);
        expect(data.success).toBe(true);
        expect(updateGitHubPR).toHaveBeenCalledWith({
          repoFullName: pr.repoFullName,
          prNumber: pr.number,
          createIfNotFound: false,
        });
      }
    });

    it("should handle check run errors gracefully", async () => {
      vi.mocked(updateGitHubPR).mockRejectedValue(new Error("API error"));

      const pr = await createTestGitHubPR({ db });
      const body = createCheckRunBody({
        repoFullName: pr.repoFullName,
        prNumbers: [pr.number],
      });
      const request = await createMockRequest(body, {
        "x-github-event": "check_run",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.error).toBe("Internal server error");
    });
  });

  describe("check suite events", () => {
    function createCheckSuiteBody({
      action = "completed",
      repoFullName = "owner/repo",
      prNumbers = [123],
      checkSuiteId = 1,
      conclusion = "success",
      status = "completed",
    }: {
      action?: string;
      repoFullName?: string;
      prNumbers?: number[];
      checkSuiteId?: number;
      conclusion?: string | null;
      status?: string;
    }) {
      return {
        action,
        check_suite: {
          id: checkSuiteId,
          status,
          conclusion,
          pull_requests: prNumbers.map((num) => ({ number: num })),
        },
        repository: {
          full_name: repoFullName,
          owner: { login: "owner" },
          name: "repo",
        },
      };
    }

    beforeEach(() => {
      vi.mocked(updateGitHubPR).mockResolvedValue();
    });

    it("should update PR checks when check suite is completed", async () => {
      const pr = await createTestGitHubPR({ db });
      const body = createCheckSuiteBody({
        repoFullName: pr.repoFullName,
        prNumbers: [pr.number],
        conclusion: "success",
      });
      const request = await createMockRequest(body, {
        "x-github-event": "check_suite",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(202);
      expect(data.success).toBe(true);
      expect(updateGitHubPR).toHaveBeenCalledWith({
        repoFullName: pr.repoFullName,
        prNumber: pr.number,
        createIfNotFound: false,
      });
      expect(routeGithubFeedbackOrSpawnThread).not.toHaveBeenCalled();
    });

    it("routes successful check suites only when an SDLC loop is enrolled", async () => {
      const pr = await createTestGitHubPR({ db });
      vi.mocked(getActiveSdlcLoopsForGithubPR).mockResolvedValueOnce([
        {
          id: "loop-1",
          userId: "loop-user-id",
        },
      ] as Awaited<ReturnType<typeof getActiveSdlcLoopsForGithubPR>>);
      const deliveryId = "delivery-check-suite-success-enrolled";
      const body = createCheckSuiteBody({
        repoFullName: pr.repoFullName,
        prNumbers: [pr.number],
        checkSuiteId: 456,
        conclusion: "success",
      });
      const request = await createMockRequest(body, {
        "x-github-event": "check_suite",
        "x-github-delivery": deliveryId,
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(202);
      expect(data.success).toBe(true);
      expect(routeGithubFeedbackOrSpawnThread).toHaveBeenCalledTimes(1);
      expect(routeGithubFeedbackOrSpawnThread).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: "loop-user-id",
          repoFullName: pr.repoFullName,
          prNumber: pr.number,
          eventType: "check_suite.completed",
          deliveryId,
          sourceType: "automation",
          checkSuiteId: 456,
          checkSummary: "Check suite (completed:pass)",
        }),
      );
    });

    it("routes successful check suites to each enrolled loop user", async () => {
      const pr = await createTestGitHubPR({ db });
      vi.mocked(getActiveSdlcLoopsForGithubPR).mockResolvedValueOnce([
        {
          id: "loop-1",
          userId: "loop-user-a",
        },
        {
          id: "loop-2",
          userId: "loop-user-b",
        },
      ] as Awaited<ReturnType<typeof getActiveSdlcLoopsForGithubPR>>);
      const deliveryId = "delivery-check-suite-success-multi-loop";
      const request = await createMockRequest(
        createCheckSuiteBody({
          repoFullName: pr.repoFullName,
          prNumbers: [pr.number],
          checkSuiteId: 654,
          conclusion: "success",
        }),
        {
          "x-github-event": "check_suite",
          "x-github-delivery": deliveryId,
        },
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(202);
      expect(data.success).toBe(true);
      expect(routeGithubFeedbackOrSpawnThread).toHaveBeenCalledTimes(2);
      expect(routeGithubFeedbackOrSpawnThread).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: "loop-user-a",
          repoFullName: pr.repoFullName,
          prNumber: pr.number,
          eventType: "check_suite.completed",
          deliveryId,
          checkSuiteId: 654,
        }),
      );
      expect(routeGithubFeedbackOrSpawnThread).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: "loop-user-b",
          repoFullName: pr.repoFullName,
          prNumber: pr.number,
          eventType: "check_suite.completed",
          deliveryId,
          checkSuiteId: 654,
        }),
      );
    });

    it("should route actionable failed check suites for each associated PR", async () => {
      const pr1 = await createTestGitHubPR({ db });
      const pr2 = await createTestGitHubPR({
        db,
        overrides: {
          number: pr1.number + 1,
          repoFullName: pr1.repoFullName,
        },
      });
      const body = createCheckSuiteBody({
        repoFullName: pr1.repoFullName,
        prNumbers: [pr1.number, pr2.number],
        checkSuiteId: 987,
        conclusion: "failure",
      });
      const deliveryId = "delivery-check-suite-failure";
      const request = await createMockRequest(body, {
        "x-github-event": "check_suite",
        "x-github-delivery": deliveryId,
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(202);
      expect(data.success).toBe(true);
      expect(routeGithubFeedbackOrSpawnThread).toHaveBeenCalledTimes(2);
      expect(routeGithubFeedbackOrSpawnThread).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: undefined,
          repoFullName: pr1.repoFullName,
          prNumber: pr1.number,
          eventType: "check_suite.completed",
          deliveryId,
          sourceType: "automation",
          checkSuiteId: 987,
        }),
      );
      expect(routeGithubFeedbackOrSpawnThread).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: undefined,
          repoFullName: pr2.repoFullName,
          prNumber: pr2.number,
          eventType: "check_suite.completed",
          deliveryId,
          sourceType: "automation",
          checkSuiteId: 987,
        }),
      );
    });

    it("should handle check suites with multiple PRs", async () => {
      const pr1 = await createTestGitHubPR({ db });
      const pr2 = await createTestGitHubPR({
        db,
        overrides: {
          number: pr1.number + 1,
          repoFullName: pr1.repoFullName,
        },
      });

      const body = createCheckSuiteBody({
        repoFullName: pr1.repoFullName,
        prNumbers: [pr1.number, pr2.number],
      });
      const request = await createMockRequest(body, {
        "x-github-event": "check_suite",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(202);
      expect(data.success).toBe(true);
      expect(updateGitHubPR).toHaveBeenCalledTimes(2);
      expect(updateGitHubPR).toHaveBeenCalledWith({
        repoFullName: pr1.repoFullName,
        prNumber: pr1.number,
        createIfNotFound: false,
      });
      expect(updateGitHubPR).toHaveBeenCalledWith({
        repoFullName: pr2.repoFullName,
        prNumber: pr2.number,
        createIfNotFound: false,
      });
    });

    it("should handle check suites with no associated PRs", async () => {
      const body = createCheckSuiteBody({
        prNumbers: [],
      });
      const request = await createMockRequest(body, {
        "x-github-event": "check_suite",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(202);
      expect(data.success).toBe(true);
      expect(updateGitHubPR).not.toHaveBeenCalled();
    });

    it("should handle different check suite actions", async () => {
      const pr = await createTestGitHubPR({ db });
      const actions = ["completed", "rerequested"];

      for (const action of actions) {
        vi.clearAllMocks();
        const body = createCheckSuiteBody({
          action,
          repoFullName: pr.repoFullName,
          prNumbers: [pr.number],
        });
        const request = await createMockRequest(body, {
          "x-github-event": "check_suite",
        });

        const response = await POST(request);
        const data = await response.json();

        expect(response.status).toBe(202);
        expect(data.success).toBe(true);
        expect(updateGitHubPR).toHaveBeenCalledWith({
          repoFullName: pr.repoFullName,
          prNumber: pr.number,
          createIfNotFound: false,
        });
      }
    });

    it("should handle check suite errors gracefully", async () => {
      vi.mocked(updateGitHubPR).mockRejectedValue(new Error("API error"));

      const pr = await createTestGitHubPR({ db });
      const body = createCheckSuiteBody({
        repoFullName: pr.repoFullName,
        prNumbers: [pr.number],
      });
      const request = await createMockRequest(body, {
        "x-github-event": "check_suite",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.error).toBe("Internal server error");
    });
  });
});
