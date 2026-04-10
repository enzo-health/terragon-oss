/* @vitest-environment jsdom */

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BroadcastThreadPatch } from "@terragon/types/broadcast";
import type { BroadcastUserMessage } from "@terragon/types/broadcast";
import { shouldProcessThreadPatch, useRealtimeThread } from "./useRealtime";
import { resetRealtimeStateForTests } from "./realtime-socket-state";

interface MockPartySocketLike extends EventTarget {
  messageListeners: number;
  readyState: number;
  dispatchUserMessage(message: BroadcastUserMessage): void;
  dispatchOpen(): void;
  dispatchClose(): void;
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
    readyState: number = WebSocket.CONNECTING;
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

    dispatchOpen(): void {
      this.readyState = WebSocket.OPEN;
      this.dispatchEvent(new Event("open"));
    }

    dispatchClose(): void {
      this.readyState = WebSocket.CLOSED;
      this.dispatchEvent(new CloseEvent("close"));
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

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
  container = null;
  resetRealtimeStateForTests();
  mockPartySocketState.sockets.splice(0);
  vi.clearAllMocks();
  vi.unstubAllGlobals();
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
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
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

  it("replays missed messages immediately after reconnect from the fetched baseline", async () => {
    const receivedPatches: BroadcastThreadPatch[][] = [];
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        entries: [
          {
            seq: 6,
            messages: [{ type: "agent", parts: [] }],
          },
        ],
        deltaEntries: [],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    function Harness() {
      useRealtimeThread(
        "thread-1",
        "chat-1",
        (patches) => {
          receivedPatches.push(patches);
        },
        { messageSeq: 5 },
      );
      return null;
    }

    await act(async () => {
      root?.render(createElement(Harness));
    });

    const socket = mockPartySocketState.sockets.at(-1);
    expect(socket).toBeDefined();

    await act(async () => {
      await Promise.resolve();
      socket?.dispatchClose();
      socket?.dispatchOpen();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const replayUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(replayUrl.pathname).toBe("/api/thread-replay");
    expect(replayUrl.searchParams.get("threadId")).toBe("thread-1");
    expect(replayUrl.searchParams.get("fromSeq")).toBe("5");
    expect(replayUrl.searchParams.get("threadChatId")).toBeNull();
    expect(replayUrl.searchParams.get("fromDeltaSeq")).toBeNull();
    expect(receivedPatches).toHaveLength(1);
    expect(receivedPatches[0]).toEqual([
      {
        threadId: "thread-1",
        threadChatId: "chat-1",
        op: "upsert",
        chatSequence: 6,
        messageSeq: 6,
        appendMessages: [{ type: "agent", parts: [] }],
      },
    ]);
  });

  it("reseeds replay cursors when the active chat switches to a lower canonical message sequence", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        entries: [],
        deltaEntries: [],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    function Harness({
      activeThreadChatId,
      baselineMessageSeq,
    }: {
      activeThreadChatId: string;
      baselineMessageSeq: number;
    }) {
      useRealtimeThread("thread-1", activeThreadChatId, () => {}, {
        messageSeq: baselineMessageSeq,
      });
      return null;
    }

    await act(async () => {
      root?.render(
        createElement(Harness, {
          activeThreadChatId: "chat-1",
          baselineMessageSeq: 5,
        }),
      );
    });

    const socket = mockPartySocketState.sockets.at(-1);
    expect(socket).toBeDefined();

    await act(async () => {
      root?.render(
        createElement(Harness, {
          activeThreadChatId: "chat-2",
          baselineMessageSeq: 2,
        }),
      );
      await Promise.resolve();
      socket?.dispatchClose();
      socket?.dispatchOpen();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const replayUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(replayUrl.searchParams.get("threadId")).toBe("thread-1");
    expect(replayUrl.searchParams.get("fromSeq")).toBe("2");
    expect(replayUrl.searchParams.get("threadChatId")).toBeNull();
    expect(replayUrl.searchParams.get("fromDeltaSeq")).toBeNull();
  });

  it("applies live patches immediately when a replay gap arrives during an in-flight replay", async () => {
    const receivedPatches: BroadcastThreadPatch[][] = [];
    const deferredReplay = createDeferred<{
      ok: boolean;
      json: () => Promise<{
        entries: Array<{ seq: number; messages: unknown[] }>;
        deltaEntries: unknown[];
      }>;
    }>();
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => deferredReplay.promise);
    vi.stubGlobal("fetch", fetchMock);

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    function Harness() {
      useRealtimeThread(
        "thread-1",
        "chat-1",
        (patches) => {
          receivedPatches.push(patches);
        },
        { messageSeq: 5 },
      );
      return null;
    }

    await act(async () => {
      root?.render(createElement(Harness));
    });

    const socket = mockPartySocketState.sockets.at(-1);
    expect(socket).toBeDefined();

    await act(async () => {
      socket?.dispatchClose();
      socket?.dispatchOpen();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);

    const livePatchMessage: BroadcastUserMessage = {
      type: "user",
      id: "message-gap",
      data: {
        threadPatches: [
          {
            threadId: "thread-1",
            threadChatId: "chat-1",
            op: "upsert",
            chatSequence: 8,
            messageSeq: 8,
            appendMessages: [{ type: "agent", parts: [] }],
          },
        ],
      },
    };

    await act(async () => {
      socket?.dispatchUserMessage(livePatchMessage);
      await Promise.resolve();
    });

    expect(receivedPatches).toHaveLength(1);
    expect(receivedPatches[0]).toEqual(livePatchMessage.data.threadPatches);

    deferredReplay.resolve({
      ok: true,
      json: async () => ({
        entries: [
          {
            seq: 6,
            messages: [{ type: "agent", parts: [{ type: "text", text: "a" }] }],
          },
          {
            seq: 7,
            messages: [{ type: "agent", parts: [{ type: "text", text: "b" }] }],
          },
        ],
        deltaEntries: [],
      }),
    });

    await act(async () => {
      await deferredReplay.promise;
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(receivedPatches).toHaveLength(2);
    expect(receivedPatches[1]).toEqual([
      {
        threadId: "thread-1",
        threadChatId: "chat-1",
        op: "upsert",
        chatSequence: 6,
        messageSeq: 6,
        appendMessages: [
          { type: "agent", parts: [{ type: "text", text: "a" }] },
        ],
      },
      {
        threadId: "thread-1",
        threadChatId: "chat-1",
        op: "upsert",
        chatSequence: 7,
        messageSeq: 7,
        appendMessages: [
          { type: "agent", parts: [{ type: "text", text: "b" }] },
        ],
      },
    ]);
  });

  it("replays immediately when mounting against an already-open shared socket", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        entries: [],
        deltaEntries: [],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    function WarmSocketHarness() {
      useRealtimeThread("thread-1", "chat-1", () => {});
      return null;
    }

    function ReplayHarness() {
      useRealtimeThread("thread-1", "chat-1", () => {}, { messageSeq: 5 });
      return null;
    }

    await act(async () => {
      root?.render(createElement(WarmSocketHarness));
    });

    const socket = mockPartySocketState.sockets.at(-1);
    expect(socket).toBeDefined();

    await act(async () => {
      socket?.dispatchOpen();
      await Promise.resolve();
    });

    fetchMock.mockClear();

    await act(async () => {
      root?.render(null);
    });

    await act(async () => {
      root?.render(createElement(ReplayHarness));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const replayUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(replayUrl.searchParams.get("threadId")).toBe("thread-1");
    expect(replayUrl.searchParams.get("fromSeq")).toBe("5");
  });

  it("falls back to live patches when replay fetch fails in the active context", async () => {
    const receivedPatches: BroadcastThreadPatch[][] = [];
    const fetchMock = vi.fn().mockRejectedValue(new Error("network fail"));
    vi.stubGlobal("fetch", fetchMock);

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    function Harness() {
      useRealtimeThread(
        "thread-1",
        "chat-1",
        (patches) => {
          receivedPatches.push(patches);
        },
        { messageSeq: 5 },
      );
      return null;
    }

    await act(async () => {
      root?.render(createElement(Harness));
    });

    const socket = mockPartySocketState.sockets.at(-1);
    expect(socket).toBeDefined();

    const gapPatchMessage: BroadcastUserMessage = {
      type: "user",
      id: "message-gap-failure",
      data: {
        threadPatches: [
          {
            threadId: "thread-1",
            threadChatId: "chat-1",
            op: "upsert",
            chatSequence: 8,
            messageSeq: 8,
            appendMessages: [{ type: "agent", parts: [] }],
          },
        ],
      },
    };

    await act(async () => {
      socket?.dispatchUserMessage(gapPatchMessage);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(receivedPatches).toEqual([gapPatchMessage.data.threadPatches]);
  });

  it("falls back to live patches when replay payload validation fails", async () => {
    const receivedPatches: BroadcastThreadPatch[][] = [];
    const consoleWarnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => {});
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        entries: "bad-shape",
        deltaEntries: [],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    function Harness() {
      useRealtimeThread(
        "thread-1",
        "chat-1",
        (patches) => {
          receivedPatches.push(patches);
        },
        { messageSeq: 5 },
      );
      return null;
    }

    await act(async () => {
      root?.render(createElement(Harness));
    });

    const socket = mockPartySocketState.sockets.at(-1);
    expect(socket).toBeDefined();

    const gapPatchMessage: BroadcastUserMessage = {
      type: "user",
      id: "message-gap-invalid-payload",
      data: {
        threadPatches: [
          {
            threadId: "thread-1",
            threadChatId: "chat-1",
            op: "upsert",
            chatSequence: 9,
            messageSeq: 9,
            appendMessages: [{ type: "agent", parts: [] }],
          },
        ],
      },
    };

    await act(async () => {
      socket?.dispatchUserMessage(gapPatchMessage);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(receivedPatches).toEqual([gapPatchMessage.data.threadPatches]);
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      "[broadcast] replay fetch failed, applying patches directly",
      expect.any(Error),
    );
  });

  it("drops stale replay failures after the active chat context changes", async () => {
    const receivedPatches: BroadcastThreadPatch[][] = [];
    const consoleWarnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => {});
    const deferredReplay = createDeferred<Response>();
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => deferredReplay.promise)
      .mockResolvedValue({
        ok: true,
        json: async () => ({
          entries: [],
          deltaEntries: [],
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    function Harness({
      activeThreadChatId,
      baselineMessageSeq,
    }: {
      activeThreadChatId: string;
      baselineMessageSeq: number;
    }) {
      useRealtimeThread(
        "thread-1",
        activeThreadChatId,
        (patches) => {
          receivedPatches.push(patches);
        },
        { messageSeq: baselineMessageSeq },
      );
      return null;
    }

    await act(async () => {
      root?.render(
        createElement(Harness, {
          activeThreadChatId: "chat-1",
          baselineMessageSeq: 5,
        }),
      );
    });

    const socket = mockPartySocketState.sockets.at(-1);
    expect(socket).toBeDefined();

    await act(async () => {
      socket?.dispatchClose();
      socket?.dispatchOpen();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      root?.render(
        createElement(Harness, {
          activeThreadChatId: "chat-2",
          baselineMessageSeq: 2,
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    deferredReplay.reject(new Error("late replay failure"));

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(receivedPatches).toHaveLength(0);
    expect(consoleWarnSpy).not.toHaveBeenCalledWith(
      "[broadcast] replay fetch failed, applying patches directly",
      expect.any(Error),
    );
  });

  it("aborts an in-flight reconnect replay so the next reconnect retries immediately", async () => {
    const fetchMock = vi.fn().mockImplementation(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal;
          if (!(signal instanceof AbortSignal)) {
            return;
          }
          signal.addEventListener(
            "abort",
            () => {
              reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    function Harness() {
      useRealtimeThread("thread-1", "chat-1", () => {}, { messageSeq: 5 });
      return null;
    }

    await act(async () => {
      root?.render(createElement(Harness));
    });

    const socket = mockPartySocketState.sockets.at(-1);
    expect(socket).toBeDefined();

    await act(async () => {
      socket?.dispatchClose();
      socket?.dispatchOpen();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      socket?.dispatchClose();
      await Promise.resolve();
    });

    await act(async () => {
      socket?.dispatchOpen();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("drops stale replay responses after the active chat context switches", async () => {
    const receivedPatches: BroadcastThreadPatch[][] = [];
    const deferredReplay = createDeferred<{
      ok: boolean;
      json: () => Promise<{
        entries: Array<{ seq: number; messages: unknown[] }>;
        deltaEntries: unknown[];
      }>;
    }>();
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => deferredReplay.promise)
      .mockResolvedValue({
        ok: true,
        json: async () => ({
          entries: [],
          deltaEntries: [],
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    function Harness({
      activeThreadChatId,
      baselineMessageSeq,
    }: {
      activeThreadChatId: string;
      baselineMessageSeq: number;
    }) {
      useRealtimeThread(
        "thread-1",
        activeThreadChatId,
        (patches) => {
          receivedPatches.push(patches);
        },
        { messageSeq: baselineMessageSeq },
      );
      return null;
    }

    await act(async () => {
      root?.render(
        createElement(Harness, {
          activeThreadChatId: "chat-1",
          baselineMessageSeq: 5,
        }),
      );
    });

    const socket = mockPartySocketState.sockets.at(-1);
    expect(socket).toBeDefined();

    await act(async () => {
      socket?.dispatchClose();
      socket?.dispatchOpen();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(
      new URL(String(fetchMock.mock.calls[0]?.[0])).searchParams.get("fromSeq"),
    ).toBe("5");

    await act(async () => {
      root?.render(
        createElement(Harness, {
          activeThreadChatId: "chat-2",
          baselineMessageSeq: 2,
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      new URL(String(fetchMock.mock.calls[1]?.[0])).searchParams.get("fromSeq"),
    ).toBe("2");

    deferredReplay.resolve({
      ok: true,
      json: async () => ({
        entries: [
          {
            seq: 6,
            messages: [{ type: "agent", parts: [] }],
          },
        ],
        deltaEntries: [],
      }),
    });

    await act(async () => {
      await deferredReplay.promise;
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(receivedPatches).toHaveLength(0);

    await act(async () => {
      socket?.dispatchClose();
      await Promise.resolve();
    });

    await act(async () => {
      socket?.dispatchOpen();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(
      new URL(String(fetchMock.mock.calls[2]?.[0])).searchParams.get("fromSeq"),
    ).toBe("2");
    expect(receivedPatches).toHaveLength(0);
  });
});
