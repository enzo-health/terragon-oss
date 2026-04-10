import { describe, expect, it } from "vitest";
import type { BroadcastThreadPatch } from "@terragon/types/broadcast";
import { shouldProcessThreadPatch } from "./useRealtime";

describe("shouldProcessThreadPatch", () => {
  it("accepts same-thread shell patches even when the active chat id is stale", () => {
    const patch = {
      threadId: "thread-1",
      threadChatId: "chat-2",
      op: "upsert",
      shell: {
        primaryThreadChatId: "chat-2",
      },
    } satisfies BroadcastThreadPatch;

    expect(
      shouldProcessThreadPatch({
        patch,
        threadId: "thread-1",
        threadChatId: "chat-1",
      }),
    ).toBe(true);
  });

  it("keeps chat-only patches gated by the active chat id", () => {
    const patch = {
      threadId: "thread-1",
      threadChatId: "chat-2",
      op: "upsert",
      chat: {
        status: "complete",
      },
    } satisfies BroadcastThreadPatch;

    expect(
      shouldProcessThreadPatch({
        patch,
        threadId: "thread-1",
        threadChatId: "chat-1",
      }),
    ).toBe(false);
  });

  it("rejects patches for other threads", () => {
    const patch = {
      threadId: "thread-2",
      threadChatId: "chat-2",
      op: "upsert",
      shell: {
        primaryThreadChatId: "chat-2",
      },
    } satisfies BroadcastThreadPatch;

    expect(
      shouldProcessThreadPatch({
        patch,
        threadId: "thread-1",
        threadChatId: "chat-1",
      }),
    ).toBe(false);
  });
});
