import { describe, expect, it, vi } from "vitest";
import type { ThreadPageChat } from "@terragon/shared";
import type { BroadcastThreadPatch } from "@terragon/types/broadcast";

describe("thread-chat-collection", () => {
  it("does not let stale query seeds overwrite fresher collection chats", async () => {
    vi.resetModules();

    const { seedChat, getThreadChatCollection } = await import(
      "./thread-chat-collection"
    );

    async function waitForReady(timeoutMs = 500) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const c = getThreadChatCollection();
        if (c.status === "ready") return;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      throw new Error("Timed out waiting for chat collection to be ready");
    }

    const fresh = makeChat({
      status: "working",
      updatedAt: new Date("2026-03-09T00:00:10.000Z"),
      messageSeq: 2,
      patchVersion: 2,
    });
    const stale = makeChat({
      status: "complete",
      updatedAt: new Date("2026-03-09T00:00:00.000Z"),
      messageSeq: 1,
      patchVersion: 1,
    });

    seedChat(fresh);
    await waitForReady();
    seedChat(stale);

    const c = getThreadChatCollection();
    const stored = c.state.get("thread-1:chat-1") as ThreadPageChat | undefined;
    expect(stored?.status).toBe("working");
    expect(stored?.messageSeq).toBe(2);
    expect(stored?.patchVersion).toBe(2);
  });

  it("lets durable refetch seeds with newer messageSeq replace higher patchVersion rows", async () => {
    vi.resetModules();

    const { seedChat, getThreadChatCollection } = await import(
      "./thread-chat-collection"
    );

    async function waitForReady(timeoutMs = 500) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const c = getThreadChatCollection();
        if (c.status === "ready") return;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      throw new Error("Timed out waiting for chat collection to be ready");
    }

    seedChat(
      makeChat({
        status: "working",
        messageSeq: 2,
        patchVersion: 5,
      }),
    );
    await waitForReady();
    seedChat(
      makeChat({
        status: "complete",
        messageSeq: 3,
        patchVersion: 0,
      }),
    );

    const c = getThreadChatCollection();
    const stored = c.state.get("thread-1:chat-1") as ThreadPageChat | undefined;
    expect(stored?.status).toBe("complete");
    expect(stored?.messageSeq).toBe(3);
    expect(stored?.patchVersion).toBe(0);
  });

  it("lets durable refetch seeds enrich the transcript at the same messageSeq after metadata patches", async () => {
    vi.resetModules();

    const { seedChat, getThreadChatCollection } = await import(
      "./thread-chat-collection"
    );

    async function waitForReady(timeoutMs = 500) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const c = getThreadChatCollection();
        if (c.status === "ready") return;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      throw new Error("Timed out waiting for chat collection to be ready");
    }

    seedChat(
      makeChat({
        status: "working",
        projectedMessages: [],
        messageCount: 0,
        messageSeq: 2,
        patchVersion: 5,
        updatedAt: new Date("2026-03-09T00:00:05.000Z"),
      }),
    );
    await waitForReady();
    seedChat(
      makeChat({
        status: "working",
        isCanonicalProjection: true,
        projectedMessages: [
          {
            type: "user",
            model: null,
            parts: [{ type: "text", text: "hello" }],
          },
          {
            type: "agent",
            parent_tool_use_id: null,
            parts: [{ type: "text", text: "hi" }],
          },
        ],
        messageCount: 2,
        messageSeq: 2,
        patchVersion: 0,
        updatedAt: new Date("2026-03-09T00:00:10.000Z"),
      }),
    );

    const c = getThreadChatCollection();
    const stored = c.state.get("thread-1:chat-1") as ThreadPageChat | undefined;
    expect(stored?.isCanonicalProjection).toBe(true);
    expect(stored?.projectedMessages).toHaveLength(2);
    expect(stored?.updatedAt).toEqual(new Date("2026-03-09T00:00:10.000Z"));
  });

  it("invalidates when a realtime chat patch arrives before the chat row is seeded", async () => {
    vi.resetModules();

    const { applyChatPatchToCollection, getThreadChatCollection } =
      await import("./thread-chat-collection");

    async function waitForReady(timeoutMs = 500) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const c = getThreadChatCollection();
        if (c.status === "ready") return;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      throw new Error("Timed out waiting for chat collection to be ready");
    }

    await waitForReady();

    const result = applyChatPatchToCollection({
      threadId: "thread-1",
      threadChatId: "chat-1",
      op: "upsert",
      messageSeq: 2,
      patchVersion: 2,
      chat: {
        status: "working",
        updatedAt: "2026-03-09T00:00:10.000Z",
      },
    } as BroadcastThreadPatch);

    expect(result.shouldInvalidate).toBe(true);
  });
});

function makeChat(overrides: Partial<ThreadPageChat> = {}): ThreadPageChat {
  const messages = [
    {
      type: "user" as const,
      model: null,
      parts: [{ type: "text" as const, text: "hello" }],
    },
  ];
  return {
    id: "chat-1",
    userId: "user-1",
    threadId: "thread-1",
    title: null,
    createdAt: new Date("2026-03-09T00:00:00.000Z"),
    updatedAt: new Date("2026-03-09T00:00:00.000Z"),
    agent: "claudeCode",
    agentVersion: 1,
    status: "complete",
    projectedMessages: messages,
    isCanonicalProjection: false,
    queuedMessages: null,
    sessionId: null,
    errorMessage: null,
    errorMessageInfo: null,
    scheduleAt: null,
    reattemptQueueAt: null,
    contextLength: null,
    permissionMode: "allowAll",
    codexPreviousResponseId: null,
    messageSeq: 1,
    messageCount: 1,
    chatSequence: null,
    patchVersion: 1,
    isUnread: false,
    ...overrides,
  };
}
