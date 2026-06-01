import type { ThreadInfo } from "@terragon/shared";
import { describe, expect, it, vi } from "vitest";

function makeThreadInfo(overrides: Partial<ThreadInfo> = {}): ThreadInfo {
  return {
    id: "thread-1",
    userId: "user-1",
    name: "Task",
    githubRepoFullName: "terragon/oss",
    githubPRNumber: null,
    githubIssueNumber: null,
    codesandboxId: "sandbox-1",
    sandboxProvider: "e2b",
    sandboxSize: "small",
    sandboxStatus: "running",
    bootingSubstatus: null,
    createdAt: new Date("2026-05-31T00:00:00.000Z"),
    updatedAt: new Date("2026-05-31T00:00:00.000Z"),
    repoBaseBranchName: "main",
    branchName: "feature/task",
    archived: false,
    automationId: null,
    parentThreadId: null,
    parentToolId: null,
    draftMessage: null,
    disableGitCheckpointing: false,
    skipSetup: false,
    sourceType: "www",
    sourceMetadata: { type: "www" },
    version: 1,
    gitDiffStats: null,
    authorName: "Tyler",
    authorImage: null,
    prStatus: null,
    prChecksStatus: null,
    visibility: "private",
    isUnread: false,
    messageSeq: 1,
    threadChats: [
      {
        id: "chat-1",
        agent: "claudeCode",
        status: "queued",
        errorMessage: null,
      },
    ],
    ...overrides,
  };
}

async function waitForReady(
  getThreadInfoCollection: () => { status: string },
  timeoutMs = 500,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (getThreadInfoCollection().status === "ready") {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for thread info collection to be ready");
}

describe("thread-info-collection", () => {
  it("does not let stale query seeds overwrite fresher realtime patches", async () => {
    vi.resetModules();

    const { seedThreadList, getThreadInfoCollection } = await import(
      "./thread-info-collection"
    );
    const freshThread = makeThreadInfo({
      name: "Fresh task",
      version: 2,
      messageSeq: 2,
      updatedAt: new Date("2026-05-31T00:00:10.000Z"),
    });
    const staleThread = makeThreadInfo({
      name: "Stale task",
      version: 3,
      messageSeq: 3,
      updatedAt: new Date("2026-05-31T00:00:01.000Z"),
    });

    seedThreadList([freshThread]);
    await waitForReady(getThreadInfoCollection);
    seedThreadList([staleThread]);

    const collection = getThreadInfoCollection();
    const stored = collection.state.get("thread-1") as ThreadInfo | undefined;
    expect(stored?.name).toBe("Fresh task");
    expect(stored?.updatedAt.toISOString()).toBe("2026-05-31T00:00:10.000Z");
  });
});
