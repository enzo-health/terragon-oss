import type { ThreadPageShell } from "@terragon/shared/db/types";
import { describe, expect, it } from "vitest";
import { createProvisionalThreadPageChat } from "./thread-provider";

describe("createProvisionalThreadPageChat", () => {
  it("creates an empty chat seed from the shell summary", () => {
    const shell = makeShell({
      primaryThreadChat: {
        ...makeShell().primaryThreadChat,
        status: "working",
        permissionMode: "plan",
        messageSeq: 7,
      },
    });

    const chat = createProvisionalThreadPageChat(shell);

    expect(chat.id).toBe(shell.primaryThreadChatId);
    expect(chat.threadId).toBe(shell.id);
    expect(chat.agent).toBe(shell.primaryThreadChat.agent);
    expect(chat.status).toBe("working");
    expect(chat.permissionMode).toBe("plan");
    expect(chat.messageSeq).toBe(7);
    expect(chat.projectedMessages).toEqual([]);
    expect(chat.messageCount).toBe(0);
    expect(chat.isCanonicalProjection).toBe(false);
  });
});

function makeShell(overrides: Partial<ThreadPageShell> = {}): ThreadPageShell {
  return {
    id: "thread-1",
    userId: "user-1",
    name: "Test task",
    branchName: "feature/test-task",
    repoBaseBranchName: "main",
    githubRepoFullName: "terragon/example",
    automationId: null,
    codesandboxId: "sandbox-1",
    sandboxProvider: "e2b",
    sandboxSize: "small",
    bootingSubstatus: null,
    archived: false,
    createdAt: new Date("2026-03-09T00:00:00.000Z"),
    updatedAt: new Date("2026-03-09T00:00:00.000Z"),
    visibility: "private",
    prStatus: null,
    prChecksStatus: null,
    authorName: "Tyler",
    authorImage: null,
    githubPRNumber: null,
    githubIssueNumber: null,
    sandboxStatus: "running",
    gitDiffStats: null,
    parentThreadName: null,
    parentThreadId: null,
    parentToolId: null,
    draftMessage: null,
    skipSetup: false,
    disableGitCheckpointing: false,
    sourceType: "www",
    sourceMetadata: {
      type: "www",
    },
    version: 1,
    isUnread: false,
    messageSeq: 0,
    childThreads: [],
    hasGitDiff: false,
    primaryThreadChatId: "chat-1",
    primaryThreadChat: {
      id: "chat-1",
      threadId: "thread-1",
      agent: "claudeCode",
      agentVersion: 1,
      status: "queued",
      errorMessage: null,
      errorMessageInfo: null,
      scheduleAt: null,
      reattemptQueueAt: null,
      contextLength: null,
      permissionMode: "allowAll",
      isUnread: false,
      updatedAt: new Date("2026-03-09T00:00:00.000Z"),
      messageSeq: 0,
    },
    ...overrides,
  };
}
