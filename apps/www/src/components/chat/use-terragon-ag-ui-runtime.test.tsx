/* @vitest-environment jsdom */

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HttpAgent } from "@ag-ui/client";
import type {
  AppendMessage,
  ExternalStoreAdapter,
  ThreadMessage,
} from "@assistant-ui/react";
import type { useToolInvocations } from "@assistant-ui/core/react";
import { useTerragonAgUiRuntime } from "./use-terragon-ag-ui-runtime";

type UseToolInvocationsOptions = Parameters<typeof useToolInvocations>[0];

const mocks = vi.hoisted(() => {
  const state: {
    capturedStore?: unknown;
    capturedToolOptions?: unknown;
    tools: Record<string, unknown>;
    runtime: unknown;
    toolInvocations: {
      reset: ReturnType<typeof vi.fn>;
      abort: ReturnType<typeof vi.fn>;
      resume: ReturnType<typeof vi.fn>;
    };
  } = {
    tools: {},
    runtime: undefined,
    toolInvocations: {
      reset: vi.fn(),
      abort: vi.fn(async () => undefined),
      resume: vi.fn(),
    },
  };

  state.runtime = {
    thread: {
      getModelContext: () => ({ tools: state.tools }),
    },
  };

  return {
    state,
    useRuntimeAdapters: vi.fn(() => null),
    useExternalStoreRuntime: vi.fn((store: unknown) => {
      state.capturedStore = store;
      return state.runtime;
    }),
    useToolInvocations: vi.fn((options: unknown) => {
      state.capturedToolOptions = options;
      return state.toolInvocations;
    }),
  };
});

vi.mock("@assistant-ui/react", () => ({
  useExternalStoreRuntime: mocks.useExternalStoreRuntime,
  useRuntimeAdapters: mocks.useRuntimeAdapters,
}));

vi.mock("@assistant-ui/core/react", () => ({
  useToolInvocations: mocks.useToolInvocations,
}));

function HookHarness({ agent }: { agent: HttpAgent }) {
  useTerragonAgUiRuntime({ agent });
  return <div />;
}

describe("useTerragonAgUiRuntime", () => {
  beforeEach(() => {
    mocks.state.capturedStore = undefined;
    mocks.state.capturedToolOptions = undefined;
    mocks.state.tools = {
      bash: {
        description: "Run a shell command",
        parameters: {},
      },
    };
    mocks.useRuntimeAdapters.mockClear();
    mocks.useExternalStoreRuntime.mockClear();
    mocks.useToolInvocations.mockClear();
    mocks.state.toolInvocations.reset.mockClear();
    mocks.state.toolInvocations.abort.mockClear();
    mocks.state.toolInvocations.resume.mockClear();
  });

  it("wires assistant-ui tool invocations and delegates tool-call resume", () => {
    const agent = {
      threadId: "thread-1",
      messages: [],
      runAgent: vi.fn(),
    } as unknown as HttpAgent;

    renderToStaticMarkup(<HookHarness agent={agent} />);

    expect(mocks.useToolInvocations).toHaveBeenCalledTimes(1);
    const toolOptions = mocks.state
      .capturedToolOptions as UseToolInvocationsOptions;
    expect(toolOptions.state.messages).toEqual([]);
    expect(toolOptions.state.isRunning).toBe(false);
    expect(toolOptions.getTools()).toBe(mocks.state.tools);

    const store = mocks.state
      .capturedStore as ExternalStoreAdapter<ThreadMessage>;
    if (!store.onResumeToolCall) {
      throw new Error("expected onResumeToolCall");
    }
    store.onResumeToolCall({
      toolCallId: "tool-1",
      payload: { approved: true },
    });

    expect(mocks.state.toolInvocations.resume).toHaveBeenCalledWith("tool-1", {
      approved: true,
    });
  });

  it("queues active user appends before they reach the AG-UI core", async () => {
    const agent = {
      threadId: "thread-1",
      messages: [],
      runAgent: vi.fn(),
    } as unknown as HttpAgent;
    const enqueue = vi.fn(async () => undefined);
    const shouldQueue = vi.fn(() => true);

    function QueueHarness(): React.JSX.Element {
      useTerragonAgUiRuntime({
        agent,
        queue: { shouldQueue, enqueue },
      });
      return createElement("div");
    }

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(createElement(QueueHarness));
    });

    const store = mocks.state
      .capturedStore as ExternalStoreAdapter<ThreadMessage>;
    const message: AppendMessage = {
      role: "user",
      content: [{ type: "text", text: "queue me" }],
      createdAt: new Date("2026-05-04T00:00:00.000Z"),
      metadata: { custom: {} },
      parentId: null,
      sourceId: null,
      runConfig: undefined,
    };

    await act(async () => {
      await store.onNew(message);
    });

    expect(shouldQueue).toHaveBeenCalledWith(message);
    expect(enqueue).toHaveBeenCalledWith(message);
    expect(agent.runAgent).not.toHaveBeenCalled();

    act(() => {
      root.unmount();
    });
    container.remove();
  });
});

describe("useTerragonAgUiRuntime cancel endpoint", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchSpy);
    mocks.state.capturedStore = undefined;
    mocks.useExternalStoreRuntime.mockClear();
    mocks.state.toolInvocations.abort.mockClear();
  });

  it("POSTs to the cancel endpoint when threadId and threadChatId are provided", async () => {
    const agent = {
      threadId: "thread-1",
      messages: [],
      runAgent: vi.fn(),
    } as unknown as HttpAgent;

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    function CancelHarness(): React.JSX.Element {
      useTerragonAgUiRuntime({
        agent,
        threadId: "thread-abc",
        threadChatId: "chat-xyz",
      });
      return createElement("div");
    }

    await act(async () => {
      root.render(createElement(CancelHarness));
    });

    const store = mocks.state
      .capturedStore as ExternalStoreAdapter<ThreadMessage>;
    if (!store.onCancel) {
      throw new Error("expected onCancel");
    }

    await act(async () => {
      await store.onCancel?.();
    });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/ag-ui/thread-abc/cancel?threadChatId=chat-xyz");
    expect(init.method).toBe("POST");

    act(() => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  it("does NOT POST to the cancel endpoint when threadId/threadChatId are absent", async () => {
    const agent = {
      threadId: "thread-1",
      messages: [],
      runAgent: vi.fn(),
    } as unknown as HttpAgent;

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    function NoCancelHarness(): React.JSX.Element {
      useTerragonAgUiRuntime({ agent });
      return createElement("div");
    }

    await act(async () => {
      root.render(createElement(NoCancelHarness));
    });

    const store = mocks.state
      .capturedStore as ExternalStoreAdapter<ThreadMessage>;
    if (!store.onCancel) {
      throw new Error("expected onCancel");
    }

    await act(async () => {
      await store.onCancel?.();
    });

    expect(fetchSpy).not.toHaveBeenCalled();

    act(() => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });
});
