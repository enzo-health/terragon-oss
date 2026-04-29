import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HttpAgent } from "@ag-ui/client";
import type { ExternalStoreAdapter, ThreadMessage } from "@assistant-ui/react";
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
});
