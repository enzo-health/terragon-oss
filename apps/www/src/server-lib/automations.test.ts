import type { DBUserMessage } from "@terragon/shared";
import type { Automation } from "@terragon/shared/db/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

const automationModelMocks = vi.hoisted(() => ({
  getAutomation: vi.fn(),
  incrementAutomationRunCount: vi.fn(),
}));

const intakeMocks = vi.hoisted(() => ({
  routeExternalTaskIntake: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {},
}));

vi.mock("@terragon/shared/model/automations", () => ({
  getAutomation: automationModelMocks.getAutomation,
  incrementAutomationRunCount: automationModelMocks.incrementAutomationRunCount,
}));

vi.mock("./external-task-intake/route-external-task-intake", () => ({
  routeExternalTaskIntake: intakeMocks.routeExternalTaskIntake,
}));

import { runAutomation } from "./automations";

const TEST_MESSAGE = {
  type: "user",
  model: null,
  parts: [{ type: "text", text: "Run the automation" }],
} satisfies DBUserMessage;

const TEST_AUTOMATION = {
  id: "automation-1",
  userId: "user-1",
  name: "Review PR",
  description: null,
  enabled: true,
  triggerType: "pull_request",
  triggerConfig: {
    filter: {},
    on: { open: true },
  },
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

describe("runAutomation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    automationModelMocks.getAutomation.mockResolvedValue(TEST_AUTOMATION);
    automationModelMocks.incrementAutomationRunCount.mockResolvedValue({
      ...TEST_AUTOMATION,
      runCount: 1,
    });
    intakeMocks.routeExternalTaskIntake.mockResolvedValue({
      intent: "create-thread",
      threadId: "thread-1",
      threadChatId: "chat-1",
    });
  });

  it("routes automation thread creation through external task intake", async () => {
    const transformedMessage = {
      ...TEST_MESSAGE,
      parts: [{ type: "text", text: "PR specific prompt" }],
    } satisfies DBUserMessage;

    const result = await runAutomation({
      userId: "user-1",
      automationId: "automation-1",
      source: "automated",
      options: {
        branchName: "feature/pr",
        prNumber: 42,
        transformMessage: () => transformedMessage,
      },
    });

    expect(result).toEqual({ threadId: "thread-1", threadChatId: "chat-1" });
    expect(intakeMocks.routeExternalTaskIntake).toHaveBeenCalledWith({
      intent: "create-thread",
      source: "automation",
      ownerUserId: "user-1",
      ownerReason: "automated",
      targetKey: {
        type: "automation-run",
        automationId: "automation-1",
        triggerType: "pull_request",
        runSource: "automated",
        githubPRNumber: 42,
      },
      message: transformedMessage,
      githubRepoFullName: "owner/repo",
      baseBranchName: "feature/pr",
      headBranchName: null,
      sourceType: "automation",
      automation: TEST_AUTOMATION,
      githubPRNumber: 42,
      githubIssueNumber: undefined,
      disableGitCheckpointing: true,
    });
    expect(
      automationModelMocks.incrementAutomationRunCount,
    ).toHaveBeenCalledWith({
      db: {},
      automationId: "automation-1",
      userId: "user-1",
      accessTier: "pro",
    });
  });

  it("does not increment run count when intake routing fails", async () => {
    intakeMocks.routeExternalTaskIntake.mockRejectedValueOnce(
      new Error("routing failed"),
    );

    await expect(
      runAutomation({
        userId: "user-1",
        automationId: "automation-1",
        source: "manual",
      }),
    ).resolves.toBeUndefined();

    expect(
      automationModelMocks.incrementAutomationRunCount,
    ).not.toHaveBeenCalled();
  });
});
