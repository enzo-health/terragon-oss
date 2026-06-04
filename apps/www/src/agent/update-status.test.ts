import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventType } from "@ag-ui/core";

const threadMocks = vi.hoisted(() => ({
  getThreadChat: vi.fn(),
  updateThread: vi.fn(),
  updateThreadChat: vi.fn(),
  updateThreadChatStatusAtomic: vi.fn(),
}));

const machineMocks = vi.hoisted(() => ({
  handleTransition: vi.fn(),
}));

const readStatusMocks = vi.hoisted(() => ({
  markThreadChatAsUnread: vi.fn(),
}));

const publisherMocks = vi.hoisted(() => ({
  broadcastAgUiEventEphemeral: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: { label: "db" },
}));

vi.mock("@terragon/shared/model/threads", () => ({
  getThreadChat: threadMocks.getThreadChat,
  updateThread: threadMocks.updateThread,
  updateThreadChat: threadMocks.updateThreadChat,
  updateThreadChatStatusAtomic: threadMocks.updateThreadChatStatusAtomic,
}));

vi.mock("@terragon/shared/model/thread-read-status", () => ({
  markThreadChatAsUnread: readStatusMocks.markThreadChatAsUnread,
}));

vi.mock("./machine", () => ({
  handleTransition: machineMocks.handleTransition,
}));

vi.mock("@/server-lib/ag-ui-publisher", () => ({
  broadcastAgUiEventEphemeral: publisherMocks.broadcastAgUiEventEphemeral,
}));

import { updateThreadChatWithTransition } from "./update-status";

const BASE_ARGS = {
  threadId: "thread-1",
  userId: "user-1",
  threadChatId: "chat-1",
  eventType: "assistant.message_done",
} as const;

describe("updateThreadChatWithTransition — thread.status_changed broadcast", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    threadMocks.getThreadChat.mockResolvedValue({
      id: "chat-1",
      threadId: "thread-1",
      status: "working",
      reattemptQueueAt: null,
    });
    threadMocks.updateThreadChatStatusAtomic.mockResolvedValue({
      id: "chat-1",
    });
    threadMocks.updateThreadChat.mockResolvedValue({});
    readStatusMocks.markThreadChatAsUnread.mockResolvedValue(undefined);
    publisherMocks.broadcastAgUiEventEphemeral.mockResolvedValue(undefined);
  });

  it("emits a CUSTOM thread.status_changed event after a successful transition", async () => {
    machineMocks.handleTransition.mockReturnValue("complete");

    await updateThreadChatWithTransition(BASE_ARGS);

    expect(publisherMocks.broadcastAgUiEventEphemeral).toHaveBeenCalledTimes(1);
    expect(publisherMocks.broadcastAgUiEventEphemeral).toHaveBeenCalledWith({
      threadChatId: "chat-1",
      event: {
        type: EventType.CUSTOM,
        name: "thread.status_changed",
        value: { status: "complete" },
      },
    });
  });

  it("emits on terminal transitions independent of chatUpdates/skipBroadcast", async () => {
    machineMocks.handleTransition.mockReturnValue("error");

    await updateThreadChatWithTransition({
      ...BASE_ARGS,
      skipBroadcast: true,
      skipAppendMessagesInBroadcast: true,
    });

    expect(publisherMocks.broadcastAgUiEventEphemeral).toHaveBeenCalledWith({
      threadChatId: "chat-1",
      event: {
        type: EventType.CUSTOM,
        name: "thread.status_changed",
        value: { status: "error" },
      },
    });
  });

  it("does not emit when there is no status transition", async () => {
    machineMocks.handleTransition.mockReturnValue(null);

    const result = await updateThreadChatWithTransition(BASE_ARGS);

    expect(result.didUpdateStatus).toBe(false);
    expect(publisherMocks.broadcastAgUiEventEphemeral).not.toHaveBeenCalled();
  });

  it("does not emit when the atomic status update did not apply", async () => {
    machineMocks.handleTransition.mockReturnValue("complete");
    threadMocks.updateThreadChatStatusAtomic.mockResolvedValue(undefined);

    const result = await updateThreadChatWithTransition(BASE_ARGS);

    expect(result.didUpdateStatus).toBe(false);
    expect(publisherMocks.broadcastAgUiEventEphemeral).not.toHaveBeenCalled();
  });

  it("does not throw or change the result when the broadcast rejects", async () => {
    machineMocks.handleTransition.mockReturnValue("complete");
    publisherMocks.broadcastAgUiEventEphemeral.mockRejectedValue(
      new Error("redis down"),
    );

    const result = await updateThreadChatWithTransition(BASE_ARGS);

    expect(result.didUpdateStatus).toBe(true);
    expect(result.updatedStatus).toBe("complete");
  });
});
