import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HttpAgent } from "@ag-ui/client";
import type { Message as AgUiMessage } from "@ag-ui/core";
import type { UseAgUiRuntimeOptions } from "@assistant-ui/react-ag-ui";
import { useTerragonRuntime } from "./assistant-runtime";

const useAgUiRuntimeSpy = vi.fn();

vi.mock("@assistant-ui/react-ag-ui", () => ({
  useAgUiRuntime: (options: unknown) => {
    useAgUiRuntimeSpy(options);
    return { __mock: true } as unknown;
  },
}));

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
    vi.unstubAllGlobals();
  });

  it("forwards Terragon runtime config to native useAgUiRuntime", () => {
    const agent = {} as HttpAgent;
    const queue = {
      shouldQueue: vi.fn(() => false),
      enqueue: vi.fn(async () => undefined),
    };

    renderToStaticMarkup(
      <HookHarness
        args={{
          agent,
          showThinking: false,
          historyLoadKey: "chat-1:active",
          queue,
        }}
      />,
    );

    expect(useAgUiRuntimeSpy).toHaveBeenCalledTimes(1);
    const opts = useAgUiRuntimeSpy.mock.calls[0]?.[0] as UseAgUiRuntimeOptions;
    expect(opts.agent).toBe(agent);
    expect(opts.showThinking).toBe(false);
    expect(opts.historyLoadKey).toBe("chat-1:active");
    expect(opts.externalMessagesStrategy).toBe("merge-after-local-mutations");
    expect(opts.queue).toBe(queue);
    expect(opts.adapters?.history).toBeDefined();
  });

  it("defaults showThinking to true", () => {
    const agent = {} as HttpAgent;

    renderToStaticMarkup(<HookHarness args={{ agent }} />);

    const opts = useAgUiRuntimeSpy.mock.calls[0]?.[0] as UseAgUiRuntimeOptions;
    expect(opts.showThinking).toBe(true);
  });

  it("hydrates assistant-ui history from AG-UI messages", async () => {
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

  it("can hydrate history without resuming a run", async () => {
    const agent = {} as HttpAgent;

    renderToStaticMarkup(
      <HookHarness
        args={{
          agent,
          historyMessages: [
            { id: "user-1", role: "user", content: "Already done" },
          ],
          resumeOnLoad: false,
        }}
      />,
    );

    const opts = useAgUiRuntimeSpy.mock.calls[0]?.[0] as UseAgUiRuntimeOptions;
    const repo = await opts.adapters?.history?.load();

    expect(repo?.unstable_resume).toBe(false);
    expect(repo?.headId).toBe("user-1");
  });

  it("loads assistant-ui history from the async durable loader", async () => {
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

  it("falls back to seeded history and reports durable loader failures", async () => {
    const agent = {} as HttpAgent;
    const onError = vi.fn();
    const loadHistoryMessages = vi.fn(async () => {
      throw new Error("database unavailable");
    });

    renderToStaticMarkup(
      <HookHarness
        args={{
          agent,
          historyMessages: [
            { id: "fallback-user-1", role: "user", content: "Fallback" },
          ],
          loadHistoryMessages,
          onError,
        }}
      />,
    );

    const opts = useAgUiRuntimeSpy.mock.calls[0]?.[0] as UseAgUiRuntimeOptions;
    const repo = await opts.adapters?.history?.load();

    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    expect(repo?.unstable_resume).toBe(true);
    expect(repo?.headId).toBe("fallback-user-1");
  });

  it("posts Terragon cancel from the native runtime cancel callback", async () => {
    const agent = {} as HttpAgent;
    const onCancel = vi.fn(async () => undefined);
    const fetchSpy = vi.fn(async (_url: string, _init: RequestInit) => ({
      ok: true,
    }));
    vi.stubGlobal("fetch", fetchSpy);

    renderToStaticMarkup(
      <HookHarness
        args={{
          agent,
          onCancel,
          threadId: "thread-abc",
          threadChatId: "chat-xyz",
        }}
      />,
    );

    const opts = useAgUiRuntimeSpy.mock.calls[0]?.[0] as UseAgUiRuntimeOptions;
    opts.onCancel?.();

    await vi.waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledOnce();
    });
    expect(onCancel).toHaveBeenCalledOnce();
    const firstCall = fetchSpy.mock.calls[0];
    if (!firstCall) {
      throw new Error("expected fetch call");
    }
    const [url, init] = firstCall;
    expect(url).toBe("/api/ag-ui/thread-abc/cancel?threadChatId=chat-xyz");
    expect(init?.method).toBe("POST");
  });

  it("still wires server cancel when no local onCancel is provided", async () => {
    const agent = {} as HttpAgent;
    const fetchSpy = vi.fn(async (_url: string, _init: RequestInit) => ({
      ok: true,
    }));
    vi.stubGlobal("fetch", fetchSpy);

    renderToStaticMarkup(
      <HookHarness
        args={{
          agent,
          threadId: "thread-abc",
          threadChatId: "chat-xyz",
        }}
      />,
    );

    const opts = useAgUiRuntimeSpy.mock.calls[0]?.[0] as UseAgUiRuntimeOptions;
    opts.onCancel?.();

    await vi.waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledOnce();
    });
  });
});
