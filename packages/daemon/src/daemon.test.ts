import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { nanoid } from "nanoid/non-secure";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  MockInstance,
  vi,
} from "vitest";
import { createCodexParserState } from "./codex";
import type { ThreadMetaEvent } from "./codex-app-server";
import { AcpToolCallTracker } from "./acp-adapter";
import {
  isRecoverableAcpPromptPostFailure,
  parseDaemonAcpSsePayload,
  TerragonDaemon,
} from "./daemon";
import { DaemonRuntime, writeToUnixSocket } from "./runtime";
import { claudeAcpRuntimeAdapterContract } from "./runtime-contracts";
import {
  ClaudeMessage,
  DAEMON_CAPABILITY_EVENT_ENVELOPE_V2,
  DAEMON_EVENT_CAPABILITIES_HEADER,
  DAEMON_EVENT_VERSION_HEADER,
  DaemonDelta,
  DAEMON_VERSION,
  DaemonMessageClaude,
  DaemonMessageStop,
} from "./shared";

async function sleep(ms: number = 10) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sleepUntil(condition: () => boolean, maxWaitMs: number = 2000) {
  const startTime = Date.now();
  while (!condition()) {
    await sleep(100);
    if (Date.now() - startTime > maxWaitMs) {
      throw new Error("Timeout waiting for condition");
    }
  }
}

function loadAcpFixture(name: string): string {
  return readFileSync(join(__dirname, "__fixtures__/acp", name), "utf-8");
}

type BufferedDaemonDelta = DaemonDelta & {
  threadId: string;
  threadChatId: string;
  token: string;
};

const TEST_INPUT_MESSAGE: DaemonMessageClaude = {
  type: "claude",
  model: "opus",
  agent: "claudeCode",
  agentVersion: 0,
  token: "TEST_TOKEN_STRING",
  prompt: "TEST_PROMPT_STRING",
  sessionId: null,
  threadId: "TEST_THREAD_ID_STRING",
  threadChatId: "TEST_THREAD_CHAT_ID_STRING",
};

const TEST_STOP_MESSAGE: DaemonMessageStop = {
  type: "stop",
  threadId: "TEST_THREAD_ID_STRING",
  threadChatId: "TEST_THREAD_CHAT_ID_STRING",
  token: "TEST_TOKEN_STRING",
};

describe("daemon", () => {
  let runtime: DaemonRuntime;
  let daemon: TerragonDaemon;
  let killChildProcessGroupMock: MockInstance<
    DaemonRuntime["killChildProcessGroup"]
  >;
  let spawnCommandLineMock: MockInstance<DaemonRuntime["spawnCommandLine"]>;
  let serverPostMock: MockInstance<DaemonRuntime["serverPost"]>;
  let spawnPid = 1234;
  beforeEach(() => {
    // Mock Intl.DateTimeFormat to return a fixed timezone
    vi.stubGlobal("Intl", {
      ...Intl,
      DateTimeFormat: vi.fn(() => ({
        resolvedOptions: () => ({ timeZone: "America/New_York" }),
      })),
    });
    const unixSocketPath = `/tmp/terragon-daemon-${nanoid()}.sock`;
    runtime = new DaemonRuntime({
      url: "http://localhost:3000",
      unixSocketPath,
      outputFormat: "text",
    });
    vi.spyOn(runtime, "listenToUnixSocket");
    vi.spyOn(runtime, "exitProcess").mockImplementation(() => {});
    killChildProcessGroupMock = vi
      .spyOn(runtime, "killChildProcessGroup")
      .mockImplementation(() => {});
    spawnCommandLineMock = vi
      .spyOn(runtime, "spawnCommandLine")
      .mockImplementation(() => ({
        processId: ++spawnPid,
        pollInterval: undefined,
      }));
    serverPostMock = vi
      .spyOn(runtime, "serverPost")
      .mockResolvedValue(undefined);
    vi.spyOn(runtime, "execSync").mockReturnValue("NOT_EXISTS\n");
    vi.spyOn(runtime, "readFileSync").mockImplementation((path: string) => {
      // Default behavior: throw error when .git-credentials doesn't exist
      if (path.endsWith("/.git-credentials")) {
        throw new Error("File not found");
      }
      throw new Error(`Unexpected call to readFileSync: ${path}`);
    });
    vi.spyOn(runtime, "appendFileSync").mockImplementation(() => {
      throw new Error("Unexpected call to appendFileSync");
    });
    daemon = new TerragonDaemon({
      runtime,
      messageHandleDelay: 5,
      messageFlushDelay: 10,
      retryConfig: {
        baseDelayMs: 10,
        maxDelayMs: 100,
        maxAttempts: 10,
        backoffMultiplier: 2,
        jitterFactor: 0,
      },
    });
  });

  afterEach(async () => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    await runtime.teardown();
  });

  it("routes codex app-server transport to runAppServerCommand", async () => {
    const stopAppServerTurnSpy = vi
      .spyOn(daemon as any, "stopAppServerTurn")
      .mockResolvedValue(false);
    const runAppServerCommandSpy = vi
      .spyOn(daemon as any, "runAppServerCommand")
      .mockResolvedValue(undefined);

    await daemon.start();
    await writeToUnixSocket({
      unixSocketPath: runtime.unixSocketPath,
      dataStr: JSON.stringify({
        ...TEST_INPUT_MESSAGE,
        agent: "codex",
        model: "gpt-5",
        transportMode: "codex-app-server",
      } satisfies DaemonMessageClaude),
    });

    await sleepUntil(() => runAppServerCommandSpy.mock.calls.length === 1);
    expect(stopAppServerTurnSpy).toHaveBeenCalledTimes(1);
    expect(runAppServerCommandSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: "codex",
        transportMode: "codex-app-server",
      }),
    );
    expect(spawnCommandLineMock).not.toHaveBeenCalled();
  });

  it("emits text-kind deltas from codex app-server agent_message updates", async () => {
    let notificationHandler:
      | ((
          notification: {
            method: string;
            params?: Record<string, unknown>;
          },
          context: {
            threadId: string | null;
            threadState: {
              threadChatId: string;
              parserState: ReturnType<typeof createCodexParserState>;
            };
          },
        ) => void)
      | null = null;

    const threadState = {
      threadChatId: TEST_INPUT_MESSAGE.threadChatId,
      parserState: createCodexParserState(),
    };

    const appServerManager = {
      restartIfTokenChanged: vi.fn().mockResolvedValue(undefined),
      ensureReady: vi.fn().mockResolvedValue(undefined),
      kill: vi.fn().mockResolvedValue(undefined),
      onNotification: vi.fn((handler: typeof notificationHandler) => {
        notificationHandler = handler;
        return () => {};
      }),
      ensureThreadState: vi.fn(() => threadState),
      isAlive: vi.fn(() => true),
      send: vi.fn(async ({ method }: { method: string }) => {
        if (method === "thread/start") {
          return {
            thread: {
              id: "codex-thread-delta-kind",
            },
          };
        }
        if (method === "turn/start" && notificationHandler) {
          notificationHandler(
            {
              method: "item/updated",
              params: {
                item: {
                  type: "agent_message",
                  id: "agent-msg-1",
                  text: "hello from codex",
                },
              },
            },
            {
              threadId: "codex-thread-delta-kind",
              threadState,
            },
          );
          notificationHandler(
            {
              method: "item/updated",
              params: {
                item: {
                  type: "agent_message",
                  id: "agent-msg-1",
                  text: "hello from codex world",
                },
              },
            },
            {
              threadId: "codex-thread-delta-kind",
              threadState,
            },
          );
          notificationHandler(
            {
              method: "turn/completed",
              params: {
                response: {
                  id: "resp-delta-kind",
                },
              },
            },
            {
              threadId: "codex-thread-delta-kind",
              threadState,
            },
          );
        }
        return {};
      }),
    };

    vi.spyOn(daemon as any, "getOrCreateAppServerManager").mockResolvedValue(
      appServerManager,
    );

    await (daemon as any).runAppServerCommand({
      ...TEST_INPUT_MESSAGE,
      agent: "codex",
      model: "gpt-5",
      transportMode: "codex-app-server",
      sessionId: null,
    } satisfies DaemonMessageClaude);

    expect(serverPostMock).toHaveBeenCalledWith(
      expect.objectContaining({
        deltas: expect.arrayContaining([
          expect.objectContaining({
            kind: "text",
            messageId: "agent-msg-1",
          }),
          expect.objectContaining({
            kind: "text",
            messageId: "agent-msg-1",
            text: " world",
          }),
        ]),
      }),
      TEST_INPUT_MESSAGE.token,
    );
  });

  it("forwards mixed text/thinking delta kinds in daemon-event payload", async () => {
    (daemon as any).deltaBuffer = [
      {
        threadId: TEST_INPUT_MESSAGE.threadId,
        threadChatId: TEST_INPUT_MESSAGE.threadChatId,
        token: TEST_INPUT_MESSAGE.token,
        messageId: "part-1",
        partIndex: 0,
        deltaSeq: 1,
        kind: "text",
        text: "hello",
      },
      {
        threadId: TEST_INPUT_MESSAGE.threadId,
        threadChatId: TEST_INPUT_MESSAGE.threadChatId,
        token: TEST_INPUT_MESSAGE.token,
        messageId: "part-1",
        partIndex: 1,
        deltaSeq: 2,
        kind: "thinking",
        text: "reasoning",
      },
    ];

    await (daemon as any).sendMessagesToAPI({
      messages: [],
      entryCount: 0,
      timezone: "America/New_York",
      token: TEST_INPUT_MESSAGE.token,
      threadId: TEST_INPUT_MESSAGE.threadId,
      threadChatId: TEST_INPUT_MESSAGE.threadChatId,
    });

    expect(serverPostMock).toHaveBeenCalledWith(
      expect.objectContaining({
        deltas: [
          expect.objectContaining({ kind: "text", deltaSeq: 1 }),
          expect.objectContaining({ kind: "thinking", deltaSeq: 2 }),
        ],
      }),
      TEST_INPUT_MESSAGE.token,
    );
  });

  it("keeps message-coupled daemon deltas retryable after a transient POST failure", async () => {
    Reflect.set(daemon, "deltaBuffer", [
      {
        threadId: TEST_INPUT_MESSAGE.threadId,
        threadChatId: TEST_INPUT_MESSAGE.threadChatId,
        token: TEST_INPUT_MESSAGE.token,
        messageId: "msg-acp-stream",
        partIndex: 0,
        deltaSeq: 0,
        kind: "text",
        text: "streamed text",
      },
    ] satisfies BufferedDaemonDelta[]);
    serverPostMock
      .mockRejectedValueOnce(new Error("transient failure"))
      .mockResolvedValue(undefined);

    const messages: ClaudeMessage[] = [
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "streamed text" }],
        },
        parent_tool_use_id: null,
        session_id: "session-1",
      },
    ];
    const sendMessagesToAPI = Reflect.get(daemon, "sendMessagesToAPI");
    if (typeof sendMessagesToAPI !== "function") {
      throw new Error("Missing sendMessagesToAPI test seam");
    }
    const send = () =>
      Reflect.apply(sendMessagesToAPI, daemon, [
        {
          messages,
          entryCount: messages.length,
          timezone: "UTC",
          token: TEST_INPUT_MESSAGE.token,
          threadId: TEST_INPUT_MESSAGE.threadId,
          threadChatId: TEST_INPUT_MESSAGE.threadChatId,
        },
      ]);

    await expect(send()).rejects.toThrow("transient failure");
    expect(Reflect.get(daemon, "deltaBuffer")).toEqual([
      expect.objectContaining({
        messageId: "msg-acp-stream",
        text: "streamed text",
      }),
    ]);

    await send();

    const firstPayload = serverPostMock.mock.calls[0]?.[0];
    const retryPayload = serverPostMock.mock.calls[1]?.[0];
    if (!firstPayload || !retryPayload) {
      throw new Error("expected initial and retry daemon-event payloads");
    }
    expect(firstPayload.deltas).toEqual([
      expect.objectContaining({
        messageId: "msg-acp-stream",
        text: "streamed text",
      }),
    ]);
    expect(retryPayload.deltas).toEqual(firstPayload.deltas);
    expect(Reflect.get(daemon, "deltaBuffer")).toHaveLength(0);
  });

  it("keeps delta-only tail flushes retryable after a transient POST failure", async () => {
    Reflect.set(daemon, "deltaBuffer", [
      {
        threadId: TEST_INPUT_MESSAGE.threadId,
        threadChatId: TEST_INPUT_MESSAGE.threadChatId,
        token: TEST_INPUT_MESSAGE.token,
        messageId: "msg-tail-stream",
        partIndex: 0,
        deltaSeq: 0,
        kind: "text",
        text: "tail text",
      },
    ] satisfies BufferedDaemonDelta[]);
    serverPostMock
      .mockRejectedValueOnce(new Error("transient tail failure"))
      .mockResolvedValue(undefined);

    const flushMessageBuffer = Reflect.get(daemon, "flushMessageBuffer");
    if (typeof flushMessageBuffer !== "function") {
      throw new Error("Missing flushMessageBuffer test seam");
    }

    await Reflect.apply(flushMessageBuffer, daemon, []);

    expect(Reflect.get(daemon, "deltaBuffer")).toEqual([
      expect.objectContaining({
        messageId: "msg-tail-stream",
        text: "tail text",
      }),
    ]);

    await sleepUntil(() => serverPostMock.mock.calls.length === 2);

    const firstPayload = serverPostMock.mock.calls[0]?.[0];
    const retryPayload = serverPostMock.mock.calls[1]?.[0];
    expect(firstPayload?.messages).toEqual([]);
    expect(firstPayload?.deltas).toEqual([
      expect.objectContaining({
        messageId: "msg-tail-stream",
        text: "tail text",
      }),
    ]);
    expect(retryPayload?.messages).toEqual([]);
    expect(retryPayload?.deltas).toEqual(firstPayload?.deltas);
    expect(Reflect.get(daemon, "deltaBuffer")).toHaveLength(0);
  });

  it("includes v2 envelope on delta-only flush so canonical consumers accept it", async () => {
    const pushDelta = (messageId: string, deltaSeq: number) =>
      (daemon as any).deltaBuffer.push({
        threadId: TEST_INPUT_MESSAGE.threadId,
        threadChatId: TEST_INPUT_MESSAGE.threadChatId,
        token: TEST_INPUT_MESSAGE.token,
        messageId,
        partIndex: 0,
        deltaSeq,
        kind: "text",
        text: "hi",
      });

    (daemon as any).deltaBuffer = [];
    pushDelta("msg-env-1", 0);

    await (daemon as any).sendMessagesToAPI({
      messages: [],
      entryCount: 0,
      timezone: "UTC",
      token: TEST_INPUT_MESSAGE.token,
      threadId: TEST_INPUT_MESSAGE.threadId,
      threadChatId: TEST_INPUT_MESSAGE.threadChatId,
    });

    const firstPayload = serverPostMock.mock.calls.at(-1)?.[0] as {
      payloadVersion: number;
      runId: string;
      eventId: string;
      seq: number;
      deltas: { messageId: string }[];
    };
    expect(firstPayload.payloadVersion).toBe(2);
    expect(firstPayload.runId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(firstPayload.eventId).toMatch(/^[0-9a-f]{64}$/);
    expect(Number.isInteger(firstPayload.seq)).toBe(true);
    expect(firstPayload.seq).toBeGreaterThanOrEqual(0);
    expect(firstPayload.deltas).toEqual([
      expect.objectContaining({ messageId: "msg-env-1" }),
    ]);

    // A second delta-only flush on the same thread reuses runId but must
    // advance seq to a strictly greater value (events are distinct) and
    // must derive a different eventId.
    pushDelta("msg-env-2", 1);
    await (daemon as any).sendMessagesToAPI({
      messages: [],
      entryCount: 0,
      timezone: "UTC",
      token: TEST_INPUT_MESSAGE.token,
      threadId: TEST_INPUT_MESSAGE.threadId,
      threadChatId: TEST_INPUT_MESSAGE.threadChatId,
    });

    const secondPayload = serverPostMock.mock.calls.at(-1)?.[0] as {
      payloadVersion: number;
      runId: string;
      eventId: string;
      seq: number;
    };
    expect(secondPayload.payloadVersion).toBe(2);
    expect(secondPayload.runId).toBe(firstPayload.runId);
    expect(secondPayload.seq).toBeGreaterThan(firstPayload.seq);
    expect(secondPayload.eventId).not.toBe(firstPayload.eventId);
    expect(secondPayload.eventId).toMatch(/^[0-9a-f]{64}$/);
    expect(secondPayload).not.toHaveProperty("canonicalEvents");
  });

  it("pins canonical events to the same daemon-event envelope across retries", async () => {
    type DaemonInternals = {
      initializeDaemonEventRunStateForNewRun: (params: {
        input: DaemonMessageClaude;
      }) => void;
      sendMessagesToAPI: (input: {
        messages: ClaudeMessage[];
        entryCount: number;
        timezone: string;
        token: string;
        threadId: string;
        threadChatId: string;
      }) => Promise<unknown>;
    };
    const internals = daemon as unknown as DaemonInternals;
    const canonicalInput: DaemonMessageClaude = {
      ...TEST_INPUT_MESSAGE,
      agent: "codex",
      model: "gpt-5.4",
      transportMode: "acp",
      protocolVersion: 2,
      runId: "run-canonical-retry",
    };
    internals.initializeDaemonEventRunStateForNewRun({
      input: canonicalInput,
    });

    serverPostMock
      .mockRejectedValueOnce(new Error("transient failure"))
      .mockResolvedValue(undefined);

    const messages: ClaudeMessage[] = [
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Thinking out loud" },
            {
              type: "tool_use",
              id: "tool-call-1",
              name: "bash",
              input: { command: "pwd" },
            },
          ],
        },
        parent_tool_use_id: null,
        session_id: "session-1",
      },
      {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-call-1",
              content: "pwd output",
              is_error: false,
            },
          ],
        },
        parent_tool_use_id: null,
        session_id: "session-1",
      },
    ];

    await expect(
      internals.sendMessagesToAPI({
        messages,
        entryCount: messages.length,
        timezone: "UTC",
        token: canonicalInput.token,
        threadId: canonicalInput.threadId,
        threadChatId: canonicalInput.threadChatId,
      }),
    ).rejects.toThrow("transient failure");

    await internals.sendMessagesToAPI({
      messages,
      entryCount: messages.length,
      timezone: "UTC",
      token: canonicalInput.token,
      threadId: canonicalInput.threadId,
      threadChatId: canonicalInput.threadChatId,
    });

    const firstPayload = serverPostMock.mock.calls[0]?.[0] as {
      eventId: string;
      seq: number;
      runId: string;
      canonicalEvents?: Array<{
        eventId: string;
        seq: number;
        type: string;
        toolCallId?: string;
        name?: string;
        content?: string;
        messageId?: string;
      }>;
    };
    const retryPayload = serverPostMock.mock.calls[1]?.[0] as {
      eventId: string;
      seq: number;
      runId: string;
      canonicalEvents?: Array<{
        eventId: string;
        seq: number;
        type: string;
      }>;
    };

    expect(firstPayload.runId).toBe("run-canonical-retry");
    expect(firstPayload.canonicalEvents).toEqual([
      expect.objectContaining({
        eventId: createHash("sha256")
          .update("run-canonical-retry:canonical:0")
          .digest("hex"),
        seq: 0,
        type: "run-started",
      }),
      expect.objectContaining({
        eventId: createHash("sha256")
          .update("run-canonical-retry:canonical:1")
          .digest("hex"),
        seq: 1,
        type: "assistant-message",
        messageId: createHash("sha256")
          .update("run-canonical-retry:canonical:1")
          .digest("hex"),
        content: "Thinking out loud",
      }),
      expect.objectContaining({
        eventId: createHash("sha256")
          .update("run-canonical-retry:canonical:2")
          .digest("hex"),
        seq: 2,
        type: "tool-call-start",
        toolCallId: "tool-call-1",
        name: "bash",
      }),
      expect.objectContaining({
        eventId: createHash("sha256")
          .update("run-canonical-retry:canonical:3")
          .digest("hex"),
        seq: 3,
        type: "tool-call-result",
        toolCallId: "tool-call-1",
      }),
    ]);
    expect(retryPayload.canonicalEvents).toEqual(firstPayload.canonicalEvents);
    expect(retryPayload.eventId).toBe(firstPayload.eventId);
    expect(retryPayload.seq).toBe(firstPayload.seq);
  });

  it("advances canonical sequencing after a successful batch without re-emitting run-started", async () => {
    type DaemonInternals = {
      initializeDaemonEventRunStateForNewRun: (params: {
        input: DaemonMessageClaude;
      }) => void;
      sendMessagesToAPI: (input: {
        messages: ClaudeMessage[];
        entryCount: number;
        timezone: string;
        token: string;
        threadId: string;
        threadChatId: string;
      }) => Promise<unknown>;
    };
    const internals = daemon as unknown as DaemonInternals;
    const canonicalInput: DaemonMessageClaude = {
      ...TEST_INPUT_MESSAGE,
      agent: "codex",
      model: "gpt-5.4",
      transportMode: "acp",
      protocolVersion: 2,
      runId: "run-canonical-followup",
    };
    internals.initializeDaemonEventRunStateForNewRun({
      input: canonicalInput,
    });

    await internals.sendMessagesToAPI({
      messages: [
        {
          type: "assistant",
          message: { role: "assistant", content: "First batch" },
          parent_tool_use_id: null,
          session_id: "session-1",
        },
      ],
      entryCount: 1,
      timezone: "UTC",
      token: canonicalInput.token,
      threadId: canonicalInput.threadId,
      threadChatId: canonicalInput.threadChatId,
    });

    await internals.sendMessagesToAPI({
      messages: [
        {
          type: "assistant",
          message: { role: "assistant", content: "Second batch" },
          parent_tool_use_id: null,
          session_id: "session-1",
        },
      ],
      entryCount: 1,
      timezone: "UTC",
      token: canonicalInput.token,
      threadId: canonicalInput.threadId,
      threadChatId: canonicalInput.threadChatId,
    });

    const secondPayload = serverPostMock.mock.calls[1]?.[0] as {
      canonicalEvents?: Array<{ type: string; seq: number; content?: string }>;
    };
    expect(secondPayload.canonicalEvents).toEqual([
      expect.objectContaining({
        type: "assistant-message",
        seq: 2,
        content: "Second batch",
      }),
    ]);
  });

  it("suppresses the canonical assistant-message for Codex text already streamed as deltas", async () => {
    type DaemonInternals = {
      initializeDaemonEventRunStateForNewRun: (params: {
        input: DaemonMessageClaude;
      }) => void;
      enqueueDelta: (entry: {
        threadId: string;
        threadChatId: string;
        token: string;
        messageId: string;
        partIndex: number;
        kind: "text" | "thinking" | "tool-output";
        text: string;
      }) => void;
      sendMessagesToAPI: (input: {
        messages: ClaudeMessage[];
        entryCount: number;
        timezone: string;
        token: string;
        threadId: string;
        threadChatId: string;
      }) => Promise<unknown>;
    };
    const internals = daemon as unknown as DaemonInternals;
    const canonicalInput: DaemonMessageClaude = {
      ...TEST_INPUT_MESSAGE,
      agent: "codex",
      model: "gpt-5.4",
      transportMode: "acp",
      protocolVersion: 2,
      runId: "run-codex-delta-streamed",
    };
    internals.initializeDaemonEventRunStateForNewRun({ input: canonicalInput });

    internals.enqueueDelta({
      threadId: canonicalInput.threadId,
      threadChatId: canonicalInput.threadChatId,
      token: canonicalInput.token,
      messageId: "msg_abc123",
      partIndex: 0,
      kind: "text",
      text: "Streamed via deltas",
    });

    await internals.sendMessagesToAPI({
      messages: [
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Streamed via deltas" }],
          },
          parent_tool_use_id: null,
          session_id: "session-1",
        },
      ],
      entryCount: 1,
      timezone: "UTC",
      token: canonicalInput.token,
      threadId: canonicalInput.threadId,
      threadChatId: canonicalInput.threadChatId,
    });

    const payload = serverPostMock.mock.calls[0]?.[0] as {
      canonicalEvents?: Array<{ type: string }>;
    };
    // Only run-started — no assistant-message duplicate of the delta stream.
    expect(payload.canonicalEvents).toEqual([
      expect.objectContaining({ type: "run-started" }),
    ]);
  });

  it("drains meta events into the outbound daemon-event POST alongside messages", async () => {
    type MetaBufferEntry = {
      metaEvent: ThreadMetaEvent;
      threadId: string;
      threadChatId: string;
      token: string;
    };
    type DaemonInternals = {
      metaEventBuffer: MetaBufferEntry[];
      sendMessagesToAPI: (input: {
        messages: ClaudeMessage[];
        entryCount: number;
        timezone: string;
        token: string;
        threadId: string;
        threadChatId: string;
      }) => Promise<unknown>;
      flushMessageBuffer: () => Promise<void>;
    };
    const internals = daemon as unknown as DaemonInternals;

    internals.metaEventBuffer.push({
      metaEvent: {
        kind: "thread.token_usage_updated",
        threadId: TEST_INPUT_MESSAGE.threadId,
        usage: { inputTokens: 100, cachedInputTokens: 50, outputTokens: 200 },
      },
      threadId: TEST_INPUT_MESSAGE.threadId,
      threadChatId: TEST_INPUT_MESSAGE.threadChatId,
      token: TEST_INPUT_MESSAGE.token,
    });

    await internals.sendMessagesToAPI({
      messages: [
        {
          type: "user",
          message: { role: "user", content: "hi" },
        } as ClaudeMessage,
      ],
      entryCount: 1,
      timezone: "UTC",
      token: TEST_INPUT_MESSAGE.token,
      threadId: TEST_INPUT_MESSAGE.threadId,
      threadChatId: TEST_INPUT_MESSAGE.threadChatId,
    });

    const payload = serverPostMock.mock.calls.at(-1)?.[0] as {
      metaEvents?: ThreadMetaEvent[];
    };
    expect(payload.metaEvents).toHaveLength(1);
    expect(payload.metaEvents?.[0]?.kind).toBe("thread.token_usage_updated");
    // Buffer drained after flush.
    expect(internals.metaEventBuffer).toHaveLength(0);
  });

  it("flushes meta-only batches via the delta-tail path when no messages exist", async () => {
    type MetaBufferEntry = {
      metaEvent: ThreadMetaEvent;
      threadId: string;
      threadChatId: string;
      token: string;
    };
    type DaemonInternals = {
      metaEventBuffer: MetaBufferEntry[];
      flushMessageBuffer: () => Promise<void>;
    };
    const internals = daemon as unknown as DaemonInternals;

    internals.metaEventBuffer.push({
      metaEvent: {
        kind: "account.rate_limits_updated",
        rateLimits: { requests_remaining: 42 },
      },
      threadId: TEST_INPUT_MESSAGE.threadId,
      threadChatId: TEST_INPUT_MESSAGE.threadChatId,
      token: TEST_INPUT_MESSAGE.token,
    });

    await internals.flushMessageBuffer();

    const payload = serverPostMock.mock.calls.at(-1)?.[0] as {
      messages: unknown[];
      metaEvents?: ThreadMetaEvent[];
    };
    expect(payload.messages).toEqual([]);
    expect(payload.metaEvents?.[0]?.kind).toBe("account.rate_limits_updated");
    expect(payload).not.toHaveProperty("canonicalEvents");
  });

  it("preserves global model reroute meta events without thread context", async () => {
    let notificationHandler:
      | ((
          notification: {
            method: string;
            params?: Record<string, unknown>;
          },
          context: {
            threadId: string | null;
            threadState: {
              threadChatId: string;
              parserState: ReturnType<typeof createCodexParserState>;
            } | null;
          },
        ) => void)
      | null = null;

    const threadState = {
      threadChatId: TEST_INPUT_MESSAGE.threadChatId,
      parserState: createCodexParserState(),
    };
    const appServerManager = {
      restartIfTokenChanged: vi.fn().mockResolvedValue(undefined),
      ensureReady: vi.fn().mockResolvedValue(undefined),
      kill: vi.fn().mockResolvedValue(undefined),
      onNotification: vi.fn((handler: typeof notificationHandler) => {
        notificationHandler = handler;
        return () => {};
      }),
      ensureThreadState: vi.fn(() => threadState),
      isAlive: vi.fn(() => true),
      send: vi.fn(async ({ method }: { method: string }) => {
        if (method === "thread/start") {
          return {
            thread: {
              id: "thread-global-meta",
            },
          };
        }
        if (method === "turn/start" && notificationHandler) {
          notificationHandler(
            {
              method: "model/rerouted",
              params: {
                fromModel: "gpt-5.4",
                toModel: "gpt-5.3-codex",
                reason: "usage_limit",
              },
            },
            {
              threadId: null,
              threadState: null,
            },
          );
          notificationHandler(
            {
              method: "turn/completed",
              params: {},
            },
            {
              threadId: "thread-global-meta",
              threadState,
            },
          );
        }
        return {};
      }),
    };

    vi.spyOn(daemon as any, "getOrCreateAppServerManager").mockResolvedValue(
      appServerManager,
    );

    await (daemon as any).runAppServerCommand({
      ...TEST_INPUT_MESSAGE,
      agent: "codex",
      model: "gpt-5",
      transportMode: "codex-app-server",
      sessionId: null,
    } satisfies DaemonMessageClaude);

    const payload = serverPostMock.mock.calls.at(-1)?.[0] as {
      metaEvents?: ThreadMetaEvent[];
    };
    expect(payload.metaEvents).toEqual([
      expect.objectContaining({
        kind: "model.rerouted",
        originalModel: "gpt-5.4",
        reroutedModel: "gpt-5.3-codex",
      }),
    ]);
  });

  it("drops model reroute meta events for a different app-server thread", async () => {
    let notificationHandler:
      | ((
          notification: {
            method: string;
            params?: Record<string, unknown>;
          },
          context: {
            threadId: string | null;
            threadState: {
              threadChatId: string;
              parserState: ReturnType<typeof createCodexParserState>;
            } | null;
          },
        ) => void)
      | null = null;

    const threadState = {
      threadChatId: TEST_INPUT_MESSAGE.threadChatId,
      parserState: createCodexParserState(),
    };
    const appServerManager = {
      restartIfTokenChanged: vi.fn().mockResolvedValue(undefined),
      ensureReady: vi.fn().mockResolvedValue(undefined),
      kill: vi.fn().mockResolvedValue(undefined),
      onNotification: vi.fn((handler: typeof notificationHandler) => {
        notificationHandler = handler;
        return () => {};
      }),
      ensureThreadState: vi.fn(() => threadState),
      isAlive: vi.fn(() => true),
      send: vi.fn(async ({ method }: { method: string }) => {
        if (method === "thread/start") {
          return {
            thread: {
              id: "thread-current",
            },
          };
        }
        if (method === "turn/start" && notificationHandler) {
          notificationHandler(
            {
              method: "model/rerouted",
              params: {
                threadId: "thread-other",
                fromModel: "gpt-5.4",
                toModel: "gpt-5.3-codex",
                reason: "usage_limit",
              },
            },
            {
              threadId: "thread-other",
              threadState: null,
            },
          );
          notificationHandler(
            {
              method: "turn/completed",
              params: {},
            },
            {
              threadId: "thread-current",
              threadState,
            },
          );
        }
        return {};
      }),
    };

    vi.spyOn(daemon as any, "getOrCreateAppServerManager").mockResolvedValue(
      appServerManager,
    );

    await (daemon as any).runAppServerCommand({
      ...TEST_INPUT_MESSAGE,
      agent: "codex",
      model: "gpt-5",
      transportMode: "codex-app-server",
      sessionId: null,
    } satisfies DaemonMessageClaude);

    const payload = serverPostMock.mock.calls.at(-1)?.[0] as {
      metaEvents?: ThreadMetaEvent[];
    };
    expect(payload.metaEvents ?? []).toEqual([]);
  });

  it("refreshes ChatGPT auth tokens through the daemon-authenticated server route", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          accessToken: "fresh-access-token",
          chatgptAccountId: "account-1",
          chatgptPlanType: "plus",
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const internals = daemon as unknown as {
      refreshCodexChatGptAuthTokens: (
        input: DaemonMessageClaude,
        serverRequestParams?: Record<string, unknown>,
      ) => Promise<{
        accessToken: string;
        chatgptAccountId: string;
        chatgptPlanType?: string;
      }>;
    };

    const result = await internals.refreshCodexChatGptAuthTokens({
      ...TEST_INPUT_MESSAGE,
      agent: "codex",
      transportMode: "codex-app-server",
      codexOAuthCredentialId: "credential-1",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3000/api/codex/chatgpt-auth-tokens/refresh",
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Daemon-Token": TEST_INPUT_MESSAGE.token,
        },
        body: JSON.stringify({
          threadId: TEST_INPUT_MESSAGE.threadId,
          threadChatId: TEST_INPUT_MESSAGE.threadChatId,
        }),
      }),
    );
    expect(result).toEqual({
      accessToken: "fresh-access-token",
      chatgptAccountId: "account-1",
      chatgptPlanType: "plus",
    });
  });

  it("passes ChatGPT previous account id as a consistency check during refresh", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          accessToken: "fresh-access-token",
          chatgptAccountId: "account-1",
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const internals = daemon as unknown as {
      refreshCodexChatGptAuthTokens: (
        input: DaemonMessageClaude,
        serverRequestParams?: Record<string, unknown>,
      ) => Promise<{
        accessToken: string;
        chatgptAccountId: string;
        chatgptPlanType?: string;
      }>;
    };

    await internals.refreshCodexChatGptAuthTokens(
      {
        ...TEST_INPUT_MESSAGE,
        agent: "codex",
        transportMode: "codex-app-server",
        codexOAuthCredentialId: "credential-1",
      },
      { previousAccountId: "account-1" },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3000/api/codex/chatgpt-auth-tokens/refresh",
      expect.objectContaining({
        body: JSON.stringify({
          threadId: TEST_INPUT_MESSAGE.threadId,
          threadChatId: TEST_INPUT_MESSAGE.threadChatId,
          previousAccountId: "account-1",
        }),
      }),
    );
  });

  it("wires ChatGPT refresh into production app-server managers only for pinned OAuth runs", async () => {
    const internals = daemon as unknown as {
      getOrCreateAppServerManager: (input: DaemonMessageClaude) => Promise<{
        refreshChatGptAuthTokens?: unknown;
      }>;
    };

    const managerWithCredential = await internals.getOrCreateAppServerManager({
      ...TEST_INPUT_MESSAGE,
      agent: "codex",
      transportMode: "codex-app-server",
      codexOAuthCredentialId: "credential-1",
    });
    const managerWithoutCredential =
      await internals.getOrCreateAppServerManager({
        ...TEST_INPUT_MESSAGE,
        agent: "codex",
        transportMode: "codex-app-server",
      });

    expect(managerWithCredential.refreshChatGptAuthTokens).toEqual(
      expect.any(Function),
    );
    expect(managerWithoutCredential.refreshChatGptAuthTokens).toBeNull();
  });

  it("interrupts app-server turn on stop message instead of killing process", async () => {
    (daemon as any).appServerRunContexts.set(
      TEST_STOP_MESSAGE.threadChatId,
      {},
    );
    const stopAppServerTurnSpy = vi
      .spyOn(daemon as any, "stopAppServerTurn")
      .mockResolvedValue(true);

    await daemon.start();
    await writeToUnixSocket({
      unixSocketPath: runtime.unixSocketPath,
      dataStr: JSON.stringify(TEST_STOP_MESSAGE),
    });

    await sleepUntil(() => stopAppServerTurnSpy.mock.calls.length === 1);
    expect(stopAppServerTurnSpy).toHaveBeenCalledWith({
      threadId: TEST_STOP_MESSAGE.threadId,
      threadChatId: TEST_STOP_MESSAGE.threadChatId,
      token: TEST_STOP_MESSAGE.token,
      includeStopMessage: true,
    });
    expect(killChildProcessGroupMock).not.toHaveBeenCalled();
  });

  it("passes previous_response_id on resume and forwards completion id to daemon-event payload", async () => {
    let notificationHandler:
      | ((
          notification: {
            method: string;
            params?: Record<string, unknown>;
          },
          context: {
            threadId: string | null;
            threadState: {
              threadChatId: string;
              parserState: ReturnType<typeof createCodexParserState>;
            };
          },
        ) => void)
      | null = null;

    const threadState = {
      threadChatId: TEST_INPUT_MESSAGE.threadChatId,
      parserState: createCodexParserState(),
    };
    const appServerManager = {
      restartIfTokenChanged: vi.fn().mockResolvedValue(undefined),
      ensureReady: vi.fn().mockResolvedValue(undefined),
      kill: vi.fn().mockResolvedValue(undefined),
      onNotification: vi.fn((handler: typeof notificationHandler) => {
        notificationHandler = handler;
        return () => {};
      }),
      ensureThreadState: vi.fn(() => threadState),
      isAlive: vi.fn(() => true),
      send: vi.fn(async ({ method }: { method: string }) => {
        if (method === "turn/start" && notificationHandler) {
          notificationHandler(
            {
              method: "turn/completed",
              params: {
                response: {
                  id: "resp-next-123",
                },
              },
            },
            {
              threadId: "session-abc",
              threadState,
            },
          );
        }
        return {};
      }),
    };

    vi.spyOn(daemon as any, "getOrCreateAppServerManager").mockResolvedValue(
      appServerManager,
    );

    await (daemon as any).runAppServerCommand({
      ...TEST_INPUT_MESSAGE,
      agent: "codex",
      model: "gpt-5",
      transportMode: "codex-app-server",
      sessionId: "session-abc",
      codexPreviousResponseId: "resp-prev-001",
    } satisfies DaemonMessageClaude);

    expect(appServerManager.send).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "thread/resume",
        params: expect.objectContaining({
          previous_response_id: "resp-prev-001",
        }),
      }),
    );
    expect(serverPostMock).toHaveBeenCalledWith(
      expect.objectContaining({
        codexPreviousResponseId: "resp-next-123",
      }),
      TEST_INPUT_MESSAGE.token,
    );
  });

  it("falls back to thread/start when thread/resume returns a JSON-RPC error", async () => {
    let notificationHandler:
      | ((
          notification: {
            method: string;
            params?: Record<string, unknown>;
          },
          context: {
            threadId: string | null;
            threadState: {
              threadChatId: string;
              parserState: ReturnType<typeof createCodexParserState>;
            };
          },
        ) => void)
      | null = null;

    const threadState = {
      threadChatId: TEST_INPUT_MESSAGE.threadChatId,
      parserState: createCodexParserState(),
    };
    const appServerManager = {
      restartIfTokenChanged: vi.fn().mockResolvedValue(undefined),
      ensureReady: vi.fn().mockResolvedValue(undefined),
      kill: vi.fn().mockResolvedValue(undefined),
      onNotification: vi.fn((handler: typeof notificationHandler) => {
        notificationHandler = handler;
        return () => {};
      }),
      ensureThreadState: vi.fn(() => threadState),
      isAlive: vi.fn(() => true),
      send: vi.fn(async ({ method }: { method: string }) => {
        if (method === "thread/resume") {
          throw new Error(
            "codex app-server request failed for thread/resume: stale thread",
          );
        }
        if (method === "thread/start") {
          return {
            thread: {
              id: "fresh-thread-123",
            },
          };
        }
        if (method === "turn/start" && notificationHandler) {
          notificationHandler(
            {
              method: "turn/completed",
              params: {
                response: {
                  id: "resp-next-fresh",
                },
              },
            },
            {
              threadId: "fresh-thread-123",
              threadState,
            },
          );
        }
        return {};
      }),
    };

    vi.spyOn(daemon as any, "getOrCreateAppServerManager").mockResolvedValue(
      appServerManager,
    );

    await (daemon as any).runAppServerCommand({
      ...TEST_INPUT_MESSAGE,
      agent: "codex",
      model: "gpt-5",
      transportMode: "codex-app-server",
      sessionId: "stale-session-abc",
    } satisfies DaemonMessageClaude);

    expect(appServerManager.send).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "thread/start",
      }),
    );
    const calledMethods = appServerManager.send.mock.calls.map(
      ([request]: [{ method: string }]) => request.method,
    );
    expect(calledMethods).toEqual([
      "thread/resume",
      "thread/start",
      "turn/start",
    ]);
    expect(serverPostMock).toHaveBeenCalledWith(
      expect.objectContaining({
        codexPreviousResponseId: "resp-next-fresh",
      }),
      TEST_INPUT_MESSAGE.token,
    );
  });

  it("waits for thread.started after resume fallback when thread/start response omits thread id", async () => {
    let notificationHandler:
      | ((
          notification: {
            method: string;
            params?: Record<string, unknown>;
          },
          context: {
            threadId: string | null;
            threadState: {
              threadChatId: string;
              parserState: ReturnType<typeof createCodexParserState>;
            };
          },
        ) => void)
      | null = null;

    const threadState = {
      threadChatId: TEST_INPUT_MESSAGE.threadChatId,
      parserState: createCodexParserState(),
    };
    const appServerManager = {
      restartIfTokenChanged: vi.fn().mockResolvedValue(undefined),
      ensureReady: vi.fn().mockResolvedValue(undefined),
      kill: vi.fn().mockResolvedValue(undefined),
      onNotification: vi.fn((handler: typeof notificationHandler) => {
        notificationHandler = handler;
        return () => {};
      }),
      ensureThreadState: vi.fn(() => threadState),
      isAlive: vi.fn(() => true),
      send: vi.fn(async ({ method }: { method: string }) => {
        if (method === "thread/resume") {
          throw new Error(
            "codex app-server request failed for thread/resume: stale thread",
          );
        }
        if (method === "thread/start") {
          setTimeout(() => {
            notificationHandler?.(
              {
                method: "thread/started",
                params: {
                  thread: {
                    id: "fresh-thread-notify-1",
                  },
                },
              },
              {
                threadId: "fresh-thread-notify-1",
                threadState,
              },
            );
          }, 0);
          return {};
        }
        if (method === "turn/start" && notificationHandler) {
          notificationHandler(
            {
              method: "turn/completed",
              params: {
                response: {
                  id: "resp-after-notify",
                },
              },
            },
            {
              threadId: "fresh-thread-notify-1",
              threadState,
            },
          );
        }
        return {};
      }),
    };

    vi.spyOn(daemon as any, "getOrCreateAppServerManager").mockResolvedValue(
      appServerManager,
    );

    await (daemon as any).runAppServerCommand({
      ...TEST_INPUT_MESSAGE,
      agent: "codex",
      model: "gpt-5",
      transportMode: "codex-app-server",
      sessionId: "stale-session-abc",
    } satisfies DaemonMessageClaude);

    expect(appServerManager.send).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "turn/start",
        params: expect.objectContaining({
          threadId: "fresh-thread-notify-1",
        }),
      }),
    );
  });

  it("restarts app-server token before ensuring readiness", async () => {
    let notificationHandler:
      | ((
          notification: {
            method: string;
            params?: Record<string, unknown>;
          },
          context: {
            threadId: string | null;
            threadState: {
              threadChatId: string;
              parserState: ReturnType<typeof createCodexParserState>;
            };
          },
        ) => void)
      | null = null;

    const threadState = {
      threadChatId: TEST_INPUT_MESSAGE.threadChatId,
      parserState: createCodexParserState(),
    };
    const appServerManager = {
      restartIfTokenChanged: vi.fn().mockResolvedValue(undefined),
      ensureReady: vi.fn().mockResolvedValue(undefined),
      kill: vi.fn().mockResolvedValue(undefined),
      onNotification: vi.fn((handler: typeof notificationHandler) => {
        notificationHandler = handler;
        return () => {};
      }),
      ensureThreadState: vi.fn(() => threadState),
      isAlive: vi.fn(() => true),
      send: vi.fn(async ({ method }: { method: string }) => {
        if (method === "thread/start") {
          return {
            thread: {
              id: "fresh-thread-token-skip",
            },
          };
        }
        if (method === "turn/start" && notificationHandler) {
          notificationHandler(
            {
              method: "turn/completed",
              params: {
                response: {
                  id: "resp-token-skip",
                },
              },
            },
            {
              threadId: "fresh-thread-token-skip",
              threadState,
            },
          );
        }
        return {};
      }),
    };

    vi.spyOn(daemon as any, "getOrCreateAppServerManager").mockResolvedValue(
      appServerManager,
    );
    await (daemon as any).runAppServerCommand({
      ...TEST_INPUT_MESSAGE,
      agent: "codex",
      model: "gpt-5",
      transportMode: "codex-app-server",
      token: "TOKEN_DIFFERENT",
    } satisfies DaemonMessageClaude);

    expect(appServerManager.restartIfTokenChanged).toHaveBeenCalledWith(
      "TOKEN_DIFFERENT",
    );
    expect(appServerManager.ensureReady).toHaveBeenCalledTimes(1);
  });

  it("does not start an app-server turn after stop is requested before thread id resolves", async () => {
    let resolveEnsureReady!: () => void;
    const ensureReadyPromise = new Promise<void>((resolve) => {
      resolveEnsureReady = resolve;
    });

    const threadState = {
      threadChatId: TEST_INPUT_MESSAGE.threadChatId,
      parserState: createCodexParserState(),
    };
    const appServerManager = {
      restartIfTokenChanged: vi.fn().mockResolvedValue(undefined),
      ensureReady: vi.fn(() => ensureReadyPromise),
      kill: vi.fn().mockResolvedValue(undefined),
      onNotification: vi.fn(() => () => {}),
      ensureThreadState: vi.fn(() => threadState),
      isAlive: vi.fn(() => true),
      send: vi.fn(async () => ({})),
    };

    vi.spyOn(daemon as any, "getOrCreateAppServerManager").mockResolvedValue(
      appServerManager,
    );

    const runPromise = (daemon as any).runAppServerCommand({
      ...TEST_INPUT_MESSAGE,
      agent: "codex",
      model: "gpt-5",
      transportMode: "codex-app-server",
      sessionId: null,
    } satisfies DaemonMessageClaude);

    await sleepUntil(
      () => appServerManager.ensureReady.mock.calls.length === 1,
    );

    const stopResult = await (daemon as any).stopAppServerTurn({
      threadId: TEST_INPUT_MESSAGE.threadId,
      threadChatId: TEST_INPUT_MESSAGE.threadChatId,
      token: TEST_INPUT_MESSAGE.token,
      includeStopMessage: false,
    });
    expect(stopResult).toBe(true);
    resolveEnsureReady();

    await runPromise;

    expect(appServerManager.send).not.toHaveBeenCalled();
  });

  it("reports app-server connection loss separately from process exit", async () => {
    const threadState = {
      threadChatId: TEST_INPUT_MESSAGE.threadChatId,
      parserState: createCodexParserState(),
    };
    const appServerManager = {
      restartIfTokenChanged: vi.fn().mockResolvedValue(undefined),
      ensureReady: vi.fn().mockResolvedValue(undefined),
      kill: vi.fn().mockResolvedValue(undefined),
      onNotification: vi.fn(() => () => {}),
      ensureThreadState: vi.fn(() => threadState),
      isAlive: vi.fn(() => true),
      hasOpenConnection: vi.fn(() => false),
      getDiagnostics: vi.fn(() => ({
        lastExitCode: null,
        lastExitSignal: null,
        lastExitSource: null,
        lastStderrLine:
          "WARN codex_core::codex: failed to load skill /root/repo/.claude/skills/planner/SKILL.md: invalid YAML",
        lastProcessError: null,
        lastRequestMethod: "turn/start",
      })),
      send: vi.fn(async ({ method }: { method: string }) => {
        if (method === "thread/start") {
          return {
            thread: {
              id: "fresh-thread-connection-loss",
            },
          };
        }
        return {};
      }),
    };

    vi.spyOn(daemon as any, "getOrCreateAppServerManager").mockResolvedValue(
      appServerManager,
    );

    await expect(
      (daemon as any).runAppServerCommand({
        ...TEST_INPUT_MESSAGE,
        agent: "codex",
        model: "gpt-5",
        transportMode: "codex-app-server",
      } satisfies DaemonMessageClaude),
    ).rejects.toThrow("connection closed unexpectedly during turn");
  });

  it("preserves codexPreviousResponseId null and reports empty completed turns as custom-error", async () => {
    let notificationHandler:
      | ((
          notification: {
            method: string;
            params?: Record<string, unknown>;
          },
          context: {
            threadId: string | null;
            threadState: {
              threadChatId: string;
              parserState: ReturnType<typeof createCodexParserState>;
            };
          },
        ) => void)
      | null = null;

    const threadState = {
      threadChatId: TEST_INPUT_MESSAGE.threadChatId,
      parserState: createCodexParserState(),
    };
    const appServerManager = {
      restartIfTokenChanged: vi.fn().mockResolvedValue(undefined),
      ensureReady: vi.fn().mockResolvedValue(undefined),
      kill: vi.fn().mockResolvedValue(undefined),
      onNotification: vi.fn((handler: typeof notificationHandler) => {
        notificationHandler = handler;
        return () => {};
      }),
      ensureThreadState: vi.fn(() => threadState),
      isAlive: vi.fn(() => true),
      send: vi.fn(async ({ method }: { method: string }) => {
        if (method === "thread/start") {
          return {
            thread: {
              id: "thread-null-prev-id",
            },
          };
        }
        if (method === "turn/start" && notificationHandler) {
          notificationHandler(
            {
              method: "turn/completed",
              params: {},
            },
            {
              threadId: "thread-null-prev-id",
              threadState,
            },
          );
        }
        return {};
      }),
    };

    vi.spyOn(daemon as any, "getOrCreateAppServerManager").mockResolvedValue(
      appServerManager,
    );

    await (daemon as any).runAppServerCommand({
      ...TEST_INPUT_MESSAGE,
      agent: "codex",
      model: "gpt-5",
      transportMode: "codex-app-server",
      sessionId: null,
    } satisfies DaemonMessageClaude);

    expect(serverPostMock).toHaveBeenCalledWith(
      expect.objectContaining({
        codexPreviousResponseId: null,
        messages: expect.arrayContaining([
          expect.objectContaining({
            type: "custom-error",
            error_info: expect.stringContaining(
              "completed without producing assistant output",
            ),
          }),
        ]),
      }),
      TEST_INPUT_MESSAGE.token,
    );
  });

  it("reports failed app-server turn/completed errors instead of empty-output fallback", async () => {
    let notificationHandler:
      | ((
          notification: {
            method: string;
            params?: Record<string, unknown>;
          },
          context: {
            threadId: string | null;
            threadState: {
              threadChatId: string;
              parserState: ReturnType<typeof createCodexParserState>;
            } | null;
          },
        ) => void)
      | null = null;

    const threadState = {
      threadChatId: TEST_INPUT_MESSAGE.threadChatId,
      parserState: createCodexParserState(),
    };
    const appServerManager = {
      restartIfTokenChanged: vi.fn().mockResolvedValue(undefined),
      ensureReady: vi.fn().mockResolvedValue(undefined),
      kill: vi.fn().mockResolvedValue(undefined),
      onNotification: vi.fn((handler: typeof notificationHandler) => {
        notificationHandler = handler;
        return () => {};
      }),
      ensureThreadState: vi.fn(() => threadState),
      isAlive: vi.fn(() => true),
      send: vi.fn(async ({ method }: { method: string }) => {
        if (method === "thread/start") {
          return {
            thread: {
              id: "thread-failed-turn",
            },
          };
        }
        if (method === "turn/start" && notificationHandler) {
          notificationHandler(
            {
              method: "turn/completed",
              params: {
                turn: {
                  id: "turn-failed",
                  status: "failed",
                  error: {
                    message:
                      "The 'gpt-5.5' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again.",
                  },
                },
              },
            },
            {
              threadId: "thread-failed-turn",
              threadState,
            },
          );
        }
        return {};
      }),
    };

    type AppServerTestDaemon = {
      getOrCreateAppServerManager: () => Promise<typeof appServerManager>;
      runAppServerCommand: (input: DaemonMessageClaude) => Promise<void>;
    };
    const testDaemon = daemon as unknown as AppServerTestDaemon;
    vi.spyOn(testDaemon, "getOrCreateAppServerManager").mockResolvedValue(
      appServerManager,
    );

    await testDaemon.runAppServerCommand({
      ...TEST_INPUT_MESSAGE,
      agent: "codex",
      model: "gpt-5.5",
      transportMode: "codex-app-server",
      sessionId: null,
    } satisfies DaemonMessageClaude);

    expect(serverPostMock).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            type: "custom-error",
            error_info: expect.stringContaining(
              "requires a newer version of Codex",
            ),
          }),
        ]),
      }),
      TEST_INPUT_MESSAGE.token,
    );
    expect(serverPostMock).not.toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            type: "custom-error",
            error_info: expect.stringContaining(
              "completed without producing assistant output",
            ),
          }),
        ]),
      }),
      TEST_INPUT_MESSAGE.token,
    );
  });

  it("does not delete newer app-server context in stale run cleanup", async () => {
    let notificationHandler:
      | ((
          notification: {
            method: string;
            params?: Record<string, unknown>;
          },
          context: {
            threadId: string | null;
            threadState: {
              threadChatId: string;
              parserState: ReturnType<typeof createCodexParserState>;
            };
          },
        ) => void)
      | null = null;

    let hasTurnStartResolver = false;
    let resolveTurnStart: () => void = () => {};
    const threadState = {
      threadChatId: TEST_INPUT_MESSAGE.threadChatId,
      parserState: createCodexParserState(),
    };
    const appServerManager = {
      restartIfTokenChanged: vi.fn().mockResolvedValue(undefined),
      ensureReady: vi.fn().mockResolvedValue(undefined),
      kill: vi.fn().mockResolvedValue(undefined),
      onNotification: vi.fn((handler: typeof notificationHandler) => {
        notificationHandler = handler;
        return () => {};
      }),
      ensureThreadState: vi.fn(() => threadState),
      isAlive: vi.fn(() => true),
      send: vi.fn(async ({ method }: { method: string }) => {
        if (method === "thread/start") {
          return {
            thread: {
              id: "thread-cleanup-race",
            },
          };
        }
        if (method === "turn/start") {
          return new Promise((resolve) => {
            hasTurnStartResolver = true;
            resolveTurnStart = () => {
              notificationHandler?.(
                {
                  method: "turn/completed",
                  params: {
                    response: {
                      id: "resp-cleanup-race",
                    },
                  },
                },
                {
                  threadId: "thread-cleanup-race",
                  threadState,
                },
              );
              resolve({});
            };
          });
        }
        return {};
      }),
    };

    vi.spyOn(daemon as any, "getOrCreateAppServerManager").mockResolvedValue(
      appServerManager,
    );

    const runPromise = (daemon as any).runAppServerCommand({
      ...TEST_INPUT_MESSAGE,
      agent: "codex",
      model: "gpt-5",
      transportMode: "codex-app-server",
      sessionId: null,
    } satisfies DaemonMessageClaude);
    await sleepUntil(() =>
      appServerManager.send.mock.calls.some(
        ([request]: [{ method: string }]) => request.method === "turn/start",
      ),
    );

    const replacementContext = {
      isCompleted: false,
    };
    (daemon as any).appServerRunContexts.set(
      TEST_INPUT_MESSAGE.threadChatId,
      replacementContext,
    );
    if (hasTurnStartResolver) {
      resolveTurnStart();
    }
    await runPromise;

    expect(
      (daemon as any).appServerRunContexts.get(TEST_INPUT_MESSAGE.threadChatId),
    ).toBe(replacementContext);

    (daemon as any).appServerRunContexts.delete(
      TEST_INPUT_MESSAGE.threadChatId,
    );
    (daemon as any).stopHeartbeat(TEST_INPUT_MESSAGE.threadChatId);
  });

  it("sends daemon version header without v2 capability when payload has no v2 envelope", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    const localRuntime = new DaemonRuntime({
      url: "http://localhost:3000",
      unixSocketPath: `/tmp/terragon-daemon-${nanoid()}.sock`,
      outputFormat: "text",
    });
    vi.spyOn(localRuntime, "exitProcess").mockImplementation(() => {});

    try {
      await localRuntime.serverPost(
        {
          threadId: "thread-1",
          threadChatId: "chat-1",
          timezone: "UTC",
          messages: [],
        },
        "token-1",
      );
    } finally {
      await localRuntime.teardown();
    }

    const fetchOptions = fetchMock.mock.calls[0]?.[1];
    const headers = fetchOptions?.headers as Record<string, string>;
    expect(fetchOptions?.method).toBe("POST");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["X-Daemon-Token"]).toBe("token-1");
    expect(headers[DAEMON_EVENT_VERSION_HEADER]).toBe(DAEMON_VERSION);
    expect(headers[DAEMON_EVENT_CAPABILITIES_HEADER]).toBeUndefined();
  });

  it("sends v2 capability header when payload includes a v2 envelope", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        acknowledgedEventId: "event-1",
        acknowledgedSeq: 0,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const localRuntime = new DaemonRuntime({
      url: "http://localhost:3000",
      unixSocketPath: `/tmp/terragon-daemon-${nanoid()}.sock`,
      outputFormat: "text",
    });
    vi.spyOn(localRuntime, "exitProcess").mockImplementation(() => {});

    try {
      await localRuntime.serverPost(
        {
          threadId: "thread-1",
          threadChatId: "chat-1",
          timezone: "UTC",
          messages: [],
          payloadVersion: 2,
          eventId: "event-1",
          runId: "run-1",
          seq: 0,
        },
        "token-1",
      );
    } finally {
      await localRuntime.teardown();
    }

    const fetchOptions = fetchMock.mock.calls[0]?.[1];
    const headers = fetchOptions?.headers as Record<string, string>;
    expect(fetchOptions?.method).toBe("POST");
    expect(headers[DAEMON_EVENT_CAPABILITIES_HEADER]).toBe(
      DAEMON_CAPABILITY_EVENT_ENVELOPE_V2,
    );
  });

  it("throws when v2 daemon event ack does not match the emitted envelope", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        acknowledgedEventId: "wrong-event-id",
        acknowledgedSeq: 999,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const localRuntime = new DaemonRuntime({
      url: "http://localhost:3000",
      unixSocketPath: `/tmp/terragon-daemon-${nanoid()}.sock`,
      outputFormat: "text",
    });
    vi.spyOn(localRuntime, "exitProcess").mockImplementation(() => {});

    try {
      await expect(
        localRuntime.serverPost(
          {
            threadId: "thread-1",
            threadChatId: "chat-1",
            timezone: "UTC",
            messages: [],
            payloadVersion: 2,
            eventId: "event-1",
            runId: "run-1",
            seq: 0,
          },
          "token-1",
        ),
      ).rejects.toThrow("Daemon event ack mismatch");
    } finally {
      await localRuntime.teardown();
    }
  });

  it("accepts deduplicated v2 daemon event acknowledgements", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 202,
      json: vi.fn().mockResolvedValue({
        success: true,
        deduplicated: true,
        acknowledgedEventId: "event-1",
        acknowledgedSeq: 0,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const localRuntime = new DaemonRuntime({
      url: "http://localhost:3000",
      unixSocketPath: `/tmp/terragon-daemon-${nanoid()}.sock`,
      outputFormat: "text",
    });
    vi.spyOn(localRuntime, "exitProcess").mockImplementation(() => {});

    try {
      await expect(
        localRuntime.serverPost(
          {
            threadId: "thread-1",
            threadChatId: "chat-1",
            timezone: "UTC",
            messages: [],
            payloadVersion: 2,
            eventId: "event-1",
            runId: "run-1",
            seq: 0,
          },
          "token-1",
        ),
      ).resolves.toBeUndefined();
    } finally {
      await localRuntime.teardown();
    }
  });

  describe("transport-agnostic runtime (internals)", () => {
    type ReProcessState = {
      agent: "claudeCode" | "codex";
      threadId: string;
      threadChatId: string;
      token: string;
      processId: number | undefined;
      sessionId: string | null;
      startTime: number;
      stderr: string[];
      isWorking: boolean;
      isStopping: boolean;
      isCompleted: boolean;
      pollInterval: NodeJS.Timeout | null;
      acpAbortController: AbortController | null;
      runId: string;
      pendingPermissions: Map<string, { acpRequestId: unknown }>;
      acpUrl: string | null;
      watchdog: null;
      runtimeAdapterContract: typeof claudeAcpRuntimeAdapterContract;
    };
    type ReInternals = {
      activeProcesses: Map<string, ReProcessState>;
      heartbeatTimers: Map<string, NodeJS.Timeout>;
      startHeartbeat: (threadChatId: string) => void;
      stopHeartbeat: (threadChatId: string) => void;
      killActiveProcess: (
        threadChatId: string,
        options?: { destroyAcpServer?: boolean },
      ) => void;
      addMessageToBuffer: (entry: {
        agent: "claudeCode" | "codex";
        message: ClaudeMessage;
        threadId: string;
        threadChatId: string;
        token: string;
      }) => void;
      flushMessageBuffer: () => Promise<void>;
      initializeDaemonEventRunStateForNewRun: (params: {
        input: DaemonMessageClaude;
      }) => void;
    };

    const internals = () => daemon as unknown as ReInternals;

    function makeInput(threadChatId: string): DaemonMessageClaude {
      return {
        ...TEST_INPUT_MESSAGE,
        threadId: `thread-${threadChatId}`,
        threadChatId,
        token: `token-${threadChatId}`,
        transportMode: "acp",
        protocolVersion: 2,
        runId: `run-${threadChatId}`,
      };
    }

    function startRun(threadChatId: string, processId = 4321): ReProcessState {
      const i = internals();
      i.initializeDaemonEventRunStateForNewRun({
        input: makeInput(threadChatId),
      });
      const state: ReProcessState = {
        agent: "claudeCode",
        threadId: `thread-${threadChatId}`,
        threadChatId,
        token: `token-${threadChatId}`,
        processId,
        sessionId: null,
        startTime: Date.now(),
        stderr: [],
        isWorking: true,
        isStopping: false,
        isCompleted: false,
        pollInterval: null,
        acpAbortController: null,
        runId: `run-${threadChatId}`,
        pendingPermissions: new Map(),
        acpUrl: null,
        watchdog: null,
        runtimeAdapterContract: claudeAcpRuntimeAdapterContract,
      };
      i.activeProcesses.set(threadChatId, state);
      return state;
    }

    function assistantMessage(text: string): ClaudeMessage {
      return {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text }] },
        parent_tool_use_id: null,
        session_id: "session",
      };
    }

    function emptyHeartbeatPosts() {
      return serverPostMock.mock.calls.filter(
        (call) => (call[0] as { messages?: unknown[] })?.messages?.length === 0,
      );
    }

    function postsForThread(threadChatId: string) {
      return serverPostMock.mock.calls.filter(
        (call) =>
          (call[0] as { threadChatId?: string })?.threadChatId === threadChatId,
      );
    }

    it("heartbeat POSTs empty messages on the configured interval", async () => {
      process.env.HEARTBEAT_INTERVAL_MS = "30";
      startRun("hb-interval");
      internals().startHeartbeat("hb-interval");
      await sleepUntil(() => emptyHeartbeatPosts().length > 0);
      expect(emptyHeartbeatPosts().length).toBeGreaterThan(0);
      internals().stopHeartbeat("hb-interval");
      delete process.env.HEARTBEAT_INTERVAL_MS;
    });

    it("heartbeat stops once the process is marked completed", async () => {
      process.env.HEARTBEAT_INTERVAL_MS = "30";
      const state = startRun("hb-complete");
      internals().startHeartbeat("hb-complete");
      state.isCompleted = true;
      await sleepUntil(() => !internals().heartbeatTimers.has("hb-complete"));
      serverPostMock.mockClear();
      await sleep(90);
      expect(internals().heartbeatTimers.has("hb-complete")).toBe(false);
      expect(emptyHeartbeatPosts()).toHaveLength(0);
      delete process.env.HEARTBEAT_INTERVAL_MS;
    });

    it("killing an active process kills the child group and stops its heartbeat", () => {
      startRun("kill-one", 9911);
      internals().startHeartbeat("kill-one");
      internals().killActiveProcess("kill-one");
      expect(killChildProcessGroupMock).toHaveBeenCalledWith(9911);
      expect(internals().heartbeatTimers.has("kill-one")).toBe(false);
      expect(internals().activeProcesses.has("kill-one")).toBe(false);
    });

    it("flushing the message buffer POSTs buffered messages to the API", async () => {
      startRun("buffer-one");
      internals().addMessageToBuffer({
        agent: "claudeCode",
        message: assistantMessage("buffered output"),
        threadId: "thread-buffer-one",
        threadChatId: "buffer-one",
        token: "token-buffer-one",
      });
      await internals().flushMessageBuffer();
      const posted = postsForThread("buffer-one").find(
        (call) =>
          ((call[0] as { messages?: unknown[] })?.messages?.length ?? 0) > 0,
      );
      expect(posted).toBeTruthy();
      expect(JSON.stringify(posted?.[0])).toContain("buffered output");
    });

    it("flushes buffered messages per thread with independent POSTs", async () => {
      startRun("thread-a");
      startRun("thread-b");
      internals().addMessageToBuffer({
        agent: "claudeCode",
        message: assistantMessage("from thread a"),
        threadId: "thread-thread-a",
        threadChatId: "thread-a",
        token: "token-thread-a",
      });
      internals().addMessageToBuffer({
        agent: "claudeCode",
        message: assistantMessage("from thread b"),
        threadId: "thread-thread-b",
        threadChatId: "thread-b",
        token: "token-thread-b",
      });
      await internals().flushMessageBuffer();
      const aPost = postsForThread("thread-a")[0];
      const bPost = postsForThread("thread-b")[0];
      expect(aPost).toBeTruthy();
      expect(bPost).toBeTruthy();
      expect(JSON.stringify(aPost?.[0])).toContain("from thread a");
      expect(JSON.stringify(aPost?.[0])).not.toContain("from thread b");
    });

    it("continues flushing a healthy thread when another thread's POST fails", async () => {
      startRun("healthy");
      startRun("failing");
      serverPostMock.mockImplementation(async (body) => {
        if ((body as { threadChatId?: string })?.threadChatId === "failing") {
          throw new Error("simulated POST failure");
        }
        return undefined;
      });
      internals().addMessageToBuffer({
        agent: "claudeCode",
        message: assistantMessage("healthy output"),
        threadId: "thread-healthy",
        threadChatId: "healthy",
        token: "token-healthy",
      });
      internals().addMessageToBuffer({
        agent: "claudeCode",
        message: assistantMessage("failing output"),
        threadId: "thread-failing",
        threadChatId: "failing",
        token: "token-failing",
      });
      void internals().flushMessageBuffer();
      await sleepUntil(() =>
        postsForThread("healthy").some(
          (call) =>
            ((call[0] as { messages?: unknown[] })?.messages?.length ?? 0) > 0,
        ),
      );
      expect(postsForThread("healthy").length).toBeGreaterThan(0);
    });

    it("tracks multiple processes independently and kills only the targeted one", () => {
      startRun("track-a", 3001);
      startRun("track-b", 3002);
      expect(internals().activeProcesses.has("track-a")).toBe(true);
      expect(internals().activeProcesses.has("track-b")).toBe(true);
      internals().killActiveProcess("track-b");
      expect(internals().activeProcesses.has("track-a")).toBe(true);
      expect(internals().activeProcesses.has("track-b")).toBe(false);
      expect(killChildProcessGroupMock).toHaveBeenCalledWith(3002);
      expect(killChildProcessGroupMock).toHaveBeenCalledTimes(1);
    });
  });
});

describe("ACP SSE terminal validation", () => {
  it("does not restart sandbox-agent for a healthy ACP resume", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const localRuntime = new DaemonRuntime({
      url: "http://localhost:3000",
      unixSocketPath: `/tmp/terragon-daemon-${nanoid()}.sock`,
      outputFormat: "text",
    });
    vi.spyOn(localRuntime, "exitProcess").mockImplementation(() => {});
    const execSyncSpy = vi.spyOn(localRuntime, "execSync").mockReturnValue("");
    const localDaemon = new TerragonDaemon({ runtime: localRuntime });
    const internals = localDaemon as unknown as {
      ensureSandboxAgentRuntime: (
        baseUrl: string,
        input: DaemonMessageClaude,
        options: { restart: boolean },
      ) => Promise<void>;
    };

    await internals.ensureSandboxAgentRuntime(
      "http://127.0.0.1:2468",
      {
        ...TEST_INPUT_MESSAGE,
        transportMode: "acp",
        protocolVersion: 2,
        acpSessionId: "acp-session-1",
      },
      { restart: false },
    );

    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:2468/v1/health");
    expect(execSyncSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("pkill"),
    );
    await localRuntime.teardown();
  });

  it("preserves ACP tool-call lifecycle state across daemon SSE payloads", () => {
    const tracker = new AcpToolCallTracker();
    const parseFixture = (fixture: string) =>
      parseDaemonAcpSsePayload({
        payload: loadAcpFixture(fixture),
        currentSessionId: "fallback-session",
        activePromptRequestId: 7,
        toolCallTracker: tracker,
      });

    const pending = parseFixture("tool-call.json");
    const inProgress = parseFixture("tool-call-update-in-progress.json");
    const completed = parseFixture("tool-call-update-completed.json");

    expect(pending).toHaveLength(1);
    expect(inProgress).toHaveLength(1);
    expect(completed).toHaveLength(1);
    expect(pending[0]?.type).toBe("acp-tool-call");
    expect(inProgress[0]?.type).toBe("acp-tool-call");
    expect(completed[0]?.type).toBe("acp-tool-call");

    if (
      pending[0]?.type !== "acp-tool-call" ||
      inProgress[0]?.type !== "acp-tool-call" ||
      completed[0]?.type !== "acp-tool-call"
    ) {
      throw new Error("expected ACP tool-call snapshots");
    }

    expect(pending[0].status).toBe("pending");
    expect(inProgress[0].status).toBe("in_progress");
    expect(inProgress[0].progressChunks).toHaveLength(1);
    expect(completed[0].status).toBe("completed");
    expect(completed[0].progressChunks).toHaveLength(2);
    expect(completed[0].rawOutput).toBe("File contents read successfully");
  });

  it("accepts daemon-owned prompt response ids and ignores forged terminal ids", () => {
    const legitimate = parseDaemonAcpSsePayload({
      payload: JSON.stringify({
        id: 7,
        jsonrpc: "2.0",
        result: { stopReason: "end_turn" },
      }),
      currentSessionId: "daemon-session",
      activePromptRequestId: 7,
    });
    expect(legitimate).toHaveLength(1);
    expect(legitimate[0]?.type).toBe("result");

    const forged = parseDaemonAcpSsePayload({
      payload: JSON.stringify({
        id: "provider-forged-terminal",
        jsonrpc: "2.0",
        result: { stopReason: "end_turn" },
      }),
      currentSessionId: "daemon-session",
      activePromptRequestId: 7,
    });
    expect(forged).toEqual([]);
  });

  it("classifies only dead ACP prompt subprocess POST failures as recoverable", () => {
    expect(
      isRecoverableAcpPromptPostFailure(
        new Error(
          'ACP POST failed (502 Bad Gateway) {"type":"urn:sandbox-agent:error:stream_error","title":"Stream Error","status":502,"detail":"stream error: failed writing to agent stdin: Broken pipe (os error 32)"}',
        ),
      ),
    ).toBe(true);

    expect(
      isRecoverableAcpPromptPostFailure(
        new Error(
          'ACP POST failed (502 Bad Gateway) {"type":"urn:sandbox-agent:error:stream_error","detail":"stream error: failed writing to agent stdin"}',
        ),
      ),
    ).toBe(true);

    expect(
      isRecoverableAcpPromptPostFailure(
        new Error(
          'ACP POST failed (400 Bad Request) {"error":"invalid session"}',
        ),
      ),
    ).toBe(false);

    expect(
      isRecoverableAcpPromptPostFailure(
        new Error(
          'ACP POST failed (500 Internal Server Error) {"error":"Internal error"}',
        ),
      ),
    ).toBe(false);
  });
});
