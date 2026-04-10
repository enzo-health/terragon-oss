/* @vitest-environment jsdom */

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BroadcastThreadPatch } from "@terragon/types/broadcast";
import type { BroadcastUserMessage } from "@terragon/types/broadcast";
import { shouldProcessThreadPatch, useRealtimeThread } from "./useRealtime";

interface MockPartySocketLike extends EventTarget {
  messageListeners: number;
  dispatchUserMessage(message: BroadcastUserMessage): void;
  close: ReturnType<typeof vi.fn>;
  reconnect: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
}

const mockPartySocketState = vi.hoisted(() => ({
  sockets: [] as MockPartySocketLike[],
}));

vi.mock("partysocket", () => {
  class MockPartySocket extends EventTarget implements MockPartySocketLike {
    messageListeners = 0;
    close = vi.fn();
    reconnect = vi.fn();
    send = vi.fn();

    constructor(
      readonly options: {
        host: string;
        party: string;
        room: string;
        maxRetries: number;
        maxReconnectionDelay: number;
        reconnectionDelayGrowFactor: number;
        query: () => { token: string | null };
      },
    ) {
      super();
      mockPartySocketState.sockets.push(this);
    }

    override addEventListener(
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions,
    ): void {
      if (type === "message" && listener != null) {
        this.messageListeners += 1;
      }
      super.addEventListener(type, listener, options);
    }

    override removeEventListener(
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | EventListenerOptions,
    ): void {
      if (type === "message" && listener != null) {
        this.messageListeners = Math.max(0, this.messageListeners - 1);
      }
      super.removeEventListener(type, listener, options);
    }

    dispatchUserMessage(message: BroadcastUserMessage): void {
      this.dispatchEvent(
        new MessageEvent("message", { data: JSON.stringify(message) }),
      );
    }
  }

  return {
    default: MockPartySocket,
  };
});

vi.mock("@terragon/env/next-public", () => ({
  publicBroadcastHost: () => "https://broadcast.test",
}));

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
  container = null;
  mockPartySocketState.sockets.splice(0);
  vi.clearAllMocks();
});

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

describe("useRealtimeThread", () => {
  it("delivers same-thread shell patches when the active chat id is stale", async () => {
    const receivedPatches: BroadcastThreadPatch[][] = [];
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    function Harness() {
      useRealtimeThread("thread-1", "chat-1", (patches) => {
        receivedPatches.push(patches);
      });
      return null;
    }

    await act(async () => {
      root?.render(createElement(Harness));
    });

    const socket = mockPartySocketState.sockets.at(-1);
    expect(socket).toBeDefined();

    await act(async () => {
      await Promise.resolve();
    });

    expect(socket?.messageListeners).toBeGreaterThan(0);

    const message: BroadcastUserMessage = {
      type: "user",
      id: "message-1",
      data: {
        threadPatches: [
          {
            threadId: "thread-1",
            threadChatId: "chat-2",
            op: "upsert",
            shell: {
              primaryThreadChatId: "chat-2",
            },
          },
        ],
      },
    };

    await act(async () => {
      socket?.dispatchUserMessage(message);
    });

    expect(receivedPatches).toHaveLength(1);
    expect(receivedPatches[0]).toEqual([
      {
        threadId: "thread-1",
        threadChatId: "chat-2",
        op: "upsert",
        shell: {
          primaryThreadChatId: "chat-2",
        },
      },
    ]);
  });
});
