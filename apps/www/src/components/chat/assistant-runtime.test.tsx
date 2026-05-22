import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { AgentSubscriber, HttpAgent } from "@ag-ui/client";
import type { ThreadAssistantMessagePart } from "@assistant-ui/react";
import {
  EventType,
  type Message as AgUiMessage,
  type RunAgentInput,
} from "@ag-ui/core";
import type { UseTerragonAgUiRuntimeOptions } from "./use-terragon-ag-ui-runtime";

const useTerragonAgUiRuntimeSpy = vi.fn();

vi.mock("./use-terragon-ag-ui-runtime", () => ({
  useTerragonAgUiRuntime: (options: unknown) => {
    useTerragonAgUiRuntimeSpy(options);
    return { __mock: true } as unknown;
  },
}));

import { useTerragonRuntime } from "./assistant-runtime";
import {
  agUiMessagesToThreadMessages,
  createAgUiHistoryAdapter,
} from "./ag-ui-history-adapter";
import type { TerragonCustomPartEvent } from "./ag-ui-custom-parts";
import { TerragonAgUiThreadRuntimeCore } from "./terragon-ag-ui-runtime-core";

function HookHarness({
  args,
}: {
  args: Parameters<typeof useTerragonRuntime>[0];
}) {
  useTerragonRuntime(args);
  return <div />;
}

function normalizeToolCallPartForComparison(
  part: ThreadAssistantMessagePart,
): unknown {
  if (part.type !== "tool-call") return part;
  const {
    parentId: _parentId,
    result,
    ...rest
  } = part as Extract<ThreadAssistantMessagePart, { type: "tool-call" }> & {
    parentId?: string;
    result?: unknown;
  };
  void _parentId;
  return {
    ...rest,
    ...(result !== undefined
      ? {
          result: typeof result === "string" ? result : JSON.stringify(result),
        }
      : {}),
  };
}

describe("useTerragonRuntime", () => {
  beforeEach(() => {
    useTerragonAgUiRuntimeSpy.mockClear();
  });

  it("forwards agent + showThinking:true to useTerragonAgUiRuntime", () => {
    const agent = {} as HttpAgent;
    renderToStaticMarkup(<HookHarness args={{ agent }} />);
    expect(useTerragonAgUiRuntimeSpy).toHaveBeenCalledTimes(1);
    const opts = useTerragonAgUiRuntimeSpy.mock.calls[0]?.[0] as {
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
    const opts = useTerragonAgUiRuntimeSpy.mock.calls[0]?.[0] as {
      onError?: (e: Error) => void;
    };
    expect(opts.onError).toBe(onError);
  });

  it("wraps async onCancel into a void-returning callback", () => {
    const agent = {} as HttpAgent;
    const onCancel = vi.fn().mockResolvedValue(undefined);
    renderToStaticMarkup(<HookHarness args={{ agent, onCancel }} />);
    const opts = useTerragonAgUiRuntimeSpy.mock.calls[0]?.[0] as {
      onCancel?: () => void;
    };
    expect(typeof opts.onCancel).toBe("function");
    opts.onCancel?.();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("omits onCancel/onError when not provided", () => {
    const agent = {} as HttpAgent;
    renderToStaticMarkup(<HookHarness args={{ agent }} />);
    const opts = useTerragonAgUiRuntimeSpy.mock.calls[0]?.[0] as {
      onCancel?: unknown;
      onError?: unknown;
    };
    expect(opts.onCancel).toBeUndefined();
    expect(opts.onError).toBeUndefined();
  });

  it("passes showThinking=false through to useTerragonAgUiRuntime when provided", () => {
    const agent = {} as HttpAgent;
    renderToStaticMarkup(<HookHarness args={{ agent, showThinking: false }} />);
    const opts = useTerragonAgUiRuntimeSpy.mock.calls[0]?.[0] as {
      showThinking: boolean;
    };
    expect(opts.showThinking).toBe(false);
  });

  it("forwards historyLoadKey to the AG-UI runtime", () => {
    const agent = {} as HttpAgent;
    renderToStaticMarkup(
      <HookHarness args={{ agent, historyLoadKey: "chat-1:active" }} />,
    );
    const opts = useTerragonAgUiRuntimeSpy.mock
      .calls[0]?.[0] as UseTerragonAgUiRuntimeOptions;

    expect(opts.historyLoadKey).toBe("chat-1:active");
  });

  it("defaults showThinking to true when omitted", () => {
    const agent = {} as HttpAgent;
    renderToStaticMarkup(<HookHarness args={{ agent }} />);
    const opts = useTerragonAgUiRuntimeSpy.mock.calls[0]?.[0] as {
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

    const opts = useTerragonAgUiRuntimeSpy.mock
      .calls[0]?.[0] as UseTerragonAgUiRuntimeOptions;
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

  it("can hydrate assistant-ui history without resuming a run", async () => {
    const agent = {} as HttpAgent;
    const historyMessages = [
      { id: "user-1", role: "user", content: "Already done" },
    ] satisfies AgUiMessage[];

    renderToStaticMarkup(
      <HookHarness args={{ agent, historyMessages, resumeOnLoad: false }} />,
    );

    const opts = useTerragonAgUiRuntimeSpy.mock
      .calls[0]?.[0] as UseTerragonAgUiRuntimeOptions;
    const repo = await opts.adapters?.history?.load();

    expect(repo?.unstable_resume).toBe(false);
    expect(repo?.headId).toBe("user-1");
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

    const opts = useTerragonAgUiRuntimeSpy.mock
      .calls[0]?.[0] as UseTerragonAgUiRuntimeOptions;
    const repo = await opts.adapters?.history?.load();

    expect(loadHistoryMessages).toHaveBeenCalledTimes(1);
    expect(repo?.headId).toBe("fresh-user-1");
    expect(repo?.messages.map((item) => item.message.id)).toEqual([
      "fresh-user-1",
    ]);
  });

  it("falls back to seeded history and reports when the durable loader fails", async () => {
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

    const opts = useTerragonAgUiRuntimeSpy.mock
      .calls[0]?.[0] as UseTerragonAgUiRuntimeOptions;
    const repo = await opts.adapters?.history?.load();

    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    expect(repo?.unstable_resume).toBe(true);
    expect(repo?.headId).toBe("fallback-user-1");
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

    const opts = useTerragonAgUiRuntimeSpy.mock
      .calls[0]?.[0] as UseTerragonAgUiRuntimeOptions;
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

describe("TerragonAgUiThreadRuntimeCore", () => {
  it("keeps runtime messages empty while async history is still loading", async () => {
    let resolveHistory: (messages: AgUiMessage[]) => void = () => {};
    const historyPromise = new Promise<AgUiMessage[]>((resolve) => {
      resolveHistory = resolve;
    });
    const notifyUpdate = vi.fn();
    const agent = {
      threadId: "thread-1",
      messages: [] as AgUiMessage[],
      runAgent: vi.fn(async () => ({ result: undefined, newMessages: [] })),
    } as unknown as HttpAgent;

    const core = new TerragonAgUiThreadRuntimeCore({
      agent,
      logger: {},
      showThinking: true,
      history: createAgUiHistoryAdapter(() => historyPromise),
      notifyUpdate,
    });

    const loadPromise = core.__internal_load();

    expect(core.isLoading).toBe(true);
    expect(core.getMessages()).toEqual([]);

    resolveHistory([{ id: "user-1", role: "user", content: "Loaded" }]);
    await loadPromise;

    expect(core.isLoading).toBe(false);
    expect(core.getMessages()[0]?.id).toBe("user-1");
  });

  it("marks history-load resumes so the server opens SSE without dispatching a follow-up", async () => {
    const agent = {
      threadId: "thread-1",
      messages: [] as AgUiMessage[],
      runAgent: vi.fn(async () => ({ result: undefined, newMessages: [] })),
    } as unknown as HttpAgent;

    const core = new TerragonAgUiThreadRuntimeCore({
      agent,
      logger: {},
      showThinking: true,
      history: createAgUiHistoryAdapter(() => [
        { id: "user-1", role: "user", content: "Loaded active run" },
      ]),
      notifyUpdate: vi.fn(),
    });

    await core.__internal_load("chat-1:active");

    expect(agent.runAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        forwardedProps: expect.objectContaining({
          terragon: expect.objectContaining({ intent: "resume" }),
        }),
      }),
      expect.any(Object),
    );
  });

  it("marks requires-action tool continuations as resumes", async () => {
    const runAgent = vi.fn(async () => ({
      result: undefined,
      newMessages: [],
    }));
    const agent = {
      threadId: "thread-1",
      messages: [] as AgUiMessage[],
      runAgent,
    } as unknown as HttpAgent;
    const core = new TerragonAgUiThreadRuntimeCore({
      agent,
      logger: {},
      showThinking: true,
      history: createAgUiHistoryAdapter(() => []),
      notifyUpdate: vi.fn(),
    });
    core.applyExternalMessages([
      {
        id: "user-1",
        role: "user",
        createdAt: new Date(0),
        content: [{ type: "text", text: "Use the tool" }],
        attachments: [],
        metadata: { custom: {} },
      },
      {
        id: "assistant-1",
        role: "assistant",
        createdAt: new Date(0),
        content: [
          {
            type: "tool-call",
            toolCallId: "tool-1",
            toolName: "Bash",
            args: { command: "pwd" },
            argsText: '{"command":"pwd"}',
          },
        ],
        status: { type: "requires-action", reason: "tool-calls" },
        metadata: {
          unstable_state: null,
          unstable_annotations: [],
          unstable_data: [],
          steps: [],
          custom: {},
        },
      },
    ]);

    core.addToolResult({
      messageId: "assistant-1",
      toolCallId: "tool-1",
      toolName: "Bash",
      result: "/repo",
      isError: false,
    });
    await vi.waitFor(() => expect(runAgent).toHaveBeenCalledTimes(1));

    expect(runAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        forwardedProps: expect.objectContaining({
          terragon: expect.objectContaining({ intent: "resume" }),
        }),
      }),
      expect.any(Object),
    );
  });

  it("publishes projection hints for runtime transcript mutations", () => {
    const projectionHintRef = {
      current: {
        version: 0,
        firstChangedRuntimeMessageIndex: null,
      },
    };
    const agent = {
      threadId: "thread-1",
      messages: [] as AgUiMessage[],
      runAgent: vi.fn(async () => ({ result: undefined, newMessages: [] })),
    } as unknown as HttpAgent;
    const core = new TerragonAgUiThreadRuntimeCore({
      agent,
      logger: {},
      showThinking: true,
      history: createAgUiHistoryAdapter(() => []),
      projectionHintRef,
      notifyUpdate: vi.fn(),
    });

    core.applyExternalMessages([
      {
        id: "user-1",
        role: "user",
        createdAt: new Date(0),
        content: [{ type: "text", text: "Use the tool" }],
        attachments: [],
        metadata: { custom: {} },
      },
      {
        id: "assistant-1",
        role: "assistant",
        createdAt: new Date(0),
        content: [
          {
            type: "tool-call",
            toolCallId: "tool-1",
            toolName: "Bash",
            args: { command: "pwd" },
            argsText: '{"command":"pwd"}',
          },
        ],
        status: { type: "running" },
        metadata: {
          unstable_state: null,
          unstable_annotations: [],
          unstable_data: [],
          steps: [],
          custom: {},
        },
      },
    ]);

    expect(projectionHintRef.current).toEqual({
      version: 1,
      firstChangedRuntimeMessageIndex: null,
    });

    core.addToolResult({
      messageId: "assistant-1",
      toolCallId: "tool-1",
      toolName: "Bash",
      result: "/repo",
      isError: false,
    });

    expect(projectionHintRef.current).toEqual({
      version: 2,
      firstChangedRuntimeMessageIndex: 1,
    });
  });

  it("reloads history when the explicit load key changes", async () => {
    const notifyUpdate = vi.fn();
    const historyLoads: AgUiMessage[][] = [
      [{ id: "user-1", role: "user", content: "Idle history" }],
      [{ id: "user-2", role: "user", content: "Active history" }],
    ];
    const loadHistory = vi.fn(async () => historyLoads.shift() ?? []);
    const agent = {
      threadId: "thread-1",
      messages: [] as AgUiMessage[],
      runAgent: vi.fn(async () => ({ result: undefined, newMessages: [] })),
    } as unknown as HttpAgent;

    const core = new TerragonAgUiThreadRuntimeCore({
      agent,
      logger: {},
      showThinking: true,
      history: createAgUiHistoryAdapter(loadHistory, { resumeOnLoad: false }),
      notifyUpdate,
    });

    await core.__internal_load("chat-1:idle");
    await core.__internal_load("chat-1:idle");
    expect(loadHistory).toHaveBeenCalledTimes(1);
    expect(core.getMessages()[0]?.id).toBe("user-1");

    await core.__internal_load("chat-1:active");
    expect(loadHistory).toHaveBeenCalledTimes(2);
    expect(core.getMessages()[0]?.id).toBe("user-2");
  });

  it("ignores stale history loads after the explicit load key changes", async () => {
    const notifyUpdate = vi.fn();
    let resolveIdle: (messages: AgUiMessage[]) => void = () => {};
    let resolveActive: (messages: AgUiMessage[]) => void = () => {};
    const idlePromise = new Promise<AgUiMessage[]>((resolve) => {
      resolveIdle = resolve;
    });
    const activePromise = new Promise<AgUiMessage[]>((resolve) => {
      resolveActive = resolve;
    });
    const loadHistory = vi
      .fn<() => Promise<AgUiMessage[]>>()
      .mockReturnValueOnce(idlePromise)
      .mockReturnValueOnce(activePromise);
    const agent = {
      threadId: "thread-1",
      messages: [] as AgUiMessage[],
      runAgent: vi.fn(async () => ({ result: undefined, newMessages: [] })),
    } as unknown as HttpAgent;

    const core = new TerragonAgUiThreadRuntimeCore({
      agent,
      logger: {},
      showThinking: true,
      history: createAgUiHistoryAdapter(loadHistory, { resumeOnLoad: false }),
      notifyUpdate,
    });

    const idleLoad = core.__internal_load("chat-1:idle");
    const activeLoad = core.__internal_load("chat-1:active");
    resolveActive([{ id: "user-active", role: "user", content: "Active" }]);
    await activeLoad;
    expect(core.getMessages()[0]?.id).toBe("user-active");

    resolveIdle([{ id: "user-idle", role: "user", content: "Idle" }]);
    await idleLoad;

    expect(core.getMessages()[0]?.id).toBe("user-active");
    expect(loadHistory).toHaveBeenCalledTimes(2);
  });

  it("retries history for the same load key after a failed load", async () => {
    const notifyUpdate = vi.fn();
    const loadHistory = vi
      .fn<() => Promise<AgUiMessage[]>>()
      .mockRejectedValueOnce(new Error("transient history failure"))
      .mockResolvedValueOnce([
        { id: "user-2", role: "user", content: "Recovered history" },
      ]);
    const onError = vi.fn();
    const agent = {
      threadId: "thread-1",
      messages: [] as AgUiMessage[],
      runAgent: vi.fn(async () => ({ result: undefined, newMessages: [] })),
    } as unknown as HttpAgent;

    const core = new TerragonAgUiThreadRuntimeCore({
      agent,
      logger: {},
      showThinking: true,
      onError,
      history: createAgUiHistoryAdapter(loadHistory, { resumeOnLoad: false }),
      notifyUpdate,
    });

    await core.__internal_load("chat-1:idle");
    expect(loadHistory).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "transient history failure" }),
    );

    await core.__internal_load("chat-1:idle");
    expect(loadHistory).toHaveBeenCalledTimes(2);
    expect(core.getMessages()[0]?.id).toBe("user-2");
  });

  it("keeps live CUSTOM terragon data-part events in runtime messages across later text updates", async () => {
    const input = {
      threadId: "thread-1",
      runId: "run-1",
      state: {},
      messages: [],
      tools: [],
      context: [],
      forwardedProps: {},
    } satisfies RunAgentInput;
    const customEvent: TerragonCustomPartEvent = {
      type: EventType.CUSTOM,
      name: "terragon.data-part",
      value: {
        messageId: "assistant-live",
        partIndex: 0,
        name: "terragon.terminal",
        data: {
          type: "terminal",
          sandboxId: "sandbox-1",
          terminalId: "terminal-1",
          chunks: [],
        },
      },
    };

    const agent = {
      threadId: "thread-1",
      messages: [] as AgUiMessage[],
      runAgent: vi.fn(
        async (_params: unknown, subscriber?: AgentSubscriber) => {
          await subscriber?.onCustomEvent?.({
            event: customEvent,
            messages: [],
            state: {},
            agent: agent as HttpAgent,
            input,
          });
          await subscriber?.onCustomEvent?.({
            event: customEvent,
            messages: [],
            state: {},
            agent: agent as HttpAgent,
            input,
          });
          await subscriber?.onTextMessageStartEvent?.({
            event: {
              type: EventType.TEXT_MESSAGE_START,
              messageId: "assistant-live",
              role: "assistant",
            },
            messages: [],
            state: {},
            agent: agent as HttpAgent,
            input,
          });
          await subscriber?.onTextMessageContentEvent?.({
            event: {
              type: EventType.TEXT_MESSAGE_CONTENT,
              messageId: "assistant-live",
              delta: "Streaming text",
            },
            textMessageBuffer: "",
            messages: [],
            state: {},
            agent: agent as HttpAgent,
            input,
          });
          await subscriber?.onRunFinalized?.({
            messages: [],
            state: {},
            agent: agent as HttpAgent,
            input,
          });
          return { result: undefined, newMessages: [] };
        },
      ),
    } as unknown as HttpAgent;

    const core = new TerragonAgUiThreadRuntimeCore({
      agent,
      logger: {},
      showThinking: true,
      history: createAgUiHistoryAdapter(() => []),
      notifyUpdate: () => {},
    });

    await core.__internal_load();

    const assistants = core
      .getMessages()
      .filter((message) => message.role === "assistant");
    const assistant = assistants.find(
      (message) => message.id === "assistant-live",
    );

    expect(assistant?.role).toBe("assistant");
    const dataParts =
      assistant?.role === "assistant"
        ? assistant.content.filter((part) => part.type === "data")
        : [];
    const textParts =
      assistant?.role === "assistant"
        ? assistant.content.filter((part) => part.type === "text")
        : [];

    expect(assistants).toHaveLength(1);
    expect(dataParts).toHaveLength(1);
    expect(dataParts[0]).toMatchObject({
      type: "data",
      name: "terragon.terminal",
      data: {
        messageId: "assistant-live",
        partIndex: 0,
        name: "terragon.terminal",
        data: {
          type: "terminal",
          sandboxId: "sandbox-1",
          terminalId: "terminal-1",
          chunks: [],
        },
      },
    });
    expect(textParts).toEqual([{ type: "text", text: "Streaming text" }]);
    expect(
      assistants
        .filter((message) => message.id !== "assistant-live")
        .flatMap((message) => message.content)
        .some((part) => part.type === "data" || part.type === "text"),
    ).toBe(false);
  });

  it("batches live CUSTOM terragon data-part notifications", async () => {
    vi.useFakeTimers();
    const input = {
      threadId: "thread-1",
      runId: "run-1",
      state: {},
      messages: [],
      tools: [],
      context: [],
      forwardedProps: {},
    } satisfies RunAgentInput;
    const notifyUpdate = vi.fn();
    const agent = {
      threadId: "thread-1",
      messages: [] as AgUiMessage[],
      runAgent: vi.fn(
        async (_params: unknown, subscriber?: AgentSubscriber) => {
          for (let index = 0; index < 5; index += 1) {
            await subscriber?.onCustomEvent?.({
              event: {
                type: EventType.CUSTOM,
                name: "terragon.data-part",
                value: {
                  messageId: "assistant-live",
                  partIndex: index,
                  name: "terragon.terminal",
                  data: {
                    type: "terminal",
                    sandboxId: "sandbox-1",
                    terminalId: "terminal-1",
                    chunks: [
                      {
                        streamSeq: index,
                        kind: "stdout",
                        text: `line ${index}`,
                      },
                    ],
                  },
                },
              },
              messages: [],
              state: {},
              agent: agent as HttpAgent,
              input,
            });
          }
          return { result: undefined, newMessages: [] };
        },
      ),
    } as unknown as HttpAgent;

    const core = new TerragonAgUiThreadRuntimeCore({
      agent,
      logger: {},
      showThinking: true,
      history: createAgUiHistoryAdapter(() => []),
      notifyUpdate,
    });

    await core.__internal_load();
    const callsBeforeFrame = notifyUpdate.mock.calls.length;
    vi.runOnlyPendingTimers();
    const assistant = core
      .getMessages()
      .find((message) => message.id === "assistant-live");

    expect(assistant?.role).toBe("assistant");
    expect(
      assistant?.role === "assistant"
        ? assistant.content.filter((part) => part.type === "data")
        : [],
    ).toHaveLength(5);

    vi.runOnlyPendingTimers();

    expect(notifyUpdate).toHaveBeenCalledTimes(callsBeforeFrame + 1);
    vi.useRealTimers();
  });

  it("batches live assistant text notifications until the next frame", async () => {
    vi.useFakeTimers();
    const input = {
      threadId: "thread-1",
      runId: "run-1",
      state: {},
      messages: [],
      tools: [],
      context: [],
      forwardedProps: {},
    } satisfies RunAgentInput;
    const notifyUpdate = vi.fn();
    const agent = {
      threadId: "thread-1",
      messages: [] as AgUiMessage[],
      runAgent: vi.fn(
        async (_params: unknown, subscriber?: AgentSubscriber) => {
          await subscriber?.onTextMessageStartEvent?.({
            event: {
              type: EventType.TEXT_MESSAGE_START,
              messageId: "assistant-live",
              role: "assistant",
            },
            messages: [],
            state: {},
            agent: agent as HttpAgent,
            input,
          });
          for (const delta of ["one", " two", " three"]) {
            await subscriber?.onTextMessageContentEvent?.({
              event: {
                type: EventType.TEXT_MESSAGE_CONTENT,
                messageId: "assistant-live",
                delta,
              },
              textMessageBuffer: "",
              messages: [],
              state: {},
              agent: agent as HttpAgent,
              input,
            });
          }
          return { result: undefined, newMessages: [] };
        },
      ),
    } as unknown as HttpAgent;

    const core = new TerragonAgUiThreadRuntimeCore({
      agent,
      logger: {},
      showThinking: true,
      history: createAgUiHistoryAdapter(() => []),
      notifyUpdate,
    });

    await core.__internal_load();
    const callsBeforeFrame = notifyUpdate.mock.calls.length;
    vi.runOnlyPendingTimers();
    const assistant = core
      .getMessages()
      .find((message) => message.id === "assistant-live");

    expect(
      assistant?.role === "assistant"
        ? assistant.content.filter((part) => part.type === "text")
        : [],
    ).toEqual([{ type: "text", text: "one two three" }]);

    vi.runOnlyPendingTimers();

    // One scheduled text projection and one runtime store notification, not
    // one React notification per text delta.
    expect(notifyUpdate).toHaveBeenCalledTimes(callsBeforeFrame + 2);
    vi.useRealTimers();
  });

  it("keeps nested tool-call parent ids on the current assistant message", async () => {
    const input = {
      threadId: "thread-1",
      runId: "run-1",
      state: {},
      messages: [],
      tools: [],
      context: [],
      forwardedProps: {},
    } satisfies RunAgentInput;
    const agent = {
      threadId: "thread-1",
      messages: [] as AgUiMessage[],
      runAgent: vi.fn(
        async (_params: unknown, subscriber?: AgentSubscriber) => {
          await subscriber?.onTextMessageStartEvent?.({
            event: {
              type: EventType.TEXT_MESSAGE_START,
              messageId: "assistant-live",
              role: "assistant",
            },
            messages: [],
            state: {},
            agent: agent as HttpAgent,
            input,
          });
          await subscriber?.onToolCallStartEvent?.({
            event: {
              type: EventType.TOOL_CALL_START,
              toolCallId: "parent-tool",
              toolCallName: "Task",
            },
            messages: [],
            state: {},
            agent: agent as HttpAgent,
            input,
          });
          await subscriber?.onToolCallStartEvent?.({
            event: {
              type: EventType.TOOL_CALL_START,
              toolCallId: "nested-tool",
              toolCallName: "Task",
              parentMessageId: "parent-tool",
            },
            messages: [],
            state: {},
            agent: agent as HttpAgent,
            input,
          });
          await subscriber?.onRunFinalized?.({
            messages: [],
            state: {},
            agent: agent as HttpAgent,
            input,
          });
          return { result: undefined, newMessages: [] };
        },
      ),
    } as unknown as HttpAgent;

    const core = new TerragonAgUiThreadRuntimeCore({
      agent,
      logger: {},
      showThinking: true,
      history: createAgUiHistoryAdapter(() => []),
      notifyUpdate: () => {},
    });

    await core.__internal_load();

    const assistants = core
      .getMessages()
      .filter((message) => message.role === "assistant");
    expect(assistants).toHaveLength(1);
    const toolParts =
      assistants[0]?.role === "assistant"
        ? assistants[0].content.filter((part) => part.type === "tool-call")
        : [];
    expect(toolParts.map((part) => part.toolCallId)).toEqual([
      "parent-tool",
      "nested-tool",
    ]);
  });

  it("projects live stream and durable history into identical assistant-ui parts", async () => {
    const input = {
      threadId: "thread-1",
      runId: "run-1",
      state: {},
      messages: [],
      tools: [],
      context: [],
      forwardedProps: {},
    } satisfies RunAgentInput;
    const diffToolArgs =
      '{"files":[{"path":"apps/www/src/components/chat/example.ts","action":"modified"}]}';
    const diffToolResult = JSON.stringify({
      type: "terragon.diff",
      part: {
        type: "diff",
        filePath: "apps/www/src/components/chat/example.ts",
        oldContent: "export const value = false;\n",
        newContent: "export const value = true;\n",
        status: "applied",
      },
    });
    const durableHistoryMessages = [
      {
        id: "assistant-live",
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "diff-tool-1",
            type: "function",
            function: {
              name: "FileChange",
              arguments: diffToolArgs,
            },
          },
        ],
      },
      {
        id: "diff-tool-result-1",
        role: "tool",
        toolCallId: "diff-tool-1",
        content: diffToolResult,
      },
      {
        id: "assistant-live",
        role: "assistant",
        content: "Streaming text",
        toolCalls: [
          {
            id: "tool-1",
            type: "function",
            function: {
              name: "Bash",
              arguments: '{"command":"pnpm test"}',
            },
          },
        ],
      },
      {
        id: "tool-result-1",
        role: "tool",
        toolCallId: "tool-1",
        content: "permission denied",
        error: "permission denied",
      },
    ] satisfies Parameters<typeof agUiMessagesToThreadMessages>[0];

    const agent = {
      threadId: "thread-1",
      messages: [] as AgUiMessage[],
      runAgent: vi.fn(
        async (_params: unknown, subscriber?: AgentSubscriber) => {
          await subscriber?.onToolCallStartEvent?.({
            event: {
              type: EventType.TOOL_CALL_START,
              toolCallId: "diff-tool-1",
              toolCallName: "FileChange",
              parentMessageId: "assistant-live",
            },
            messages: [],
            state: {},
            agent: agent as HttpAgent,
            input,
          });
          await subscriber?.onToolCallArgsEvent?.({
            event: {
              type: EventType.TOOL_CALL_ARGS,
              toolCallId: "diff-tool-1",
              delta: diffToolArgs,
            },
            toolCallBuffer: diffToolArgs,
            toolCallName: "FileChange",
            partialToolCallArgs: {
              files: [
                {
                  path: "apps/www/src/components/chat/example.ts",
                  action: "modified",
                },
              ],
            },
            messages: [],
            state: {},
            agent: agent as HttpAgent,
            input,
          });
          await subscriber?.onToolCallResultEvent?.({
            event: {
              type: EventType.TOOL_CALL_RESULT,
              messageId: "diff-tool-result-1",
              toolCallId: "diff-tool-1",
              content: diffToolResult,
            },
            messages: [],
            state: {},
            agent: agent as HttpAgent,
            input,
          });
          await subscriber?.onTextMessageStartEvent?.({
            event: {
              type: EventType.TEXT_MESSAGE_START,
              messageId: "assistant-live",
              role: "assistant",
            },
            messages: [],
            state: {},
            agent: agent as HttpAgent,
            input,
          });
          await subscriber?.onTextMessageContentEvent?.({
            event: {
              type: EventType.TEXT_MESSAGE_CONTENT,
              messageId: "assistant-live",
              delta: "Streaming text",
            },
            textMessageBuffer: "",
            messages: [],
            state: {},
            agent: agent as HttpAgent,
            input,
          });
          await subscriber?.onTextMessageEndEvent?.({
            event: {
              type: EventType.TEXT_MESSAGE_END,
              messageId: "assistant-live",
            },
            textMessageBuffer: "Streaming text",
            messages: [],
            state: {},
            agent: agent as HttpAgent,
            input,
          });
          await subscriber?.onToolCallStartEvent?.({
            event: {
              type: EventType.TOOL_CALL_START,
              toolCallId: "tool-1",
              toolCallName: "Bash",
            },
            messages: [],
            state: {},
            agent: agent as HttpAgent,
            input,
          });
          await subscriber?.onToolCallArgsEvent?.({
            event: {
              type: EventType.TOOL_CALL_ARGS,
              toolCallId: "tool-1",
              delta: '{"command":"pnpm test"}',
            },
            toolCallBuffer: '{"command":"pnpm test"}',
            toolCallName: "Bash",
            partialToolCallArgs: { command: "pnpm test" },
            messages: [],
            state: {},
            agent: agent as HttpAgent,
            input,
          });
          await subscriber?.onToolCallResultEvent?.({
            event: {
              type: EventType.TOOL_CALL_RESULT,
              messageId: "tool-result-1",
              toolCallId: "tool-1",
              content: "permission denied",
              role: "tool",
              isError: true,
            },
            messages: [],
            state: {},
            agent: agent as HttpAgent,
            input,
          });
          await subscriber?.onRunFinalized?.({
            messages: [],
            state: {},
            agent: agent as HttpAgent,
            input,
          });
          return { result: undefined, newMessages: [] };
        },
      ),
    } as unknown as HttpAgent;

    const core = new TerragonAgUiThreadRuntimeCore({
      agent,
      logger: {},
      showThinking: true,
      history: createAgUiHistoryAdapter(() => []),
      notifyUpdate: () => {},
    });

    await core.__internal_load();

    const liveAssistant = core
      .getMessages()
      .find((message) => message.role === "assistant");
    const durableAssistant = agUiMessagesToThreadMessages(
      durableHistoryMessages,
    ).find((message) => message.role === "assistant");

    expect(liveAssistant?.role).toBe("assistant");
    expect(durableAssistant?.role).toBe("assistant");
    expect(
      liveAssistant?.role === "assistant"
        ? liveAssistant.content.map(normalizeToolCallPartForComparison)
        : null,
    ).toEqual(
      durableAssistant?.role === "assistant"
        ? durableAssistant.content.map(normalizeToolCallPartForComparison)
        : null,
    );
  });

  it("marks failed live tool-call results as errored on the runtime part", async () => {
    const input = {
      threadId: "thread-1",
      runId: "run-1",
      state: {},
      messages: [],
      tools: [],
      context: [],
      forwardedProps: {},
    } satisfies RunAgentInput;

    const agent = {
      threadId: "thread-1",
      messages: [] as AgUiMessage[],
      runAgent: vi.fn(
        async (_params: unknown, subscriber?: AgentSubscriber) => {
          await subscriber?.onToolCallStartEvent?.({
            event: {
              type: EventType.TOOL_CALL_START,
              toolCallId: "tool-err",
              toolCallName: "bash",
              parentMessageId: "assistant-live",
            },
            messages: [],
            state: {},
            agent: agent as HttpAgent,
            input,
          });
          await subscriber?.onToolCallArgsEvent?.({
            event: {
              type: EventType.TOOL_CALL_ARGS,
              toolCallId: "tool-err",
              delta: '{"command":"false"}',
            },
            toolCallBuffer: '{"command":"false"}',
            toolCallName: "bash",
            partialToolCallArgs: { command: "false" },
            messages: [],
            state: {},
            agent: agent as HttpAgent,
            input,
          });
          await subscriber?.onToolCallResultEvent?.({
            event: {
              type: EventType.TOOL_CALL_RESULT,
              messageId: "tool-err",
              toolCallId: "tool-err",
              content: "permission denied",
              role: "tool",
              isError: true,
            },
            messages: [],
            state: {},
            agent: agent as HttpAgent,
            input,
          });
          await subscriber?.onRunFinalized?.({
            messages: [],
            state: {},
            agent: agent as HttpAgent,
            input,
          });
          return { result: undefined, newMessages: [] };
        },
      ),
    } as unknown as HttpAgent;

    const core = new TerragonAgUiThreadRuntimeCore({
      agent,
      logger: {},
      showThinking: true,
      history: createAgUiHistoryAdapter(() => []),
      notifyUpdate: () => {},
    });

    await core.__internal_load();

    const assistant = core
      .getMessages()
      .find((message) => message.role === "assistant");
    expect(assistant?.id).toBe("assistant-live");
    const toolPart =
      assistant?.role === "assistant"
        ? assistant.content.find((part) => part.type === "tool-call")
        : undefined;

    expect(toolPart?.type).toBe("tool-call");
    if (toolPart?.type !== "tool-call") {
      throw new Error("expected tool-call part");
    }
    expect(toolPart.toolCallId).toBe("tool-err");
    expect(toolPart.result).toBe("permission denied");
    expect(toolPart.isError).toBe(true);
  });

  it("marks unresolved live tool calls as errored when the run finalizes", async () => {
    const input = {
      threadId: "thread-1",
      runId: "run-1",
      state: {},
      messages: [],
      tools: [],
      context: [],
      forwardedProps: {},
    } satisfies RunAgentInput;

    const agent = {
      threadId: "thread-1",
      messages: [] as AgUiMessage[],
      runAgent: vi.fn(
        async (_params: unknown, subscriber?: AgentSubscriber) => {
          await subscriber?.onTextMessageStartEvent?.({
            event: {
              type: EventType.TEXT_MESSAGE_START,
              messageId: "assistant-live",
              role: "assistant",
            },
            messages: [],
            state: {},
            agent: agent as HttpAgent,
            input,
          });
          await subscriber?.onToolCallStartEvent?.({
            event: {
              type: EventType.TOOL_CALL_START,
              toolCallId: "task-open",
              toolCallName: "Task",
              parentMessageId: "assistant-live",
            },
            messages: [],
            state: {},
            agent: agent as HttpAgent,
            input,
          });
          await subscriber?.onToolCallArgsEvent?.({
            event: {
              type: EventType.TOOL_CALL_ARGS,
              toolCallId: "task-open",
              delta:
                '{"description":"Complete the delegated sub-agent task.","prompt":"Complete the delegated sub-agent task.","subagent_type":"codex-subagent"}',
            },
            toolCallBuffer:
              '{"description":"Complete the delegated sub-agent task.","prompt":"Complete the delegated sub-agent task.","subagent_type":"codex-subagent"}',
            toolCallName: "Task",
            partialToolCallArgs: {
              description: "Complete the delegated sub-agent task.",
              prompt: "Complete the delegated sub-agent task.",
              subagent_type: "codex-subagent",
            },
            messages: [],
            state: {},
            agent: agent as HttpAgent,
            input,
          });
          await subscriber?.onToolCallEndEvent?.({
            event: {
              type: EventType.TOOL_CALL_END,
              toolCallId: "task-open",
            },
            toolCallName: "Task",
            toolCallArgs: {
              description: "Complete the delegated sub-agent task.",
              prompt: "Complete the delegated sub-agent task.",
              subagent_type: "codex-subagent",
            },
            messages: [],
            state: {},
            agent: agent as HttpAgent,
            input,
          });
          await subscriber?.onTextMessageContentEvent?.({
            event: {
              type: EventType.TEXT_MESSAGE_CONTENT,
              messageId: "assistant-live",
              delta: "Text after the unresolved tool call",
            },
            textMessageBuffer: "",
            messages: [],
            state: {},
            agent: agent as HttpAgent,
            input,
          });
          await subscriber?.onRunFinalized?.({
            messages: [],
            state: {},
            agent: agent as HttpAgent,
            input,
          });
          return { result: undefined, newMessages: [] };
        },
      ),
    } as unknown as HttpAgent;

    const core = new TerragonAgUiThreadRuntimeCore({
      agent,
      logger: {},
      showThinking: true,
      history: createAgUiHistoryAdapter(() => []),
      notifyUpdate: () => {},
    });

    await core.__internal_load();

    const assistant = core
      .getMessages()
      .find((message) => message.role === "assistant");
    expect(assistant?.id).toBe("assistant-live");
    const toolPart =
      assistant?.role === "assistant"
        ? assistant.content.find((part) => part.type === "tool-call")
        : undefined;

    expect(toolPart?.type).toBe("tool-call");
    if (toolPart?.type !== "tool-call") {
      throw new Error("expected tool-call part");
    }
    expect(toolPart.toolCallId).toBe("task-open");
    expect(toolPart.result).toBe("Tool call ended without a result.");
    expect(toolPart.isError).toBe(true);
  });
});
