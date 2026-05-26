import type { AppendMessage } from "@assistant-ui/react";
import type { DBUserMessage } from "@terragon/shared";
import { describe, expect, it, vi } from "vitest";
import { createChatRuntimeQueue } from "./chat-ui-layout";

function userAppendMessage(): AppendMessage {
  return {
    role: "user",
    content: [{ type: "text", text: "queue me" }],
    createdAt: new Date("2026-05-23T00:00:00.000Z"),
    metadata: { custom: {} },
    parentId: null,
    sourceId: null,
    runConfig: undefined,
  };
}

describe("createChatRuntimeQueue", () => {
  it("dedupes a retried append through the real queue write path", async () => {
    const queuedMessagesRef = { current: null as DBUserMessage[] | null };
    const queueWriteRef = { current: Promise.resolve() };
    const forceScrollToBottom = vi.fn();
    const onOptimisticQueuedMessagesUpdate = vi.fn();
    const publish = vi.fn(async () => undefined);
    const reconcileActiveChatFromServer = vi.fn(async () => undefined);
    const setError = vi.fn();
    const queue = createChatRuntimeQueue({
      forceScrollToBottom,
      isAgentCurrentlyWorking: true,
      onOptimisticQueuedMessagesUpdate,
      publish,
      queueWriteRef,
      queuedMessagesRef,
      reconcileActiveChatFromServer,
      setError,
      threadChatId: "thread-chat-1",
      threadId: "thread-1",
    });
    const message = userAppendMessage();

    await queue.enqueue(message);
    await queue.enqueue(message);

    expect(onOptimisticQueuedMessagesUpdate).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith({
      type: "queue-message",
      threadId: "thread-1",
      threadChatId: "thread-chat-1",
      messages: expect.arrayContaining([
        expect.not.objectContaining({ clientSubmissionId: expect.any(String) }),
      ]),
    });
    expect(queuedMessagesRef.current).toHaveLength(1);
    expect(forceScrollToBottom).toHaveBeenCalledTimes(2);
  });
});
