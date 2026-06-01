import type { DBUserMessage } from "@terragon/shared";
import type { Automation } from "@terragon/shared/db/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

const followUpMocks = vi.hoisted(() => ({
  queueFollowUpInternal: vi.fn(),
}));

const newThreadMocks = vi.hoisted(() => ({
  newThreadInternal: vi.fn(),
}));

vi.mock("@/server-lib/follow-up", () => ({
  queueFollowUpInternal: followUpMocks.queueFollowUpInternal,
}));

vi.mock("@/server-lib/new-thread-internal", () => ({
  newThreadInternal: newThreadMocks.newThreadInternal,
}));

import { routeExternalTaskIntake } from "./route-external-task-intake";

const TEST_MESSAGE = {
  type: "user",
  model: "sonnet",
  parts: [{ type: "text", text: "work on ENG-42" }],
  timestamp: "2026-05-31T12:00:00.000Z",
} satisfies DBUserMessage;

const TEST_AUTOMATION = {
  id: "automation-1",
  userId: "user-1",
  name: "Daily cleanup",
  description: null,
  enabled: true,
  triggerType: "manual",
  triggerConfig: {},
  repoFullName: "owner/repo",
  branchName: "main",
  action: {
    type: "user_message",
    config: { message: TEST_MESSAGE },
  },
  skipSetup: false,
  disableGitCheckpointing: true,
  lastRunAt: null,
  nextRunAt: null,
  runCount: 0,
  createdAt: new Date("2026-05-31T12:00:00.000Z"),
  updatedAt: new Date("2026-05-31T12:00:00.000Z"),
} satisfies Automation;

describe("routeExternalTaskIntake", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    followUpMocks.queueFollowUpInternal.mockResolvedValue(undefined);
    newThreadMocks.newThreadInternal.mockResolvedValue({
      threadId: "thread-1",
      threadChatId: "chat-1",
      model: "sonnet",
    });
  });

  it("routes Linear create-thread intake through newThreadInternal", async () => {
    const result = await routeExternalTaskIntake({
      intent: "create-thread",
      source: "linear",
      ownerUserId: "user-1",
      ownerReason: "linear-account-link",
      externalActor: { type: "linear-user", id: "linear-user-1" },
      targetKey: {
        type: "linear-agent-session",
        organizationId: "org-1",
        agentSessionId: "session-1",
        issueId: "issue-1",
        deliveryId: "delivery-1",
      },
      idempotencyKey: "delivery-1",
      message: TEST_MESSAGE,
      githubRepoFullName: "owner/repo",
      baseBranchName: null,
      headBranchName: null,
      sourceType: "linear-mention",
      sourceMetadata: {
        type: "linear-mention",
        organizationId: "org-1",
        issueId: "issue-1",
        issueIdentifier: "ENG-42",
        issueUrl: "https://linear.app/team/issue/ENG-42",
        agentSessionId: "session-1",
        linearDeliveryId: "delivery-1",
      },
    });

    expect(result).toEqual({
      intent: "create-thread",
      threadId: "thread-1",
      threadChatId: "chat-1",
    });
    expect(newThreadMocks.newThreadInternal).toHaveBeenCalledWith({
      userId: "user-1",
      message: expect.objectContaining({
        parts: [
          { type: "text", text: "work on ENG-42" },
          {
            type: "text",
            text: expect.stringContaining(
              "<!-- terragon-external-task-intake:linear:delivery-1 -->",
            ),
          },
        ],
      }),
      parentThreadId: undefined,
      parentToolId: undefined,
      githubRepoFullName: "owner/repo",
      baseBranchName: null,
      headBranchName: null,
      sourceType: "linear-mention",
      sourceMetadata: expect.objectContaining({
        type: "linear-mention",
        agentSessionId: "session-1",
      }),
    });
    expect(followUpMocks.queueFollowUpInternal).not.toHaveBeenCalled();
  });

  it("routes Linear follow-up intake through queueFollowUpInternal", async () => {
    const result = await routeExternalTaskIntake({
      intent: "follow-up",
      source: "linear",
      ownerUserId: "user-1",
      ownerReason: "linear-thread-owner",
      targetKey: {
        type: "linear-agent-session",
        organizationId: "org-1",
        agentSessionId: "session-1",
      },
      message: TEST_MESSAGE,
      threadId: "thread-1",
      threadChatId: "chat-1",
      appendOrReplace: "append",
    });

    expect(result).toEqual({
      intent: "follow-up",
      threadId: "thread-1",
      threadChatId: "chat-1",
    });
    expect(followUpMocks.queueFollowUpInternal).toHaveBeenCalledWith({
      userId: "user-1",
      threadId: "thread-1",
      threadChatId: "chat-1",
      messages: [TEST_MESSAGE],
      appendOrReplace: "append",
      source: "linear",
    });
    expect(newThreadMocks.newThreadInternal).not.toHaveBeenCalled();
  });

  it("adds a delivery marker to idempotent external follow-ups", async () => {
    await routeExternalTaskIntake({
      intent: "follow-up",
      source: "linear",
      ownerUserId: "user-1",
      ownerReason: "linear-thread-owner",
      targetKey: {
        type: "linear-agent-session",
        organizationId: "org-1",
        agentSessionId: "session-1",
        deliveryId: "delivery-1",
      },
      idempotencyKey: "delivery-1",
      message: TEST_MESSAGE,
      threadId: "thread-1",
      threadChatId: "chat-1",
      appendOrReplace: "append",
    });

    const queuedMessage =
      followUpMocks.queueFollowUpInternal.mock.calls[0]?.[0]?.messages[0];
    expect(queuedMessage).toMatchObject({
      type: "user",
      parts: [
        { type: "text", text: "work on ENG-42" },
        {
          type: "text",
          text: expect.stringContaining(
            "<!-- terragon-external-task-intake:linear:delivery-1 -->",
          ),
        },
      ],
    });
    expect(followUpMocks.queueFollowUpInternal).toHaveBeenCalledWith(
      expect.objectContaining({
        dedupeMarker:
          "<!-- terragon-external-task-intake:linear:delivery-1 -->",
      }),
    );
  });

  it("routes GitHub feedback create-thread intake through newThreadInternal", async () => {
    await routeExternalTaskIntake({
      intent: "create-thread",
      source: "github",
      ownerUserId: "user-1",
      ownerReason: "pr-author-fallback",
      externalActor: { type: "github-user", accountId: "12345" },
      targetKey: {
        type: "github-pr",
        repoFullName: "owner/repo",
        prNumber: 42,
        eventType: "check_run.completed",
        deliveryId: "delivery-1",
      },
      idempotencyKey: "delivery-1",
      message: TEST_MESSAGE,
      githubRepoFullName: "owner/repo",
      baseBranchName: "main",
      headBranchName: "feature/feedback",
      githubPRNumber: 42,
      sourceType: "automation",
    });

    expect(newThreadMocks.newThreadInternal).toHaveBeenCalledWith({
      userId: "user-1",
      message: expect.objectContaining({
        parts: [
          { type: "text", text: "work on ENG-42" },
          {
            type: "text",
            text: expect.stringContaining(
              "<!-- terragon-external-task-intake:github:delivery-1 -->",
            ),
          },
        ],
      }),
      parentThreadId: undefined,
      parentToolId: undefined,
      githubRepoFullName: "owner/repo",
      baseBranchName: "main",
      headBranchName: "feature/feedback",
      githubPRNumber: 42,
      githubIssueNumber: undefined,
      sourceType: "automation",
      sourceMetadata: undefined,
    });
  });

  it("routes GitHub feedback follow-up intake through queueFollowUpInternal", async () => {
    await routeExternalTaskIntake({
      intent: "follow-up",
      source: "github",
      ownerUserId: "user-1",
      ownerReason: "existing-unarchived-thread",
      targetKey: {
        type: "github-pr",
        repoFullName: "owner/repo",
        prNumber: 42,
        eventType: "pull_request_review.submitted",
      },
      message: TEST_MESSAGE,
      threadId: "thread-1",
      threadChatId: "chat-1",
      appendOrReplace: "append",
    });

    expect(followUpMocks.queueFollowUpInternal).toHaveBeenCalledWith({
      userId: "user-1",
      threadId: "thread-1",
      threadChatId: "chat-1",
      messages: [TEST_MESSAGE],
      appendOrReplace: "append",
      source: "github",
    });
  });

  it("routes Slack create-thread intake through newThreadInternal", async () => {
    await routeExternalTaskIntake({
      intent: "create-thread",
      source: "slack",
      ownerUserId: "user-1",
      ownerReason: "slack-account-link",
      externalActor: { type: "slack-user", id: "U123" },
      targetKey: {
        type: "slack-thread",
        teamId: "T123",
        channel: "C123",
        threadTs: "123.456",
      },
      idempotencyKey: "event-1",
      message: TEST_MESSAGE,
      githubRepoFullName: "owner/repo",
      baseBranchName: null,
      headBranchName: null,
      sourceType: "slack-mention",
      sourceMetadata: {
        type: "slack-mention",
        teamId: "T123",
        workspaceDomain: "terragon",
        channel: "C123",
        messageTs: "123.456",
        threadTs: "123.456",
      },
    });

    expect(newThreadMocks.newThreadInternal).toHaveBeenCalledWith({
      userId: "user-1",
      message: expect.objectContaining({
        parts: [
          { type: "text", text: "work on ENG-42" },
          {
            type: "text",
            text: expect.stringContaining(
              "<!-- terragon-external-task-intake:slack:event-1 -->",
            ),
          },
        ],
      }),
      parentThreadId: undefined,
      parentToolId: undefined,
      githubRepoFullName: "owner/repo",
      baseBranchName: null,
      headBranchName: null,
      sourceType: "slack-mention",
      sourceMetadata: expect.objectContaining({
        type: "slack-mention",
        teamId: "T123",
      }),
    });
  });

  it("routes automation create-thread intake through newThreadInternal", async () => {
    await routeExternalTaskIntake({
      intent: "create-thread",
      source: "automation",
      ownerUserId: "user-1",
      ownerReason: "automated",
      targetKey: {
        type: "automation-run",
        automationId: "automation-1",
        triggerType: "manual",
        runSource: "automated",
        githubPRNumber: 42,
      },
      message: TEST_MESSAGE,
      githubRepoFullName: "owner/repo",
      baseBranchName: "main",
      headBranchName: null,
      githubPRNumber: 42,
      sourceType: "automation",
      automation: TEST_AUTOMATION,
      disableGitCheckpointing: true,
    });

    expect(newThreadMocks.newThreadInternal).toHaveBeenCalledWith({
      userId: "user-1",
      message: TEST_MESSAGE,
      parentThreadId: undefined,
      parentToolId: undefined,
      automation: TEST_AUTOMATION,
      disableGitCheckpointing: true,
      githubRepoFullName: "owner/repo",
      baseBranchName: "main",
      headBranchName: null,
      githubPRNumber: 42,
      githubIssueNumber: undefined,
      sourceType: "automation",
    });
  });

  it("routes Slack follow-up intake through queueFollowUpInternal", async () => {
    await routeExternalTaskIntake({
      intent: "follow-up",
      source: "slack",
      ownerUserId: "user-1",
      ownerReason: "slack-thread-key",
      externalActor: { type: "slack-user", id: "U123" },
      targetKey: {
        type: "slack-thread",
        teamId: "T123",
        channel: "C123",
        threadTs: "123.456",
      },
      message: TEST_MESSAGE,
      threadId: "thread-1",
      threadChatId: "chat-1",
      appendOrReplace: "append",
    });

    expect(followUpMocks.queueFollowUpInternal).toHaveBeenCalledWith({
      userId: "user-1",
      threadId: "thread-1",
      threadChatId: "chat-1",
      messages: [TEST_MESSAGE],
      appendOrReplace: "append",
      source: "slack",
    });
  });
});
