import { describe, expect, it, vi } from "vitest";
import type { ThreadPageShell } from "@terragon/shared";

describe("thread-shell-collection", () => {
  it("applies shell patches that arrive before the initial seed", async () => {
    vi.resetModules();

    const mod = await import("./thread-shell-collection");
    const { applyShellPatchToCollection, seedShell, getThreadShellCollection } =
      mod;

    async function waitForReady(timeoutMs = 500) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const c = getThreadShellCollection();
        if (c.status === "ready") return;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      throw new Error("Timed out waiting for shell collection to be ready");
    }

    const baseShell: ThreadPageShell = {
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
        deliveryLoopOptIn: false,
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
    };

    // Patch arrives first, but row doesn't exist yet.
    applyShellPatchToCollection({
      threadId: "thread-1",
      op: "upsert",
      shell: {
        updatedAt: "2026-03-09T00:00:10.000Z",
        name: "Patched task",
      },
    });

    // Then the seed arrives.
    seedShell(baseShell);

    await waitForReady();
    const c = getThreadShellCollection();
    const stored = c.state.get("thread-1") as ThreadPageShell | undefined;
    expect(stored?.name).toBe("Patched task");
    expect(stored?.updatedAt.toISOString()).toBe("2026-03-09T00:00:10.000Z");
  });
});
