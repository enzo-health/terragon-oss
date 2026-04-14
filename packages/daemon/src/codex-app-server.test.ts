import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  CodexAppServerManager,
  dumpRawNotification,
  extractMetaEvent,
  extractThreadEvent,
  SILENTLY_IGNORED_ITEM_TYPES,
  type CodexAppServerProcess,
  type CodexAppServerSpawn,
  type CodexAppServerSpawnOptions,
  type CodexAppServerStdin,
} from "./codex-app-server";

function loadFixture(name: string): Record<string, unknown> {
  const raw = fs.readFileSync(
    new URL(`./__fixtures__/codex/${name}.json`, import.meta.url),
    "utf8",
  );
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Fixture ${name} is not a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

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

  // Task 2.1: collabAgentToolCall is now handled — not silently ignored.
  test("SILENTLY_IGNORED_ITEM_TYPES does NOT include collabAgentToolCall", () => {
    expect(SILENTLY_IGNORED_ITEM_TYPES.has("collabAgentToolCall")).toBe(false);
  });

  // Task 2.1: collabAgentToolCall fixture produces a delegation item.started event.
  test("collab-agent-tool-call-started fixture → item.started with delegation item", () => {
    const fixture = loadFixture("collab-agent-tool-call-started");
    const event = extractThreadEvent(fixture);
    expect(event).not.toBeNull();
    expect(event?.type).toBe("item.started");
    if (event?.type !== "item.started") {
      return;
    }
    const item = event.item as Record<string, unknown>;
    expect(item.type).toBe("delegation");
    expect(item.id).toBe("item_collab_001");
    expect(item.senderThreadId).toBe("019cb55a-6ab5-7ad2-876b-dd1d3dedcf52");
    expect(item.receiverThreadIds).toEqual([
      "019cb55b-7bc6-8be3-987c-ee2e4eefdg63",
      "019cb55c-8cd7-9cf4-a98d-ff3f5ffgeh74",
    ]);
    expect(item.tool).toBe("spawn");
    expect(item.status).toBe("initiated");
  });

  // Task 2.2: turn/diff/updated fixture.
  test("turn-diff-updated fixture → turn.diff_updated event with diff string", () => {
    const fixture = loadFixture("turn-diff-updated");
    const event = extractThreadEvent(fixture);
    expect(event).not.toBeNull();
    expect(event?.type).toBe("turn.diff_updated");
    if (event?.type !== "turn.diff_updated") {
      return;
    }
    expect(typeof event.diff).toBe("string");
    expect(event.diff).toContain("--- a/");
  });

  // Task 2.2: turn/plan/updated fixture.
  test("turn-plan-updated fixture → turn.plan_updated event with plan object", () => {
    const fixture = loadFixture("turn-plan-updated");
    const event = extractThreadEvent(fixture);
    expect(event).not.toBeNull();
    expect(event?.type).toBe("turn.plan_updated");
    if (event?.type !== "turn.plan_updated") {
      return;
    }
    expect(event.plan).toBeDefined();
    expect(typeof event.plan).toBe("object");
  });

  // Task 2.3: item/commandExecution/outputDelta fixture.
  test("item-command-execution-output-delta fixture → item.updated with command_execution and output", () => {
    const fixture = loadFixture("item-command-execution-output-delta");
    const event = extractThreadEvent(fixture);
    expect(event).not.toBeNull();
    expect(event?.type).toBe("item.updated");
    if (event?.type !== "item.updated") {
      return;
    }
    const item = event.item as Record<string, unknown>;
    expect(item.type).toBe("command_execution");
    expect(item.id).toBe("item_cmd_001");
    expect(typeof item.aggregated_output).toBe("string");
    expect((item.aggregated_output as string).length).toBeGreaterThan(0);
  });

  // Task 2.4: item/fileChange/outputDelta fixture.
  test("item-file-change-output-delta fixture → item.updated with file_change and delta", () => {
    const fixture = loadFixture("item-file-change-output-delta");
    const event = extractThreadEvent(fixture);
    expect(event).not.toBeNull();
    expect(event?.type).toBe("item.updated");
    if (event?.type !== "item.updated") {
      return;
    }
    const item = event.item as Record<string, unknown>;
    expect(item.type).toBe("file_change");
    expect(item.id).toBe("item_file_001");
    expect(typeof item._delta).toBe("string");
    expect((item._delta as string).length).toBeGreaterThan(0);
  });

  // Task 2.5: item/reasoning/summaryTextDelta fixture.
  test("item-reasoning-summary-text-delta fixture → item.updated with reasoning + summaryText delta", () => {
    const fixture = loadFixture("item-reasoning-summary-text-delta");
    const event = extractThreadEvent(fixture);
    expect(event).not.toBeNull();
    expect(event?.type).toBe("item.updated");
    if (event?.type !== "item.updated") {
      return;
    }
    const item = event.item as Record<string, unknown>;
    expect(item.type).toBe("reasoning");
    expect(item.id).toBe("item_reasoning_001");
    expect(item._deltaKind).toBe("summaryText");
    expect(typeof item.text).toBe("string");
  });

  // Task 2.5: item/reasoning/summaryPartAdded fixture.
  test("item-reasoning-summary-part-added fixture → item.updated with reasoning + summaryPart delta", () => {
    const fixture = loadFixture("item-reasoning-summary-part-added");
    const event = extractThreadEvent(fixture);
    expect(event).not.toBeNull();
    expect(event?.type).toBe("item.updated");
    if (event?.type !== "item.updated") {
      return;
    }
    const item = event.item as Record<string, unknown>;
    expect(item.type).toBe("reasoning");
    expect(item.id).toBe("item_reasoning_001");
    expect(item._deltaKind).toBe("summaryPart");
    expect(item._summaryPart).toBeDefined();
  });

  // Task 2.5: item/reasoning/textDelta fixture.
  test("item-reasoning-text-delta fixture → item.updated with reasoning + text delta", () => {
    const fixture = loadFixture("item-reasoning-text-delta");
    const event = extractThreadEvent(fixture);
    expect(event).not.toBeNull();
    expect(event?.type).toBe("item.updated");
    if (event?.type !== "item.updated") {
      return;
    }
    const item = event.item as Record<string, unknown>;
    expect(item.type).toBe("reasoning");
    expect(item.id).toBe("item_reasoning_001");
    expect(item._deltaKind).toBe("text");
    expect(typeof item.text).toBe("string");
  });

  // Task 2.6: item/mcpToolCall/progress fixture.
  test("item-mcp-tool-call-progress fixture → item.updated with mcp_tool_call and progress", () => {
    const fixture = loadFixture("item-mcp-tool-call-progress");
    const event = extractThreadEvent(fixture);
    expect(event).not.toBeNull();
    expect(event?.type).toBe("item.updated");
    if (event?.type !== "item.updated") {
      return;
    }
    const item = event.item as Record<string, unknown>;
    expect(item.type).toBe("mcp_tool_call");
    expect(item.id).toBe("item_mcp_001");
    expect(item.status).toBe("in_progress");
    expect(item._progress).toBeDefined();
  });

  // Task 2.7: item/autoApprovalReview/started fixture.
  test("item-auto-approval-review-started fixture → item.started with auto_approval_review", () => {
    const fixture = loadFixture("item-auto-approval-review-started");
    const event = extractThreadEvent(fixture);
    expect(event).not.toBeNull();
    expect(event?.type).toBe("item.started");
    if (event?.type !== "item.started") {
      return;
    }
    const item = event.item as Record<string, unknown>;
    expect(item.type).toBe("auto_approval_review");
    expect(item.reviewId).toBe("review_001");
    expect(item.targetItemId).toBe("item_file_001");
    expect(item.status).toBe("pending");
  });

  // Task 2.7: item/autoApprovalReview/completed fixture.
  test("item-auto-approval-review-completed fixture → item.completed with auto_approval_review decision", () => {
    const fixture = loadFixture("item-auto-approval-review-completed");
    const event = extractThreadEvent(fixture);
    expect(event).not.toBeNull();
    expect(event?.type).toBe("item.completed");
    if (event?.type !== "item.completed") {
      return;
    }
    const item = event.item as Record<string, unknown>;
    expect(item.type).toBe("auto_approval_review");
    expect(item.reviewId).toBe("review_001");
    expect(item.decision).toBe("approved");
    expect(item.status).toBe("approved");
  });

  // Task 2.9: SILENTLY_IGNORED_ITEM_TYPES shrinks to only "userMessage".
  test("SILENTLY_IGNORED_ITEM_TYPES equals Set(['userMessage'])", () => {
    expect(SILENTLY_IGNORED_ITEM_TYPES).toEqual(new Set(["userMessage"]));
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

describe("extractMetaEvent (Task 2.8)", () => {
  // thread/tokenUsage/updated fixture.
  test("thread-token-usage-updated fixture → thread.token_usage_updated", () => {
    const fixture = loadFixture("thread-token-usage-updated");
    const meta = extractMetaEvent(fixture);
    expect(meta).not.toBeNull();
    expect(meta?.kind).toBe("thread.token_usage_updated");
    if (meta?.kind !== "thread.token_usage_updated") {
      return;
    }
    expect(meta.threadId).toBe("019cb55a-6ab5-7ad2-876b-dd1d3dedcf52");
    expect(meta.usage.inputTokens).toBe(2048);
    expect(meta.usage.cachedInputTokens).toBe(512);
    expect(meta.usage.outputTokens).toBe(1024);
  });

  // account/rateLimits/updated fixture.
  test("account-rate-limits-updated fixture → account.rate_limits_updated", () => {
    const fixture = loadFixture("account-rate-limits-updated");
    const meta = extractMetaEvent(fixture);
    expect(meta).not.toBeNull();
    expect(meta?.kind).toBe("account.rate_limits_updated");
    if (meta?.kind !== "account.rate_limits_updated") {
      return;
    }
    expect(meta.rateLimits).toBeDefined();
    expect(typeof meta.rateLimits).toBe("object");
  });

  // model/rerouted fixture.
  test("model-rerouted fixture → model.rerouted", () => {
    const fixture = loadFixture("model-rerouted");
    const meta = extractMetaEvent(fixture);
    expect(meta).not.toBeNull();
    expect(meta?.kind).toBe("model.rerouted");
    if (meta?.kind !== "model.rerouted") {
      return;
    }
    expect(meta.originalModel).toBe("claude-3-5-sonnet-20241022");
    expect(meta.reroutedModel).toBe("claude-3-opus-20250219");
    expect(meta.reason).toBe("model_overloaded");
  });

  // mcpServer/startupStatus/updated fixture.
  test("mcp-server-startup-status-updated fixture → mcp_server.startup_status_updated", () => {
    const fixture = loadFixture("mcp-server-startup-status-updated");
    const meta = extractMetaEvent(fixture);
    expect(meta).not.toBeNull();
    expect(meta?.kind).toBe("mcp_server.startup_status_updated");
    if (meta?.kind !== "mcp_server.startup_status_updated") {
      return;
    }
    expect(meta.serverName).toBe("github-integration");
    expect(meta.status).toBe("ready");
  });

  // thread/status/changed (synthesized inline — no fixture).
  test("thread/status/changed inline → thread.status_changed", () => {
    const meta = extractMetaEvent({
      jsonrpc: "2.0",
      method: "thread/status/changed",
      params: { threadId: "t-abc", status: "running" },
    });
    expect(meta).not.toBeNull();
    expect(meta?.kind).toBe("thread.status_changed");
    if (meta?.kind !== "thread.status_changed") {
      return;
    }
    expect(meta.threadId).toBe("t-abc");
    expect(meta.status).toBe("running");
  });

  // config/warning (synthesized inline — no fixture).
  test("config/warning inline → config.warning", () => {
    const meta = extractMetaEvent({
      jsonrpc: "2.0",
      method: "config/warning",
      params: { message: "deprecated option", context: "model config" },
    });
    expect(meta).not.toBeNull();
    expect(meta?.kind).toBe("config.warning");
    if (meta?.kind !== "config.warning") {
      return;
    }
    expect(meta.message).toBe("deprecated option");
    expect(meta.context).toBe("model config");
  });

  // deprecation/notice (synthesized inline — no fixture).
  test("deprecation/notice inline → deprecation.notice", () => {
    const meta = extractMetaEvent({
      jsonrpc: "2.0",
      method: "deprecation/notice",
      params: { message: "old param removed", replacement: "newParam" },
    });
    expect(meta).not.toBeNull();
    expect(meta?.kind).toBe("deprecation.notice");
    if (meta?.kind !== "deprecation.notice") {
      return;
    }
    expect(meta.message).toBe("old param removed");
    expect(meta.replacement).toBe("newParam");
  });

  // Non-meta method returns null.
  test("non-meta method returns null", () => {
    const meta = extractMetaEvent({
      jsonrpc: "2.0",
      method: "item/started",
      params: { item: { id: "x", type: "agent_message" } },
    });
    expect(meta).toBeNull();
  });
});

describe("DEBUG_DUMP_NOTIFICATIONS harness", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-dump-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("writes raw notification line to <dir>/codex-app-server.jsonl when dir is set", () => {
    const line = '{"method":"item/started","params":{"item":{"type":"x"}}}';
    dumpRawNotification(line, tmpDir);
    const dumpPath = path.join(tmpDir, "codex-app-server.jsonl");
    const contents = fs.readFileSync(dumpPath, "utf8");
    expect(contents.trim()).toBe(line);
  });

  test("appends multiple lines separated by newlines", () => {
    const lineA = '{"method":"item/started"}';
    const lineB = '{"method":"item/completed"}';
    dumpRawNotification(lineA, tmpDir);
    dumpRawNotification(lineB, tmpDir);
    const dumpPath = path.join(tmpDir, "codex-app-server.jsonl");
    const contents = fs.readFileSync(dumpPath, "utf8");
    expect(contents.split("\n").filter(Boolean)).toEqual([lineA, lineB]);
  });

  test("is a no-op when dir is undefined", () => {
    dumpRawNotification('{"method":"test"}', undefined);
    expect(fs.readdirSync(tmpDir)).toEqual([]);
  });

  test("is a no-op when dir is empty string", () => {
    dumpRawNotification('{"method":"test"}', "");
    expect(fs.readdirSync(tmpDir)).toEqual([]);
  });

  test("fails soft on a nonexistent parent directory (logs but does not throw)", () => {
    const badDir = path.join(tmpDir, "does-not-exist-yet");
    expect(() => dumpRawNotification('{"test":1}', badDir)).not.toThrow();
  });

  test("zero-overhead when dir is undefined — no fs calls occur", () => {
    const spy = vi.spyOn(fs, "appendFileSync");
    dumpRawNotification('{"test":1}', undefined);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
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
