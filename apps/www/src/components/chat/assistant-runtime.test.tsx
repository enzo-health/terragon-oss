import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { HttpAgent } from "@ag-ui/client";
import type { Message as AgUiMessage } from "@ag-ui/core";
import type { UseAgUiRuntimeOptions } from "@assistant-ui/react-ag-ui";

const useAgUiRuntimeSpy = vi.fn();

vi.mock("@assistant-ui/react-ag-ui", () => ({
  useAgUiRuntime: (options: unknown) => {
    useAgUiRuntimeSpy(options);
    return { __mock: true } as unknown;
  },
}));

import { useTerragonRuntime } from "./assistant-runtime";

function HookHarness({
  args,
}: {
  args: Parameters<typeof useTerragonRuntime>[0];
}) {
  useTerragonRuntime(args);
  return <div />;
}

describe("useTerragonRuntime", () => {
  beforeEach(() => {
    useAgUiRuntimeSpy.mockClear();
  });

  it("forwards agent + showThinking:true to useAgUiRuntime", () => {
    const agent = {} as HttpAgent;
    renderToStaticMarkup(<HookHarness args={{ agent }} />);
    expect(useAgUiRuntimeSpy).toHaveBeenCalledTimes(1);
    const opts = useAgUiRuntimeSpy.mock.calls[0]?.[0] as {
      agent: HttpAgent;
      showThinking: boolean;
    };
    expect(opts.agent).toBe(agent);
    expect(opts.showThinking).toBe(true);
  });

  it("passes onError through when provided", () => {
    const agent = {} as HttpAgent;
    const onError = vi.fn();
    renderToStaticMarkup(<HookHarness args={{ agent, onError }} />);
    const opts = useAgUiRuntimeSpy.mock.calls[0]?.[0] as {
      onError?: (e: Error) => void;
    };
    expect(opts.onError).toBe(onError);
  });

  it("wraps async onCancel into a void-returning callback", () => {
    const agent = {} as HttpAgent;
    const onCancel = vi.fn().mockResolvedValue(undefined);
    renderToStaticMarkup(<HookHarness args={{ agent, onCancel }} />);
    const opts = useAgUiRuntimeSpy.mock.calls[0]?.[0] as {
      onCancel?: () => void;
    };
    expect(typeof opts.onCancel).toBe("function");
    opts.onCancel?.();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("omits onCancel/onError when not provided", () => {
    const agent = {} as HttpAgent;
    renderToStaticMarkup(<HookHarness args={{ agent }} />);
    const opts = useAgUiRuntimeSpy.mock.calls[0]?.[0] as {
      onCancel?: unknown;
      onError?: unknown;
    };
    expect(opts.onCancel).toBeUndefined();
    expect(opts.onError).toBeUndefined();
  });

  it("passes showThinking=false through to useAgUiRuntime when provided", () => {
    const agent = {} as HttpAgent;
    renderToStaticMarkup(<HookHarness args={{ agent, showThinking: false }} />);
    const opts = useAgUiRuntimeSpy.mock.calls[0]?.[0] as {
      showThinking: boolean;
    };
    expect(opts.showThinking).toBe(false);
  });

  it("defaults showThinking to true when omitted", () => {
    const agent = {} as HttpAgent;
    renderToStaticMarkup(<HookHarness args={{ agent }} />);
    const opts = useAgUiRuntimeSpy.mock.calls[0]?.[0] as {
      showThinking: boolean;
    };
    expect(opts.showThinking).toBe(true);
  });

  it("hydrates assistant-ui history from AG-UI initial messages", async () => {
    const agent = {} as HttpAgent;
    const historyMessages = [
      { id: "user-1", role: "user", content: "Ship it" },
      { id: "assistant-1", role: "assistant", content: "On it" },
    ] satisfies AgUiMessage[];

    renderToStaticMarkup(<HookHarness args={{ agent, historyMessages }} />);

    const opts = useAgUiRuntimeSpy.mock.calls[0]?.[0] as UseAgUiRuntimeOptions;
    const repo = await opts.adapters?.history?.load();

    expect(repo?.unstable_resume).toBe(true);
    expect(repo?.headId).toBe("assistant-1");
    expect(repo?.messages.map((item) => item.message.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(repo?.messages.map((item) => item.parentId)).toEqual([
      null,
      "user-1",
    ]);
  });

  it("loads assistant-ui history from the async durable loader when provided", async () => {
    const agent = {} as HttpAgent;
    const loadHistoryMessages = vi.fn(
      async () =>
        [
          { id: "fresh-user-1", role: "user", content: "Fresh from DB" },
        ] satisfies AgUiMessage[],
    );

    renderToStaticMarkup(
      <HookHarness
        args={{
          agent,
          historyMessages: [
            { id: "stale-user-1", role: "user", content: "Stale" },
          ],
          loadHistoryMessages,
        }}
      />,
    );

    const opts = useAgUiRuntimeSpy.mock.calls[0]?.[0] as UseAgUiRuntimeOptions;
    const repo = await opts.adapters?.history?.load();

    expect(loadHistoryMessages).toHaveBeenCalledTimes(1);
    expect(repo?.headId).toBe("fresh-user-1");
    expect(repo?.messages.map((item) => item.message.id)).toEqual([
      "fresh-user-1",
    ]);
  });

  it("merges AG-UI tool results into assistant history tool calls", async () => {
    const agent = {} as HttpAgent;
    const historyMessages = [
      {
        id: "assistant-1",
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "tool-1",
            type: "function",
            function: { name: "read_file", arguments: '{"path":"a.ts"}' },
          },
        ],
      },
      {
        id: "tool-result-1",
        role: "tool",
        toolCallId: "tool-1",
        content: "file contents",
      },
    ] satisfies AgUiMessage[];

    renderToStaticMarkup(<HookHarness args={{ agent, historyMessages }} />);

    const opts = useAgUiRuntimeSpy.mock.calls[0]?.[0] as UseAgUiRuntimeOptions;
    const repo = await opts.adapters?.history?.load();
    const assistant = repo?.messages[0]?.message;
    const toolPart = assistant?.content[0];

    expect(assistant?.role).toBe("assistant");
    expect(toolPart?.type).toBe("tool-call");
    if (toolPart?.type !== "tool-call") {
      throw new Error("expected tool-call part");
    }
    expect(toolPart.toolName).toBe("read_file");
    expect(toolPart.args).toEqual({ path: "a.ts" });
    expect(toolPart.result).toBe("file contents");
  });
});
