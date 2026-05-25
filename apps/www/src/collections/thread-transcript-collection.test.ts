import { describe, expect, it, vi } from "vitest";

describe("thread-transcript-collection", () => {
  it("round-trips projection-aware replay cursors through the transcript cache", async () => {
    vi.resetModules();

    const {
      getCachedTranscript,
      getThreadTranscriptCollection,
      seedTranscript,
    } = await import("./thread-transcript-collection");

    async function waitForReady(timeoutMs = 500): Promise<void> {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (getThreadTranscriptCollection().status === "ready") {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      throw new Error("Timed out waiting for transcript collection");
    }

    seedTranscript({
      threadId: "thread-1",
      threadChatId: "chat-1",
      result: {
        messages: [{ id: "user-1", role: "user", content: "hello" }],
        lastSeq: 42,
        lastCursor: { seq: 42, projectionIndex: 1 },
      },
    });
    await waitForReady();

    expect(getCachedTranscript("thread-1", "chat-1")).toEqual({
      messages: [{ id: "user-1", role: "user", content: "hello" }],
      lastSeq: 42,
      lastCursor: { seq: 42, projectionIndex: 1 },
    });
  });
});
