import net from "node:net";
import { spawn } from "node:child_process";
import readline from "node:readline";
import type { ThreadEvent, ThreadItem, Usage } from "@openai/codex-sdk";
import WebSocket from "ws";
import {
  codexAppServerStartCommand,
  createCodexParserState,
  type CodexParserState,
} from "./codex";
import type { Logger } from "./logger";

export type CodexAppServerTransport = "stdio" | "websocket";

export type JsonRpcRequestEnvelope = {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
};

export type JsonRpcResponseEnvelope = {
  jsonrpc?: string;
  id: number;
  result?: unknown;
  error?: unknown;
};

export type JsonRpcNotificationEnvelope = {
  jsonrpc?: string;
  method: string;
  params?: Record<string, unknown>;
};

export type CodexAppServerRequest = {
  method: string;
  params?: Record<string, unknown>;
  timeoutMs?: number;
  threadChatId?: string;
};

export type CodexAppServerThreadState = {
  threadChatId: string;
  parserState: CodexParserState;
};

export type CodexAppServerNotificationContext = {
  threadId: string | null;
  threadState: CodexAppServerThreadState | null;
};

export type CodexAppServerNotificationHandler = (
  notification: JsonRpcNotificationEnvelope,
  context: CodexAppServerNotificationContext,
) => void;

export type CodexAppServerSpawnOptions = {
  env: NodeJS.ProcessEnv;
};

export type CodexAppServerStdin = {
  write: (chunk: string, callback: (error?: Error | null) => void) => boolean;
  end: () => void;
};

export type CodexAppServerProcess = {
  pid?: number;
  killed: boolean;
  exitCode: number | null;
  stdin: CodexAppServerStdin;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  kill: (signal?: NodeJS.Signals | number) => boolean;
  on: (
    event: string,
    listener: (...args: unknown[]) => void,
  ) => CodexAppServerProcess;
  once: (
    event: string,
    listener: (...args: unknown[]) => void,
  ) => CodexAppServerProcess;
};

export type CodexAppServerSpawn = (
  command: string,
  args: string[],
  options: CodexAppServerSpawnOptions,
) => CodexAppServerProcess;

type PendingRequest = {
  method: string;
  timeoutHandle: NodeJS.Timeout;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
};

type PendingThreadStart = {
  requestId: number;
  threadChatId: string;
};

type AppServerLogger = Pick<Logger, "debug" | "info" | "warn" | "error">;

type CodexItemEventType = "item.started" | "item.updated" | "item.completed";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 30_000;
const FORCE_KILL_TIMEOUT_MS = 5_000;
const EMPTY_USAGE: Usage = {
  input_tokens: 0,
  cached_input_tokens: 0,
  output_tokens: 0,
};

const METHOD_TO_THREAD_EVENT_TYPE: Partial<
  Record<string, ThreadEvent["type"]>
> = {
  "thread/started": "thread.started",
  "turn/started": "turn.started",
  "turn/completed": "turn.completed",
  "turn/failed": "turn.failed",
  "item/started": "item.started",
  "item/updated": "item.updated",
  "item/completed": "item.completed",
};

const CODEX_MESSAGE_TO_THREAD_EVENT_TYPE: Partial<
  Record<string, ThreadEvent["type"]>
> = {
  thread_started: "thread.started",
  turn_started: "turn.started",
  turn_completed: "turn.completed",
  turn_failed: "turn.failed",
  item_started: "item.started",
  item_updated: "item.updated",
  item_completed: "item.completed",
  error: "error",
};

function toRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return Object.fromEntries(Object.entries(value));
}

function toArray(value: unknown): unknown[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  return value;
}

function readString(
  value: Record<string, unknown>,
  key: string,
): string | null {
  const keyValue = value[key];
  return typeof keyValue === "string" ? keyValue : null;
}

function readNumber(
  value: Record<string, unknown>,
  key: string,
): number | null {
  const keyValue = value[key];
  return typeof keyValue === "number" ? keyValue : null;
}

function normalizeCommandStatus(
  status: string | null,
  eventType: CodexItemEventType,
): "in_progress" | "completed" | "failed" {
  const normalizedStatus = (status ?? "").toLowerCase();
  if (normalizedStatus === "completed") {
    return "completed";
  }
  if (normalizedStatus === "failed") {
    return "failed";
  }
  if (normalizedStatus === "in_progress" || normalizedStatus === "inprogress") {
    return "in_progress";
  }
  return eventType === "item.completed" ? "completed" : "in_progress";
}

function normalizePatchStatus(
  status: string | null,
  eventType: CodexItemEventType,
): "completed" | "failed" {
  const normalizedStatus = (status ?? "").toLowerCase();
  if (normalizedStatus === "failed") {
    return "failed";
  }
  if (normalizedStatus === "completed") {
    return "completed";
  }
  return eventType === "item.completed" ? "completed" : "failed";
}

function normalizeMcpStatus(
  status: string | null,
  eventType: CodexItemEventType,
): "in_progress" | "completed" | "failed" {
  const normalizedStatus = (status ?? "").toLowerCase();
  if (normalizedStatus === "completed") {
    return "completed";
  }
  if (normalizedStatus === "failed") {
    return "failed";
  }
  if (normalizedStatus === "in_progress" || normalizedStatus === "inprogress") {
    return "in_progress";
  }
  return eventType === "item.completed" ? "completed" : "in_progress";
}

function normalizeThreadItemType(rawType: string): ThreadItem["type"] | null {
  const normalizedType = rawType.replace(/[_-]/g, "").toLowerCase();
  switch (normalizedType) {
    case "agentmessage":
      return "agent_message";
    case "reasoning":
      return "reasoning";
    case "commandexecution":
      return "command_execution";
    case "filechange":
      return "file_change";
    case "mcptoolcall":
      return "mcp_tool_call";
    case "websearch":
      return "web_search";
    case "todolist":
      return "todo_list";
    case "error":
      return "error";
    default:
      return null;
  }
}

function extractTextFromContent(contentValue: unknown): string {
  const content = toArray(contentValue);
  if (!content) {
    return "";
  }
  const textParts = content
    .map((entry) => {
      const entryRecord = toRecord(entry);
      if (!entryRecord) {
        return null;
      }
      return readString(entryRecord, "text");
    })
    .filter((value): value is string => typeof value === "string");
  return textParts.join("");
}

function normalizeThreadItem(
  rawItem: Record<string, unknown>,
  eventType: CodexItemEventType,
): ThreadItem | null {
  const itemId = readString(rawItem, "id");
  const rawItemType = readString(rawItem, "type");
  if (!itemId || !rawItemType) {
    return null;
  }

  const normalizedType = normalizeThreadItemType(rawItemType);
  if (!normalizedType) {
    return null;
  }

  switch (normalizedType) {
    case "agent_message": {
      const text =
        readString(rawItem, "text") ??
        extractTextFromContent(rawItem.content) ??
        "";
      return {
        id: itemId,
        type: "agent_message",
        text,
      };
    }
    case "reasoning": {
      const text =
        readString(rawItem, "text") ??
        extractTextFromContent(rawItem.content) ??
        (() => {
          const summary = toArray(rawItem.summary);
          if (!summary) {
            return "";
          }
          return summary
            .filter((entry): entry is string => typeof entry === "string")
            .join("\n");
        })();
      return {
        id: itemId,
        type: "reasoning",
        text,
      };
    }
    case "command_execution": {
      const command = readString(rawItem, "command") ?? "";
      const aggregatedOutput =
        readString(rawItem, "aggregated_output") ??
        readString(rawItem, "aggregatedOutput") ??
        "";
      const status = normalizeCommandStatus(
        readString(rawItem, "status"),
        eventType,
      );
      const exitCode =
        readNumber(rawItem, "exit_code") ?? readNumber(rawItem, "exitCode");
      return {
        id: itemId,
        type: "command_execution",
        command,
        aggregated_output: aggregatedOutput,
        ...(exitCode === null ? {} : { exit_code: exitCode }),
        status,
      };
    }
    case "file_change": {
      const changes = toArray(rawItem.changes) ?? [];
      const normalizedChanges = changes
        .map((change) => {
          const changeRecord = toRecord(change);
          if (!changeRecord) {
            return null;
          }
          const path = readString(changeRecord, "path");
          if (!path) {
            return null;
          }
          const rawKind = readString(changeRecord, "kind");
          const kind =
            rawKind === "add" || rawKind === "delete" || rawKind === "update"
              ? rawKind
              : "update";
          return {
            path,
            kind,
          };
        })
        .filter(
          (
            entry,
          ): entry is {
            path: string;
            kind: "add" | "delete" | "update";
          } => entry !== null,
        );
      return {
        id: itemId,
        type: "file_change",
        changes: normalizedChanges,
        status: normalizePatchStatus(readString(rawItem, "status"), eventType),
      };
    }
    case "mcp_tool_call": {
      const server = readString(rawItem, "server") ?? "unknown";
      const tool = readString(rawItem, "tool") ?? "unknown";
      const mcpArguments = rawItem.arguments ?? {};
      const status = normalizeMcpStatus(
        readString(rawItem, "status"),
        eventType,
      );
      const errorRecord = toRecord(rawItem.error);
      const errorMessage =
        readString(rawItem, "error") ??
        readString(errorRecord ?? {}, "message");
      return {
        id: itemId,
        type: "mcp_tool_call",
        server,
        tool,
        arguments: mcpArguments,
        ...(errorMessage === null ? {} : { error: { message: errorMessage } }),
        status,
      };
    }
    case "web_search": {
      const query = readString(rawItem, "query") ?? "";
      return {
        id: itemId,
        type: "web_search",
        query,
      };
    }
    case "todo_list": {
      const items = toArray(rawItem.items) ?? [];
      const normalizedItems = items
        .map((todoItem) => {
          const todoRecord = toRecord(todoItem);
          if (!todoRecord) {
            return null;
          }
          const text = readString(todoRecord, "text");
          const completed =
            typeof todoRecord.completed === "boolean"
              ? todoRecord.completed
              : false;
          if (!text) {
            return null;
          }
          return { text, completed };
        })
        .filter(
          (
            item,
          ): item is {
            text: string;
            completed: boolean;
          } => item !== null,
        );
      return {
        id: itemId,
        type: "todo_list",
        items: normalizedItems,
      };
    }
    case "error": {
      const message =
        readString(rawItem, "message") ?? "Codex reported an error";
      return {
        id: itemId,
        type: "error",
        message,
      };
    }
  }
}

function parseUsage(rawUsage: unknown): Usage {
  const usageRecord = toRecord(rawUsage);
  if (!usageRecord) {
    return EMPTY_USAGE;
  }
  const inputTokens =
    readNumber(usageRecord, "input_tokens") ??
    readNumber(usageRecord, "inputTokens") ??
    0;
  const cachedInputTokens =
    readNumber(usageRecord, "cached_input_tokens") ??
    readNumber(usageRecord, "cachedInputTokens") ??
    0;
  const outputTokens =
    readNumber(usageRecord, "output_tokens") ??
    readNumber(usageRecord, "outputTokens") ??
    0;
  return {
    input_tokens: inputTokens,
    cached_input_tokens: cachedInputTokens,
    output_tokens: outputTokens,
  };
}

function extractThreadIdFromParams(
  params: Record<string, unknown>,
): string | null {
  const directThreadId = readString(params, "threadId");
  if (directThreadId) {
    return directThreadId;
  }

  const snakeCaseThreadId = readString(params, "thread_id");
  if (snakeCaseThreadId) {
    return snakeCaseThreadId;
  }

  const conversationId = readString(params, "conversationId");
  if (conversationId) {
    return conversationId;
  }

  const threadRecord = toRecord(params.thread);
  if (threadRecord) {
    const threadId = readString(threadRecord, "id");
    if (threadId) {
      return threadId;
    }
  }

  const messageRecord = toRecord(params.msg);
  if (messageRecord) {
    const messageThreadId = readString(messageRecord, "thread_id");
    if (messageThreadId) {
      return messageThreadId;
    }
  }

  return null;
}

function extractErrorMessage(errorValue: unknown): string {
  const errorRecord = toRecord(errorValue);
  if (errorRecord) {
    const message = readString(errorRecord, "message");
    if (message) {
      return message;
    }
  }
  if (typeof errorValue === "string") {
    return errorValue;
  }
  return "Codex app-server reported an error";
}

function extractThreadIdFromThreadStartResult(
  resultValue: unknown,
): string | null {
  const resultRecord = toRecord(resultValue);
  if (!resultRecord) {
    return null;
  }

  const directThreadId =
    readString(resultRecord, "threadId") ??
    readString(resultRecord, "thread_id") ??
    readString(resultRecord, "conversationId") ??
    readString(resultRecord, "id");
  if (directThreadId) {
    return directThreadId;
  }

  const threadRecord = toRecord(resultRecord.thread);
  if (threadRecord) {
    const nestedThreadId =
      readString(threadRecord, "id") ??
      readString(threadRecord, "threadId") ??
      readString(threadRecord, "thread_id");
    if (nestedThreadId) {
      return nestedThreadId;
    }
  }

  return null;
}

function extractThreadEventFromMethod({
  method,
  params,
}: {
  method: string;
  params: Record<string, unknown>;
}): ThreadEvent | null {
  const eventType = METHOD_TO_THREAD_EVENT_TYPE[method];
  if (!eventType) {
    return null;
  }

  switch (eventType) {
    case "thread.started": {
      const threadId = extractThreadIdFromParams(params);
      if (!threadId) {
        return null;
      }
      return {
        type: "thread.started",
        thread_id: threadId,
      };
    }
    case "turn.started": {
      return { type: "turn.started" };
    }
    case "turn.completed": {
      const turnRecord = toRecord(params.turn);
      return {
        type: "turn.completed",
        usage: parseUsage(turnRecord?.usage ?? params.usage),
      };
    }
    case "turn.failed": {
      return {
        type: "turn.failed",
        error: {
          message: extractErrorMessage(params.error),
        },
      };
    }
    case "item.started":
    case "item.updated":
    case "item.completed": {
      const rawItem = toRecord(params.item);
      if (!rawItem) {
        return null;
      }
      const normalizedItem = normalizeThreadItem(rawItem, eventType);
      if (!normalizedItem) {
        return null;
      }
      return {
        type: eventType,
        item: normalizedItem,
      };
    }
    case "error": {
      return {
        type: "error",
        message: extractErrorMessage(params.error ?? params.message),
      };
    }
  }
}

function extractThreadEventFromCodexMessage(
  message: Record<string, unknown>,
): ThreadEvent | null {
  const messageType = readString(message, "type");
  if (!messageType) {
    return null;
  }
  const eventType = CODEX_MESSAGE_TO_THREAD_EVENT_TYPE[messageType];
  if (!eventType) {
    return null;
  }

  switch (eventType) {
    case "thread.started": {
      const threadId = readString(message, "thread_id");
      if (!threadId) {
        return null;
      }
      return {
        type: "thread.started",
        thread_id: threadId,
      };
    }
    case "turn.started": {
      return { type: "turn.started" };
    }
    case "turn.completed": {
      return {
        type: "turn.completed",
        usage: parseUsage(message.usage),
      };
    }
    case "turn.failed": {
      return {
        type: "turn.failed",
        error: {
          message: extractErrorMessage(message.error),
        },
      };
    }
    case "item.started":
    case "item.updated":
    case "item.completed": {
      const rawItem = toRecord(message.item);
      if (!rawItem) {
        return null;
      }
      const normalizedItem = normalizeThreadItem(rawItem, eventType);
      if (!normalizedItem) {
        return null;
      }
      return {
        type: eventType,
        item: normalizedItem,
      };
    }
    case "error": {
      return {
        type: "error",
        message: extractErrorMessage(message.message),
      };
    }
  }
}

function extractRawThreadEvent(
  value: Record<string, unknown>,
): ThreadEvent | null {
  const threadEventType = readString(value, "type");
  if (!threadEventType) {
    return null;
  }

  switch (threadEventType) {
    case "thread.started": {
      const threadId = readString(value, "thread_id");
      if (!threadId) {
        return null;
      }
      return {
        type: "thread.started",
        thread_id: threadId,
      };
    }
    case "turn.started":
      return { type: "turn.started" };
    case "turn.completed":
      return {
        type: "turn.completed",
        usage: parseUsage(value.usage),
      };
    case "turn.failed":
      return {
        type: "turn.failed",
        error: {
          message: extractErrorMessage(value.error),
        },
      };
    case "item.started":
    case "item.updated":
    case "item.completed": {
      const rawItem = toRecord(value.item);
      if (!rawItem) {
        return null;
      }
      const normalizedItem = normalizeThreadItem(rawItem, threadEventType);
      if (!normalizedItem) {
        return null;
      }
      return {
        type: threadEventType,
        item: normalizedItem,
      };
    }
    case "error":
      return {
        type: "error",
        message: extractErrorMessage(value.message),
      };
    default:
      return null;
  }
}

export function extractThreadEvent(message: unknown): ThreadEvent | null {
  const messageRecord = toRecord(message);
  if (!messageRecord) {
    return null;
  }

  const rawThreadEvent = extractRawThreadEvent(messageRecord);
  if (rawThreadEvent) {
    return rawThreadEvent;
  }

  const method = readString(messageRecord, "method");
  if (!method) {
    return null;
  }
  const params = toRecord(messageRecord.params) ?? {};

  const extractedEvent = extractThreadEventFromMethod({
    method,
    params,
  });
  if (extractedEvent) {
    return extractedEvent;
  }

  if (!method.startsWith("codex/event/")) {
    return null;
  }
  const codexMessage = toRecord(params.msg);
  if (!codexMessage) {
    return null;
  }
  return extractThreadEventFromCodexMessage(codexMessage);
}

function defaultSpawnProcess(
  command: string,
  args: string[],
  options: CodexAppServerSpawnOptions,
): CodexAppServerProcess {
  return spawn(command, args, {
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

export type CodexAppServerManagerOptions = {
  logger: AppServerLogger;
  model: string;
  useCredits?: boolean;
  daemonToken?: string | null;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  spawnProcess?: CodexAppServerSpawn;
  transport?: CodexAppServerTransport;
  wsPort?: number;
  createWebSocket?: (url: string) => WebSocket;
};

export class CodexAppServerManager {
  readonly threadStates = new Map<string, CodexAppServerThreadState>();

  private readonly logger: AppServerLogger;
  private readonly model: string;
  private readonly useCredits: boolean;
  private readonly requestTimeoutMs: number;
  private readonly handshakeTimeoutMs: number;
  private readonly spawnProcess: CodexAppServerSpawn;
  private readonly baseEnv: NodeJS.ProcessEnv;
  private readonly notificationHandlers =
    new Set<CodexAppServerNotificationHandler>();
  private readonly transport: CodexAppServerTransport;
  private readonly createWebSocket: (url: string) => WebSocket;

  private process: CodexAppServerProcess | null = null;
  private stdoutInterface: readline.Interface | null = null;
  private ws: WebSocket | null = null;
  private wsPort: number | undefined;
  private nextRequestId = 1;
  private pendingRequests = new Map<number, PendingRequest>();
  private pendingThreadStarts: PendingThreadStart[] = [];
  private writeQueue: Promise<void> = Promise.resolve();
  private ready = false;
  private readyPromise: Promise<void> | null = null;
  private daemonToken: string | null;
  private spawnToken: string | null = null;

  constructor({
    logger,
    model,
    useCredits = false,
    daemonToken = process.env.DAEMON_TOKEN ?? null,
    env = process.env,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    handshakeTimeoutMs = DEFAULT_HANDSHAKE_TIMEOUT_MS,
    spawnProcess = defaultSpawnProcess,
    transport = "stdio",
    wsPort,
    createWebSocket = (url: string) => new WebSocket(url),
  }: CodexAppServerManagerOptions) {
    this.logger = logger;
    this.model = model;
    this.useCredits = useCredits;
    this.daemonToken = daemonToken;
    this.baseEnv = env;
    this.requestTimeoutMs = requestTimeoutMs;
    this.handshakeTimeoutMs = handshakeTimeoutMs;
    this.spawnProcess = spawnProcess;
    this.transport = transport;
    this.wsPort = wsPort;
    this.createWebSocket = createWebSocket;
  }

  spawn(): void {
    if (this.isAlive()) {
      return;
    }

    const listenAddress =
      this.transport === "websocket"
        ? `ws://127.0.0.1:${this.wsPort}`
        : undefined;
    const [command, args] = codexAppServerStartCommand({
      model: this.model,
      useCredits: this.useCredits,
      listenAddress,
    });
    const spawnEnv: NodeJS.ProcessEnv = {
      ...this.baseEnv,
    };
    if (this.daemonToken) {
      spawnEnv.DAEMON_TOKEN = this.daemonToken;
    } else {
      delete spawnEnv.DAEMON_TOKEN;
    }

    const processHandle = this.spawnProcess(command, args, {
      env: spawnEnv,
    });
    this.process = processHandle;
    this.spawnToken = this.daemonToken;
    this.ready = false;
    this.pendingThreadStarts = [];
    this.attachProcessHandlers(processHandle);

    this.logger.info("Spawned codex app-server", {
      pid: processHandle.pid ?? null,
      command,
      args,
    });
  }

  async ensureReady(): Promise<void> {
    if (this.ready && this.isAlive()) {
      return;
    }
    if (this.readyPromise) {
      return this.readyPromise;
    }

    this.readyPromise = (async () => {
      if (this.transport === "websocket" && this.wsPort === undefined) {
        this.wsPort = await getAvailablePort();
      }
      if (!this.isAlive()) {
        this.spawn();
      }
      if (this.transport === "websocket" && !this.ws) {
        await this.connectWebSocket();
      }
      await this.sendRequestInternal({
        method: "initialize",
        params: {
          clientInfo: {
            name: "terragon-daemon",
            version: "1.0",
          },
          capabilities: {},
        },
        timeoutMs: this.handshakeTimeoutMs,
      });
      await this.sendNotification({
        method: "initialized",
        params: {},
      });
      this.ready = true;
    })().finally(() => {
      this.readyPromise = null;
    });

    return this.readyPromise;
  }

  async send(request: CodexAppServerRequest): Promise<unknown> {
    await this.ensureReady();
    return this.sendRequestInternal(request);
  }

  onNotification(handler: CodexAppServerNotificationHandler): () => void {
    this.notificationHandlers.add(handler);
    return () => {
      this.notificationHandlers.delete(handler);
    };
  }

  isAlive(): boolean {
    if (!this.process) {
      return false;
    }
    const processAlive = this.process.exitCode === null && !this.process.killed;
    if (
      this.transport === "websocket" &&
      processAlive &&
      this.ws?.readyState !== WebSocket.OPEN
    ) {
      return false;
    }
    return processAlive;
  }

  getThreadState(threadId: string): CodexAppServerThreadState | null {
    return this.threadStates.get(threadId) ?? null;
  }

  ensureThreadState({
    threadId,
    threadChatId,
  }: {
    threadId: string;
    threadChatId: string;
  }): CodexAppServerThreadState {
    const existingState = this.threadStates.get(threadId);
    if (existingState) {
      existingState.threadChatId = threadChatId;
      return existingState;
    }
    const nextState = {
      threadChatId,
      parserState: createCodexParserState(),
    };
    this.threadStates.set(threadId, nextState);
    return nextState;
  }

  clearThreadState(threadId: string): void {
    this.threadStates.delete(threadId);
  }

  async restartIfTokenChanged(
    currentToken: string | null | undefined,
  ): Promise<boolean> {
    const normalizedToken = currentToken ?? null;
    if (!this.isAlive()) {
      this.daemonToken = normalizedToken;
      return false;
    }
    if (this.spawnToken === normalizedToken) {
      return false;
    }

    this.logger.info("Restarting codex app-server after daemon token change", {
      hadPreviousToken: this.spawnToken !== null,
      hasCurrentToken: normalizedToken !== null,
    });
    this.daemonToken = normalizedToken;
    await this.kill();
    await this.ensureReady();
    return true;
  }

  async kill(): Promise<void> {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    const processHandle = this.process;
    if (!processHandle) {
      return;
    }

    const waitForClose = new Promise<void>((resolve) => {
      processHandle.once("close", () => {
        resolve();
      });
    });

    processHandle.kill("SIGTERM");
    await Promise.race([
      waitForClose,
      new Promise<void>((resolve) => {
        setTimeout(resolve, FORCE_KILL_TIMEOUT_MS);
      }),
    ]);

    if (this.process === processHandle && this.isAlive()) {
      processHandle.kill("SIGKILL");
      await waitForClose;
    }
  }

  private attachProcessHandlers(processHandle: CodexAppServerProcess): void {
    let closeHandled = false;
    const handleClose = ({
      code,
      source,
    }: {
      code: number | null;
      source: string;
    }): void => {
      if (closeHandled) {
        return;
      }
      closeHandled = true;
      if (this.stdoutInterface) {
        this.stdoutInterface.close();
        this.stdoutInterface = null;
      }
      if (this.process === processHandle) {
        this.process = null;
      }
      this.ready = false;
      this.pendingThreadStarts = [];
      this.threadStates.clear();
      this.rejectPendingRequests(
        new Error(`codex app-server exited (${source}) with code ${code}`),
      );
    };

    if (this.transport === "stdio") {
      this.stdoutInterface = readline.createInterface({
        input: processHandle.stdout,
        crlfDelay: Infinity,
      });
      this.stdoutInterface.on("line", (line) => {
        this.handleIncomingMessage(line);
      });
    }

    processHandle.stderr.on("data", (chunk: unknown) => {
      const stderrOutput =
        typeof chunk === "string"
          ? chunk
          : chunk instanceof Buffer
            ? chunk.toString()
            : String(chunk);
      const trimmed = stderrOutput.trim();
      if (!trimmed) {
        return;
      }
      const level = trimmed.includes("failed to load skill") ? "debug" : "warn";
      this.logger[level]("codex app-server stderr", {
        line: trimmed,
      });
    });

    processHandle.on("error", (error: unknown) => {
      const message =
        error instanceof Error ? error.message : "Unknown process error";
      this.logger.error("codex app-server process error", {
        message,
      });
      this.rejectPendingRequests(
        new Error(`codex app-server process error: ${message}`),
      );
    });

    processHandle.on("exit", (rawCode: unknown) => {
      const code = typeof rawCode === "number" ? rawCode : null;
      handleClose({
        code,
        source: "exit",
      });
    });
    processHandle.on("close", (rawCode: unknown) => {
      const code = typeof rawCode === "number" ? rawCode : null;
      handleClose({
        code,
        source: "close",
      });
    });
  }

  private handleIncomingMessage(line: string): void {
    const trimmedLine = line.trim();
    if (!trimmedLine) {
      return;
    }

    let parsedLine: unknown;
    try {
      parsedLine = JSON.parse(trimmedLine);
    } catch {
      this.logger.warn("Skipping non-JSON codex app-server stdout line", {
        line: trimmedLine,
      });
      return;
    }
    const record = toRecord(parsedLine);
    if (!record) {
      this.logger.warn("Skipping non-object codex app-server stdout payload", {
        line: trimmedLine,
      });
      return;
    }

    const responseId = readNumber(record, "id");
    if (responseId !== null && ("result" in record || "error" in record)) {
      this.handleResponse({
        id: responseId,
        result: record.result,
        error: record.error,
      });
      return;
    }

    const method = readString(record, "method");
    if (!method || "id" in record) {
      return;
    }
    const params = toRecord(record.params) ?? {};
    this.dispatchNotification({
      method,
      params,
    });
  }

  private handleResponse(response: JsonRpcResponseEnvelope): void {
    const pending = this.pendingRequests.get(response.id);
    if (!pending) {
      this.logger.debug(
        "Received app-server response with no pending request",
        {
          id: response.id,
        },
      );
      return;
    }
    this.pendingRequests.delete(response.id);
    clearTimeout(pending.timeoutHandle);

    const pendingThreadStart =
      pending.method === "thread/start"
        ? this.getPendingThreadStartByRequestId(response.id)
        : null;

    if (response.error !== undefined) {
      if (pendingThreadStart) {
        this.removePendingThreadStartByRequestId(response.id);
      }
      pending.reject(
        new Error(
          `codex app-server request failed for ${pending.method}: ${extractErrorMessage(response.error)}`,
        ),
      );
      return;
    }

    if (pendingThreadStart) {
      const threadId = extractThreadIdFromThreadStartResult(response.result);
      if (threadId) {
        this.removePendingThreadStartByRequestId(response.id);
        this.ensureThreadState({
          threadId,
          threadChatId: pendingThreadStart.threadChatId,
        });
      }
    }
    pending.resolve(response.result);
  }

  private dispatchNotification(
    notification: JsonRpcNotificationEnvelope,
  ): void {
    const threadId = extractThreadIdFromParams(notification.params ?? {});
    if (
      notification.method === "thread/started" &&
      threadId &&
      !this.threadStates.has(threadId)
    ) {
      const pendingThreadStart = this.getSinglePendingThreadStart();
      if (pendingThreadStart) {
        this.removePendingThreadStartByRequestId(pendingThreadStart.requestId);
        this.threadStates.set(threadId, {
          threadChatId: pendingThreadStart.threadChatId,
          parserState: createCodexParserState(),
        });
      } else {
        this.logger.warn(
          "Ignoring ambiguous thread/started notification without correlated request result",
          {
            threadId,
            pendingThreadStarts: this.pendingThreadStarts.length,
          },
        );
      }
    }
    const threadState = threadId
      ? (this.threadStates.get(threadId) ?? null)
      : null;

    for (const handler of this.notificationHandlers) {
      try {
        handler(notification, {
          threadId,
          threadState,
        });
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Unknown notification handler error";
        this.logger.error("codex app-server notification handler failed", {
          error: message,
          method: notification.method,
          threadId,
        });
      }
    }
  }

  private rejectPendingRequests(error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeoutHandle);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  private getPendingThreadStartByRequestId(
    requestId: number,
  ): PendingThreadStart | null {
    const pendingThreadStart =
      this.pendingThreadStarts.find((entry) => entry.requestId === requestId) ??
      null;
    return pendingThreadStart;
  }

  private removePendingThreadStartByRequestId(
    requestId: number,
  ): PendingThreadStart | null {
    const pendingIndex = this.pendingThreadStarts.findIndex(
      (entry) => entry.requestId === requestId,
    );
    if (pendingIndex === -1) {
      return null;
    }
    const [pendingThreadStart] = this.pendingThreadStarts.splice(
      pendingIndex,
      1,
    );
    return pendingThreadStart ?? null;
  }

  private getSinglePendingThreadStart(): PendingThreadStart | null {
    if (this.pendingThreadStarts.length !== 1) {
      return null;
    }
    return this.pendingThreadStarts[0] ?? null;
  }

  private withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    const nextOperation = this.writeQueue.then(operation, operation);
    this.writeQueue = nextOperation.then(
      () => undefined,
      () => undefined,
    );
    return nextOperation;
  }

  private async writeJsonLine(payload: Record<string, unknown>): Promise<void> {
    if (this.transport === "websocket" && this.ws) {
      const data = JSON.stringify(payload);
      await this.withWriteLock(
        () =>
          new Promise<void>((resolve, reject) => {
            this.ws!.send(data, (error) => {
              if (error) {
                reject(error);
                return;
              }
              resolve();
            });
          }),
      );
      return;
    }

    const line = `${JSON.stringify(payload)}\n`;
    await this.withWriteLock(
      () =>
        new Promise<void>((resolve, reject) => {
          if (!this.process) {
            reject(new Error("codex app-server is not running"));
            return;
          }
          this.process.stdin.write(line, (error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        }),
    );
  }

  private async sendNotification({
    method,
    params,
  }: {
    method: string;
    params?: Record<string, unknown>;
  }): Promise<void> {
    await this.writeJsonLine({
      jsonrpc: "2.0",
      method,
      ...(params ? { params } : {}),
    });
  }

  private async sendRequestInternal(
    request: CodexAppServerRequest,
  ): Promise<unknown> {
    if (!this.process) {
      throw new Error("codex app-server is not running");
    }

    const timeoutMs = request.timeoutMs ?? this.requestTimeoutMs;
    const requestId = this.nextRequestId;
    this.nextRequestId += 1;

    if (request.method === "thread/start" && request.threadChatId) {
      this.pendingThreadStarts.push({
        requestId,
        threadChatId: request.threadChatId,
      });
    }

    const responsePromise = new Promise<unknown>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        this.removePendingThreadStartByRequestId(requestId);
        reject(
          new Error(
            `codex app-server request timed out after ${timeoutMs}ms: ${request.method}`,
          ),
        );
      }, timeoutMs);
      this.pendingRequests.set(requestId, {
        method: request.method,
        timeoutHandle,
        resolve,
        reject,
      });
    });

    try {
      await this.writeJsonLine({
        jsonrpc: "2.0",
        id: requestId,
        method: request.method,
        ...(request.params ? { params: request.params } : {}),
      });
    } catch (error) {
      const pendingRequest = this.pendingRequests.get(requestId);
      if (pendingRequest) {
        clearTimeout(pendingRequest.timeoutHandle);
        this.pendingRequests.delete(requestId);
      }
      this.removePendingThreadStartByRequestId(requestId);
      throw error;
    }

    return responsePromise;
  }

  private async connectWebSocket(): Promise<void> {
    const port = this.wsPort;
    if (port === undefined) {
      throw new Error("wsPort must be set before connecting WebSocket");
    }

    const url = `ws://127.0.0.1:${port}`;
    const startTime = Date.now();
    const timeout = this.handshakeTimeoutMs;

    // Poll /readyz until server is listening (bounded by timeout)
    while (Date.now() - startTime < timeout) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/readyz`);
        if (res.ok) break;
      } catch {
        // Server not ready yet
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    if (Date.now() - startTime >= timeout) {
      throw new Error(`codex app-server /readyz timeout after ${timeout}ms`);
    }

    // Connect WebSocket
    const ws = this.createWebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("WebSocket connect timeout")),
        timeout,
      );
      ws.on("open", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    ws.on("message", (data) => {
      const line = typeof data === "string" ? data : data.toString();
      this.handleIncomingMessage(line);
    });

    ws.on("close", () => {
      this.ws = null;
      this.ready = false;
      this.rejectPendingRequests(
        new Error("WebSocket connection closed unexpectedly"),
      );
    });

    ws.on("error", (error) => {
      this.logger.error("WebSocket error", { message: error.message });
    });

    this.ws = ws;
  }
}

async function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}
