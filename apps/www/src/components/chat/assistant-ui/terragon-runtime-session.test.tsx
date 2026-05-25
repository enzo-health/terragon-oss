/* @vitest-environment jsdom */

import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpAgent } from "@ag-ui/client";
import type { Message as AgUiMessage } from "@ag-ui/core";
import type { UseAgUiRuntimeOptions } from "@assistant-ui/react-ag-ui";
import type { AIAgent } from "@terragon/agent/types";
import { TerragonRuntimeSession } from "./terragon-runtime-session";

const useAgUiRuntimeSpy = vi.fn<(options: UseAgUiRuntimeOptions) => unknown>();

vi.mock("@assistant-ui/react-ag-ui", () => ({
  useAgUiRuntime: (options: UseAgUiRuntimeOptions) => {
    useAgUiRuntimeSpy(options);
    return { __mock: true };
  },
}));

vi.mock("@assistant-ui/react", () => ({
  AssistantRuntimeProvider: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", null, children),
}));

function makeAgent(): HttpAgent {
  return new HttpAgent({
    url: "/api/ag-ui/thread-abc?threadChatId=chat-xyz",
    threadId: "thread-abc",
  });
}

function lastRuntimeOptions(): UseAgUiRuntimeOptions {
  const options = useAgUiRuntimeSpy.mock.calls.at(-1)?.[0];
  if (!options) {
    throw new Error("expected useAgUiRuntime to be called");
  }
  return options;
}

function SessionHarness({
  agent,
  chatAgent = "codex",
  isAgentWorking,
  loadAgUiHistoryMessages,
  setReplayCursor = vi.fn(),
}: {
  agent: HttpAgent;
  chatAgent?: AIAgent;
  isAgentWorking: boolean;
  loadAgUiHistoryMessages: () => Promise<{
    messages: AgUiMessage[];
    lastSeq: number;
  }>;
  setReplayCursor?: React.ComponentProps<
    typeof TerragonRuntimeSession
  >["setReplayCursor"];
}) {
  return (
    <TerragonRuntimeSession
      agent={agent}
      loadAgUiHistoryMessages={loadAgUiHistoryMessages}
      chatAgent={chatAgent}
      isAgentWorking={isAgentWorking}
      threadId="thread-abc"
      threadChatId="chat-xyz"
      setReplayCursor={setReplayCursor}
    >
      {() => <div />}
    </TerragonRuntimeSession>
  );
}

function mountSessionHarness(
  props: React.ComponentProps<typeof SessionHarness>,
  onRenderProps?: (props: {
    errorInfo?: string;
    errorType?: string;
    handleRetry?: () => Promise<void>;
    isRetrying?: boolean;
  }) => void,
) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  function Harness() {
    return (
      <TerragonRuntimeSession
        agent={props.agent}
        loadAgUiHistoryMessages={props.loadAgUiHistoryMessages}
        chatAgent={props.chatAgent ?? "codex"}
        isAgentWorking={props.isAgentWorking}
        threadId="thread-abc"
        threadChatId="chat-xyz"
        setReplayCursor={props.setReplayCursor ?? vi.fn()}
      >
        {(renderProps) => {
          onRenderProps?.(renderProps);
          return (
            <div>
              <span data-testid="error-type">
                {renderProps.errorType ?? ""}
              </span>
              <span data-testid="error-info">
                {renderProps.errorInfo ?? ""}
              </span>
              <button
                type="button"
                onClick={() => {
                  void renderProps.handleRetry?.();
                }}
              >
                retry
              </button>
            </div>
          );
        }}
      </TerragonRuntimeSession>
    );
  }

  act(() => {
    root.render(<Harness />);
  });

  return {
    container,
    root,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe("TerragonRuntimeSession", () => {
  beforeEach(() => {
    useAgUiRuntimeSpy.mockClear();
    vi.unstubAllGlobals();
  });

  it("forwards Terragon runtime config to native useAgUiRuntime", () => {
    const agent = makeAgent();

    renderToStaticMarkup(
      <SessionHarness
        agent={agent}
        chatAgent="amp"
        isAgentWorking={true}
        loadAgUiHistoryMessages={async () => ({ messages: [], lastSeq: 0 })}
      />,
    );

    expect(useAgUiRuntimeSpy).toHaveBeenCalledTimes(1);
    const opts = lastRuntimeOptions();
    expect(opts.agent).toBe(agent);
    expect(opts.showThinking).toBe(false);
    expect(opts.historyLoadKey).toBe("chat-xyz:active");
    expect(opts.externalMessagesStrategy).toBe("merge-after-local-mutations");
    expect(opts.adapters?.history).toBeDefined();
  });

  it("enables thinking for Codex and Claude Code agents", () => {
    const agent = makeAgent();

    renderToStaticMarkup(
      <SessionHarness
        agent={agent}
        chatAgent="codex"
        isAgentWorking={true}
        loadAgUiHistoryMessages={async () => ({ messages: [], lastSeq: 0 })}
      />,
    );

    const opts = lastRuntimeOptions();
    expect(opts.showThinking).toBe(true);
  });

  it("hydrates assistant-ui history from AG-UI messages", async () => {
    const agent = makeAgent();
    const historyMessages = [
      { id: "user-1", role: "user", content: "Ship it" },
      { id: "assistant-1", role: "assistant", content: "On it" },
    ] satisfies AgUiMessage[];

    renderToStaticMarkup(
      <SessionHarness
        agent={agent}
        isAgentWorking={true}
        loadAgUiHistoryMessages={async () => ({
          messages: historyMessages,
          lastSeq: 2,
        })}
      />,
    );

    const opts = lastRuntimeOptions();
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
    const agent = makeAgent();

    renderToStaticMarkup(
      <SessionHarness
        agent={agent}
        isAgentWorking={false}
        loadAgUiHistoryMessages={async () => ({
          messages: [
            { id: "user-1", role: "user", content: "Already done" },
          ] satisfies AgUiMessage[],
          lastSeq: 1,
        })}
      />,
    );

    const opts = lastRuntimeOptions();
    const repo = await opts.adapters?.history?.load();

    expect(repo?.unstable_resume).toBe(false);
    expect(repo?.headId).toBe("user-1");
  });

  it("loads assistant-ui history from the async durable loader", async () => {
    const agent = makeAgent();
    const loadAgUiHistoryMessages = vi.fn(async () => ({
      messages: [
        { id: "fresh-user-1", role: "user", content: "Fresh from DB" },
      ] satisfies AgUiMessage[],
      lastSeq: 1,
    }));

    renderToStaticMarkup(
      <SessionHarness
        agent={agent}
        isAgentWorking={true}
        loadAgUiHistoryMessages={loadAgUiHistoryMessages}
      />,
    );

    const opts = lastRuntimeOptions();
    const repo = await opts.adapters?.history?.load();

    expect(loadAgUiHistoryMessages).toHaveBeenCalledTimes(1);
    expect(repo?.headId).toBe("fresh-user-1");
    expect(repo?.messages.map((item) => item.message.id)).toEqual([
      "fresh-user-1",
    ]);
  });

  it("reports durable loader failures and returns an empty history", async () => {
    const agent = makeAgent();
    const loadAgUiHistoryMessages = vi.fn(async () => {
      throw new Error("database unavailable");
    });

    renderToStaticMarkup(
      <SessionHarness
        agent={agent}
        isAgentWorking={true}
        loadAgUiHistoryMessages={loadAgUiHistoryMessages}
      />,
    );

    const opts = lastRuntimeOptions();
    const repo = await opts.adapters?.history?.load();

    expect(repo?.unstable_resume).toBe(true);
    expect(repo?.headId).toBe(null);
    expect(repo?.messages).toEqual([]);
  });

  it("exposes history load errors and retry through child render props", async () => {
    const agent = makeAgent();
    const loadAgUiHistoryMessages = vi.fn(async () => {
      throw new Error("database unavailable");
    });
    const renderProps: Array<{
      errorInfo?: string;
      errorType?: string;
      handleRetry?: () => Promise<void>;
      isRetrying?: boolean;
    }> = [];
    const mounted = mountSessionHarness(
      {
        agent,
        isAgentWorking: true,
        loadAgUiHistoryMessages,
      },
      (props) => renderProps.push(props),
    );

    try {
      const firstOpts = useAgUiRuntimeSpy.mock.calls[0]?.[0];
      await firstOpts?.adapters?.history?.load();

      await vi.waitFor(() => {
        expect(mounted.container.textContent).toContain("history-load");
      });
      expect(mounted.container.textContent).toContain("database unavailable");
      const latestProps = renderProps.at(-1);
      expect(latestProps?.handleRetry).toBeDefined();
      expect(latestProps?.isRetrying).toBe(false);

      await act(async () => {
        await latestProps?.handleRetry?.();
      });

      await vi.waitFor(() => {
        const latestOpts = useAgUiRuntimeSpy.mock.calls.at(-1)?.[0];
        expect(latestOpts?.historyLoadKey).toBe("chat-xyz:active:retry-1");
      });
    } finally {
      mounted.unmount();
    }
  });

  it("posts Terragon cancel from the native runtime cancel callback", async () => {
    const agent = makeAgent();
    const fetchSpy = vi.fn(async (_url: string, _init: RequestInit) => ({
      ok: true,
      text: vi.fn(async () => ""),
    }));
    vi.stubGlobal("fetch", fetchSpy);

    renderToStaticMarkup(
      <SessionHarness
        agent={agent}
        isAgentWorking={true}
        loadAgUiHistoryMessages={async () => ({ messages: [], lastSeq: 0 })}
      />,
    );

    const opts = lastRuntimeOptions();
    opts.onCancel?.();

    await vi.waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledOnce();
    });
    const firstCall = fetchSpy.mock.calls[0];
    if (!firstCall) {
      throw new Error("expected fetch call");
    }
    const [url, init] = firstCall;
    expect(url).toBe("/api/ag-ui/thread-abc/cancel?threadChatId=chat-xyz");
    expect(init?.method).toBe("POST");
  });

  it("reports cancel route failures through the runtime error channel", async () => {
    const agent = makeAgent();
    const fetchSpy = vi.fn(async (_url: string, _init: RequestInit) => ({
      ok: false,
      status: 403,
      text: vi.fn(async () => "not allowed"),
    }));
    vi.stubGlobal("fetch", fetchSpy);
    const mounted = mountSessionHarness({
      agent,
      isAgentWorking: true,
      loadAgUiHistoryMessages: async () => ({
        messages: [],
        lastSeq: 0,
      }),
    });

    try {
      const opts = lastRuntimeOptions();
      opts.onCancel?.();

      await vi.waitFor(() => {
        expect(fetchSpy).toHaveBeenCalledOnce();
      });
      await vi.waitFor(() => {
        expect(useAgUiRuntimeSpy).toHaveBeenCalledTimes(2);
      });
      expect(mounted.container.textContent).toContain("runtime");
      expect(mounted.container.textContent).toContain(
        "Cancel failed: not allowed",
      );
    } finally {
      mounted.unmount();
    }
  });

  it("applies the replay cursor before active runtime resume", async () => {
    const agent = makeAgent();
    const setReplayCursor = vi.fn(
      (cursor: { seq: number; projectionIndex: number | null } | null) => {
        agent.url =
          cursor === null
            ? "/api/ag-ui/thread-abc?threadChatId=chat-xyz"
            : `/api/ag-ui/thread-abc?threadChatId=chat-xyz&fromSeq=${cursor.seq}${
                cursor.projectionIndex === null
                  ? ""
                  : `:${cursor.projectionIndex}`
              }`;
      },
    );
    const loadAgUiHistoryMessages = vi.fn(async () => ({
      messages: [
        { id: "user-1", role: "user", content: "Resume" },
      ] satisfies AgUiMessage[],
      lastSeq: 42,
      lastCursor: { seq: 42, projectionIndex: 1 },
    }));

    renderToStaticMarkup(
      <SessionHarness
        agent={agent}
        isAgentWorking={true}
        loadAgUiHistoryMessages={loadAgUiHistoryMessages}
        setReplayCursor={setReplayCursor}
      />,
    );

    const opts = lastRuntimeOptions();
    const repo = await opts.adapters?.history?.load();

    expect(loadAgUiHistoryMessages).toHaveBeenCalledOnce();
    expect(setReplayCursor).toHaveBeenCalledWith({
      seq: 42,
      projectionIndex: 1,
    });
    expect(agent.url).toBe(
      "/api/ag-ui/thread-abc?threadChatId=chat-xyz&fromSeq=42:1",
    );
    expect(repo?.unstable_resume).toBe(true);
  });

  it("does not apply the replay cursor for idle history loads", async () => {
    const agent = makeAgent();
    const setReplayCursor = vi.fn();
    const loadAgUiHistoryMessages = vi.fn(async () => ({
      messages: [
        { id: "user-1", role: "user", content: "Done" },
      ] satisfies AgUiMessage[],
      lastSeq: 42,
    }));

    renderToStaticMarkup(
      <SessionHarness
        agent={agent}
        isAgentWorking={false}
        loadAgUiHistoryMessages={loadAgUiHistoryMessages}
        setReplayCursor={setReplayCursor}
      />,
    );

    const opts = lastRuntimeOptions();
    const repo = await opts.adapters?.history?.load();

    expect(setReplayCursor).toHaveBeenCalledWith(null);
    expect(repo?.unstable_resume).toBe(false);
  });
});
