import {
  describe,
  expect,
  it,
  vi,
  beforeEach,
  beforeAll,
  afterAll,
} from "vitest";
import { handleCommentCreated, buildLinearMentionMessage } from "./handlers";
import { User } from "@terragon/shared";
import {
  createTestUser,
  setFeatureFlagOverrideForTest,
} from "@terragon/shared/model/test-helpers";
import { upsertLinearAccount } from "@terragon/shared/model/linear";
import { db } from "@/lib/db";
import { newThreadInternal } from "@/server-lib/new-thread-internal";
import { env } from "@terragon/env/apps-www";

// Mock newThreadInternal
vi.mock("@/server-lib/new-thread-internal", () => ({
  newThreadInternal: vi.fn().mockResolvedValue({
    threadId: "test-thread-id",
    threadChatId: "test-chat-id",
  }),
}));

// Mock Linear SDK
const mockCreateComment = vi.fn().mockResolvedValue({ success: true });
const mockIssue = vi.fn().mockResolvedValue({
  identifier: "ENG-123",
  title: "Fix the bug",
  description: "Something is broken",
  url: "https://linear.app/team/issue/ENG-123",
  branchName: "fix-the-bug",
  attachments: vi.fn().mockResolvedValue({
    nodes: [],
  }),
});

vi.mock("@linear/sdk", () => ({
  LinearClient: vi.fn().mockImplementation(() => ({
    createComment: mockCreateComment,
    issue: mockIssue,
  })),
}));

function makeCommentPayload(overrides: Record<string, unknown> = {}) {
  return {
    action: "create",
    type: "Comment",
    organizationId: "org-123",
    webhookId: "webhook-456",
    webhookTimestamp: Date.now(),
    actor: { id: "actor-1", name: "Test User", type: "user" },
    data: {
      id: "comment-789",
      body: `Hey @terragon please fix this`,
      createdAt: new Date().toISOString(),
      issueId: "issue-abc",
      userId: "linear-user-1",
      ...((overrides.data as Record<string, unknown>) ?? {}),
    },
    ...Object.fromEntries(
      Object.entries(overrides).filter(([k]) => k !== "data"),
    ),
  };
}

describe("handlers", () => {
  describe("buildLinearMentionMessage", () => {
    it("should build a message with issue context", () => {
      const message = buildLinearMentionMessage({
        issueIdentifier: "ENG-123",
        issueTitle: "Fix the bug",
        issueDescription: "Something is broken",
        issueUrl: "https://linear.app/team/issue/ENG-123",
        commentBody: "Hey @terragon fix this",
        attachments: [],
      });

      expect(message).toContain("ENG-123");
      expect(message).toContain("Fix the bug");
      expect(message).toContain("Something is broken");
      expect(message).toContain("Hey @terragon fix this");
      expect(message).toContain("https://linear.app/team/issue/ENG-123");
    });

    it("should include attachments when present", () => {
      const message = buildLinearMentionMessage({
        issueIdentifier: "ENG-123",
        issueTitle: "Fix the bug",
        issueDescription: null,
        issueUrl: "https://linear.app/team/issue/ENG-123",
        commentBody: "Fix it",
        attachments: [
          {
            title: "PR #42",
            url: "https://github.com/owner/repo/pull/42",
            sourceType: "github",
          },
        ],
      });

      expect(message).toContain("PR #42");
      expect(message).toContain("https://github.com/owner/repo/pull/42");
    });

    it("should omit description when null", () => {
      const message = buildLinearMentionMessage({
        issueIdentifier: "ENG-123",
        issueTitle: "Fix the bug",
        issueDescription: null,
        issueUrl: "https://linear.app/team/issue/ENG-123",
        commentBody: "Fix it",
        attachments: [],
      });

      expect(message).not.toContain("Issue description");
    });
  });

  describe("handleCommentCreated", () => {
    let user: User;
    let originalApiKey: string;

    beforeAll(async () => {
      // Set a dummy API key so getLinearClient() doesn't throw
      // (LinearClient is mocked, so the actual value doesn't matter)
      originalApiKey = env.LINEAR_API_KEY;
      // @ts-expect-error - modifying env for test
      env.LINEAR_API_KEY = "test-linear-api-key";

      const testUserResult = await createTestUser({ db });
      user = testUserResult.user;

      // Link a linear account
      await upsertLinearAccount({
        db,
        userId: user.id,
        organizationId: "org-123",
        account: {
          linearUserId: "linear-user-1",
          linearUserName: "Test User",
          linearUserEmail: "test@linear.app",
        },
      });

      // Enable the feature flag
      await setFeatureFlagOverrideForTest({
        db,
        userId: user.id,
        name: "linearIntegration",
        value: true,
      });
    });

    afterAll(() => {
      // @ts-expect-error - restoring env for test
      env.LINEAR_API_KEY = originalApiKey;
    });

    beforeEach(() => {
      vi.clearAllMocks();
      vi.mocked(newThreadInternal).mockResolvedValue({
        threadId: "test-thread-id",
        threadChatId: "test-chat-id",
      });
      mockIssue.mockResolvedValue({
        identifier: "ENG-123",
        title: "Fix the bug",
        description: "Something is broken",
        url: "https://linear.app/team/issue/ENG-123",
        branchName: "fix-the-bug",
        attachments: vi.fn().mockResolvedValue({
          nodes: [],
        }),
      });
    });

    it("should skip processing when LINEAR_MENTION_HANDLE is empty", async () => {
      const originalHandle = env.LINEAR_MENTION_HANDLE;
      // @ts-expect-error - modifying env for test
      env.LINEAR_MENTION_HANDLE = "";
      try {
        await handleCommentCreated(makeCommentPayload());
        expect(newThreadInternal).not.toHaveBeenCalled();
        expect(mockCreateComment).not.toHaveBeenCalled();
      } finally {
        // @ts-expect-error - restoring env for test
        env.LINEAR_MENTION_HANDLE = originalHandle;
      }
    });

    it("should skip non-mention comments", async () => {
      const originalHandle = env.LINEAR_MENTION_HANDLE;
      // @ts-expect-error - modifying env for test
      env.LINEAR_MENTION_HANDLE = "@terragon";
      try {
        await handleCommentCreated(
          makeCommentPayload({
            data: { body: "This comment has no mention at all" },
          }),
        );
        expect(newThreadInternal).not.toHaveBeenCalled();
      } finally {
        // @ts-expect-error - restoring env for test
        env.LINEAR_MENTION_HANDLE = originalHandle;
      }
    });

    it("should detect mentions case-insensitively", async () => {
      const originalHandle = env.LINEAR_MENTION_HANDLE;
      // @ts-expect-error - modifying env for test
      env.LINEAR_MENTION_HANDLE = "@terragon";
      try {
        // Provide a GitHub attachment so we have a repo
        mockIssue.mockResolvedValue({
          identifier: "ENG-123",
          title: "Fix the bug",
          description: "Something is broken",
          url: "https://linear.app/team/issue/ENG-123",
          branchName: "fix-the-bug",
          attachments: vi.fn().mockResolvedValue({
            nodes: [
              {
                title: "PR #42",
                url: "https://github.com/owner/repo/pull/42",
                sourceType: "github",
              },
            ],
          }),
        });

        await handleCommentCreated(
          makeCommentPayload({
            data: { body: "Hey @TERRAGON please fix this" },
          }),
        );
        expect(newThreadInternal).toHaveBeenCalled();
      } finally {
        // @ts-expect-error - restoring env for test
        env.LINEAR_MENTION_HANDLE = originalHandle;
      }
    });

    it("should post error comment when no linked account found", async () => {
      const originalHandle = env.LINEAR_MENTION_HANDLE;
      // @ts-expect-error - modifying env for test
      env.LINEAR_MENTION_HANDLE = "@terragon";
      try {
        await handleCommentCreated(
          makeCommentPayload({
            data: { userId: "unknown-linear-user" },
          }),
        );
        expect(newThreadInternal).not.toHaveBeenCalled();
        expect(mockCreateComment).toHaveBeenCalledWith(
          expect.objectContaining({
            issueId: "issue-abc",
            body: expect.stringContaining("connect your Linear account"),
          }),
        );
      } finally {
        // @ts-expect-error - restoring env for test
        env.LINEAR_MENTION_HANDLE = originalHandle;
      }
    });

    it("should silently ignore when feature flag is disabled", async () => {
      // Create a user with disabled feature flag
      const testUser2 = await createTestUser({ db });
      await upsertLinearAccount({
        db,
        userId: testUser2.user.id,
        organizationId: "org-disabled",
        account: {
          linearUserId: "linear-user-disabled",
          linearUserName: "Disabled User",
          linearUserEmail: "disabled@linear.app",
        },
      });
      // Feature flag is off by default

      const originalHandle = env.LINEAR_MENTION_HANDLE;
      // @ts-expect-error - modifying env for test
      env.LINEAR_MENTION_HANDLE = "@terragon";
      try {
        await handleCommentCreated(
          makeCommentPayload({
            organizationId: "org-disabled",
            data: { userId: "linear-user-disabled" },
          }),
        );
        expect(newThreadInternal).not.toHaveBeenCalled();
        // Should NOT post any comment (silently ignore)
        expect(mockCreateComment).not.toHaveBeenCalled();
      } finally {
        // @ts-expect-error - restoring env for test
        env.LINEAR_MENTION_HANDLE = originalHandle;
      }
    });

    it("should post error when no default repo and no GitHub attachment", async () => {
      const originalHandle = env.LINEAR_MENTION_HANDLE;
      // @ts-expect-error - modifying env for test
      env.LINEAR_MENTION_HANDLE = "@terragon";
      try {
        // No linear settings means no default repo; issue has no attachments
        await handleCommentCreated(makeCommentPayload());
        expect(newThreadInternal).not.toHaveBeenCalled();
        expect(mockCreateComment).toHaveBeenCalledWith(
          expect.objectContaining({
            body: expect.stringContaining("No default repository configured"),
          }),
        );
      } finally {
        // @ts-expect-error - restoring env for test
        env.LINEAR_MENTION_HANDLE = originalHandle;
      }
    });

    it("should extract GitHub repo from attachment and create thread", async () => {
      const originalHandle = env.LINEAR_MENTION_HANDLE;
      // @ts-expect-error - modifying env for test
      env.LINEAR_MENTION_HANDLE = "@terragon";
      try {
        mockIssue.mockResolvedValue({
          identifier: "ENG-123",
          title: "Fix the bug",
          description: "Something is broken",
          url: "https://linear.app/team/issue/ENG-123",
          branchName: "fix-the-bug",
          attachments: vi.fn().mockResolvedValue({
            nodes: [
              {
                title: "PR #42",
                url: "https://github.com/owner/repo/pull/42",
                sourceType: "github",
              },
            ],
          }),
        });

        await handleCommentCreated(makeCommentPayload());

        expect(newThreadInternal).toHaveBeenCalledWith(
          expect.objectContaining({
            userId: user.id,
            githubRepoFullName: "owner/repo",
            sourceType: "linear-mention",
            sourceMetadata: expect.objectContaining({
              type: "linear-mention",
              organizationId: "org-123",
              issueId: "issue-abc",
              issueIdentifier: "ENG-123",
              commentId: "comment-789",
            }),
          }),
        );

        // Ack comment posted
        expect(mockCreateComment).toHaveBeenCalledWith(
          expect.objectContaining({
            issueId: "issue-abc",
            body: expect.stringContaining("Task created"),
          }),
        );
      } finally {
        // @ts-expect-error - restoring env for test
        env.LINEAR_MENTION_HANDLE = originalHandle;
      }
    });

    it("should ensure ack comments never contain the mention handle", async () => {
      const originalHandle = env.LINEAR_MENTION_HANDLE;
      // @ts-expect-error - modifying env for test
      env.LINEAR_MENTION_HANDLE = "@terragon";
      try {
        mockIssue.mockResolvedValue({
          identifier: "ENG-123",
          title: "Fix the bug",
          description: "Something is broken",
          url: "https://linear.app/team/issue/ENG-123",
          branchName: "fix-the-bug",
          attachments: vi.fn().mockResolvedValue({
            nodes: [
              {
                title: "PR #42",
                url: "https://github.com/owner/repo/pull/42",
                sourceType: "github",
              },
            ],
          }),
        });

        await handleCommentCreated(makeCommentPayload());

        // Verify no ack/error comment contains the mention handle
        for (const call of mockCreateComment.mock.calls) {
          const commentBody = call[0]?.body as string;
          expect(commentBody).not.toContain("@terragon");
        }
      } finally {
        // @ts-expect-error - restoring env for test
        env.LINEAR_MENTION_HANDLE = originalHandle;
      }
    });

    it("should skip when issueId is missing from comment data", async () => {
      const originalHandle = env.LINEAR_MENTION_HANDLE;
      // @ts-expect-error - modifying env for test
      env.LINEAR_MENTION_HANDLE = "@terragon";
      try {
        await handleCommentCreated(
          makeCommentPayload({
            data: { issueId: undefined },
          }),
        );
        expect(newThreadInternal).not.toHaveBeenCalled();
        expect(mockCreateComment).not.toHaveBeenCalled();
      } finally {
        // @ts-expect-error - restoring env for test
        env.LINEAR_MENTION_HANDLE = originalHandle;
      }
    });
  });
});
