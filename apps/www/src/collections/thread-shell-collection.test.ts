import type { ThreadPageShell } from "@terragon/shared";
import { describe, expect, it, vi } from "vitest";

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

  it("does not let stale query seeds overwrite fresher collection shells", async () => {
    vi.resetModules();

    const { seedShell, getThreadShellCollection } = await import(
      "./thread-shell-collection"
    );

    async function waitForReady(timeoutMs = 500) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const c = getThreadShellCollection();
        if (c.status === "ready") return;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      throw new Error("Timed out waiting for shell collection to be ready");
    }

    const freshShell = makeShell({
      name: "Fresh task",
      updatedAt: new Date("2026-03-09T00:00:10.000Z"),
      version: 2,
      messageSeq: 2,
      primaryThreadChat: {
        ...makeShell().primaryThreadChat,
        status: "working",
        updatedAt: new Date("2026-03-09T00:00:10.000Z"),
        messageSeq: 2,
      },
    });
    const staleShell = makeShell({
      name: "Stale task",
      updatedAt: new Date("2026-03-09T00:00:00.000Z"),
      version: 1,
      messageSeq: 1,
      primaryThreadChat: {
        ...makeShell().primaryThreadChat,
        status: "complete",
        updatedAt: new Date("2026-03-09T00:00:00.000Z"),
        messageSeq: 1,
      },
    });

    seedShell(freshShell);
    await waitForReady();
    seedShell(staleShell);

    const c = getThreadShellCollection();
    const stored = c.state.get("thread-1") as ThreadPageShell | undefined;
    expect(stored?.name).toBe("Fresh task");
    expect(stored?.version).toBe(2);
    expect(stored?.primaryThreadChat.status).toBe("working");
  });

  it("adopts fresher query seeds for existing shell rows", async () => {
    vi.resetModules();

    const { seedShell, getThreadShellCollection } = await import(
      "./thread-shell-collection"
    );

    async function waitForReady(timeoutMs = 500) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const c = getThreadShellCollection();
        if (c.status === "ready") return;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      throw new Error("Timed out waiting for shell collection to be ready");
    }

    seedShell(makeShell({ name: "Version 1", version: 1 }));
    await waitForReady();
    seedShell(makeShell({ name: "Version 2", version: 2 }));

    const c = getThreadShellCollection();
    const stored = c.state.get("thread-1") as ThreadPageShell | undefined;
    expect(stored?.name).toBe("Version 2");
    expect(stored?.version).toBe(2);
  });

  it("lets durable shell seeds with newer chat messageSeq replace higher thread versions", async () => {
    vi.resetModules();

    const { seedShell, getThreadShellCollection } = await import(
      "./thread-shell-collection"
    );

    async function waitForReady(timeoutMs = 500) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const c = getThreadShellCollection();
        if (c.status === "ready") return;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      throw new Error("Timed out waiting for shell collection to be ready");
    }

    seedShell(
      makeShell({
        name: "Patched shell",
        version: 5,
        primaryThreadChat: {
          ...makeShell().primaryThreadChat,
          messageSeq: 2,
          status: "working",
        },
      }),
    );
    await waitForReady();
    seedShell(
      makeShell({
        name: "Durable shell",
        version: 4,
        primaryThreadChat: {
          ...makeShell().primaryThreadChat,
          messageSeq: 3,
          status: "complete",
        },
      }),
    );

    const c = getThreadShellCollection();
    const stored = c.state.get("thread-1") as ThreadPageShell | undefined;
    expect(stored?.name).toBe("Durable shell");
    expect(stored?.version).toBe(4);
    expect(stored?.primaryThreadChat.messageSeq).toBe(3);
    expect(stored?.primaryThreadChat.status).toBe("complete");
  });

  it("rejects stale shell seeds even when their thread version is higher", async () => {
    vi.resetModules();

    const { seedShell, getThreadShellCollection } = await import(
      "./thread-shell-collection"
    );

    async function waitForReady(timeoutMs = 500) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const c = getThreadShellCollection();
        if (c.status === "ready") return;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      throw new Error("Timed out waiting for shell collection to be ready");
    }

    seedShell(
      makeShell({
        name: "Fresh shell",
        version: 4,
        primaryThreadChat: {
          ...makeShell().primaryThreadChat,
          messageSeq: 3,
          status: "working",
        },
      }),
    );
    await waitForReady();
    seedShell(
      makeShell({
        name: "Stale shell",
        version: 5,
        primaryThreadChat: {
          ...makeShell().primaryThreadChat,
          messageSeq: 2,
          status: "complete",
        },
      }),
    );

    const c = getThreadShellCollection();
    const stored = c.state.get("thread-1") as ThreadPageShell | undefined;
    expect(stored?.name).toBe("Fresh shell");
    expect(stored?.version).toBe(4);
    expect(stored?.primaryThreadChat.messageSeq).toBe(3);
    expect(stored?.primaryThreadChat.status).toBe("working");
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
