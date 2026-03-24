import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, test, vi } from "vitest";
import {
  CodexAppServerManager,
  extractThreadEvent,
  SILENTLY_IGNORED_ITEM_TYPES,
  type CodexAppServerProcess,
  type CodexAppServerSpawn,
  type CodexAppServerSpawnOptions,
  type CodexAppServerStdin,
} from "./codex-app-server";

const APP_SERVER_ITEM_COMPLETED_TRANSCRIPT =
  '{"method":"item/completed","params":{"item":{"type":"agentMessage","id":"msg_0900a174019cd6ed0169a7422ac12881a0a5dcff0bd264e361","text":"hello"},"threadId":"019cb55a-6ab5-7ad2-876b-dd1d3dedcf52","turnId":"0"}}';
const APP_SERVER_CODEX_EVENT_ITEM_COMPLETED_TRANSCRIPT =
  '{"method":"codex/event/item_completed","params":{"id":"0","msg":{"type":"item_completed","thread_id":"019cb55a-6ab5-7ad2-876b-dd1d3dedcf52","turn_id":"0","item":{"type":"AgentMessage","id":"msg_0900a174019cd6ed0169a7422ac12881a0a5dcff0bd264e361","content":[{"type":"Text","text":"hello"}]}},"conversationId":"019cb55a-6ab5-7ad2-876b-dd1d3dedcf52"}}';

type MockLogger = {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
};

function createMockLogger(): MockLogger {
  return {
    info: vi.fn<(message: string, data?: Record<string, unknown>) => void>(),
    warn: vi.fn<(message: string, data?: Record<string, unknown>) => void>(),
    error: vi.fn<(message: string, data?: Record<string, unknown>) => void>(),
    debug: vi.fn<(message: string, data?: Record<string, unknown>) => void>(),
  };
}

function parseJsonObject(line: string): Record<string, unknown> {
  const parsed = JSON.parse(line);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Expected parsed JSON object");
  }
  return parsed;
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });
  }
  throw new Error("Timed out waiting for condition");
}

class MockCodexAppServerProcess
  extends EventEmitter
  implements CodexAppServerProcess
{
  pid: number | undefined;
  killed = false;
  exitCode: number | null = null;
  stdin: CodexAppServerStdin;
  stdout = new PassThrough();
  stderr = new PassThrough();
  readonly stdinWrites: string[] = [];
  maxConcurrentWrites = 0;
  private activeWrites = 0;
  private readonly writeDelayMs: number;

  constructor({
    pid,
    writeDelayMs = 0,
  }: {
    pid: number;
    writeDelayMs?: number;
  }) {
    super();
    this.pid = pid;
    this.writeDelayMs = writeDelayMs;
    this.stdin = {
      write: (
        chunk: string,
        callback: (error?: Error | null) => void,
      ): boolean => {
        this.stdinWrites.push(chunk);
        this.activeWrites += 1;
        this.maxConcurrentWrites = Math.max(
          this.maxConcurrentWrites,
          this.activeWrites,
        );
        const finishWrite = (): void => {
          this.activeWrites -= 1;
          callback();
        };
        if (this.writeDelayMs > 0) {
          setTimeout(finishWrite, this.writeDelayMs);
        } else {
          finishWrite();
        }
        return true;
      },
      end: (): void => {
        return;
      },
    };
  }

  kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
    this.killed = true;
    this.exitCode = signal === "SIGKILL" ? 137 : 0;
    this.emit("exit", this.exitCode, signal);
    this.emit("close", this.exitCode, signal);
    return true;
  }

  emitStdoutLine(line: string): void {
    this.stdout.write(`${line}\n`);
  }

  emitStderrLine(line: string): void {
    this.stderr.write(`${line}\n`);
  }

  crash(exitCode = 1): void {
    this.killed = true;
    this.exitCode = exitCode;
    this.emit("exit", exitCode, null);
    this.emit("close", exitCode, null);
  }
}

function createManagerHarness({
  writeDelayMs = 0,
  requestTimeoutMs = 200,
  handshakeTimeoutMs = 200,
  daemonToken = "token-a",
}: {
  writeDelayMs?: number;
  requestTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  daemonToken?: string | null;
} = {}): {
  manager: CodexAppServerManager;
  logger: MockLogger;
  processes: MockCodexAppServerProcess[];
  spawnCalls: Array<{
    command: string;
    args: string[];
    options: CodexAppServerSpawnOptions;
  }>;
} {
  const logger = createMockLogger();
  const processes: MockCodexAppServerProcess[] = [];
  const spawnCalls: Array<{
    command: string;
    args: string[];
    options: CodexAppServerSpawnOptions;
  }> = [];

  let nextPid = 42_000;
  const spawnProcess: CodexAppServerSpawn = (command, args, options) => {
    const processHandle = new MockCodexAppServerProcess({
      pid: nextPid,
      writeDelayMs,
    });
    nextPid += 1;
    processes.push(processHandle);
    spawnCalls.push({
      command,
      args,
      options,
    });
    return processHandle;
  };

  const manager = new CodexAppServerManager({
    logger,
    model: "gpt-5.3-codex-medium",
    daemonToken,
    requestTimeoutMs,
    handshakeTimeoutMs,
    spawnProcess,
  });

  return {
    manager,
    logger,
    processes,
    spawnCalls,
  };
}

async function completeInitializeHandshake(
  processHandle: MockCodexAppServerProcess,
): Promise<void> {
  await waitForCondition(() => processHandle.stdinWrites.length >= 1);
  const initializeRequest = parseJsonObject(
    processHandle.stdinWrites[0] ?? "{}",
  );
  const initializeId =
    typeof initializeRequest.id === "number" ? initializeRequest.id : 1;
  processHandle.emitStdoutLine(
    JSON.stringify({
      id: initializeId,
      result: { capabilities: {} },
    }),
  );
  await waitForCondition(() => processHandle.stdinWrites.length >= 2);
}

describe("extractThreadEvent", () => {
  test("passes through raw ThreadEvent payloads", () => {
    const event = extractThreadEvent({
      type: "thread.started",
      thread_id: "thread-raw-1",
    });

    expect(event).toEqual({
      type: "thread.started",
      thread_id: "thread-raw-1",
    });
  });

  test("extracts thread events from app-server item notifications", () => {
    const event = extractThreadEvent(
      parseJsonObject(APP_SERVER_ITEM_COMPLETED_TRANSCRIPT),
    );

    expect(event).toEqual({
      type: "item.completed",
      item: {
        id: "msg_0900a174019cd6ed0169a7422ac12881a0a5dcff0bd264e361",
        type: "agent_message",
        text: "hello",
      },
    });
  });

  test("extracts thread events from codex/event JSON-RPC envelopes", () => {
    const event = extractThreadEvent(
      parseJsonObject(APP_SERVER_CODEX_EVENT_ITEM_COMPLETED_TRANSCRIPT),
    );

    expect(event).toEqual({
      type: "item.completed",
      item: {
        id: "msg_0900a174019cd6ed0169a7422ac12881a0a5dcff0bd264e361",
        type: "agent_message",
        text: "hello",
      },
    });
  });

  test("returns null for non-thread notifications", () => {
    const event = extractThreadEvent(
      parseJsonObject('{"method":"account/rateLimits/updated","params":{}}'),
    );
    expect(event).toBeNull();
  });

  test("returns null for userMessage items (silently ignored)", () => {
    const event = extractThreadEvent(
      parseJsonObject(
        '{"method":"item/completed","params":{"threadId":"t-1","item":{"id":"msg-u1","type":"userMessage","text":"user input"}}}',
      ),
    );
    expect(event).toBeNull();
  });

  test("SILENTLY_IGNORED_ITEM_TYPES includes userMessage", () => {
    expect(SILENTLY_IGNORED_ITEM_TYPES.has("userMessage")).toBe(true);
  });

  test("converts item/agentMessage/delta into item.updated event", () => {
    const event = extractThreadEvent(
      parseJsonObject(
        '{"method":"item/agentMessage/delta","params":{"threadId":"t-1","itemId":"msg-d1","delta":"hello "}}',
      ),
    );
    expect(event).toEqual({
      type: "item.updated",
      item: {
        id: "msg-d1",
        type: "agent_message",
        text: "hello ",
      },
    });
  });

  test("returns null for item/agentMessage/delta without itemId", () => {
    const event = extractThreadEvent(
      parseJsonObject(
        '{"method":"item/agentMessage/delta","params":{"threadId":"t-1","delta":"text"}}',
      ),
    );
    expect(event).toBeNull();
  });
});

describe("CodexAppServerManager", () => {
  test("spawns process and completes initialize + initialized handshake", async () => {
    const { manager, processes, spawnCalls } = createManagerHarness();

    const readyPromise = manager.ensureReady();
    await waitForCondition(() => processes.length === 1);
    const processHandle = processes[0];
    expect(processHandle).toBeDefined();

    await completeInitializeHandshake(processHandle!);
    await readyPromise;

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]).toMatchObject({
      command: "codex",
      args: [
        "app-server",
        "-c",
        'model="gpt-5.3-codex"',
        "-c",
        'model_reasoning_effort="medium"',
      ],
    });

    const initialize = parseJsonObject(processHandle!.stdinWrites[0] ?? "{}");
    const initialized = parseJsonObject(processHandle!.stdinWrites[1] ?? "{}");
    expect(initialize).toMatchObject({
      jsonrpc: "2.0",
      method: "initialize",
      id: 1,
    });
    expect(initialized).toMatchObject({
      jsonrpc: "2.0",
      method: "initialized",
    });
  });

  test("send correlates responses by id", async () => {
    const { manager, processes } = createManagerHarness();

    const readyPromise = manager.ensureReady();
    await waitForCondition(() => processes.length === 1);
    const processHandle = processes[0]!;
    await completeInitializeHandshake(processHandle);
    await readyPromise;

    const requestPromise = manager.send({
      method: "thread/start",
      params: {},
      threadChatId: "thread-chat-1",
    });

    await waitForCondition(() => processHandle.stdinWrites.length >= 3);
    const request = parseJsonObject(processHandle.stdinWrites[2] ?? "{}");
    const requestId = request.id;
    expect(typeof requestId).toBe("number");

    processHandle.emitStdoutLine(
      JSON.stringify({
        id: requestId,
        result: { thread: { id: "thread-1" } },
      }),
    );

    await expect(requestPromise).resolves.toEqual({
      thread: { id: "thread-1" },
    });
    await manager.kill();
  });

  test("send enforces per-request timeout", async () => {
    const { manager, processes } = createManagerHarness({
      requestTimeoutMs: 100,
    });

    const readyPromise = manager.ensureReady();
    await waitForCondition(() => processes.length === 1);
    const processHandle = processes[0]!;
    await completeInitializeHandshake(processHandle);
    await readyPromise;

    const requestPromise = manager.send({
      method: "thread/start",
      params: {},
      timeoutMs: 20,
      threadChatId: "thread-chat-timeout",
    });
    await expect(requestPromise).rejects.toThrow(
      "codex app-server request timed out",
    );
    await manager.kill();
  });

  test("removes timed-out thread/start state before future thread/started notifications", async () => {
    const { manager, processes } = createManagerHarness({
      requestTimeoutMs: 100,
    });

    const readyPromise = manager.ensureReady();
    await waitForCondition(() => processes.length === 1);
    const processHandle = processes[0]!;
    await completeInitializeHandshake(processHandle);
    await readyPromise;

    const timedOutThreadStart = manager.send({
      method: "thread/start",
      params: {},
      timeoutMs: 20,
      threadChatId: "thread-chat-stale",
    });
    await expect(timedOutThreadStart).rejects.toThrow(
      "codex app-server request timed out",
    );

    const nextThreadStart = manager.send({
      method: "thread/start",
      params: {},
      timeoutMs: 300,
      threadChatId: "thread-chat-fresh",
    });
    await waitForCondition(() => processHandle.stdinWrites.length >= 4);
    const nextThreadRequest = parseJsonObject(
      processHandle.stdinWrites[3] ?? "{}",
    );
    processHandle.emitStdoutLine(
      JSON.stringify({
        id: nextThreadRequest.id,
        result: {},
      }),
    );
    await nextThreadStart;

    processHandle.emitStdoutLine(
      '{"method":"thread/started","params":{"thread":{"id":"thread-fresh"}}}',
    );
    await waitForCondition(
      () => manager.getThreadState("thread-fresh") !== null,
      500,
    );

    expect(manager.getThreadState("thread-fresh")?.threadChatId).toBe(
      "thread-chat-fresh",
    );
    await manager.kill();
  });

  test("routes notifications by thread id with isolated parser state", async () => {
    const { manager, processes } = createManagerHarness();
    const notifications: Array<{
      method: string;
      threadId: string | null;
      threadChatId: string | null;
    }> = [];

    manager.onNotification((notification, context) => {
      notifications.push({
        method: notification.method,
        threadId: context.threadId,
        threadChatId: context.threadState?.threadChatId ?? null,
      });
    });

    const readyPromise = manager.ensureReady();
    await waitForCondition(() => processes.length === 1);
    const processHandle = processes[0]!;
    await completeInitializeHandshake(processHandle);
    await readyPromise;

    const startThreadOne = manager.send({
      method: "thread/start",
      params: {},
      threadChatId: "thread-chat-1",
    });
    await waitForCondition(() => processHandle.stdinWrites.length >= 3);
    const startThreadOneRequest = parseJsonObject(
      processHandle.stdinWrites[2] ?? "{}",
    );
    processHandle.emitStdoutLine(
      JSON.stringify({
        id: startThreadOneRequest.id,
        result: { thread: { id: "thread-1" } },
      }),
    );
    await startThreadOne;

    processHandle.emitStdoutLine(
      '{"method":"thread/started","params":{"thread":{"id":"thread-1"}}}',
    );
    await waitForCondition(() => manager.getThreadState("thread-1") !== null);

    const startThreadTwo = manager.send({
      method: "thread/start",
      params: {},
      threadChatId: "thread-chat-2",
    });
    await waitForCondition(() => processHandle.stdinWrites.length >= 4);
    const startThreadTwoRequest = parseJsonObject(
      processHandle.stdinWrites[3] ?? "{}",
    );
    processHandle.emitStdoutLine(
      JSON.stringify({
        id: startThreadTwoRequest.id,
        result: { thread: { id: "thread-2" } },
      }),
    );
    await startThreadTwo;

    processHandle.emitStdoutLine(
      '{"method":"thread/started","params":{"thread":{"id":"thread-2"}}}',
    );
    await waitForCondition(() => manager.getThreadState("thread-2") !== null);

    const threadOneState = manager.getThreadState("thread-1");
    const threadTwoState = manager.getThreadState("thread-2");
    expect(threadOneState?.threadChatId).toBe("thread-chat-1");
    expect(threadTwoState?.threadChatId).toBe("thread-chat-2");

    threadOneState?.parserState.activeTaskToolUseIds.push("task-one");
    expect(threadTwoState?.parserState.activeTaskToolUseIds).toEqual([]);

    processHandle.emitStdoutLine(
      '{"method":"item/completed","params":{"threadId":"thread-1","item":{"id":"msg-1","type":"agentMessage","text":"hello"}}}',
    );
    await waitForCondition(() =>
      notifications.some(
        (notification) => notification.method === "item/completed",
      ),
    );

    const routedNotification = notifications.find(
      (notification) => notification.method === "item/completed",
    );
    expect(routedNotification).toEqual({
      method: "item/completed",
      threadId: "thread-1",
      threadChatId: "thread-chat-1",
    });
    await manager.kill();
  });

  test("ignores ambiguous thread/started notification when multiple thread starts are pending", async () => {
    const { manager, processes } = createManagerHarness();

    const readyPromise = manager.ensureReady();
    await waitForCondition(() => processes.length === 1);
    const processHandle = processes[0]!;
    await completeInitializeHandshake(processHandle);
    await readyPromise;

    const startThreadOne = manager.send({
      method: "thread/start",
      params: {},
      threadChatId: "thread-chat-1",
    });
    const startThreadTwo = manager.send({
      method: "thread/start",
      params: {},
      threadChatId: "thread-chat-2",
    });
    await waitForCondition(() => processHandle.stdinWrites.length >= 4);
    const startThreadOneRequest = parseJsonObject(
      processHandle.stdinWrites[2] ?? "{}",
    );
    const startThreadTwoRequest = parseJsonObject(
      processHandle.stdinWrites[3] ?? "{}",
    );

    processHandle.emitStdoutLine(
      '{"method":"thread/started","params":{"thread":{"id":"thread-ambiguous"}}}',
    );
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 20);
    });
    expect(manager.getThreadState("thread-ambiguous")).toBeNull();

    processHandle.emitStdoutLine(
      JSON.stringify({
        id: startThreadTwoRequest.id,
        result: { thread: { id: "thread-2" } },
      }),
    );
    processHandle.emitStdoutLine(
      JSON.stringify({
        id: startThreadOneRequest.id,
        result: { thread: { id: "thread-1" } },
      }),
    );
    await Promise.all([startThreadOne, startThreadTwo]);

    expect(manager.getThreadState("thread-1")?.threadChatId).toBe(
      "thread-chat-1",
    );
    expect(manager.getThreadState("thread-2")?.threadChatId).toBe(
      "thread-chat-2",
    );

    await manager.kill();
  });

  test("global stdin mutex prevents overlapping writes", async () => {
    const { manager, processes } = createManagerHarness({
      writeDelayMs: 10,
      requestTimeoutMs: 500,
    });

    const readyPromise = manager.ensureReady();
    await waitForCondition(() => processes.length === 1);
    const processHandle = processes[0]!;
    await completeInitializeHandshake(processHandle);
    await readyPromise;

    const requestOne = manager.send({
      method: "thread/start",
      params: {},
      threadChatId: "thread-chat-a",
      timeoutMs: 500,
    });
    const requestTwo = manager.send({
      method: "thread/start",
      params: {},
      threadChatId: "thread-chat-b",
      timeoutMs: 500,
    });

    await waitForCondition(() => processHandle.stdinWrites.length >= 4);
    const firstRequest = parseJsonObject(processHandle.stdinWrites[2] ?? "{}");
    const secondRequest = parseJsonObject(processHandle.stdinWrites[3] ?? "{}");
    processHandle.emitStdoutLine(
      JSON.stringify({ id: firstRequest.id, result: { ok: true } }),
    );
    processHandle.emitStdoutLine(
      JSON.stringify({ id: secondRequest.id, result: { ok: true } }),
    );

    await Promise.all([requestOne, requestTwo]);
    expect(processHandle.maxConcurrentWrites).toBe(1);
    await manager.kill();
  });

  test("kills process and reports dead state", async () => {
    const { manager, processes } = createManagerHarness();

    const readyPromise = manager.ensureReady();
    await waitForCondition(() => processes.length === 1);
    const processHandle = processes[0]!;
    await completeInitializeHandshake(processHandle);
    await readyPromise;

    expect(manager.isAlive()).toBe(true);
    await manager.kill();
    expect(processHandle.killed).toBe(true);
    expect(manager.isAlive()).toBe(false);
  });

  test("rejects pending requests when process crashes", async () => {
    const { manager, processes } = createManagerHarness();

    const readyPromise = manager.ensureReady();
    await waitForCondition(() => processes.length === 1);
    const processHandle = processes[0]!;
    await completeInitializeHandshake(processHandle);
    await readyPromise;

    const requestPromise = manager.send({
      method: "thread/start",
      params: {},
      timeoutMs: 500,
      threadChatId: "thread-chat-crash",
    });
    await waitForCondition(() => processHandle.stdinWrites.length >= 3);
    processHandle.crash(1);

    await expect(requestPromise).rejects.toThrow("codex app-server exited");
  });

  test("restartIfTokenChanged respawns process when daemon token changes", async () => {
    const { manager, processes, spawnCalls } = createManagerHarness({
      daemonToken: "token-a",
    });

    const firstReadyPromise = manager.ensureReady();
    await waitForCondition(() => processes.length === 1);
    const firstProcess = processes[0]!;
    await completeInitializeHandshake(firstProcess);
    await firstReadyPromise;

    const restartPromise = manager.restartIfTokenChanged("token-b");
    await waitForCondition(() => processes.length === 2);
    const secondProcess = processes[1]!;
    await completeInitializeHandshake(secondProcess);

    await expect(restartPromise).resolves.toBe(true);
    expect(firstProcess.killed).toBe(true);
    expect(spawnCalls[1]?.options.env.DAEMON_TOKEN).toBe("token-b");
    await manager.kill();
  });

  test("skips non-JSON stdout and forwards stderr", async () => {
    const { manager, processes, logger } = createManagerHarness();

    const readyPromise = manager.ensureReady();
    await waitForCondition(() => processes.length === 1);
    const processHandle = processes[0]!;
    await completeInitializeHandshake(processHandle);
    await readyPromise;

    processHandle.emitStdoutLine(
      "2026-03-03T20:18:34.756559Z  WARN codex_core::shell_snapshot: noisy line",
    );
    processHandle.emitStderrLine("app-server stderr warning");
    await waitForCondition(() => logger.warn.mock.calls.length >= 2);

    expect(logger.warn).toHaveBeenCalledWith(
      "Skipping non-JSON codex app-server stdout line",
      expect.objectContaining({
        line: expect.stringContaining("WARN codex_core::shell_snapshot"),
      }),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      "codex app-server stderr",
      expect.objectContaining({
        line: "app-server stderr warning",
      }),
    );
    await manager.kill();
  });
});
