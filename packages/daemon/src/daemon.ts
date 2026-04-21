import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { CanonicalEvent } from "@terragon/agent/canonical-events";
import { AIAgent, type AIModel, AIModelSchema } from "@terragon/agent/types";
import {
  coalesceAssistantTextMessages,
  parseAcpLineToClaudeMessages,
} from "./acp-adapter";
import { tryParseAcpAsCodexEvent } from "./acp-codex-adapter";
import { AgentFrontmatterReader } from "./agent-frontmatter";
import { ampCommand, getAmpApiKeyOrNull } from "./amp";
import {
  ClaudeCodeParser,
  claudeCommand,
  getAnthropicApiKeyOrNull,
  maybeFixLogsForSessionId,
} from "./claude";
import {
  buildThreadStartParams,
  buildTurnStartParams,
  CODEX_TURN_START_MAX_INPUT_CHARS,
  codexCommand,
  createCodexParserState,
  estimateTurnStartRequestSizeChars,
  parseCodexLine,
} from "./codex";
import {
  type CodexAppServerDiagnostics,
  type ThreadMetaEvent,
  CodexAppServerManager,
  extractMetaEvent,
  extractThreadEvent,
  SILENTLY_IGNORED_ITEM_TYPES,
} from "./codex-app-server";
import {
  createGeminiParserState,
  geminiCommand,
  parseGeminiLine,
} from "./gemini";
import {
  getOpencodeApiKeyOrNull,
  opencodeCommand,
  parseOpencodeLine,
} from "./opencode";
import { sanitizeRepoSkillFiles } from "./sanitize-skills";
import { DEFAULT_RETRY_CONFIG, RetryBackoff, RetryConfig } from "./retry";
import {
  DaemonServerPostError,
  IDaemonRuntime,
  writeToUnixSocket,
} from "./runtime";
import {
  ClaudeMessage,
  DAEMON_CAPABILITY_SDLC_SELF_DISPATCH,
  DAEMON_VERSION,
  DaemonDelta,
  DaemonEventAPIBody,
  DaemonMessage,
  DaemonMessageClaude,
  DaemonMessageSchema,
  DaemonTransportMode,
  FeatureFlags,
  SdlcSelfDispatchPayload,
} from "./shared";
import {
  createIdleWatchdog,
  IdleWatchdog,
  killProcessGroup,
  MessageBufferEntry,
} from "./utils";

const DAEMON_EVENT_CLAIM_IN_PROGRESS_RETRY_MS = 5_000;
const ACP_SSE_RECONNECT_DELAY_MS = 150;
const ACP_SSE_MAX_CONSECUTIVE_FAILURES = 50;
const ACP_SSE_STARTUP_GRACE_MS = 60_000;
const ACP_SSE_STARTUP_404_BACKOFF_MS = 400;
const ACP_REQUEST_TIMEOUT_MS = 120_000;
const ACP_SSE_INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000; // 10 min of SSE silence
const ACP_INACTIVITY_CHECK_INTERVAL_MS = 30_000; // check every 30s
const ACP_TERMINAL_QUIESCENCE_MS = 300;
const ACP_TERMINAL_MAX_WAIT_MS = 2_500;
const ACP_POST_INIT_INTERNAL_ERROR_GRACE_MS = 90_000;
const ACP_POST_INIT_INTERNAL_ERROR_SUPPRESS_LIMIT = 5;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const APP_SERVER_TURN_WATCHDOG_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
const APP_SERVER_INTERRUPT_TIMEOUT_MS = 30_000;
const APP_SERVER_RESPAWN_WINDOW_MS = 60_000;
const APP_SERVER_MAX_RESPAWNS_PER_WINDOW = 3;
const APP_SERVER_RESPAWN_BASE_DELAY_MS = 1_000;

type AcpRequestEnvelope = {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
};

type AcpResponseEnvelope = {
  jsonrpc?: unknown;
  id?: unknown;
  result?: unknown;
  error?: unknown;
};

class AcpSseHttpError extends Error {
  constructor(
    readonly status: number,
    readonly statusText: string,
  ) {
    super(`ACP SSE failed (${status} ${statusText})`);
    this.name = "AcpSseHttpError";
  }
}

function formatError(error: unknown): object {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.cause ? { cause: error.cause } : {}),
    };
  }
  return { value: error };
}

function formatAppServerDiagnostics(
  diagnostics: CodexAppServerDiagnostics,
): string {
  return [
    `lastRequestMethod=${diagnostics.lastRequestMethod ?? "null"}`,
    `lastExitCode=${diagnostics.lastExitCode ?? "null"}`,
    `lastExitSignal=${diagnostics.lastExitSignal ?? "null"}`,
    `lastExitSource=${diagnostics.lastExitSource ?? "null"}`,
    `lastStderrLine=${diagnostics.lastStderrLine ?? "null"}`,
    `lastProcessError=${diagnostics.lastProcessError ?? "null"}`,
  ].join(", ");
}

function isDaemonEventClaimInProgressError(error: unknown): boolean {
  if (error instanceof DaemonServerPostError) {
    return (
      error.status === 409 &&
      error.errorCode === "daemon_event_claim_in_progress"
    );
  }

  if (!error || typeof error !== "object") {
    return false;
  }
  if (!("status" in error) || !("errorCode" in error)) {
    return false;
  }

  const status = (error as { status?: unknown }).status;
  const errorCode = (error as { errorCode?: unknown }).errorCode;
  return status === 409 && errorCode === "daemon_event_claim_in_progress";
}

/**
 * Detect permanent auth errors that should NOT be retried.
 * A 401 with daemon_token_claims_required means the token is invalid
 * and retrying won't help — the daemon needs a fresh token from the server.
 */
function isNonRetryableAuthError(error: unknown): boolean {
  if (error instanceof DaemonServerPostError) {
    return error.status === 401 || error.status === 403;
  }
  if (!error || typeof error !== "object" || !("status" in error)) {
    return false;
  }
  const status = (error as { status?: unknown }).status;
  return status === 401 || status === 403;
}

function toRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readString(
  value: Record<string, unknown> | null,
  key: string,
): string | null {
  if (!value) {
    return null;
  }
  const keyValue = value[key];
  return typeof keyValue === "string" ? keyValue : null;
}

function readBoolean(
  value: Record<string, unknown> | null,
  key: string,
): boolean | null {
  if (!value) {
    return null;
  }
  const keyValue = value[key];
  return typeof keyValue === "boolean" ? keyValue : null;
}

function stringifyCanonicalToolResult(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === undefined) {
    return "";
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function extractThreadIdFromRpcResult(result: unknown): string | null {
  const resultRecord = toRecord(result);
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
  if (!threadRecord) {
    return null;
  }
  return (
    readString(threadRecord, "id") ??
    readString(threadRecord, "threadId") ??
    readString(threadRecord, "thread_id")
  );
}

function extractCodexPreviousResponseIdFromParams(
  params: Record<string, unknown>,
): string | null {
  const turnRecord = toRecord(params.turn);
  const responseRecord =
    toRecord(turnRecord?.response) ?? toRecord(params.response);
  const resultRecord = toRecord(params.result);
  const previousResponseId =
    readString(responseRecord, "id") ??
    readString(resultRecord, "id") ??
    readString(turnRecord, "id") ??
    readString(turnRecord, "response_id") ??
    readString(turnRecord, "responseId") ??
    readString(params, "response_id") ??
    readString(params, "responseId") ??
    readString(params, "previous_response_id") ??
    readString(params, "previousResponseId") ??
    readString(params, "id");
  return previousResponseId;
}

function isThreadResumeRpcError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.message.includes("request failed for thread/resume");
}

function isTurnInterruptedFromParams(params: Record<string, unknown>): boolean {
  const turnRecord = toRecord(params.turn);
  const status =
    readString(turnRecord, "status") ??
    readString(turnRecord, "completionStatus") ??
    readString(params, "status");
  return typeof status === "string" && status.toLowerCase() === "interrupted";
}

function extractTurnFailureMessage(params: Record<string, unknown>): string {
  const errorRecord =
    toRecord(params.error) ?? toRecord(toRecord(params.turn)?.error);
  const message =
    readString(errorRecord, "message") ??
    readString(params, "message") ??
    "Codex turn failed";
  return message;
}

type ActiveProcessState = {
  agent: AIAgent;
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
  /** AbortController for ACP transport — signals SSE loop and unblocks Promise.race on stop. */
  acpAbortController: AbortController | null;
  /** Unique ID for this run, used to guard cleanup against race conditions with overlapping runs. */
  runId: string;
  /** Pending ACP permission requests awaiting user approval (plan mode only). */
  pendingPermissions: Map<string, { acpRequestId: unknown }>;
  /** The ACP server URL, set when the ACP connection is established. */
  acpUrl: string | null;
  /** Idle watchdog reference, used by heartbeat to reset timeout. */
  watchdog: IdleWatchdog | null;
};

type AppServerTurnCompletion = {
  status: "completed" | "failed" | "interrupted";
  codexPreviousResponseId: string | null;
  errorMessage: string | null;
};

type AppServerRunContext = {
  threadChatId: string;
  daemonThreadId: string;
  token: string;
  manager: CodexAppServerManager;
  startTime: number;
  threadId: string | null;
  isStopping: boolean;
  isCompleted: boolean;
  watchdogTriggered: boolean;
  turnCompletePromise: Promise<AppServerTurnCompletion>;
  threadReadyPromise: Promise<string>;
  watchdogTimer: NodeJS.Timeout | null;
  /** Last full agent_message text by item id (for cumulative update dedupe). */
  agentMessageTextById: Map<string, string>;
  /**
   * Most recent non-empty diff from `turn/diff/updated`. Held across
   * intermediate updates and flushed as a single `codex-diff` ClaudeMessage
   * when the turn completes, so N file edits produce ONE DBDiffPart.
   */
  pendingTurnDiff: string | null;
  resolveTurnComplete: (result: AppServerTurnCompletion) => void;
  rejectTurnComplete: (error: Error) => void;
  resolveThreadReady: (threadId: string) => void;
};

type DaemonEventRunState = {
  runId: string;
  nextSeq: number;
  nextCanonicalSeq: number;
  nextDeltaSeq: number;
  agent: AIAgent | null;
  model: string | null;
  transportMode: DaemonTransportMode;
  protocolVersion: number;
  acpServerId: string | null;
  acpSessionId: string | null;
  canonicalRunStartedEmitted: boolean;
  cleanupRequested: boolean;
  pendingEnvelope: {
    messagesFingerprint: string;
    eventId: string;
    seq: number;
    entryCount: number;
    canonicalEvents: CanonicalEvent[];
    nextCanonicalSeqAfterBatch: number;
    canonicalRunStartedEmittedAfterBatch: boolean;
  } | null;
};

type DaemonEventEnvelopePayload = {
  payloadVersion: 2;
  eventId: string;
  runId: string;
  seq: number;
};

export class TerragonDaemon {
  private startTime: number = 0;
  private messageBuffer: MessageBufferEntry[] = [];
  private deltaBuffer: Array<
    DaemonDelta & { threadId: string; threadChatId: string; token: string }
  > = [];
  /**
   * Queued meta events to be sent on the next daemon-event POST.  Meta events
   * are piggybacked on the existing `/api/daemon-event` endpoint via the
   * optional `metaEvents` field in `DaemonEventAPIBody`, so no new endpoint
   * is required.  They are fire-and-forget: logged and dropped on flush error.
   */
  private metaEventBuffer: Array<{
    metaEvent: ThreadMetaEvent;
    threadId: string;
    threadChatId: string;
    token: string;
  }> = [];
  private runtime: IDaemonRuntime;
  private mcpConfigPath: string | undefined;

  private activeProcesses: Map<string, ActiveProcessState> = new Map();
  private appServerRunContexts: Map<string, AppServerRunContext> = new Map();
  private heartbeatTimers: Map<string, NodeJS.Timeout> = new Map();
  private daemonEventRunStates: Map<string, DaemonEventRunState> = new Map();
  private appServerCrashTimestamps: number[] = [];
  private launchedSelfDispatchRunIds: Set<string> = new Set();

  private messageHandleDelay: number = 0;
  private messageFlushDelay: number = 0;
  private messageFlushTimer: NodeJS.Timeout | null = null;
  private uptimeReportingInterval: number = 0;
  private uptimeReportingTimer: NodeJS.Timeout | null = null;
  private isFlushInProgress: boolean = false;
  private pendingFlushRequired: boolean = false;
  private retryBackoffs: Map<string, RetryBackoff> = new Map();
  private retryConfig: RetryConfig;

  private featureFlags: FeatureFlags = {} as FeatureFlags;
  private agentFrontmatterReader: AgentFrontmatterReader;

  constructor({
    messageFlushDelay = 33,
    messageHandleDelay = 100,
    uptimeReportingInterval = 5000,
    runtime,
    retryConfig = DEFAULT_RETRY_CONFIG,
    mcpConfigPath,
  }: {
    messageFlushDelay?: number;
    messageHandleDelay?: number;
    uptimeReportingInterval?: number;
    runtime: IDaemonRuntime;
    retryConfig?: RetryConfig;
    mcpConfigPath?: string;
  }) {
    this.startTime = performance.now();
    this.runtime = runtime;
    this.messageHandleDelay = messageHandleDelay;
    this.messageFlushDelay = messageFlushDelay;
    this.uptimeReportingInterval = uptimeReportingInterval;
    this.retryConfig = retryConfig;
    this.mcpConfigPath = mcpConfigPath;
    this.agentFrontmatterReader = new AgentFrontmatterReader(runtime);

    // Load feature flags from environment variable if available
    const envFeatureFlags = process.env.TERRAGON_FEATURE_FLAGS;
    if (envFeatureFlags) {
      try {
        this.featureFlags = JSON.parse(envFeatureFlags);
        this.runtime.logger.info("Feature flags loaded from environment", {
          featureFlags: this.featureFlags,
        });
      } catch (error) {
        this.runtime.logger.error(
          "Failed to parse feature flags from environment",
          {
            error: formatError(error),
            envFeatureFlags,
          },
        );
      }
    }
  }

  private getRetryBackoff(threadChatId: string): RetryBackoff {
    let backoff = this.retryBackoffs.get(threadChatId);
    if (!backoff) {
      backoff = new RetryBackoff(this.retryConfig);
      this.retryBackoffs.set(threadChatId, backoff);
    }
    return backoff;
  }

  /**
   * Initialize and start the daemon
   */
  async start(): Promise<void> {
    this.runtime.logger.info("🚀 Starting Terragon Daemon...");
    this.runtime.logger.info("Daemon version", {
      version: DAEMON_VERSION,
    });
    this.runtime.logger.info("Server URL configured", {
      url: this.runtime.url,
    });
    this.runtime.logger.info("Unix socket configured", {
      unixSocketPath: this.runtime.unixSocketPath,
    });
    this.runtime.logger.info("MCP config path configured", {
      mcpConfigPath: this.mcpConfigPath ?? null,
    });

    // Load agent frontmatter
    await this.agentFrontmatterReader.loadAgents();

    // Start listening to the unix socket
    await this.runtime.listenToUnixSocket(
      this.handleUnixSocketMessage.bind(this),
    );
    this.runtime.logger.info(
      "✅ Daemon started successfully, waiting for messages...",
    );

    // Log every 5 seconds
    this.uptimeReportingTimer = setInterval(() => {
      const uptime = Math.round((performance.now() - this.startTime) / 1000);
      this.runtime.logger.info("Daemon Heartbeat", {
        uptime: `${uptime}s`,
      });
    }, this.uptimeReportingInterval);
    // // Graceful shutdown handling
    this.runtime.onTeardown(this.teardown.bind(this));
  }

  private getCurrentTimezone(): string {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch (error) {
      this.runtime.logger.error(
        "Failed to get current timezone. Falling back to UTC.",
        { error: formatError(error) },
      );
      return "UTC";
    }
  }

  /**
   * Handle incoming message from the unix socket
   */
  private async handleUnixSocketMessage(message: string): Promise<void> {
    let parsedMessage: DaemonMessage | null = null;
    try {
      this.runtime.logger.info("Received unix socket message", { message });
      const jsonObj = JSON.parse(message);
      parsedMessage = DaemonMessageSchema.parse(jsonObj);
    } catch (error) {
      this.runtime.logger.error("Failed to parse unix socket message", {
        error: formatError(error),
      });
      throw error;
    }
    if (!parsedMessage) {
      this.runtime.logger.error("Failed to parse unix socket message", {
        message,
      });
      throw new Error("Failed to parse unix socket message");
    }
    // Process the message so we acknowledge the unix socket message
    // first.
    setTimeout(() => {
      switch (parsedMessage.type) {
        case "kill": {
          this.killAllActiveProcesses();
          if (process.env.NODE_ENV !== "test") {
            process.exit(0);
          }
          break;
        }
        case "stop": {
          const appServerRun = this.appServerRunContexts.get(
            parsedMessage.threadChatId,
          );
          if (appServerRun) {
            this.runtime.logger.info(
              "Stop message received, interrupting codex app-server turn...",
              { threadChatId: parsedMessage.threadChatId },
            );
            void this.stopAppServerTurn({
              threadId: parsedMessage.threadId,
              threadChatId: parsedMessage.threadChatId,
              token: parsedMessage.token,
              includeStopMessage: true,
            }).catch((error) => {
              this.runtime.logger.error("Failed to stop app-server turn", {
                threadChatId: parsedMessage.threadChatId,
                error: formatError(error),
              });
            });
            break;
          }

          this.runtime.logger.info(
            "Stop message received, killing specific process...",
            { threadChatId: parsedMessage.threadChatId },
          );
          const processDurationMs = this.getProcessDurationMs(
            parsedMessage.threadChatId,
          );
          const processToStop = this.activeProcesses.get(
            parsedMessage.threadChatId,
          );
          if (processToStop) {
            this.updateActiveProcessState(parsedMessage.threadChatId, {
              isStopping: true,
            });
            this.killActiveProcess(parsedMessage.threadChatId);
          } else {
            this.runtime.logger.warn(
              "Stop message received but no process found for threadChatId",
              { threadChatId: parsedMessage.threadChatId },
            );
          }
          this.markDaemonEventRunStateForCleanup(parsedMessage.threadChatId);
          this.addMessageToBuffer({
            agent: null,
            message: {
              type: "custom-stop",
              session_id: null,
              duration_ms: processDurationMs,
            },
            threadId: parsedMessage.threadId,
            threadChatId: parsedMessage.threadChatId,
            token: parsedMessage.token,
          });
          this.flushMessageBuffer();
          break;
        }
        case "ping": {
          this.runtime.logger.info("Ping message received");
          break;
        }
        case "permission-response": {
          this.runtime.logger.info("Permission response received", {
            promptId: parsedMessage.promptId,
            optionId: parsedMessage.optionId,
            threadChatId: parsedMessage.threadChatId,
          });

          const processState = this.activeProcesses.get(
            parsedMessage.threadChatId,
          );
          const pending = processState?.pendingPermissions?.get(
            parsedMessage.promptId,
          );
          if (!pending) {
            this.runtime.logger.warn("No pending permission found", {
              promptId: parsedMessage.promptId,
            });
            break;
          }

          // POST approval/denial to ACP server
          const acpUrl = processState?.acpUrl;
          if (acpUrl) {
            fetch(acpUrl, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
              },
              body: JSON.stringify({
                jsonrpc: "2.0",
                id: pending.acpRequestId,
                result: { optionId: parsedMessage.optionId },
              }),
            }).catch((err) => {
              this.runtime.logger.error("Permission response POST failed", {
                error: formatError(err),
              });
            });
          }

          processState!.pendingPermissions.delete(parsedMessage.promptId);

          // Emit synthetic tool result so UI shows resolution
          this.addMessageToBuffer({
            agent: null,
            message: {
              type: "user",
              session_id: "",
              parent_tool_use_id: null,
              message: {
                role: "user",
                content: [
                  {
                    type: "tool_result",
                    tool_use_id: parsedMessage.promptId,
                    content:
                      parsedMessage.optionId === "approved"
                        ? "Permission granted"
                        : "Permission denied",
                    is_error: parsedMessage.optionId !== "approved",
                  },
                ],
              },
            },
            threadId: parsedMessage.threadId,
            threadChatId: parsedMessage.threadChatId,
            token: parsedMessage.token,
          });
          this.flushMessageBuffer();
          break;
        }
        case "claude": {
          this.runCommand(parsedMessage).catch((error) => {
            this.runtime.logger.error("Failed to run command", {
              error: formatError(error),
            });
          });
          break;
        }
        default: {
          const _exhaustiveCheck: never = parsedMessage;
          this.runtime.logger.error("Unknown message type", {
            msg: _exhaustiveCheck,
          });
          break;
        }
      }
    }, this.messageHandleDelay);
  }

  private killActiveProcess(threadChatId: string) {
    // Kill specific process
    const activeProcessState = this.activeProcesses.get(threadChatId);
    if (activeProcessState) {
      const processId = activeProcessState?.processId;
      if (processId) {
        this.runtime.logger.info("Killing active process", {
          pid: processId,
          threadChatId,
        });
        killProcessGroup(this.runtime, processId);
      }
      // Abort ACP transport (SSE loop + unblock Promise.race)
      if (activeProcessState.acpAbortController) {
        this.runtime.logger.info("Aborting ACP transport", { threadChatId });
        activeProcessState.acpAbortController.abort();
      }
      // Clean up polling interval to prevent memory leaks
      if (activeProcessState.pollInterval) {
        this.runtime.logger.info("Clearing polling interval", {
          pid: processId,
          threadChatId,
        });
        clearInterval(activeProcessState.pollInterval);
      }
      if (
        activeProcessState.agent === "claudeCode" &&
        activeProcessState.sessionId
      ) {
        this.runtime.logger.info("Cleaning up claude session logs", {
          session: activeProcessState.sessionId,
        });
        maybeFixLogsForSessionId(this.runtime, activeProcessState.sessionId);
      }
      this.stopHeartbeat(threadChatId);
      this.activeProcesses.delete(threadChatId);
      this.markDaemonEventRunStateForCleanup(threadChatId);
    }
  }

  private killAllActiveProcesses() {
    for (const threadChatId of this.activeProcesses.keys()) {
      this.killActiveProcess(threadChatId);
    }
    for (const threadChatId of this.appServerRunContexts.keys()) {
      const context = this.appServerRunContexts.get(threadChatId);
      if (!context) {
        continue;
      }
      context.isStopping = true;
      context.rejectTurnComplete(
        new Error("Codex app-server turn stopped during daemon shutdown"),
      );
      this.clearAppServerWatchdog(context);
      this.stopHeartbeat(threadChatId);
      this.markDaemonEventRunStateForCleanup(threadChatId);
      void context.manager.kill().catch((error) => {
        this.runtime.logger.error("Failed to kill codex app-server", {
          threadChatId,
          error: formatError(error),
        });
      });
    }
    this.appServerRunContexts.clear();
  }

  private initializeDaemonEventRunStateForNewRun({
    input,
  }: {
    input: DaemonMessageClaude;
  }): void {
    const existing = this.daemonEventRunStates.get(input.threadChatId);
    if (existing?.pendingEnvelope) {
      existing.agent = input.agent;
      existing.model = input.model;
      existing.cleanupRequested = false;
      this.daemonEventRunStates.set(input.threadChatId, existing);
      return;
    }
    this.daemonEventRunStates.set(input.threadChatId, {
      runId: input.runId ?? randomUUID(),
      nextSeq: 0,
      nextCanonicalSeq: 0,
      nextDeltaSeq: 0,
      agent: input.agent,
      model: input.model,
      transportMode: input.transportMode ?? "legacy",
      protocolVersion: input.protocolVersion ?? 1,
      acpServerId: input.acpServerId ?? null,
      acpSessionId: input.acpSessionId ?? null,
      canonicalRunStartedEmitted: false,
      cleanupRequested: false,
      pendingEnvelope: null,
    });
  }

  private startSelfDispatchRun(params: {
    payload: SdlcSelfDispatchPayload;
    originalThreadChatId: string;
  }): void {
    const { payload, originalThreadChatId } = params;
    if (this.launchedSelfDispatchRunIds.has(payload.runId)) {
      this.runtime.logger.info(
        "Delivery Loop self-dispatch: skipping duplicate follow-up run",
        {
          threadId: payload.threadId,
          threadChatId: payload.threadChatId,
          runId: payload.runId,
        },
      );
      return;
    }
    if (this.activeProcesses.has(originalThreadChatId)) {
      this.runtime.logger.warn(
        "Delivery Loop self-dispatch skipped: active process exists",
        { threadChatId: originalThreadChatId },
      );
      return;
    }
    this.launchedSelfDispatchRunIds.add(payload.runId);
    const syntheticInput: DaemonMessageClaude = {
      type: "claude",
      token: payload.token,
      prompt: payload.prompt,
      model: payload.model,
      agent: payload.agent,
      agentVersion: payload.agentVersion,
      sessionId: payload.sessionId,
      featureFlags: payload.featureFlags,
      permissionMode: payload.permissionMode,
      transportMode: payload.transportMode,
      protocolVersion: payload.protocolVersion,
      threadId: payload.threadId,
      threadChatId: payload.threadChatId,
      runId: payload.runId,
      useCredits: payload.useCredits,
    };
    this.runtime.logger.info(
      "Delivery Loop self-dispatch: starting follow-up run",
      {
        threadId: payload.threadId,
        threadChatId: payload.threadChatId,
        runId: payload.runId,
      },
    );
    this.runCommand(syntheticInput).catch(async (error) => {
      this.runtime.logger.error("Delivery Loop self-dispatch failed", {
        error: formatError(error),
        runId: payload.runId,
        threadChatId: payload.threadChatId,
      });
      this.addMessageToBuffer({
        agent: payload.agent,
        message: {
          type: "custom-error",
          session_id: null,
          duration_ms: 0,
          error_info:
            error instanceof Error
              ? `Delivery Loop self-dispatch failed: ${error.message}`
              : "Delivery Loop self-dispatch failed",
        },
        threadId: payload.threadId,
        threadChatId: payload.threadChatId,
        token: payload.token,
      });
      await this.flushMessageBuffer();
    });
  }

  private async runCommand(input: DaemonMessageClaude): Promise<void> {
    // Store feature flags if provided
    if (input.featureFlags) {
      this.featureFlags = input.featureFlags;
      this.runtime.logger.info("Feature flags updated", {
        featureFlags: this.featureFlags,
      });
    }
    // Always advertise SDLC self-dispatch capability
    this.runtime.additionalCapabilities?.add(
      DAEMON_CAPABILITY_SDLC_SELF_DISPATCH,
    );
    // Kill any existing process for this threadChatId
    this.killActiveProcess(input.threadChatId);
    await this.stopAppServerTurn({
      threadId: input.threadId,
      threadChatId: input.threadChatId,
      token: input.token,
      includeStopMessage: false,
    });
    const bufferedBefore = this.messageBuffer.length;
    this.messageBuffer = this.messageBuffer.filter(
      (entry) => entry.threadChatId !== input.threadChatId,
    );
    if (this.messageBuffer.length !== bufferedBefore) {
      this.runtime.logger.warn(
        "Dropped buffered daemon messages from previous run before starting new run",
        {
          threadChatId: input.threadChatId,
          droppedEntries: bufferedBefore - this.messageBuffer.length,
        },
      );
      this.clearPendingDaemonEventEnvelope(input.threadChatId);
    }
    this.initializeDaemonEventRunStateForNewRun({
      input,
    });
    if (input.transportMode === "codex-app-server") {
      if (input.agent !== "codex") {
        throw new Error(
          `codex-app-server transport is only supported for codex agent, received ${input.agent}`,
        );
      }
      await this.runAppServerCommand(input);
      return;
    }
    // Create new process state for this threadChatId
    const runId = input.runId ?? randomUUID();
    const newProcessState: ActiveProcessState = {
      processId: undefined,
      agent: input.agent,
      sessionId: null,
      startTime: Date.now(),
      stderr: [],
      isStopping: false,
      isCompleted: false,
      isWorking: false,
      threadId: input.threadId,
      threadChatId: input.threadChatId,
      token: input.token,
      pollInterval: null,
      acpAbortController: null,
      runId,
      pendingPermissions: new Map(),
      acpUrl: null,
      watchdog: null,
    };
    this.activeProcesses.set(input.threadChatId, newProcessState);
    this.startHeartbeat(input.threadChatId);
    if (input.transportMode === "acp") {
      try {
        await this.runAcpTransportCommand(input);
      } catch (error) {
        // Clean up if runAcpTransportCommand threw before its inner try/finally
        if (this.activeProcesses.has(input.threadChatId)) {
          this.activeProcesses.delete(input.threadChatId);
        }
        throw error;
      }
      return;
    }
    switch (input.agent) {
      case "claudeCode":
        await this.runClaudeCodeCommand(input);
        break;
      case "amp":
        await this.runAmpCommand(input);
        break;
      case "codex":
        await this.runCodexCommand(input);
        break;
      case "gemini":
        await this.runGeminiCommand(input);
        break;
      case "opencode":
        await this.runOpencodeCommand(input);
        break;
      default: {
        // This ensures we handle all model types exhaustively
        const _exhaustiveCheck: never = input.agent;
        this.runtime.logger.error("Unknown agent", {
          agent: _exhaustiveCheck,
          agentVersion: input.agentVersion,
          model: input.model,
        });
        throw new Error(`Unknown agent: ${input.agent}`);
      }
    }
  }

  private createAppServerRunContext({
    input,
    manager,
  }: {
    input: DaemonMessageClaude;
    manager: CodexAppServerManager;
  }): AppServerRunContext {
    let resolveTurnCompleteBase!: (result: AppServerTurnCompletion) => void;
    let rejectTurnCompleteBase!: (error: Error) => void;
    const turnCompletePromise = new Promise<AppServerTurnCompletion>(
      (resolve, reject) => {
        resolveTurnCompleteBase = resolve;
        rejectTurnCompleteBase = (error) => reject(error);
      },
    );

    let resolveThreadReadyBase!: (threadId: string) => void;
    const threadReadyPromise = new Promise<string>((resolve) => {
      resolveThreadReadyBase = resolve;
    });

    let threadReadyResolved = false;
    const context: AppServerRunContext = {
      threadChatId: input.threadChatId,
      daemonThreadId: input.threadId,
      token: input.token,
      manager,
      startTime: Date.now(),
      threadId: null,
      isStopping: false,
      isCompleted: false,
      watchdogTriggered: false,
      turnCompletePromise,
      threadReadyPromise,
      watchdogTimer: null,
      agentMessageTextById: new Map<string, string>(),
      pendingTurnDiff: null,
      resolveTurnComplete: (result) => {
        if (context.isCompleted) {
          return;
        }
        context.isCompleted = true;
        resolveTurnCompleteBase(result);
      },
      rejectTurnComplete: (error) => {
        if (context.isCompleted) {
          return;
        }
        context.isCompleted = true;
        rejectTurnCompleteBase(error);
      },
      resolveThreadReady: (threadId) => {
        if (threadReadyResolved) {
          return;
        }
        threadReadyResolved = true;
        resolveThreadReadyBase(threadId);
      },
    };
    return context;
  }

  private getAppServerWatchdogTimeoutMs(): number {
    if (process.env.IDLE_TIMEOUT_MS) {
      const timeoutMs = Number(process.env.IDLE_TIMEOUT_MS);
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        return timeoutMs;
      }
    }
    return APP_SERVER_TURN_WATCHDOG_TIMEOUT_MS;
  }

  private clearAppServerWatchdog(context: AppServerRunContext): void {
    if (context.watchdogTimer) {
      clearTimeout(context.watchdogTimer);
      context.watchdogTimer = null;
    }
  }

  private normalizeAppServerMessageSessionId({
    message,
    threadId,
  }: {
    message: ClaudeMessage;
    threadId: string;
  }): ClaudeMessage {
    if (
      "session_id" in message &&
      typeof message.session_id === "string" &&
      message.session_id.length === 0
    ) {
      return {
        ...message,
        session_id: threadId,
      };
    }
    return message;
  }

  private resolveAppServerThread({
    context,
    manager,
    threadId,
  }: {
    context: AppServerRunContext;
    manager: CodexAppServerManager;
    threadId: string;
  }): void {
    context.threadId = threadId;
    context.resolveThreadReady(threadId);
    manager.ensureThreadState({
      threadId,
      threadChatId: context.threadChatId,
    });
  }

  private async sendAppServerTurnInterrupt({
    manager,
    threadId,
    threadChatId,
  }: {
    manager: CodexAppServerManager;
    threadId: string;
    threadChatId: string;
  }): Promise<void> {
    await manager.send({
      method: "turn/interrupt",
      threadChatId,
      timeoutMs: APP_SERVER_INTERRUPT_TIMEOUT_MS,
      params: {
        threadId,
        thread_id: threadId,
      },
    });
  }

  private resetAppServerWatchdog({
    context,
    input,
    manager,
  }: {
    context: AppServerRunContext;
    input: DaemonMessageClaude;
    manager: CodexAppServerManager;
  }): void {
    if (context.isStopping || context.isCompleted) {
      return;
    }
    this.clearAppServerWatchdog(context);
    const timeoutMs = this.getAppServerWatchdogTimeoutMs();
    context.watchdogTimer = setTimeout(() => {
      if (context.isStopping || context.isCompleted) {
        return;
      }
      context.watchdogTriggered = true;
      this.runtime.logger.warn(
        "Codex app-server turn idle timeout reached, interrupting turn",
        {
          threadChatId: input.threadChatId,
          timeoutMs,
          threadId: context.threadId,
        },
      );
      const threadId = context.threadId;
      if (!threadId) {
        context.rejectTurnComplete(
          new Error("Codex app-server watchdog timeout before thread id ready"),
        );
        return;
      }
      void this.sendAppServerTurnInterrupt({
        manager,
        threadId,
        threadChatId: input.threadChatId,
      })
        .catch((error) => {
          this.runtime.logger.error(
            "Failed to interrupt codex app-server turn after watchdog timeout",
            {
              threadChatId: input.threadChatId,
              threadId,
              error: formatError(error),
            },
          );
        })
        .finally(() => {
          this.clearAppServerWatchdog(context);
          context.watchdogTimer = setTimeout(() => {
            if (context.isCompleted || context.isStopping) {
              return;
            }
            this.runtime.logger.warn(
              "Codex app-server did not acknowledge watchdog interrupt in time; forcing restart",
              {
                threadChatId: input.threadChatId,
                threadId,
              },
            );
            context.rejectTurnComplete(
              new Error(
                "Codex app-server turn timed out and did not complete after interrupt",
              ),
            );
            void manager.kill().catch((error) => {
              this.runtime.logger.error(
                "Failed to kill codex app-server after watchdog timeout",
                {
                  error: formatError(error),
                },
              );
            });
          }, APP_SERVER_INTERRUPT_TIMEOUT_MS);
        });
    }, timeoutMs);
  }

  private pruneAppServerCrashWindow(now: number = Date.now()): void {
    this.appServerCrashTimestamps = this.appServerCrashTimestamps.filter(
      (timestamp) => now - timestamp <= APP_SERVER_RESPAWN_WINDOW_MS,
    );
  }

  private registerAppServerCrash(): number {
    const now = Date.now();
    this.pruneAppServerCrashWindow(now);
    this.appServerCrashTimestamps.push(now);
    this.pruneAppServerCrashWindow(now);
    return this.appServerCrashTimestamps.length;
  }

  private resetAppServerCrashHistory(): void {
    this.appServerCrashTimestamps = [];
  }

  private async applyAppServerRespawnBackoff(): Promise<void> {
    this.pruneAppServerCrashWindow();
    const crashCount = this.appServerCrashTimestamps.length;
    if (crashCount === 0) {
      return;
    }
    if (crashCount > APP_SERVER_MAX_RESPAWNS_PER_WINDOW) {
      throw new Error(
        `Codex app-server exceeded ${APP_SERVER_MAX_RESPAWNS_PER_WINDOW} respawns within ${APP_SERVER_RESPAWN_WINDOW_MS / 1000}s`,
      );
    }
    const delayMs = Math.min(
      10_000,
      APP_SERVER_RESPAWN_BASE_DELAY_MS * 2 ** (crashCount - 1),
    );
    await new Promise<void>((resolve) => {
      setTimeout(resolve, delayMs);
    });
  }

  private isAppServerCrashError(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }
    const lowerMessage = error.message.toLowerCase();
    return (
      lowerMessage.includes("codex app-server exited") ||
      lowerMessage.includes("codex app-server is not running")
    );
  }

  private hasAppServerConnection(manager: CodexAppServerManager): boolean {
    const candidate = manager as CodexAppServerManager & {
      hasOpenConnection?: () => boolean;
    };
    return candidate.hasOpenConnection?.() ?? true;
  }

  private async getOrCreateAppServerManager(
    input: DaemonMessageClaude,
  ): Promise<CodexAppServerManager> {
    return new CodexAppServerManager({
      logger: this.runtime.logger,
      model: input.model,
      useCredits: !!input.useCredits,
      daemonToken: input.token,
      transport: "websocket",
    });
  }

  private async stopAppServerTurn({
    threadId,
    threadChatId,
    token,
    includeStopMessage,
  }: {
    threadId: string;
    threadChatId: string;
    token: string;
    includeStopMessage: boolean;
  }): Promise<boolean> {
    const context = this.appServerRunContexts.get(threadChatId);
    if (!context) {
      return false;
    }
    if (context.isCompleted) {
      return true;
    }

    context.isStopping = true;
    this.clearAppServerWatchdog(context);

    if (context.threadId) {
      try {
        await this.sendAppServerTurnInterrupt({
          manager: context.manager,
          threadId: context.threadId,
          threadChatId,
        });
      } catch (error) {
        this.runtime.logger.warn(
          "Failed to send app-server turn interrupt during stop",
          {
            threadChatId,
            threadId: context.threadId,
            error: formatError(error),
          },
        );
      }
    } else {
      context.rejectTurnComplete(
        new Error("Stop requested before codex app-server thread started"),
      );
    }

    await Promise.race([
      context.turnCompletePromise.catch(() => undefined),
      new Promise<void>((resolve) => {
        setTimeout(resolve, APP_SERVER_INTERRUPT_TIMEOUT_MS);
      }),
    ]);

    if (!context.isCompleted) {
      context.rejectTurnComplete(
        new Error("Stop timeout waiting for codex app-server turn completion"),
      );
      await context.manager.kill().catch((error) => {
        this.runtime.logger.error(
          "Failed to kill codex app-server after stop timeout",
          {
            threadChatId,
            error: formatError(error),
          },
        );
      });
    }

    this.markDaemonEventRunStateForCleanup(threadChatId);

    if (includeStopMessage) {
      const durationMs = this.getProcessDurationMs(threadChatId);
      this.addMessageToBuffer({
        agent: null,
        message: {
          type: "custom-stop",
          session_id: null,
          duration_ms: durationMs,
        },
        threadId,
        threadChatId,
        token,
      });
      await this.flushMessageBuffer();
    }

    return true;
  }

  private async runAppServerCommand(input: DaemonMessageClaude): Promise<void> {
    const manager = await this.getOrCreateAppServerManager(input);
    const context = this.createAppServerRunContext({ input, manager });
    this.appServerRunContexts.set(input.threadChatId, context);
    this.startHeartbeat(input.threadChatId);

    let removeNotificationHandler: (() => void) | null = null;
    let processHealthInterval: NodeJS.Timeout | null = null;
    const seenUnknownTypes = new Set<string>();

    try {
      // Update MCP config with current env vars so the MCP server subprocess
      // can reach the Terragon API (env vars change per dispatch).
      if (this.mcpConfigPath) {
        try {
          const raw = this.runtime.readFileSync(this.mcpConfigPath);
          const mcpConfig = JSON.parse(raw);
          if (mcpConfig?.mcpServers?.terry) {
            mcpConfig.mcpServers.terry.env = {
              ...mcpConfig.mcpServers.terry.env,
              TERRAGON_SERVER_URL: this.runtime.normalizedUrl,
              DAEMON_TOKEN: input.token,
              TERRAGON_THREAD_ID: input.threadId,
              TERRAGON_THREAD_CHAT_ID: input.threadChatId,
            };
            this.runtime.writeFileSync(
              this.mcpConfigPath,
              JSON.stringify(mcpConfig, null, 2),
            );
          }
        } catch {
          this.runtime.logger.warn(
            "Failed to update MCP config with env vars for app-server",
          );
        }
      }

      // Write env vars to a well-known file so the MCP server can read them
      // even when spawned by codex app-server (which reads ~/.codex/config.toml
      // and doesn't pass env vars from the JSON MCP config).
      try {
        this.runtime.writeFileSync(
          "/tmp/terragon-mcp-env.json",
          JSON.stringify({
            TERRAGON_SERVER_URL: this.runtime.normalizedUrl,
            DAEMON_TOKEN: input.token,
            TERRAGON_THREAD_ID: input.threadId,
            TERRAGON_THREAD_CHAT_ID: input.threadChatId,
          }),
        );
      } catch {
        this.runtime.logger.warn("Failed to write MCP env file for app-server");
      }

      // Pre-flight: disable skill files with broken YAML frontmatter before
      // Codex starts. Codex treats invalid skill YAML as fatal and crashes.
      sanitizeRepoSkillFiles(this.runtime.logger);

      await this.applyAppServerRespawnBackoff();
      await manager.restartIfTokenChanged(input.token);
      await manager.ensureReady();
      if (context.isStopping || context.isCompleted) {
        return;
      }

      removeNotificationHandler = manager.onNotification(
        (notification, notificationContext) => {
          const belongsToThread =
            notificationContext.threadState?.threadChatId ===
              input.threadChatId ||
            (context.threadId !== null &&
              notificationContext.threadId === context.threadId);
          if (!belongsToThread) {
            return;
          }

          // Dispatch meta events (token usage, rate limits, model re-routing,
          // MCP server health) on a separate channel before attempting to
          // extract a thread-chat event. Meta events are piggybacked on the
          // daemon-event POST body via a new `metaEvents` field so we don't
          // need a new HTTP endpoint.
          const metaEvent = extractMetaEvent(notification);
          if (metaEvent) {
            this.enqueueMetaEvent({
              metaEvent,
              threadId: input.threadId,
              threadChatId: input.threadChatId,
              token: input.token,
            });
            return;
          }

          const threadEvent = extractThreadEvent(notification);
          if (!threadEvent) {
            if (notification.method?.includes("item")) {
              const itemType = (
                notification.params?.item as Record<string, unknown> | undefined
              )?.type;
              if (
                typeof itemType !== "string" ||
                !SILENTLY_IGNORED_ITEM_TYPES.has(itemType)
              ) {
                const warnKey = `${notification.method}:${itemType}`;
                if (!seenUnknownTypes.has(warnKey)) {
                  seenUnknownTypes.add(warnKey);
                  this.runtime.logger.warn(
                    "Unknown Codex notification, skipping",
                    {
                      method: notification.method,
                      itemType,
                      threadId: input.threadId,
                    },
                  );
                }
              }
            }
            return;
          }

          // Synthetic-only events (turn diffs and plan snapshots) don't flow
          // through parseCodexLine. We emit them as dedicated ClaudeMessages
          // so chat history shows them on reload (the live stream already
          // updates the UI in flight).
          if (threadEvent.type === "turn.plan_updated") {
            const planEntries = normalizeCodexPlanEntries(threadEvent.plan);
            if (planEntries.length > 0) {
              this.addMessageToBuffer({
                agent: "codex",
                message: {
                  type: "codex-plan",
                  session_id: context.threadId ?? null,
                  entries: planEntries,
                },
                threadId: input.threadId,
                threadChatId: input.threadChatId,
                token: input.token,
              });
            }
            return;
          }
          if (threadEvent.type === "turn.diff_updated") {
            // Store the latest diff on the run context. Do NOT persist yet —
            // Codex fires this on every mutation, so a 5-file edit would
            // produce 5 DBDiffPart rows. We flush exactly one codex-diff
            // ClaudeMessage on turn.completed below using this stored value.
            context.pendingTurnDiff =
              threadEvent.diff && threadEvent.diff.length > 0
                ? threadEvent.diff
                : null;
            return;
          }

          if (threadEvent.type === "thread.started") {
            this.resolveAppServerThread({
              context,
              manager,
              threadId: threadEvent.thread_id,
            });
          } else if (notificationContext.threadId) {
            this.resolveAppServerThread({
              context,
              manager,
              threadId: notificationContext.threadId,
            });
          }

          const threadState =
            notificationContext.threadState ??
            (context.threadId
              ? manager.ensureThreadState({
                  threadId: context.threadId,
                  threadChatId: input.threadChatId,
                })
              : null);
          if (!threadState) {
            return;
          }

          // Intercept agentMessage deltas before they reach parseCodexLine.
          // Route them through the delta buffer for ephemeral streaming to
          // clients, then short-circuit to avoid persisting a DBMessage per
          // character-level accumulation.
          //
          // INVARIANT: this guard's `item.type === "agent_message"` check
          // MUST stay in sync with parseCodexLine's `agent_message` case
          // under `item.updated`. If codex-app-server ever renames this
          // item type, both branches must be updated atomically — otherwise
          // the parser's fall-through default path (which treats unknown
          // types as no-ops) will silently double-persist deltas via the
          // daemon's pass-through to parseCodexLine. A parser unit test
          // asserts the unknown-item-type default is a no-op so the
          // surface area of this invariant is explicit.
          if (
            threadEvent.type === "item.updated" &&
            threadEvent.item &&
            (threadEvent.item as Record<string, unknown>).type ===
              "agent_message"
          ) {
            const item = threadEvent.item as Record<string, unknown>;
            const itemId = item.id as string | undefined;
            const messageText = item.text as string | undefined;
            if (itemId && messageText) {
              const previousText =
                context.agentMessageTextById.get(itemId) ?? "";
              const isExplicitDeltaMethod =
                notification.method === "item/agentMessage/delta";
              const deltaText = isExplicitDeltaMethod
                ? messageText
                : messageText.startsWith(previousText)
                  ? messageText.slice(previousText.length)
                  : messageText;
              if (isExplicitDeltaMethod) {
                context.agentMessageTextById.set(
                  itemId,
                  previousText + messageText,
                );
              } else {
                context.agentMessageTextById.set(itemId, messageText);
              }
              if (deltaText) {
                this.enqueueDelta({
                  threadId: input.threadId,
                  threadChatId: input.threadChatId,
                  token: input.token,
                  messageId: itemId,
                  partIndex: 0,
                  kind: "text",
                  text: deltaText,
                });
              }
            }
            // Deltas were routed through the broadcast buffer above; skip
            // parseCodexLine for agent_message item.updated so we don't
            // also persist a DBMessage per character-level accumulation
            // (parseCodexLine now emits intermediate agent_message rows
            // for replay / test harnesses, but the production daemon
            // already streams deltas and persists the final item.completed).
            return;
          }

          // Route commandExecution/outputDelta through the delta buffer as
          // "text" kind so the client can stream command output progressively.
          if (
            threadEvent.type === "item.updated" &&
            notification.method === "item/commandExecution/outputDelta"
          ) {
            const item = threadEvent.item as Record<string, unknown>;
            const itemId = item?.id as string | undefined;
            const output = item?.aggregated_output as string | undefined;
            if (itemId && output) {
              this.enqueueDelta({
                threadId: input.threadId,
                threadChatId: input.threadChatId,
                token: input.token,
                messageId: itemId,
                partIndex: 0,
                kind: "text",
                text: output,
              });
            }
            // commandExecution/outputDelta is delta-only — don't pass to
            // parseCodexLine since there's no full item to persist yet.
            return;
          }

          // Route fileChange/outputDelta through the delta buffer as "text"
          // kind so the client can stream unified-diff output progressively.
          if (
            threadEvent.type === "item.updated" &&
            notification.method === "item/fileChange/outputDelta"
          ) {
            const item = threadEvent.item as Record<string, unknown>;
            const itemId = item?.id as string | undefined;
            const delta = item?._delta as string | undefined;
            if (itemId && delta) {
              this.enqueueDelta({
                threadId: input.threadId,
                threadChatId: input.threadChatId,
                token: input.token,
                messageId: itemId,
                partIndex: 0,
                kind: "text",
                text: delta,
              });
            }
            return;
          }

          // Route reasoning deltas through the delta buffer as "thinking" kind.
          if (
            threadEvent.type === "item.updated" &&
            (notification.method === "item/reasoning/summaryTextDelta" ||
              notification.method === "item/reasoning/textDelta" ||
              notification.method === "item/reasoning/summaryPartAdded")
          ) {
            const item = threadEvent.item as Record<string, unknown>;
            const itemId = item?.id as string | undefined;
            const text = item?.text as string | undefined;
            if (itemId && text) {
              this.enqueueDelta({
                threadId: input.threadId,
                threadChatId: input.threadChatId,
                token: input.token,
                messageId: itemId,
                partIndex: 0,
                kind: "thinking",
                text,
              });
            }
            return;
          }

          // mcpToolCall/progress updates are delta-only — don't persist them
          // as messages; future sprints will surface progress via the UI layer.
          if (notification.method === "item/mcpToolCall/progress") {
            return;
          }

          // autoApprovalReview events are surfaced as chat messages containing
          // a DBAutoApprovalReviewPart. They go through parseCodexLine below,
          // which will emit them when we add a handler in a future sprint.
          // For now they fall through gracefully as unknown item types.

          const parsedMessages = parseCodexLine({
            line: JSON.stringify(threadEvent),
            runtime: this.runtime,
            state: threadState.parserState,
          });
          for (const parsedMessage of parsedMessages) {
            const normalized = context.threadId
              ? this.normalizeAppServerMessageSessionId({
                  message: parsedMessage,
                  threadId: context.threadId,
                })
              : parsedMessage;
            this.addMessageToBuffer({
              agent: "codex",
              message: normalized,
              threadId: input.threadId,
              threadChatId: input.threadChatId,
              token: input.token,
            });
          }

          if (
            threadEvent.type === "item.started" ||
            threadEvent.type === "item.updated" ||
            threadEvent.type === "item.completed"
          ) {
            this.resetAppServerWatchdog({
              context,
              input,
              manager,
            });
          }

          // Intermediate flush for codex: coalesce rapid-fire completions
          // at 250ms instead of the default 33ms messageFlushDelay
          if (threadEvent.type === "item.completed") {
            if (this.messageFlushTimer) {
              clearTimeout(this.messageFlushTimer);
            }
            this.messageFlushTimer = setTimeout(() => {
              this.flushMessageBuffer();
            }, 250);
          }

          if (threadEvent.type === "turn.failed") {
            const params = notification.params ?? {};
            context.resolveTurnComplete({
              status: "failed",
              codexPreviousResponseId: null,
              errorMessage: extractTurnFailureMessage(params),
            });
            return;
          }

          if (threadEvent.type === "error") {
            context.resolveTurnComplete({
              status: "failed",
              codexPreviousResponseId: null,
              errorMessage: threadEvent.message,
            });
            return;
          }

          if (threadEvent.type === "turn.completed") {
            // Flush the turn's final unified diff as exactly one codex-diff
            // ClaudeMessage (see turn.diff_updated handler). This replaces
            // what used to be per-update diff emissions with a single
            // per-turn DBDiffPart.
            if (context.pendingTurnDiff) {
              this.addMessageToBuffer({
                agent: "codex",
                message: {
                  type: "codex-diff",
                  session_id: context.threadId ?? null,
                  diff: context.pendingTurnDiff,
                },
                threadId: input.threadId,
                threadChatId: input.threadChatId,
                token: input.token,
              });
              context.pendingTurnDiff = null;
            }

            const params = notification.params ?? {};
            const completionStatus = isTurnInterruptedFromParams(params)
              ? "interrupted"
              : "completed";
            context.resolveTurnComplete({
              status: completionStatus,
              codexPreviousResponseId:
                extractCodexPreviousResponseIdFromParams(params),
              errorMessage: null,
            });
          }
        },
      );

      if (input.sessionId) {
        try {
          await manager.send({
            method: "thread/resume",
            threadChatId: input.threadChatId,
            params: {
              threadId: input.sessionId,
              thread_id: input.sessionId,
              ...(input.codexPreviousResponseId
                ? { previous_response_id: input.codexPreviousResponseId }
                : {}),
            },
          });
          this.resolveAppServerThread({
            context,
            manager,
            threadId: input.sessionId,
          });
        } catch (error) {
          if (!isThreadResumeRpcError(error)) {
            throw error;
          }
          this.runtime.logger.warn(
            "Codex app-server thread/resume failed; falling back to thread/start",
            {
              threadChatId: input.threadChatId,
              sessionId: input.sessionId,
              codexPreviousResponseId: input.codexPreviousResponseId ?? null,
              error: formatError(error),
            },
          );
          const threadStartResult = await manager.send({
            method: "thread/start",
            threadChatId: input.threadChatId,
            params: buildThreadStartParams({
              model: input.model,
              instructions: input.prompt,
            }),
          });
          const threadIdFromResult =
            extractThreadIdFromRpcResult(threadStartResult);
          if (threadIdFromResult) {
            this.resolveAppServerThread({
              context,
              manager,
              threadId: threadIdFromResult,
            });
          }
        }
      } else {
        const threadStartResult = await manager.send({
          method: "thread/start",
          threadChatId: input.threadChatId,
          params: buildThreadStartParams({
            model: input.model,
            instructions: input.prompt,
          }),
        });
        const threadIdFromResult =
          extractThreadIdFromRpcResult(threadStartResult);
        if (threadIdFromResult) {
          this.resolveAppServerThread({
            context,
            manager,
            threadId: threadIdFromResult,
          });
        }
      }

      const threadId = await Promise.race([
        context.threadReadyPromise,
        new Promise<string>((_, reject) => {
          setTimeout(
            () => reject(new Error("Timed out waiting for codex thread id")),
            APP_SERVER_INTERRUPT_TIMEOUT_MS,
          );
        }),
      ]);
      if (context.isStopping || context.isCompleted) {
        return;
      }

      this.resetAppServerWatchdog({
        context,
        input,
        manager,
      });
      const turnStartParams = buildTurnStartParams({
        threadId,
        prompt: input.prompt,
      });
      const turnStartPayloadChars =
        estimateTurnStartRequestSizeChars(turnStartParams);
      this.runtime.logger.info("Codex turn/start payload size", {
        threadChatId: input.threadChatId,
        threadId,
        chars: turnStartPayloadChars,
      });
      if (turnStartPayloadChars > CODEX_TURN_START_MAX_INPUT_CHARS) {
        throw new Error(
          `codex app-server request failed for turn/start: Input exceeds the maximum length of ${CODEX_TURN_START_MAX_INPUT_CHARS} characters (estimated=${turnStartPayloadChars})`,
        );
      }
      await manager.send({
        method: "turn/start",
        threadChatId: input.threadChatId,
        params: turnStartParams,
      });

      processHealthInterval = setInterval(() => {
        if (context.isCompleted || context.isStopping) {
          return;
        }
        const processAlive = manager.isAlive();
        const connectionOpen = this.hasAppServerConnection(manager);
        if (processAlive && connectionOpen) {
          return;
        }
        const diagnostics = formatAppServerDiagnostics(
          manager.getDiagnostics(),
        );
        context.rejectTurnComplete(
          new Error(
            processAlive
              ? `codex app-server connection closed unexpectedly during turn (${diagnostics})`
              : `codex app-server exited unexpectedly during turn (${diagnostics})`,
          ),
        );
      }, 250);

      const completion = await context.turnCompletePromise;
      const processDurationMs = this.getProcessDurationMs(input.threadChatId);
      const normalizedThreadId = context.threadId ?? input.sessionId ?? "";

      if (!context.isStopping && completion.status === "completed") {
        this.addMessageToBuffer({
          agent: "codex",
          message: {
            type: "result",
            subtype: "success",
            total_cost_usd: 0,
            duration_ms: processDurationMs,
            duration_api_ms: processDurationMs,
            is_error: false,
            num_turns: 1,
            result: "Codex successfully completed",
            session_id: normalizedThreadId,
          },
          threadId: input.threadId,
          threadChatId: input.threadChatId,
          token: input.token,
          codexPreviousResponseId: completion.codexPreviousResponseId,
        });
      } else if (!context.isStopping) {
        const errorInfo =
          completion.errorMessage ??
          (context.watchdogTriggered
            ? "Codex turn timed out and was interrupted"
            : "Codex turn did not complete successfully");
        this.addMessageToBuffer({
          agent: "codex",
          message: {
            type: "custom-error",
            session_id: null,
            duration_ms: processDurationMs,
            error_info: errorInfo,
          },
          threadId: input.threadId,
          threadChatId: input.threadChatId,
          token: input.token,
        });
      }

      this.runtime.logger.info("Codex app-server turn completed", {
        threadChatId: input.threadChatId,
        threadId: normalizedThreadId || null,
        codexPreviousResponseId: completion.codexPreviousResponseId,
        status: completion.status,
      });

      await this.flushMessageBuffer();
      this.resetAppServerCrashHistory();
    } catch (error) {
      if (!context.isStopping) {
        const crashError =
          this.isAppServerCrashError(error) || !manager.isAlive();
        if (crashError) {
          const crashCount = this.registerAppServerCrash();
          if (crashCount > APP_SERVER_MAX_RESPAWNS_PER_WINDOW) {
            this.runtime.logger.error("Codex app-server crash loop detected", {
              crashCount,
              threadChatId: input.threadChatId,
            });
          }
        }

        this.addMessageToBuffer({
          agent: "codex",
          message: {
            type: "custom-error",
            session_id: null,
            duration_ms: this.getProcessDurationMs(input.threadChatId),
            error_info: (() => {
              const diagnostics = formatAppServerDiagnostics(
                manager.getDiagnostics(),
              );
              if (error instanceof Error) {
                // Avoid double-appending diagnostics when the error was
                // raised by a site that already formatted them (e.g. the
                // process-health interval below).
                if (error.message.includes("lastRequestMethod=")) {
                  return error.message;
                }
                return `${error.message} (${diagnostics})`;
              }
              return `Codex app-server error (${diagnostics})`;
            })(),
          },
          threadId: input.threadId,
          threadChatId: input.threadChatId,
          token: input.token,
        });
        await this.flushMessageBuffer();
      }

      if (!context.isStopping) {
        throw error;
      }
    } finally {
      if (removeNotificationHandler) {
        removeNotificationHandler();
      }
      await manager.kill().catch((error) => {
        this.runtime.logger.error("Failed to kill codex app-server", {
          threadChatId: input.threadChatId,
          error: formatError(error),
        });
      });
      if (processHealthInterval) {
        clearInterval(processHealthInterval);
      }
      this.clearAppServerWatchdog(context);
      if (this.appServerRunContexts.get(input.threadChatId) === context) {
        this.stopHeartbeat(input.threadChatId);
        this.appServerRunContexts.delete(input.threadChatId);
        this.markDaemonEventRunStateForCleanup(input.threadChatId);
      }
    }
  }

  private async runAcpTransportCommand(
    input: DaemonMessageClaude,
  ): Promise<void> {
    if (!this.activeProcesses.has(input.threadChatId)) {
      throw new Error("Missing active process state for ACP transport");
    }
    // Capture runId early so the finally block can guard cleanup against overlapping runs
    const localRunId = this.activeProcesses.get(input.threadChatId)!.runId;

    const baseUrlRaw = process.env.SANDBOX_AGENT_BASE_URL;
    if (!baseUrlRaw) {
      throw new Error("SANDBOX_AGENT_BASE_URL is required for ACP transport");
    }
    const baseUrl = baseUrlRaw.replace(/\/+$/, "");
    if (!baseUrl) {
      throw new Error("SANDBOX_AGENT_BASE_URL is invalid for ACP transport");
    }

    const acpAgent = (() => {
      switch (input.agent) {
        case "claudeCode":
          return "claude";
        case "codex":
          return "codex";
        case "amp":
          return "amp";
        case "opencode":
          return "opencode";
        case "gemini":
          throw new Error("ACP transport is not supported for gemini agent");
        default: {
          const _exhaustiveCheck: never = input.agent;
          throw new Error(
            `ACP transport is not supported for agent: ${_exhaustiveCheck}`,
          );
        }
      }
    })();

    const runState = this.getOrCreateDaemonEventRunState(input.threadChatId);
    const serverId =
      input.acpServerId ?? runState.acpServerId ?? `terragon-${runState.runId}`;
    runState.acpServerId = serverId;
    if (input.acpSessionId) {
      runState.acpSessionId = input.acpSessionId;
    }
    this.daemonEventRunStates.set(input.threadChatId, runState);
    // When the agent is Codex, create a parser state so ACP events can be
    // routed through the structured Codex parsing pipeline (parseCodexItem).
    const codexAcpState =
      input.agent === "codex" ? createCodexParserState() : null;

    let sawTerminalEventFromStream = false;
    let circuitBreakerTripped = false;
    let resolveSseTerminal: (() => void) | null = null;
    const sseTerminalPromise = new Promise<void>((resolve) => {
      resolveSseTerminal = resolve;
    });
    let lastAcpMessageAtMs = Date.now();
    let lastEventId: string | null = null;
    const promptPostAbortController = new AbortController();

    // Delta streaming: stable message ID for accumulating text/thinking deltas
    // on the client. Resets each time a non-text message arrives (tool_use, result).
    let deltaMessageId: string = randomUUID();
    let deltaPartIndex = 0;

    const createUrl = (bootstrapAgent: boolean): string => {
      const url = new URL(`${baseUrl}/v1/acp/${encodeURIComponent(serverId)}`);
      if (bootstrapAgent) {
        url.searchParams.set("agent", acpAgent);
      }
      return url.toString();
    };

    // Store ACP URL on process state for permission-response handler
    this.updateActiveProcessState(input.threadChatId, {
      acpUrl: createUrl(false),
    });

    const toObject = (value: unknown): Record<string, unknown> | null => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return null;
      }
      return value as Record<string, unknown>;
    };

    const getErrorMessage = (error: unknown): string => {
      if (error instanceof Error) {
        return error.message;
      }
      try {
        return JSON.stringify(error);
      } catch {
        return String(error);
      }
    };

    const timeoutSignal = (
      overrideMs?: number | null,
    ): AbortSignal | undefined => {
      if (overrideMs === null) return undefined;
      if (
        typeof AbortSignal !== "undefined" &&
        typeof AbortSignal.timeout === "function"
      ) {
        return AbortSignal.timeout(overrideMs ?? ACP_REQUEST_TIMEOUT_MS);
      }
      return undefined;
    };

    let nextRequestId = 1;
    const postEnvelope = async ({
      method,
      params,
      bootstrap,
      noTimeout,
      signal,
    }: {
      method: string;
      params?: Record<string, unknown>;
      bootstrap?: boolean;
      /** Skip the request timeout (for long-running calls like session/prompt). */
      noTimeout?: boolean;
      /** Optional abort signal to cancel the request externally. */
      signal?: AbortSignal;
    }): Promise<AcpResponseEnvelope> => {
      const envelope: AcpRequestEnvelope = {
        jsonrpc: "2.0",
        id: nextRequestId,
        method,
      };
      nextRequestId += 1;
      if (params) {
        envelope.params = params;
      }
      const timeoutSig = timeoutSignal(noTimeout ? null : undefined);
      const combinedSignal =
        signal && timeoutSig
          ? AbortSignal.any([signal, timeoutSig])
          : (signal ?? timeoutSig);
      const response = await fetch(createUrl(!!bootstrap), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(envelope),
        signal: combinedSignal,
      });
      const bodyText = await response.text();
      if (!response.ok) {
        throw new Error(
          `ACP POST failed (${response.status} ${response.statusText}) ${bodyText}`,
        );
      }
      if (!bodyText.trim()) {
        return {};
      }
      return JSON.parse(bodyText) as AcpResponseEnvelope;
    };

    const applyAcpMessages = (messages: ClaudeMessage[]) => {
      if (!this.activeProcesses.has(input.threadChatId)) {
        this.runtime.logger.warn("ACP messages dropped: no active process", {
          threadChatId: input.threadChatId,
          droppedMessageCount: messages.length,
        });
        return;
      }
      for (const message of messages) {
        lastAcpMessageAtMs = Date.now();
        if (message.type === "assistant" || message.type === "user") {
          sawAssistantOrUserMessage = true;
        }
        if (
          (message.type === "assistant" || message.type === "user") &&
          message.session_id
        ) {
          this.updateActiveProcessState(input.threadChatId, {
            sessionId: message.session_id,
            isWorking: true,
          });
        }
        if (
          message.type === "result" ||
          message.type === "custom-error" ||
          message.type === "custom-stop"
        ) {
          // Before ACP init succeeds, error envelopes like "Internal error" are
          // expected — sandbox-agent hasn't registered ACP endpoints yet. Suppress
          // them so the SSE loop doesn't prematurely kill the run while initialize
          // is still retrying.
          if (message.type === "custom-error" && !acpInitialized) {
            this.runtime.logger.debug(
              "Suppressing pre-init SSE error envelope (not terminal)",
              {
                threadChatId: input.threadChatId,
                errorInfo:
                  "error_info" in message ? message.error_info : undefined,
              },
            );
            return;
          }
          if (message.type === "custom-error" && acpInitialized) {
            const errorInfo =
              "error_info" in message ? message.error_info : undefined;
            const isInternalError =
              typeof errorInfo === "string" &&
              errorInfo.trim() === "Internal error";
            const postInitGraceActive =
              promptIssuedAtMs > 0 &&
              Date.now() - promptIssuedAtMs <=
                ACP_POST_INIT_INTERNAL_ERROR_GRACE_MS &&
              !sawAssistantOrUserMessage;
            if (
              isInternalError &&
              postInitGraceActive &&
              suppressedPostInitInternalErrors <
                ACP_POST_INIT_INTERNAL_ERROR_SUPPRESS_LIMIT
            ) {
              suppressedPostInitInternalErrors += 1;
              this.runtime.logger.debug(
                "Suppressing early post-init Internal error envelope (not terminal)",
                {
                  threadChatId: input.threadChatId,
                  suppressedCount: suppressedPostInitInternalErrors,
                  suppressLimit: ACP_POST_INIT_INTERNAL_ERROR_SUPPRESS_LIMIT,
                  graceRemainingMs: Math.max(
                    0,
                    ACP_POST_INIT_INTERNAL_ERROR_GRACE_MS -
                      (Date.now() - promptIssuedAtMs),
                  ),
                },
              );
              continue;
            }
          }
          sawTerminalEventFromStream = true;
          resolveSseTerminal?.();
          this.updateActiveProcessState(input.threadChatId, {
            isCompleted: true,
          });
        }
        // Send text/thinking deltas immediately for token-level streaming.
        // Terminal messages (result, error, stop) reset the delta ID for the next turn.
        if (
          message.type === "result" ||
          message.type === "custom-error" ||
          message.type === "custom-stop"
        ) {
          deltaMessageId = randomUUID();
          deltaPartIndex = 0;
        } else if (message.type === "assistant" && message.message?.content) {
          const content = message.message.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === "text" && block.text) {
                this.enqueueDelta({
                  threadId: input.threadId,
                  threadChatId: input.threadChatId,
                  token: input.token,
                  messageId: deltaMessageId,
                  partIndex: deltaPartIndex,
                  kind: "text",
                  text: block.text,
                });
              } else if (block.type === "thinking" && block.thinking) {
                this.enqueueDelta({
                  threadId: input.threadId,
                  threadChatId: input.threadChatId,
                  token: input.token,
                  messageId: deltaMessageId,
                  partIndex: deltaPartIndex,
                  kind: "thinking",
                  text: block.thinking,
                });
              }
            }
            // If any content block is a tool_use, bump the part index for the next text block
            if (content.some((b: { type: string }) => b.type === "tool_use")) {
              deltaPartIndex += 1;
            }
          }
        }

        this.addMessageToBuffer({
          agent: input.agent,
          message,
          threadId: input.threadId,
          threadChatId: input.threadChatId,
          token: input.token,
        });
      }
    };

    const parseSseChunk = (chunk: string) => {
      if (!chunk.trim()) {
        return;
      }
      let eventName = "message";
      const dataLines: string[] = [];
      for (const line of chunk.split("\n")) {
        if (!line || line.startsWith(":")) {
          continue;
        }
        if (line.startsWith("event:")) {
          eventName = line.slice(6).trim();
          continue;
        }
        if (line.startsWith("id:")) {
          lastEventId = line.slice(3).trim();
          continue;
        }
        if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trimStart());
        }
      }
      if (eventName !== "message" || dataLines.length === 0) {
        if (eventName !== "message") {
          this.runtime.logger.debug(
            "ACP SSE event ignored (non-message event)",
            {
              eventName,
              threadChatId: input.threadChatId,
            },
          );
        }
        return;
      }
      const payload = dataLines.join("\n");

      // Handle ACP permission requests.
      // The ACP server sends session/request_permission as a JSON-RPC request
      // (has an `id` field) over SSE. The agent blocks until a response is
      // POSTed back. In allowAll mode, auto-approve immediately. In plan mode,
      // emit a synthetic PermissionRequest tool call for user approval.
      try {
        const envelope = JSON.parse(payload);
        if (
          envelope &&
          typeof envelope === "object" &&
          envelope.method === "session/request_permission" &&
          envelope.id !== undefined
        ) {
          lastAcpMessageAtMs = Date.now();

          // In allowAll mode (default), auto-approve immediately
          if (input.permissionMode !== "plan") {
            this.runtime.logger.info("ACP auto-approving permission request", {
              threadChatId: input.threadChatId,
              requestId: envelope.id,
            });
            fetch(createUrl(false), {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
              },
              body: JSON.stringify({
                jsonrpc: "2.0",
                id: envelope.id,
                result: { optionId: "approved" },
              }),
            }).catch((err) => {
              this.runtime.logger.error("ACP permission approval POST failed", {
                threadChatId: input.threadChatId,
                error: getErrorMessage(err),
              });
            });
            return;
          }

          // In plan mode, surface as a synthetic tool call for user approval
          const promptId = `perm-${randomUUID()}`;
          const params =
            typeof envelope.params === "object" && envelope.params
              ? envelope.params
              : {};
          const processState = this.activeProcesses.get(input.threadChatId);
          if (processState) {
            processState.pendingPermissions.set(promptId, {
              acpRequestId: envelope.id,
            });
          }

          this.runtime.logger.info(
            "ACP permission request surfaced for user approval",
            {
              threadChatId: input.threadChatId,
              requestId: envelope.id,
              promptId,
            },
          );

          const currentSessionId =
            this.activeProcesses.get(input.threadChatId)?.sessionId ??
            input.sessionId ??
            "";
          applyAcpMessages([
            {
              type: "assistant",
              session_id: currentSessionId,
              parent_tool_use_id: null,
              message: {
                role: "assistant",
                content: [
                  {
                    type: "tool_use",
                    id: promptId,
                    name: "PermissionRequest",
                    input: {
                      options: params.options ?? [],
                      description: params.description ?? "",
                      tool_name: params.tool_name ?? "",
                    },
                  },
                ],
              },
            },
          ]);
          return;
        }
      } catch {
        // Not valid JSON — fall through to normal handler
      }

      const currentSessionId =
        this.activeProcesses.get(input.threadChatId)?.sessionId ??
        input.sessionId ??
        "";

      // For Codex ACP sessions, try to parse the payload as a structured
      // Codex event first. This produces rich tool calls (Bash, Write,
      // WebSearch, Task, etc.) instead of flattened text.
      if (codexAcpState) {
        const codexMessages = tryParseAcpAsCodexEvent(
          payload,
          currentSessionId,
          codexAcpState,
          this.runtime,
        );
        if (codexMessages && codexMessages.length > 0) {
          applyAcpMessages(codexMessages);
          return;
        }
      }

      // Generic ACP parsing fallback
      const messages = parseAcpLineToClaudeMessages(payload, currentSessionId);
      if (messages.length > 0) {
        applyAcpMessages(messages);
      } else {
        this.runtime.logger.debug("ACP SSE payload produced no messages", {
          threadChatId: input.threadChatId,
          payloadPreview: payload.slice(0, 200),
        });
      }
    };

    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      });

    const waitForStreamQuiescence = async (): Promise<void> => {
      const startedAtMs = Date.now();
      while (Date.now() - startedAtMs < ACP_TERMINAL_MAX_WAIT_MS) {
        const sinceLastMessageMs = Date.now() - lastAcpMessageAtMs;
        if (sinceLastMessageMs >= ACP_TERMINAL_QUIESCENCE_MS) {
          return;
        }
        await sleep(
          Math.min(ACP_TERMINAL_QUIESCENCE_MS - sinceLastMessageMs, 50),
        );
      }
    };

    const consumeSse = async (
      body: ReadableStream<Uint8Array>,
      abortSignal: AbortSignal,
    ): Promise<void> => {
      const reader = body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        while (!abortSignal.aborted) {
          const { done, value } = await reader.read();
          if (done) {
            return;
          }
          buffer += decoder
            .decode(value, { stream: true })
            .replace(/\r\n/g, "\n")
            .replace(/\r/g, "\n");
          let separatorIndex = buffer.indexOf("\n\n");
          while (separatorIndex !== -1) {
            const eventChunk = buffer.slice(0, separatorIndex);
            buffer = buffer.slice(separatorIndex + 2);
            parseSseChunk(eventChunk);
            separatorIndex = buffer.indexOf("\n\n");
          }
        }
      } finally {
        // Flush any remaining complete event before releasing
        if (buffer.trim()) {
          const separatorIndex = buffer.indexOf("\n\n");
          if (separatorIndex !== -1) {
            const eventChunk = buffer.slice(0, separatorIndex);
            parseSseChunk(eventChunk);
          }
        }
        reader.releaseLock();
      }
    };

    const sseAbortController = new AbortController();
    const abortableSleep = (ms: number): Promise<void> =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        const onAbort = (): void => {
          clearTimeout(timer);
          resolve();
        };
        sseAbortController.signal.addEventListener("abort", onAbort, {
          once: true,
        });
      });
    // Store on process state so killActiveProcess can abort ACP transport
    const processState = this.activeProcesses.get(input.threadChatId);
    if (processState) {
      processState.acpAbortController = sseAbortController;
    }
    // When externally aborted (stop message), unblock the SSE terminal promise
    // Wrap in arrow fn so TS doesn't narrow the mutable `let` inside closures.
    const triggerSseTerminal = (): void => resolveSseTerminal?.();
    sseAbortController.signal.addEventListener("abort", triggerSseTerminal, {
      once: true,
    });

    // Propagate the daemon token to sandbox-agent's environment.
    // In ACP mode, sandbox-agent spawns agent processes (e.g., Codex).
    // Codex reads DAEMON_TOKEN via env_http_headers for proxy auth.
    // The token changes each run, so sandbox-agent must be restarted to
    // inherit the updated process.env before spawning the agent.
    await this.ensureSandboxAgentHasToken(baseUrl, input);

    // Wait for ACP endpoints to register after health passes. sandbox-agent's
    // /v1/health responds before ACP endpoints are ready (~15s gap). This delay
    // avoids burning retry budget on guaranteed-to-fail requests.
    await new Promise((r) => setTimeout(r, 5_000));

    // Track that we just restarted so we can suppress expected initial SSE 404s
    let justRestarted = true;
    // Track whether initialize + session/new have succeeded. Before this is set,
    // SSE error envelopes (e.g. "Internal error") must NOT be treated as terminal
    // because they're expected during the ACP registration window.
    let acpInitialized = false;
    // Track the post-prompt bootstrap window where ACP can emit transient
    // "Internal error" envelopes before the first meaningful stream message.
    let promptIssuedAtMs = 0;
    let sawAssistantOrUserMessage = false;
    let suppressedPostInitInternalErrors = 0;

    const sseLoop = (async () => {
      // Settle after sandbox-agent restart — ACP endpoints need ~15s to register
      // after /v1/health passes. A longer initial delay reduces SSE failure budget burn.
      await abortableSleep(2_000);
      let consecutiveSseFailures = 0;
      const sseStartupAtMs = Date.now();
      while (!sseAbortController.signal.aborted) {
        try {
          const sseHeaders: Record<string, string> = {
            Accept: "text/event-stream",
          };
          if (lastEventId) {
            sseHeaders["Last-Event-ID"] = lastEventId;
          }
          const response = await fetch(createUrl(false), {
            method: "GET",
            headers: sseHeaders,
            signal: sseAbortController.signal,
          });
          if (!response.ok) {
            throw new AcpSseHttpError(response.status, response.statusText);
          }
          if (!response.body) {
            throw new Error("ACP SSE response has no body");
          }
          justRestarted = false;
          const sseStartMs = Date.now();
          await consumeSse(response.body, sseAbortController.signal);
          // Only reset failure counter if connection was stable (>5s)
          if (Date.now() - sseStartMs > 5_000) {
            consecutiveSseFailures = 0;
          }
          if (!sseAbortController.signal.aborted) {
            await abortableSleep(ACP_SSE_RECONNECT_DELAY_MS);
          }
        } catch (error) {
          if (sseAbortController.signal.aborted) {
            return;
          }
          // During startup grace we expect intermittent 404s while ACP routes
          // are still registering behind /v1/health.
          const startupGraceActive =
            justRestarted &&
            Date.now() - sseStartupAtMs <= ACP_SSE_STARTUP_GRACE_MS;
          if (
            startupGraceActive &&
            error instanceof AcpSseHttpError &&
            error.status === 404
          ) {
            this.runtime.logger.debug(
              "ACP SSE not yet available after restart (expected)",
              {
                threadChatId: input.threadChatId,
                serverId,
                startupGraceRemainingMs: Math.max(
                  0,
                  ACP_SSE_STARTUP_GRACE_MS - (Date.now() - sseStartupAtMs),
                ),
              },
            );
            await abortableSleep(ACP_SSE_STARTUP_404_BACKOFF_MS);
            continue;
          }

          consecutiveSseFailures++;
          if (startupGraceActive) {
            this.runtime.logger.debug(
              "ACP SSE loop error during startup grace",
              {
                threadChatId: input.threadChatId,
                serverId,
                error: formatError(error),
                consecutiveSseFailures,
                startupGraceRemainingMs: Math.max(
                  0,
                  ACP_SSE_STARTUP_GRACE_MS - (Date.now() - sseStartupAtMs),
                ),
              },
            );
          } else {
            this.runtime.logger.warn("ACP SSE loop error", {
              threadChatId: input.threadChatId,
              serverId,
              error: formatError(error),
              consecutiveSseFailures,
            });
          }
          if (consecutiveSseFailures >= ACP_SSE_MAX_CONSECUTIVE_FAILURES) {
            this.runtime.logger.error(
              "ACP SSE circuit breaker tripped — giving up after max consecutive failures",
              {
                threadChatId: input.threadChatId,
                serverId,
                consecutiveSseFailures,
              },
            );
            circuitBreakerTripped = true;
            triggerSseTerminal();
            return;
          }
          const backoffMs = Math.min(
            ACP_SSE_RECONNECT_DELAY_MS * 2 ** consecutiveSseFailures,
            5_000,
          );
          await abortableSleep(backoffMs);
        }
      }
    })();
    let sseClosed = false;
    const closeSse = async (): Promise<void> => {
      if (sseClosed) {
        return;
      }
      sseClosed = true;
      sseAbortController.abort();
      await sseLoop.catch(() => undefined);
    };

    try {
      // Retry initialize — ACP endpoints may not be registered yet even
      // though /v1/health passed. Typically ready within ~15s of restart.
      // Use 20 attempts with exponential backoff (2s base, 5s cap) to
      // tolerate variance in sandbox-agent startup time.
      const ACP_INIT_MAX_ATTEMPTS = 20;
      let initializeResponse: AcpResponseEnvelope | undefined;
      for (let attempt = 0; attempt < ACP_INIT_MAX_ATTEMPTS; attempt++) {
        try {
          initializeResponse = await postEnvelope({
            method: "initialize",
            params: {
              protocolVersion: 1,
              clientInfo: {
                name: "terragon-daemon",
                version: DAEMON_VERSION,
              },
            },
            bootstrap: true,
          });
          if (!toObject(initializeResponse.error)) break;
        } catch (err) {
          if (attempt >= ACP_INIT_MAX_ATTEMPTS - 1) throw err;
          this.runtime.logger.debug(
            `ACP initialize attempt ${attempt + 1} failed, retrying`,
            { error: formatError(err) },
          );
        }
        const backoff = Math.min(2_000 * 1.5 ** attempt, 5_000);
        await new Promise((r) => setTimeout(r, backoff));
      }
      if (toObject(initializeResponse?.error)) {
        throw new Error(
          `ACP initialize failed: ${JSON.stringify(initializeResponse?.error)}`,
        );
      }

      // Always create a fresh session — sandbox-agent was just restarted
      // so any previous acpSessionId is stale and meaningless.
      let sessionId: string | undefined;
      {
        let newSessionResponse: AcpResponseEnvelope | undefined;
        for (let attempt = 0; attempt < ACP_INIT_MAX_ATTEMPTS; attempt++) {
          try {
            newSessionResponse = await postEnvelope({
              method: "session/new",
              params: {
                cwd: process.cwd(),
                mcpServers: [],
              },
            });
            if (!toObject(newSessionResponse.error)) break;
          } catch (err) {
            if (attempt >= ACP_INIT_MAX_ATTEMPTS - 1) throw err;
            this.runtime.logger.debug(
              `ACP session/new attempt ${attempt + 1} failed, retrying`,
              { error: formatError(err) },
            );
          }
          const backoff = Math.min(2_000 * 1.5 ** attempt, 5_000);
          await new Promise((r) => setTimeout(r, backoff));
        }
        if (toObject(newSessionResponse?.error)) {
          throw new Error(
            `ACP session/new failed: ${JSON.stringify(newSessionResponse?.error)}`,
          );
        }
        const result = toObject(newSessionResponse?.result);
        const newSessionId = result?.sessionId;
        if (typeof newSessionId !== "string" || newSessionId.length === 0) {
          throw new Error("ACP session/new returned invalid sessionId");
        }
        sessionId = newSessionId;
      }

      // Mark ACP as initialized — SSE error envelopes are now treated as
      // terminal (before this point they were suppressed as startup noise).
      acpInitialized = true;

      this.updateActiveProcessState(input.threadChatId, {
        sessionId,
        isWorking: true,
      });
      const refreshedRunState = this.getOrCreateDaemonEventRunState(
        input.threadChatId,
      );
      refreshedRunState.acpServerId = serverId;
      refreshedRunState.acpSessionId = sessionId;
      this.daemonEventRunStates.set(input.threadChatId, refreshedRunState);

      // Fire POST as trigger only — don't use response for completion.
      // The POST holds the connection open for the entire agent turn (5-30+ min).
      // HTTP proxies/LBs may kill it, so SSE terminal event is the sole completion signal.
      promptIssuedAtMs = Date.now();
      suppressedPostInitInternalErrors = 0;
      sawAssistantOrUserMessage = false;
      postEnvelope({
        method: "session/prompt",
        params: {
          sessionId,
          prompt: [{ type: "text", text: input.prompt }],
        },
        noTimeout: true,
        signal: promptPostAbortController.signal,
      }).catch((err: unknown) => {
        // POST failures are non-fatal: SSE terminal event is sole completion signal
        if (!promptPostAbortController.signal.aborted) {
          this.runtime.logger.warn(
            "ACP session/prompt POST failed (non-fatal)",
            {
              threadChatId: input.threadChatId,
              error: formatError(err),
            },
          );
        }
      });

      // Await SSE terminal event OR prolonged SSE inactivity
      let inactivityTimer: ReturnType<typeof setInterval> | undefined;
      const completionReason = await Promise.race([
        sseTerminalPromise.then(() => "sse_terminal" as const),
        new Promise<"timeout">((resolve) => {
          inactivityTimer = setInterval(() => {
            const inactiveMs = Date.now() - lastAcpMessageAtMs;
            if (inactiveMs >= ACP_SSE_INACTIVITY_TIMEOUT_MS) {
              resolve("timeout");
            }
          }, ACP_INACTIVITY_CHECK_INTERVAL_MS);
        }),
      ]);
      if (inactivityTimer) clearInterval(inactivityTimer);

      await waitForStreamQuiescence();
      await closeSse();

      if (!this.activeProcesses.has(input.threadChatId)) {
        return;
      }

      // Polling fallback: if SSE failed but agent may have completed, check status.
      // The /status endpoint may not exist on all ACP servers — failures are expected and harmless.
      if (!sawTerminalEventFromStream && circuitBreakerTripped) {
        for (let pollAttempt = 0; pollAttempt < 5; pollAttempt++) {
          const pollDelay = Math.min(1_000 * 2 ** pollAttempt, 16_000);
          await new Promise<void>((resolve) => setTimeout(resolve, pollDelay));
          try {
            const statusUrl = `${createUrl(false)}/status`;
            const statusResponse = await fetch(statusUrl, {
              method: "GET",
              headers: { Accept: "application/json" },
              signal: AbortSignal.timeout(10_000),
            });
            if (statusResponse.ok) {
              const statusBody = (await statusResponse.json()) as Record<
                string,
                unknown
              >;
              if (
                statusBody &&
                typeof statusBody === "object" &&
                statusBody.completed
              ) {
                this.runtime.logger.info(
                  "ACP polling fallback: agent completed despite SSE failure",
                  {
                    threadChatId: input.threadChatId,
                    pollAttempt,
                    serverId,
                  },
                );
                // Construct a success result from the status response
                this.addMessageToBuffer({
                  agent: input.agent,
                  message: {
                    type: "result",
                    subtype: "success",
                    total_cost_usd: 0,
                    duration_ms: this.getProcessDurationMs(input.threadChatId),
                    duration_api_ms: this.getProcessDurationMs(
                      input.threadChatId,
                    ),
                    is_error: false,
                    num_turns: 1,
                    result:
                      typeof statusBody.stopReason === "string"
                        ? statusBody.stopReason
                        : "acp_poll_complete",
                    session_id: sessionId,
                  },
                  threadId: input.threadId,
                  threadChatId: input.threadChatId,
                  token: input.token,
                });
                sawTerminalEventFromStream = true; // skip the error branch below
                break;
              }
            }
          } catch {
            // Poll failed — expected if server doesn't support /status endpoint
            this.runtime.logger.debug("ACP polling fallback attempt failed", {
              threadChatId: input.threadChatId,
              pollAttempt,
            });
          }
        }
      }

      if (sawTerminalEventFromStream) {
        // SSE delivered the terminal event (or polling recovered it) — already buffered.
        // Nothing more to do.
      } else if (completionReason === "timeout") {
        this.addMessageToBuffer({
          agent: input.agent,
          message: {
            type: "custom-error",
            session_id: null,
            duration_ms: this.getProcessDurationMs(input.threadChatId),
            error_info: circuitBreakerTripped
              ? "ACP SSE circuit breaker tripped — agent connection lost after max consecutive failures"
              : `ACP completion timeout — no SSE activity for ${Math.round(ACP_SSE_INACTIVITY_TIMEOUT_MS / 60_000)} minutes`,
          },
          threadId: input.threadId,
          threadChatId: input.threadChatId,
          token: input.token,
        });
      }

      this.updateActiveProcessState(input.threadChatId, {
        isCompleted: true,
      });
    } catch (error) {
      await closeSse();
      this.runtime.logger.error("ACP transport command failed", {
        threadChatId: input.threadChatId,
        runId: input.runId ?? null,
        serverId,
        error: formatError(error),
      });
      if (!sawTerminalEventFromStream) {
        this.addMessageToBuffer({
          agent: input.agent,
          message: {
            type: "custom-error",
            session_id: null,
            duration_ms: this.getProcessDurationMs(input.threadChatId),
            error_info: getErrorMessage(error),
          },
          threadId: input.threadId,
          threadChatId: input.threadChatId,
          token: input.token,
        });
      }
      this.updateActiveProcessState(input.threadChatId, {
        isCompleted: true,
      });
    } finally {
      promptPostAbortController.abort();
      await closeSse();
      // Fire-and-forget: server cleanup is best-effort, don't block on it
      fetch(createUrl(false), {
        method: "DELETE",
        headers: {
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(10_000),
      }).catch(() => {
        // Intentionally ignore - server cleanup is best-effort
      });
      // Only delete if this run still owns the entry — a newer run may have
      // already replaced it, and deleting would destroy the new run's state.
      const currentProcess = this.activeProcesses.get(input.threadChatId);
      if (currentProcess?.runId === localRunId) {
        this.activeProcesses.delete(input.threadChatId);
        this.markDaemonEventRunStateForCleanup(input.threadChatId);
      }
      await this.flushMessageBuffer();
    }
  }

  /**
   * Restart sandbox-agent with the daemon token in its environment.
   *
   * In ACP transport, sandbox-agent spawns agent processes (e.g., Codex
   * `app-server`). Agents like Codex read DAEMON_TOKEN from their env
   * (via `env_http_headers` in config.toml) to authenticate API calls
   * through our proxy. Since the token changes each run and sandbox-agent
   * was originally started without it, we must restart sandbox-agent so
   * the new process inherits the updated `process.env`.
   */
  private async ensureSandboxAgentHasToken(
    baseUrl: string,
    input: DaemonMessageClaude,
  ): Promise<void> {
    // Set token env vars on daemon process so execSync children inherit them.
    process.env.DAEMON_TOKEN = input.token;
    // Increase sandbox-agent's ACP proxy timeout from 120s default to 10 minutes.
    // session/prompt can take many minutes for complex coding tasks.
    process.env.SANDBOX_AGENT_ACP_REQUEST_TIMEOUT_MS = "600000";

    // For Claude Code ACP, also set Anthropic-specific env vars
    if (input.agent === "claudeCode" && input.useCredits) {
      process.env.ANTHROPIC_AUTH_TOKEN = input.token;
      process.env.ANTHROPIC_BASE_URL = `${this.runtime.normalizedUrl}/api/proxy/anthropic`;
    }

    let port = "2468";
    let host = "127.0.0.1";
    try {
      const parsed = new URL(baseUrl);
      port = parsed.port || "2468";
      host = parsed.hostname || "127.0.0.1";
    } catch {
      // Use defaults
    }

    // Kill existing sandbox-agent so we can restart with updated env
    try {
      this.runtime.execSync(
        `pkill -f "sandbox-agent.*--port ${port}" 2>/dev/null || true`,
      );
    } catch {
      // Ignore — process may not exist
    }

    // Brief pause for process cleanup
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Find sandbox-agent binary (mirrors logic in packages/sandbox/src/setup.ts)
    let sandboxAgentBin = "sandbox-agent";
    for (const candidate of [
      "sandbox-agent",
      "/usr/bin/sandbox-agent",
      "/usr/local/bin/sandbox-agent",
    ]) {
      try {
        this.runtime.execSync(
          candidate === "sandbox-agent"
            ? "command -v sandbox-agent >/dev/null 2>&1"
            : `test -x ${candidate}`,
        );
        sandboxAgentBin = candidate;
        break;
      } catch {
        continue;
      }
    }

    // Start sandbox-agent — inherits process.env (including DAEMON_TOKEN)
    try {
      this.runtime.execSync(
        `nohup ${sandboxAgentBin} server --no-token --host ${host} --port ${port} >> /tmp/sandbox-agent.log 2>&1 &`,
      );
    } catch (error) {
      this.runtime.logger.error(
        "Failed to restart sandbox-agent with DAEMON_TOKEN",
        { error: formatError(error) },
      );
      throw new Error("Failed to restart sandbox-agent with DAEMON_TOKEN");
    }

    // Wait for sandbox-agent health (matches setup.ts pattern)
    const healthUrl = `${baseUrl.replace(/\/+$/, "")}/v1/health`;
    const maxRetries = 20;
    for (let i = 0; i < maxRetries; i++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      try {
        const response = await fetch(healthUrl);
        if (response.ok) {
          this.runtime.logger.info(
            "sandbox-agent restarted with DAEMON_TOKEN",
            { port, retries: i },
          );
          return;
        }
      } catch {
        // Continue retrying
      }
    }
    throw new Error(
      `sandbox-agent failed to become healthy after restart (${maxRetries} retries)`,
    );
  }

  private shouldEmitDaemonEventEnvelopeV2(_threadChatId: string): boolean {
    return true;
  }

  private getMessageFingerprint(messages: ClaudeMessage[]): string {
    return createHash("sha256").update(JSON.stringify(messages)).digest("hex");
  }

  private createCanonicalEventId(runId: string, seq: number): string {
    return createHash("sha256")
      .update(`${runId}:canonical:${seq}`)
      .digest("hex");
  }

  private allocateCanonicalBaseEvent(params: {
    runId: string;
    threadId: string;
    threadChatId: string;
    seq: number;
    timestamp: string;
  }): Pick<
    CanonicalEvent,
    | "payloadVersion"
    | "eventId"
    | "runId"
    | "threadId"
    | "threadChatId"
    | "seq"
    | "timestamp"
  > {
    return {
      payloadVersion: 2,
      eventId: this.createCanonicalEventId(params.runId, params.seq),
      runId: params.runId,
      threadId: params.threadId,
      threadChatId: params.threadChatId,
      seq: params.seq,
      timestamp: params.timestamp,
    };
  }

  private toCanonicalModelOrNull(model: string | null): AIModel | null {
    if (!model) {
      return null;
    }
    const parsed = AIModelSchema.safeParse(model);
    return parsed.success ? parsed.data : null;
  }

  private toCanonicalToolParameters(value: unknown): Record<string, unknown> {
    const record = toRecord(value);
    if (record) {
      return record;
    }
    if (value === undefined) {
      return {};
    }
    return { value };
  }

  private buildCanonicalEventsForBatch(params: {
    runState: DaemonEventRunState;
    threadId: string;
    threadChatId: string;
    messages: ClaudeMessage[];
  }): {
    canonicalEvents: CanonicalEvent[];
    nextCanonicalSeqAfterBatch: number;
    canonicalRunStartedEmittedAfterBatch: boolean;
  } {
    const { runState, threadId, threadChatId, messages } = params;
    if (messages.length === 0 || runState.agent === null) {
      return {
        canonicalEvents: [],
        nextCanonicalSeqAfterBatch: runState.nextCanonicalSeq,
        canonicalRunStartedEmittedAfterBatch:
          runState.canonicalRunStartedEmitted,
      };
    }

    const timestamp = new Date().toISOString();
    const events: CanonicalEvent[] = [];
    let nextCanonicalSeq = runState.nextCanonicalSeq;
    let canonicalRunStartedEmitted = runState.canonicalRunStartedEmitted;
    const allocateBaseEvent = (): Pick<
      CanonicalEvent,
      | "payloadVersion"
      | "eventId"
      | "runId"
      | "threadId"
      | "threadChatId"
      | "seq"
      | "timestamp"
    > => {
      const baseEvent = this.allocateCanonicalBaseEvent({
        runId: runState.runId,
        threadId,
        threadChatId,
        seq: nextCanonicalSeq,
        timestamp,
      });
      nextCanonicalSeq += 1;
      return baseEvent;
    };
    const warnMalformedCanonicalBlock = (
      reason: string,
      blockType: string,
    ): void => {
      this.runtime.logger.warn("Skipping malformed canonical block", {
        runId: runState.runId,
        threadId,
        threadChatId,
        blockType,
        reason,
      });
    };

    if (!canonicalRunStartedEmitted) {
      const baseEvent = allocateBaseEvent();
      const model = this.toCanonicalModelOrNull(runState.model);
      events.push({
        ...baseEvent,
        category: "operational",
        type: "run-started",
        agent: runState.agent,
        transportMode: runState.transportMode,
        protocolVersion: runState.protocolVersion,
        ...(model ? { model } : {}),
      });
      canonicalRunStartedEmitted = true;
    }

    const canonicalModel = this.toCanonicalModelOrNull(runState.model);
    for (const message of messages) {
      if (message.type === "assistant") {
        const content = message.message.content;
        if (typeof content === "string") {
          if (content.length === 0) {
            continue;
          }
          const baseEvent = allocateBaseEvent();
          events.push({
            ...baseEvent,
            category: "transcript",
            type: "assistant-message",
            messageId: baseEvent.eventId,
            content,
            parentToolUseId: message.parent_tool_use_id,
            ...(canonicalModel ? { model: canonicalModel } : {}),
          });
          continue;
        }

        if (!Array.isArray(content)) {
          continue;
        }

        for (const block of content) {
          const blockRecord = toRecord(block);
          const blockType = readString(blockRecord, "type");
          if (blockType === "text") {
            const text = readString(blockRecord, "text");
            if (!text || text.length === 0) {
              continue;
            }
            const baseEvent = allocateBaseEvent();
            events.push({
              ...baseEvent,
              category: "transcript",
              type: "assistant-message",
              messageId: baseEvent.eventId,
              content: text,
              parentToolUseId: message.parent_tool_use_id,
              ...(canonicalModel ? { model: canonicalModel } : {}),
            });
            continue;
          }
          if (blockType !== "tool_use") {
            continue;
          }
          const toolCallId = readString(blockRecord, "id");
          const name = readString(blockRecord, "name");
          if (!toolCallId || !name) {
            warnMalformedCanonicalBlock(
              "missing_tool_use_identity",
              "tool_use",
            );
            continue;
          }
          const baseEvent = allocateBaseEvent();
          events.push({
            ...baseEvent,
            category: "tool_lifecycle",
            type: "tool-call-start",
            toolCallId,
            name,
            parameters: this.toCanonicalToolParameters(blockRecord?.input),
            parentToolUseId: message.parent_tool_use_id,
          });
        }
        continue;
      }

      if (message.type !== "user") {
        continue;
      }

      const content = message.message.content;
      if (!Array.isArray(content)) {
        continue;
      }

      for (const block of content) {
        const blockRecord = toRecord(block);
        if (readString(blockRecord, "type") !== "tool_result") {
          continue;
        }
        const toolCallId = readString(blockRecord, "tool_use_id");
        if (!toolCallId) {
          warnMalformedCanonicalBlock(
            "missing_tool_result_identity",
            "tool_result",
          );
          continue;
        }
        const baseEvent = allocateBaseEvent();
        events.push({
          ...baseEvent,
          category: "tool_lifecycle",
          type: "tool-call-result",
          toolCallId,
          result: stringifyCanonicalToolResult(blockRecord?.content),
          isError: readBoolean(blockRecord, "is_error") ?? false,
          completedAt: timestamp,
        });
      }
    }

    return {
      canonicalEvents: events,
      nextCanonicalSeqAfterBatch: nextCanonicalSeq,
      canonicalRunStartedEmittedAfterBatch: canonicalRunStartedEmitted,
    };
  }

  private getOrCreateDaemonEventRunState(
    threadChatId: string,
  ): DaemonEventRunState {
    const existing = this.daemonEventRunStates.get(threadChatId);
    if (existing) {
      return existing;
    }
    const created: DaemonEventRunState = {
      runId: randomUUID(),
      nextSeq: 0,
      nextCanonicalSeq: 0,
      nextDeltaSeq: 0,
      agent: null,
      model: null,
      transportMode: "legacy",
      protocolVersion: 1,
      acpServerId: null,
      acpSessionId: null,
      canonicalRunStartedEmitted: false,
      cleanupRequested: false,
      pendingEnvelope: null,
    };
    this.daemonEventRunStates.set(threadChatId, created);
    return created;
  }

  private createDaemonEventEnvelope({
    threadId,
    threadChatId,
    messages,
    entryCount,
  }: {
    threadId: string;
    threadChatId: string;
    messages: ClaudeMessage[];
    entryCount: number;
  }): DaemonEventEnvelopePayload {
    const runState = this.getOrCreateDaemonEventRunState(threadChatId);
    const messagesFingerprint = this.getMessageFingerprint(messages);
    const pendingEnvelope = runState.pendingEnvelope;
    if (pendingEnvelope) {
      if (pendingEnvelope.messagesFingerprint !== messagesFingerprint) {
        this.runtime.logger.warn(
          "Pending daemon envelope fingerprint mismatch; reusing pending identity until ack",
          {
            threadChatId,
            expectedFingerprint: pendingEnvelope.messagesFingerprint,
            actualFingerprint: messagesFingerprint,
          },
        );
      }
      return {
        payloadVersion: 2,
        eventId: pendingEnvelope.eventId,
        runId: runState.runId,
        seq: pendingEnvelope.seq,
      };
    }

    const seq = runState.nextSeq;
    runState.nextSeq += 1;
    const eventId = createHash("sha256")
      .update(`${runState.runId}:${seq}`)
      .digest("hex");
    const canonicalBatch = this.buildCanonicalEventsForBatch({
      runState,
      threadId,
      threadChatId,
      messages,
    });
    runState.pendingEnvelope = {
      messagesFingerprint,
      eventId,
      seq,
      entryCount,
      canonicalEvents: canonicalBatch.canonicalEvents,
      nextCanonicalSeqAfterBatch: canonicalBatch.nextCanonicalSeqAfterBatch,
      canonicalRunStartedEmittedAfterBatch:
        canonicalBatch.canonicalRunStartedEmittedAfterBatch,
    };
    this.daemonEventRunStates.set(threadChatId, runState);

    return {
      payloadVersion: 2,
      eventId,
      runId: runState.runId,
      seq,
    };
  }

  /**
   * Construct a v2 envelope for a delta-only daemon-event flush (no
   * associated messages). Each flush needs its own seq so the server can
   * treat it as a distinct event; v3-enrolled loops reject payloads without
   * the v2 envelope (`enrolled_loop_requires_v2_envelope`), which silently
   * breaks streaming even though the subsequent full-message POST still
   * succeeds.
   */
  private createDeltaOnlyDaemonEventEnvelope(
    threadChatId: string,
  ): DaemonEventEnvelopePayload {
    const runState = this.getOrCreateDaemonEventRunState(threadChatId);
    const seq = runState.nextSeq;
    runState.nextSeq += 1;
    const eventId = createHash("sha256")
      .update(`${runState.runId}:${seq}:delta-only`)
      .digest("hex");
    this.daemonEventRunStates.set(threadChatId, runState);
    return {
      payloadVersion: 2,
      eventId,
      runId: runState.runId,
      seq,
    };
  }

  private markDaemonEventEnvelopeDelivered({
    threadChatId,
    eventId,
  }: {
    threadChatId: string;
    eventId: string;
  }): void {
    const runState = this.daemonEventRunStates.get(threadChatId);
    if (!runState?.pendingEnvelope) {
      return;
    }
    if (runState.pendingEnvelope.eventId !== eventId) {
      return;
    }
    runState.nextCanonicalSeq =
      runState.pendingEnvelope.nextCanonicalSeqAfterBatch;
    runState.canonicalRunStartedEmitted =
      runState.pendingEnvelope.canonicalRunStartedEmittedAfterBatch;
    runState.pendingEnvelope = null;
    this.daemonEventRunStates.set(threadChatId, runState);
    this.maybeCleanupDaemonEventRunState(threadChatId);
  }

  private clearPendingDaemonEventEnvelope(threadChatId: string): void {
    const runState = this.daemonEventRunStates.get(threadChatId);
    if (!runState?.pendingEnvelope) {
      return;
    }
    runState.pendingEnvelope = null;
    this.daemonEventRunStates.set(threadChatId, runState);
    this.maybeCleanupDaemonEventRunState(threadChatId);
  }

  private markDaemonEventRunStateForCleanup(threadChatId: string): void {
    const runState = this.daemonEventRunStates.get(threadChatId);
    if (!runState) {
      return;
    }
    runState.cleanupRequested = true;
    this.daemonEventRunStates.set(threadChatId, runState);
    this.retryBackoffs.delete(threadChatId);
  }

  private maybeCleanupDaemonEventRunState(threadChatId: string): void {
    const runState = this.daemonEventRunStates.get(threadChatId);
    if (!runState?.cleanupRequested) {
      return;
    }
    if (this.activeProcesses.has(threadChatId)) {
      return;
    }
    if (runState.pendingEnvelope) {
      return;
    }
    if (
      this.messageBuffer.some((entry) => entry.threadChatId === threadChatId)
    ) {
      return;
    }
    this.daemonEventRunStates.delete(threadChatId);
  }

  private maybeCleanupAllDaemonEventRunStates(): void {
    for (const threadChatId of this.daemonEventRunStates.keys()) {
      this.maybeCleanupDaemonEventRunState(threadChatId);
    }
  }

  private getPendingBatchEntriesForThread({
    threadChatId,
    entries,
  }: {
    threadChatId: string;
    entries: MessageBufferEntry[];
  }): MessageBufferEntry[] {
    const runState = this.daemonEventRunStates.get(threadChatId);
    const pendingEntryCount = runState?.pendingEnvelope?.entryCount ?? null;
    if (pendingEntryCount == null) {
      return entries;
    }
    if (pendingEntryCount <= 0) {
      return entries;
    }
    if (entries.length < pendingEntryCount) {
      this.runtime.logger.warn(
        "Pending daemon envelope entry count exceeded available buffered entries; retrying with available entries",
        {
          threadChatId,
          pendingEntryCount,
          availableEntries: entries.length,
        },
      );
      return entries;
    }
    return entries.slice(0, pendingEntryCount);
  }

  private onProcessStderr = (
    agent: string,
    line: string,
    threadChatId: string,
  ) => {
    this.runtime.logger.error(`${agent} stderr`, {
      line,
      threadChatId,
    });
    const activeProcessState = this.activeProcesses.get(threadChatId);
    if (activeProcessState) {
      activeProcessState.stderr.push(line);
      if (activeProcessState.stderr.length > 20) {
        activeProcessState.stderr.shift();
      }
    }
  };

  private getProcessErrorInfo = (threadChatId: string) => {
    const activeProcessState = this.activeProcesses.get(threadChatId);
    if (activeProcessState?.stderr.length) {
      return activeProcessState.stderr.join("\n");
    }
    const appServerContext = this.appServerRunContexts.get(threadChatId);
    if (appServerContext?.watchdogTriggered) {
      return "Codex app-server turn hit the watchdog timeout";
    }
    return undefined;
  };

  private getProcessDurationMs = (threadChatId: string) => {
    const activeProcessState = this.activeProcesses.get(threadChatId);
    if (activeProcessState?.startTime) {
      return Math.round(Date.now() - activeProcessState.startTime);
    }
    const appServerContext = this.appServerRunContexts.get(threadChatId);
    if (appServerContext?.startTime) {
      return Math.round(Date.now() - appServerContext.startTime);
    }
    return 0;
  };

  private updateActiveProcessState = (
    threadChatId: string,
    update: Partial<
      Pick<
        ActiveProcessState,
        | "processId"
        | "sessionId"
        | "isWorking"
        | "isStopping"
        | "isCompleted"
        | "pollInterval"
        | "acpUrl"
        | "watchdog"
      >
    >,
  ) => {
    const activeProcessState = this.activeProcesses.get(threadChatId);
    if (!activeProcessState) {
      this.runtime.logger.warn(
        "Attempt to update active process state but it is undefined.",
        { threadChatId, update },
      );
      return;
    }
    this.activeProcesses.set(threadChatId, {
      ...activeProcessState,
      ...update,
    });
  };

  private handleProcessClose = ({
    agent,
    processId,
    exitCode,
    threadChatId,
    getMockSuccessResult,
  }: {
    agent: string;
    processId: number | undefined;
    exitCode: number | null;
    threadChatId: string;
    getMockSuccessResult?: () => string;
  }) => {
    this.runtime.logger.info(`${agent} command finished`, {
      exitCode,
      processId,
      threadChatId,
    });
    const activeState = this.activeProcesses.get(threadChatId);
    if (!activeState || activeState.processId !== processId) {
      this.runtime.logger.info("Process closed but not handled", {
        processId,
        exitCode,
        threadChatId,
      });
      return;
    }
    if (exitCode !== 0 && !activeState.isStopping && !activeState.isCompleted) {
      this.addMessageToBuffer({
        agent: activeState.agent,
        message: {
          type: "custom-error",
          session_id: null,
          duration_ms: this.getProcessDurationMs(threadChatId),
          error_info: this.getProcessErrorInfo(threadChatId),
        },
        threadId: activeState.threadId,
        threadChatId: activeState.threadChatId,
        token: activeState.token,
      });
    }
    if (exitCode === 0 && typeof getMockSuccessResult === "function") {
      this.addMessageToBuffer({
        agent: activeState.agent,
        message: {
          type: "result",
          subtype: "success",
          total_cost_usd: 0,
          duration_ms: this.getProcessDurationMs(threadChatId),
          duration_api_ms: this.getProcessDurationMs(threadChatId),
          is_error: false,
          num_turns: 1,
          session_id: activeState.sessionId ?? "",
          result: getMockSuccessResult(),
        },
        threadId: activeState.threadId,
        threadChatId: activeState.threadChatId,
        token: activeState.token,
      });
    }
    // Remove this process from the map
    this.stopHeartbeat(threadChatId);
    this.activeProcesses.delete(threadChatId);
    this.markDaemonEventRunStateForCleanup(threadChatId);
  };

  private async spawnAgentProcess({
    agentName,
    command,
    env,
    input,
    onStdoutLine,
    onClose,
    getMockSuccessResult,
  }: {
    agentName: string;
    input: DaemonMessageClaude;
    command: string;
    env?: Record<string, string | undefined>;
    onStdoutLine: (line: string) => void;
    onClose?: (code: number | null) => void;
    getMockSuccessResult?: () => string;
  }): Promise<void> {
    this.runtime.logger.info("Spawning agent process", {
      agentName,
      command,
    });
    return new Promise((resolve) => {
      // Watchdog: kill process if it stops emitting output for too long
      const watchdogTimeoutMs = (() => {
        if (process.env.IDLE_TIMEOUT_MS) {
          const n = Number(process.env.IDLE_TIMEOUT_MS);
          if (Number.isFinite(n) && n > 0) return n;
        }
        return 15 * 60 * 1000; // default 15 minutes
      })();
      let spawnedProcessId: number | undefined;
      const watchdog = createIdleWatchdog({
        timeoutMs: watchdogTimeoutMs,
        logger: this.runtime.logger,
        onTimeout: async () => {
          const durationMs = this.getProcessDurationMs(input.threadChatId);
          this.runtime.logger.warn("Idle timeout reached, killing process", {
            agentName,
            processId: spawnedProcessId,
            watchdogTimeoutMs,
            durationMs,
          });
          this.addMessageToBuffer({
            agent: input.agent,
            message: {
              type: "result",
              subtype: "success",
              total_cost_usd: 0,
              duration_ms: durationMs,
              duration_api_ms: durationMs,
              is_error: true,
              num_turns: 1,
              result: `${agentName} error: no output for ${watchdogTimeoutMs / 1000}s; process killed`,
              session_id:
                this.activeProcesses.get(input.threadChatId)?.sessionId ?? "",
            },
            threadId: input.threadId,
            threadChatId: input.threadChatId,
            token: input.token,
          });
          this.killActiveProcess(input.threadChatId);
          await this.flushMessageBuffer();
        },
      });

      // Update MCP config with current env vars so the MCP server subprocess
      // can reach the Terragon API (env vars change per dispatch).
      if (this.mcpConfigPath) {
        try {
          const raw = this.runtime.readFileSync(this.mcpConfigPath);
          const mcpConfig = JSON.parse(raw);
          if (mcpConfig?.mcpServers?.terry) {
            mcpConfig.mcpServers.terry.env = {
              ...mcpConfig.mcpServers.terry.env,
              TERRAGON_SERVER_URL: this.runtime.normalizedUrl,
              DAEMON_TOKEN: input.token,
              TERRAGON_THREAD_ID: input.threadId,
              TERRAGON_THREAD_CHAT_ID: input.threadChatId,
            };
            this.runtime.writeFileSync(
              this.mcpConfigPath,
              JSON.stringify(mcpConfig, null, 2),
            );
          }
        } catch {
          this.runtime.logger.warn("Failed to update MCP config with env vars");
        }
      }

      // Write env vars to a well-known file so the MCP server can read them
      // even when spawned by codex app-server (which reads ~/.codex/config.toml
      // and doesn't pass env vars from the JSON MCP config).
      try {
        this.runtime.writeFileSync(
          "/tmp/terragon-mcp-env.json",
          JSON.stringify({
            TERRAGON_SERVER_URL: this.runtime.normalizedUrl,
            DAEMON_TOKEN: input.token,
            TERRAGON_THREAD_ID: input.threadId,
            TERRAGON_THREAD_CHAT_ID: input.threadChatId,
          }),
        );
      } catch {
        this.runtime.logger.warn("Failed to write MCP env file");
      }

      const { processId, pollInterval } = this.runtime.spawnCommandLine(
        command,
        {
          env: {
            ...process.env,
            ...env,
            DAEMON_TOKEN: input.token,
            TERRAGON_SERVER_URL: this.runtime.normalizedUrl,
            TERRAGON_THREAD_ID: input.threadId,
            TERRAGON_THREAD_CHAT_ID: input.threadChatId,
          },
          onStdoutLine: (line) => {
            this.runtime.logger.debug("Agent output", { processId, line });
            if (line) {
              // Any output indicates activity; reset the watchdog
              watchdog.reset();
              onStdoutLine(line);
            }
          },
          onStderr: (line) => {
            watchdog.reset();
            this.onProcessStderr(agentName, line, input.threadChatId);
          },
          onError: (error: any) => {
            this.runtime.logger.error("Agent command error", {
              processId,
              error: formatError(error),
            });
          },
          onClose: (code) => {
            watchdog.clear();
            if (onClose) {
              onClose(code);
            }
            this.handleProcessClose({
              agent: agentName,
              exitCode: code,
              processId,
              threadChatId: input.threadChatId,
              getMockSuccessResult,
            });
            this.flushMessageBuffer();
            resolve();
          },
        },
      );
      if (!processId) {
        this.runtime.logger.error("Spawn failed: child process has no pid", {
          agentName,
          threadChatId: input.threadChatId,
        });
        // The child "error" event will fire and trigger handleProcessClose,
        // which will report the failure to the server. No early return here
        // so that the onClose callback path handles cleanup consistently.
      } else {
        this.runtime.logger.info("Spawned agent process", {
          agentName,
          processId,
        });
      }
      if (processId) {
        spawnedProcessId = processId;
        this.updateActiveProcessState(input.threadChatId, {
          processId,
          pollInterval,
          watchdog,
        });
        // Start the watchdog once the process is running
        watchdog.reset();
      }
    });
  }

  private async runClaudeCodeCommand(
    input: DaemonMessageClaude,
  ): Promise<void> {
    if (input.sessionId) {
      maybeFixLogsForSessionId(this.runtime, input.sessionId);
    }
    const claudeCodeParser = new ClaudeCodeParser();
    return this.spawnAgentProcess({
      agentName: "Claude",
      input,
      command: claudeCommand({
        runtime: this.runtime,
        prompt: input.prompt,
        sessionId: input.sessionId,
        model: input.model,
        mcpConfigPath: this.mcpConfigPath ?? null,
        permissionMode: input.permissionMode,
        enableMcpPermissionPrompt: this.getFeatureFlag("mcpPermissionPrompt"),
      }),
      env: {
        ANTHROPIC_API_KEY: getAnthropicApiKeyOrNull(this.runtime),
        BASH_MAX_TIMEOUT_MS: (60 * 1000).toString(),
        ...(!!input.useCredits
          ? {
              ANTHROPIC_BASE_URL: `${this.runtime.normalizedUrl}/api/proxy/anthropic`,
              ANTHROPIC_AUTH_TOKEN: input.token,
            }
          : {}),
      },
      onStdoutLine: (line) => {
        try {
          const { messages, metaEvents, deltas } =
            claudeCodeParser.parseClaudeCodeLine(line);

          // Enqueue meta events (session.initialized, usage.incremental, message.stop)
          for (const metaEvent of metaEvents) {
            this.enqueueMetaEvent({
              metaEvent,
              threadId: input.threadId,
              threadChatId: input.threadChatId,
              token: input.token,
            });
          }

          // Push text/thinking deltas into the delta buffer
          if (deltas.length > 0) {
            for (const delta of deltas) {
              if (delta.kind !== "text" && delta.kind !== "thinking") {
                continue;
              }
              this.enqueueDelta({
                threadId: input.threadId,
                threadChatId: input.threadChatId,
                token: input.token,
                messageId: delta.messageId,
                partIndex: delta.partIndex,
                kind: delta.kind,
                text: delta.text,
              });
            }
          }

          // Push parsed chat messages into the message buffer
          for (const outputMessage of messages) {
            const sessionId = (outputMessage as any).session_id;
            if (sessionId) {
              this.updateActiveProcessState(input.threadChatId, {
                sessionId,
                isWorking: true,
              });
            }
            if (outputMessage.type === "result") {
              this.updateActiveProcessState(input.threadChatId, {
                isCompleted: true,
              });
            }
            this.addMessageToBuffer({
              agent: "claudeCode",
              message: outputMessage,
              threadId: input.threadId,
              threadChatId: input.threadChatId,
              token: input.token,
            });
          }
        } catch (e) {
          this.runtime.logger.error("Failed to parse Claude output line", {
            line,
            error: formatError(e),
          });
        }
      },
    });
  }

  private async runOpencodeCommand(input: DaemonMessageClaude): Promise<void> {
    return this.spawnAgentProcess({
      agentName: "Opencode",
      input,
      command: opencodeCommand({
        runtime: this.runtime,
        prompt: input.prompt,
        model: input.model,
        sessionId: input.sessionId,
      }),
      env: {
        OPENCODE_API_KEY: getOpencodeApiKeyOrNull(this.runtime),
      },
      getMockSuccessResult: () => "Opencode successfully completed",
      onStdoutLine: (line) => {
        const activeProcessState = this.activeProcesses.get(input.threadChatId);
        const parsedMessages = parseOpencodeLine({
          line,
          runtime: this.runtime,
          isWorking: !!activeProcessState?.isWorking,
        });
        for (const parsedMessage of parsedMessages) {
          const type = parsedMessage.type;
          const sessionId = parsedMessage.session_id;
          if (type === "system" && sessionId) {
            this.updateActiveProcessState(input.threadChatId, {
              sessionId,
              isWorking: true,
            });
          } else if (
            activeProcessState?.sessionId &&
            (type === "assistant" || type === "user")
          ) {
            parsedMessage.session_id = activeProcessState.sessionId;
          }
          if (type === "result") {
            this.updateActiveProcessState(input.threadChatId, {
              isCompleted: true,
            });
          }
          this.addMessageToBuffer({
            agent: "opencode",
            message: parsedMessage,
            threadId: input.threadId,
            threadChatId: input.threadChatId,
            token: input.token,
          });
        }
      },
    });
  }

  private async runAmpCommand(input: DaemonMessageClaude): Promise<void> {
    return this.spawnAgentProcess({
      agentName: "Amp",
      command: ampCommand({
        runtime: this.runtime,
        prompt: input.prompt,
        sessionId: input.sessionId,
      }),
      env: { AMP_API_KEY: getAmpApiKeyOrNull(this.runtime) },
      input,
      onStdoutLine: (line) => {
        try {
          const outputMessage = JSON.parse(line);
          if (outputMessage.type === "result") {
            this.updateActiveProcessState(input.threadChatId, {
              isCompleted: true,
            });
          }
          if (
            outputMessage.type === "user" &&
            outputMessage.message?.role === "user" &&
            outputMessage.message?.content?.[0]?.type === "text"
          ) {
            // Ignore this message because amp echos the first message from the user.
            this.runtime.logger.debug("Ignoring Amp user message", {
              message: outputMessage,
            });
            return;
          }
          this.addMessageToBuffer({
            agent: "amp",
            message: outputMessage,
            threadId: input.threadId,
            threadChatId: input.threadChatId,
            token: input.token,
          });
        } catch (e) {
          this.runtime.logger.error("Failed to parse Amp output line", {
            line,
            error: e,
          });
        }
      },
    });
  }

  private async runCodexCommand(input: DaemonMessageClaude): Promise<void> {
    const parserState = createCodexParserState();
    return this.spawnAgentProcess({
      agentName: "Codex",
      input,
      command: codexCommand({
        runtime: this.runtime,
        prompt: input.prompt,
        model: input.model,
        sessionId: input.sessionId,
        useCredits: !!input.useCredits,
      }),
      getMockSuccessResult: () => "Codex successfully completed",
      onStdoutLine: (line) => {
        // Parse the line into ClaudeMessage format
        const parsedMessages = parseCodexLine({
          line,
          runtime: this.runtime,
          state: parserState,
        });
        const activeProcessState = this.activeProcesses.get(input.threadChatId);
        for (const parsedMessage of parsedMessages) {
          const type = parsedMessage.type;
          const sessionId = parsedMessage.session_id;
          if (type === "system" && sessionId) {
            this.updateActiveProcessState(input.threadChatId, {
              sessionId,
              isWorking: true,
            });
          } else if (
            activeProcessState?.sessionId &&
            (type === "assistant" || type === "user")
          ) {
            parsedMessage.session_id = activeProcessState.sessionId;
          }
          this.addMessageToBuffer({
            agent: "codex",
            message: parsedMessage,
            threadId: input.threadId,
            threadChatId: input.threadChatId,
            token: input.token,
          });
          if (parsedMessage.type === "result") {
            this.updateActiveProcessState(input.threadChatId, {
              isCompleted: true,
            });
            if (parsedMessage.is_error) {
              this.flushMessageBuffer();
            }
          }
        }
      },
    });
  }

  private async runGeminiCommand(input: DaemonMessageClaude): Promise<void> {
    // Create parser state for accumulating deltas
    const parserState = createGeminiParserState();
    return this.spawnAgentProcess({
      agentName: "Gemini",
      command: geminiCommand({
        runtime: this.runtime,
        prompt: input.prompt,
        model: input.model,
        sessionId: input.sessionId,
      }),
      env: {
        GOOGLE_GEMINI_BASE_URL: `${this.runtime.normalizedUrl}/api/proxy/google`,
        GEMINI_API_KEY: input.token,
      },
      input,
      onStdoutLine: (line) => {
        // Parse the line into ClaudeMessage format
        const parsedMessages = parseGeminiLine({
          line,
          runtime: this.runtime,
          state: parserState,
        });
        const activeProcessState = this.activeProcesses.get(input.threadChatId);
        for (const parsedMessage of parsedMessages) {
          const type = parsedMessage.type;
          const sessionId = parsedMessage.session_id;
          if (type === "system" && sessionId) {
            this.updateActiveProcessState(input.threadChatId, {
              sessionId,
              isWorking: true,
            });
          } else if (
            activeProcessState?.sessionId &&
            (type === "assistant" || type === "user")
          ) {
            parsedMessage.session_id = activeProcessState.sessionId;
          }
          if (type === "result") {
            this.updateActiveProcessState(input.threadChatId, {
              isCompleted: true,
            });
          }
          this.addMessageToBuffer({
            agent: "gemini",
            message: parsedMessage,
            threadId: input.threadId,
            threadChatId: input.threadChatId,
            token: input.token,
          });
        }
      },
      onClose: () => {
        // Flush any remaining accumulated content
        if (parserState.accumulatedContent) {
          const activeProcessState = this.activeProcesses.get(
            input.threadChatId,
          );
          this.addMessageToBuffer({
            agent: "gemini",
            message: {
              type: "assistant",
              message: {
                role: "assistant",
                content: [
                  { type: "text", text: parserState.accumulatedContent },
                ],
              },
              parent_tool_use_id: null,
              session_id: activeProcessState?.sessionId || "",
            },
            threadId: input.threadId,
            threadChatId: input.threadChatId,
            token: input.token,
          });
        }
      },
    });
  }

  private processMessagesForSending(
    entries: MessageBufferEntry[],
  ): MessageBufferEntry[] {
    if (entries.find((e) => e.agent === "gemini" || e.agent === "codex")) {
      const errorEntry = entries.find(
        (e) => e.message.type === "result" && e.message.is_error,
      );
      if (errorEntry) {
        this.updateActiveProcessState(errorEntry.threadChatId, {
          isStopping: true,
        });
        this.killActiveProcess(errorEntry.threadChatId);
      }
    }

    if (entries.find((e) => e.agent === "claudeCode" || e.agent === "codex")) {
      this.runtime.logger.info(
        "Processing Task messages for agent metadata enrichment",
        {
          messageCount: entries.length,
          claudeMessageCount: entries.filter((e) => e.agent === "claudeCode")
            .length,
          codexMessageCount: entries.filter((e) => e.agent === "codex").length,
        },
      );

      return entries.map((entry) => {
        if (
          (entry.agent === "claudeCode" || entry.agent === "codex") &&
          entry.message.type === "assistant"
        ) {
          const message = entry.message.message;
          if ("content" in message && Array.isArray(message.content)) {
            for (const content of message.content) {
              if (
                content.type === "tool_use" &&
                content.name === "Task" &&
                "input" in content
              ) {
                const input = content.input as any;
                if (input.subagent_type) {
                  this.runtime.logger.info(
                    "Found Task tool with subagent_type",
                    {
                      subagent_type: input.subagent_type,
                      description: input.description?.substring(0, 50) + "...",
                    },
                  );

                  const agentProps =
                    this.agentFrontmatterReader.getAgentProperties(
                      input.subagent_type,
                    );

                  if (agentProps) {
                    this.runtime.logger.info(
                      "Found agent properties for subagent",
                      {
                        subagent_type: input.subagent_type,
                        hasColor: !!agentProps.color,
                        color: agentProps.color || "(no color)",
                      },
                    );

                    if (agentProps.color) {
                      // Add color metadata to the input parameters
                      input._agent_color = agentProps.color;
                      this.runtime.logger.info(
                        "Added agent color to Task tool input",
                        {
                          subagent_type: input.subagent_type,
                          color: agentProps.color,
                        },
                      );
                    }
                  } else {
                    this.runtime.logger.info(
                      "No agent properties found for subagent",
                      {
                        subagent_type: input.subagent_type,
                        availableAgents: Array.from(
                          this.agentFrontmatterReader.getAllAgents().keys(),
                        ),
                      },
                    );
                  }
                }
              }
            }
          }
        }
        return entry;
      });
    }

    return entries;
  }

  /**
   * Queue a meta event for delivery on the next daemon-event POST.
   * Meta events are piggybacked on the existing `/api/daemon-event` endpoint
   * via the optional `metaEvents` field in `DaemonEventAPIBody`.
   */
  private enqueueMetaEvent(entry: {
    metaEvent: ThreadMetaEvent;
    threadId: string;
    threadChatId: string;
    token: string;
  }): void {
    this.metaEventBuffer.push(entry);
    // Fast-path: flush meta events immediately at 16ms (60fps) for smooth streaming
    if (!this.isFlushInProgress && !this.messageFlushTimer) {
      this.messageFlushTimer = setTimeout(() => {
        this.flushMessageBuffer();
      }, 16);
    }
  }

  private enqueueDelta(entry: {
    threadId: string;
    threadChatId: string;
    token: string;
    messageId: string;
    partIndex: number;
    kind: "text" | "thinking";
    text: string;
  }): void {
    const runState = this.getOrCreateDaemonEventRunState(entry.threadChatId);
    const deltaSeq = runState.nextDeltaSeq;
    runState.nextDeltaSeq += 1;
    this.deltaBuffer.push({
      ...entry,
      deltaSeq,
    });
    // Fast-path: flush deltas immediately at 16ms (60fps) for smooth streaming
    // This is independent of message buffer flush timing
    if (!this.isFlushInProgress && !this.messageFlushTimer) {
      this.messageFlushTimer = setTimeout(() => {
        this.flushMessageBuffer();
      }, 16);
    }
  }

  /**
   * Add a message to the buffer and trigger debounced sending
   */
  private addMessageToBuffer(entry: MessageBufferEntry): void {
    this.getRetryBackoff(entry.threadChatId).reset();
    this.messageBuffer.push(entry);
    this.runtime.logger.debug("Added message to buffer", {
      bufferSize: this.messageBuffer.length,
    });

    // If a flush is in progress, mark that another flush is needed
    if (this.isFlushInProgress) {
      this.pendingFlushRequired = true;
      return;
    }

    // Clear existing timer and set a new one
    if (this.messageFlushTimer) {
      clearTimeout(this.messageFlushTimer);
    }
    this.messageFlushTimer = setTimeout(() => {
      this.flushMessageBuffer();
    }, this.messageFlushDelay);
  }

  /**
   * Send all buffered messages to the API and clear the buffer
   */
  private async flushMessageBuffer(): Promise<void> {
    // Prevent concurrent flushes
    if (this.isFlushInProgress) {
      this.pendingFlushRequired = true;
      return;
    }

    if (
      this.messageBuffer.length === 0 &&
      this.deltaBuffer.length === 0 &&
      this.metaEventBuffer.length === 0
    ) {
      this.maybeCleanupAllDaemonEventRunStates();
      return;
    }

    this.isFlushInProgress = true;
    this.pendingFlushRequired = false;

    let retryDelayOverrideMs: number | null = null;
    let pendingSelfDispatch: {
      payload: SdlcSelfDispatchPayload;
      originalThreadChatId: string;
    } | null = null;
    try {
      if (this.messageFlushTimer) {
        clearTimeout(this.messageFlushTimer);
        this.messageFlushTimer = null;
      }

      const messageBufferCopy = [...this.messageBuffer];
      this.messageBuffer = [];

      // Group messages by threadChatId so each thread flushes independently
      const groupsOrdered: Array<{
        threadChatId: string;
        entries: MessageBufferEntry[];
      }> = [];
      const groupMap = new Map<string, MessageBufferEntry[]>();
      for (const entry of messageBufferCopy) {
        const threadChatId = entry.threadChatId;
        let group = groupMap.get(threadChatId);
        if (!group) {
          group = [];
          groupMap.set(threadChatId, group);
          groupsOrdered.push({ threadChatId, entries: group });
        }
        group.push(entry);
      }

      const handledEntries = new Set<MessageBufferEntry>();
      const failedGroups: Array<{
        threadId: string;
        threadChatId: string;
        messageCount: number;
        error: unknown;
      }> = [];
      const timezone = this.getCurrentTimezone();

      for (const group of groupsOrdered) {
        const entriesToSend = this.getPendingBatchEntriesForThread({
          threadChatId: group.threadChatId,
          entries: group.entries,
        });
        if (entriesToSend.length === 0) {
          continue;
        }
        const lastEntry = entriesToSend[entriesToSend.length - 1]!;
        const threadId = lastEntry.threadId;
        const threadChatId = lastEntry.threadChatId;
        const token = lastEntry.token;
        const processedEntriesToSend =
          this.processMessagesForSending(entriesToSend);
        if (processedEntriesToSend.length === 0) {
          for (const entry of entriesToSend) {
            handledEntries.add(entry);
          }
          if (entriesToSend.length < group.entries.length) {
            this.pendingFlushRequired = true;
          }
          continue;
        }

        try {
          const messagesToSend = coalesceAssistantTextMessages(
            processedEntriesToSend.map((e) => e.message),
          );
          const codexPreviousResponseEntry = [...processedEntriesToSend]
            .reverse()
            .find((entry) => entry.codexPreviousResponseId !== undefined);
          const codexPreviousResponseId = codexPreviousResponseEntry
            ? codexPreviousResponseEntry.codexPreviousResponseId
            : undefined;
          const selfDispatchResult = await this.sendMessagesToAPI({
            messages: messagesToSend,
            entryCount: entriesToSend.length,
            timezone,
            token,
            threadId,
            threadChatId,
            codexPreviousResponseId,
          });
          // Track self-dispatch payload from terminal batches
          if (selfDispatchResult) {
            const hasTerminalMessage = messagesToSend.some(
              (m) =>
                m.type === "result" ||
                m.type === "custom-error" ||
                m.type === "custom-stop",
            );
            if (hasTerminalMessage) {
              pendingSelfDispatch = {
                payload: selfDispatchResult,
                originalThreadChatId: threadChatId,
              };
            }
          }
          for (const entry of entriesToSend) {
            handledEntries.add(entry);
          }
          if (entriesToSend.length < group.entries.length) {
            this.pendingFlushRequired = true;
          }
        } catch (error) {
          failedGroups.push({
            threadId,
            threadChatId,
            messageCount: processedEntriesToSend.length,
            error,
          });
        }
      }

      // Send any remaining deltas / meta events that weren't drained by
      // sendMessagesToAPI (e.g., delta-only or meta-only flush with no
      // messages for that threadChatId).
      if (this.deltaBuffer.length > 0 || this.metaEventBuffer.length > 0) {
        type RemainingTail = {
          threadId: string;
          threadChatId: string;
          token: string;
          deltas: DaemonDelta[];
          metaEvents: ThreadMetaEvent[];
        };
        const tailByThread = new Map<string, RemainingTail>();
        const ensure = (
          threadChatId: string,
          threadId: string,
          token: string,
        ): RemainingTail => {
          let t = tailByThread.get(threadChatId);
          if (!t) {
            t = {
              threadId,
              threadChatId,
              token,
              deltas: [],
              metaEvents: [],
            };
            tailByThread.set(threadChatId, t);
          }
          return t;
        };
        for (const d of this.deltaBuffer) {
          ensure(d.threadChatId, d.threadId, d.token).deltas.push({
            messageId: d.messageId,
            partIndex: d.partIndex,
            deltaSeq: d.deltaSeq,
            kind: d.kind,
            text: d.text,
          });
        }
        for (const entry of this.metaEventBuffer) {
          ensure(
            entry.threadChatId,
            entry.threadId,
            entry.token,
          ).metaEvents.push(entry.metaEvent);
        }
        this.deltaBuffer = [];
        this.metaEventBuffer = [];

        for (const tail of tailByThread.values()) {
          try {
            const runState = this.getOrCreateDaemonEventRunState(
              tail.threadChatId,
            );
            const deltaEnvelope = this.createDeltaOnlyDaemonEventEnvelope(
              tail.threadChatId,
            );
            const tailPayload: DaemonEventAPIBody = {
              messages: [],
              threadId: tail.threadId,
              timezone,
              threadChatId: tail.threadChatId,
              transportMode: runState.transportMode,
              protocolVersion: runState.protocolVersion,
              acpServerId: runState.acpServerId,
              acpSessionId: runState.acpSessionId,
              payloadVersion: deltaEnvelope.payloadVersion,
              eventId: deltaEnvelope.eventId,
              runId: deltaEnvelope.runId,
              seq: deltaEnvelope.seq,
              ...(tail.deltas.length > 0 ? { deltas: tail.deltas } : {}),
              ...(tail.metaEvents.length > 0
                ? { metaEvents: tail.metaEvents }
                : {}),
            };
            await this.runtime.serverPost(tailPayload, tail.token);
          } catch (error) {
            // Deltas + meta events are ephemeral — log and drop on failure
            this.runtime.logger.warn("Tail flush failed", {
              threadId: tail.threadId,
              deltaCount: tail.deltas.length,
              metaEventCount: tail.metaEvents.length,
              error,
            });
          }
        }
      }

      const unsentEntries = messageBufferCopy.filter(
        (entry) => !handledEntries.has(entry),
      );
      if (unsentEntries.length > 0) {
        this.messageBuffer = [...unsentEntries, ...this.messageBuffer];
        if (failedGroups.length === 0) {
          this.pendingFlushRequired = true;
        }
      }

      if (failedGroups.length > 0) {
        // Detect permanent auth errors (401/403) — drop messages instead of retrying forever.
        // These indicate an invalid token that won't become valid on its own.
        const retryableGroups = failedGroups.filter((g) => {
          if (isNonRetryableAuthError(g.error)) {
            this.runtime.logger.error(
              "Permanent auth error — dropping messages (token is invalid, retrying won't help)",
              {
                error: formatError(g.error),
                messageCount: g.messageCount,
                threadId: g.threadId,
                threadChatId: g.threadChatId,
              },
            );
            this.getRetryBackoff(g.threadChatId).reset();
            // Remove these messages from the buffer
            this.messageBuffer = this.messageBuffer.filter(
              (entry) => entry.threadChatId !== g.threadChatId,
            );
            this.clearPendingDaemonEventEnvelope(g.threadChatId);
            return false;
          }
          return true;
        });

        const allClaimInProgress =
          retryableGroups.length > 0 &&
          retryableGroups.every((failedGroup) =>
            isDaemonEventClaimInProgressError(failedGroup.error),
          );
        if (allClaimInProgress) {
          for (const failedGroup of retryableGroups) {
            this.getRetryBackoff(failedGroup.threadChatId).reset();
            this.runtime.logger.warn(
              "Daemon event claim is in progress; preserving payload identity and retrying",
              {
                error: formatError(failedGroup.error),
                messageCount: failedGroup.messageCount,
                threadId: failedGroup.threadId,
                threadChatId: failedGroup.threadChatId,
                retryingIn: DAEMON_EVENT_CLAIM_IN_PROGRESS_RETRY_MS,
              },
            );
          }
          retryDelayOverrideMs = DAEMON_EVENT_CLAIM_IN_PROGRESS_RETRY_MS;
          this.pendingFlushRequired = true;
        } else if (retryableGroups.length > 0) {
          for (const failedGroup of retryableGroups) {
            const backoff = this.getRetryBackoff(failedGroup.threadChatId);
            backoff.increment();
            const retryInOrNull = backoff.retryIn();
            if (retryInOrNull === null) {
              this.runtime.logger.error(
                "Max retries reached for this message group, scheduling fallback retry",
                {
                  error: formatError(failedGroup.error),
                  messageCount: failedGroup.messageCount,
                  threadId: failedGroup.threadId,
                  threadChatId: failedGroup.threadChatId,
                  attempt: backoff.retryAttempt,
                },
              );
              backoff.reset();
            } else {
              this.runtime.logger.error(
                "API call failed for message group, will retry messages",
                {
                  error: formatError(failedGroup.error),
                  messageCount: failedGroup.messageCount,
                  threadId: failedGroup.threadId,
                  threadChatId: failedGroup.threadChatId,
                  retryingIn: retryInOrNull,
                  attempt: backoff.retryAttempt,
                },
              );
            }
          }
          this.pendingFlushRequired = true;
        }
      } else if (handledEntries.size > 0) {
        // Reset backoff for successfully flushed threads
        for (const entry of handledEntries) {
          this.getRetryBackoff(entry.threadChatId).reset();
        }
      } else if (handledEntries.size === 0) {
        this.runtime.logger.info("All messages filtered out, nothing to send");
      }
    } finally {
      this.isFlushInProgress = false;
    }
    // If new messages arrived while we were flushing, or if we need to retry
    if (
      this.pendingFlushRequired &&
      (this.messageBuffer.length > 0 || this.deltaBuffer.length > 0)
    ) {
      // Compute minimum retry delay across all threads that have pending retries
      let minRetryDelay: number | null = null;
      for (const [, backoff] of this.retryBackoffs) {
        const delay = backoff.retryIn();
        if (
          delay !== null &&
          (minRetryDelay === null || delay < minRetryDelay)
        ) {
          minRetryDelay = delay;
        }
      }
      const delay =
        retryDelayOverrideMs ?? minRetryDelay ?? this.messageFlushDelay;
      this.messageFlushTimer = setTimeout(() => {
        this.flushMessageBuffer();
      }, delay);
    }
    this.maybeCleanupAllDaemonEventRunStates();

    // SDLC self-dispatch: if the server included a follow-up payload in the
    // terminal batch response, start the new run now that flush is complete.
    if (pendingSelfDispatch) {
      this.startSelfDispatchRun(pendingSelfDispatch);
    }
  }

  /**
   * Send an array of messages to the API endpoint
   */
  private async sendMessagesToAPI({
    messages,
    entryCount,
    timezone,
    token,
    threadId,
    threadChatId,
    codexPreviousResponseId,
  }: {
    messages: ClaudeMessage[];
    entryCount: number;
    timezone: string;
    token: string;
    threadId: string;
    threadChatId: string;
    codexPreviousResponseId?: string | null;
  }): Promise<SdlcSelfDispatchPayload | null> {
    try {
      this.runtime.logger.info("Sending messages to API", {
        messageCount: messages.length,
        threadId,
      });
      const envelopeV2 = this.shouldEmitDaemonEventEnvelopeV2(threadChatId)
        ? this.createDaemonEventEnvelope({
            threadId,
            threadChatId,
            messages,
            entryCount,
          })
        : null;
      const runState = this.getOrCreateDaemonEventRunState(threadChatId);
      const canonicalEvents =
        messages.length > 0
          ? (runState.pendingEnvelope?.canonicalEvents ?? [])
          : [];
      const hasTerminalMessage = messages.some(
        (m) =>
          m.type === "result" ||
          m.type === "custom-error" ||
          m.type === "custom-stop",
      );
      let headShaAtCompletion: string | null = null;
      if (hasTerminalMessage) {
        try {
          const sha = this.runtime
            .execSync("git rev-parse HEAD 2>/dev/null")
            .trim();
          if (/^[0-9a-f]{40}$/i.test(sha)) {
            headShaAtCompletion = sha;
          }
        } catch {
          /* no git repo or git not available */
        }
      }
      // Drain deltas matching this threadChatId
      const matchingDeltas: DaemonDelta[] = [];
      const remainingDeltas: typeof this.deltaBuffer = [];
      for (const d of this.deltaBuffer) {
        if (d.threadChatId === threadChatId) {
          matchingDeltas.push({
            messageId: d.messageId,
            partIndex: d.partIndex,
            deltaSeq: d.deltaSeq,
            kind: d.kind,
            text: d.text,
          });
        } else {
          remainingDeltas.push(d);
        }
      }
      this.deltaBuffer = remainingDeltas;

      // Drain meta events matching this threadChatId — they ride on the same
      // POST as messages so the client sees them within one broadcast round
      // trip rather than requiring a separate endpoint.
      const matchingMetaEvents: ThreadMetaEvent[] = [];
      const remainingMetaEvents: typeof this.metaEventBuffer = [];
      for (const entry of this.metaEventBuffer) {
        if (entry.threadChatId === threadChatId) {
          matchingMetaEvents.push(entry.metaEvent);
        } else {
          remainingMetaEvents.push(entry);
        }
      }
      this.metaEventBuffer = remainingMetaEvents;

      const payload: DaemonEventAPIBody = {
        messages,
        threadId,
        timezone,
        threadChatId,
        transportMode: runState.transportMode,
        protocolVersion: runState.protocolVersion,
        acpServerId: runState.acpServerId,
        acpSessionId: runState.acpSessionId,
        ...(codexPreviousResponseId !== undefined
          ? { codexPreviousResponseId }
          : {}),
        ...(envelopeV2 ?? {}),
        ...(headShaAtCompletion ? { headShaAtCompletion } : {}),
        ...(canonicalEvents.length > 0 ? { canonicalEvents } : {}),
        ...(matchingDeltas.length > 0 ? { deltas: matchingDeltas } : {}),
        ...(matchingMetaEvents.length > 0
          ? { metaEvents: matchingMetaEvents }
          : {}),
      };

      const selfDispatchPayload = await this.runtime.serverPost(payload, token);
      if (envelopeV2) {
        this.markDaemonEventEnvelopeDelivered({
          threadChatId,
          eventId: envelopeV2.eventId,
        });
      }
      this.runtime.logger.info("Messages sent successfully", {
        messageCount: messages.length,
      });
      return selfDispatchPayload;
    } catch (error) {
      this.runtime.logger.error("Failed to send messages to API", {
        error: formatError(error),
        messageCount: messages.length,
      });
      // Re-throw the error so flushMessageBuffer can handle it
      throw error;
    }
  }

  /**
   * Get a specific feature flag value
   */
  public getFeatureFlag(name: keyof FeatureFlags): boolean {
    return this.featureFlags[name] ?? false;
  }

  // ── Heartbeat ────────────────────────────────────────────────────────
  // Periodically POSTs an empty `messages: []` event to keep all timeout
  // layers alive (daemon watchdog, sandbox auto-pause, stalled-tasks cron).

  private getHeartbeatIntervalMs(): number {
    if (process.env.HEARTBEAT_INTERVAL_MS) {
      const n = Number(process.env.HEARTBEAT_INTERVAL_MS);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return DEFAULT_HEARTBEAT_INTERVAL_MS;
  }

  private startHeartbeat(threadChatId: string): void {
    this.stopHeartbeat(threadChatId); // clear any stale timer
    const intervalMs = this.getHeartbeatIntervalMs();
    const timer = setInterval(() => {
      this.sendHeartbeat(threadChatId);
    }, intervalMs);
    this.heartbeatTimers.set(threadChatId, timer);
  }

  private stopHeartbeat(threadChatId: string): void {
    const timer = this.heartbeatTimers.get(threadChatId);
    if (timer) {
      clearInterval(timer);
      this.heartbeatTimers.delete(threadChatId);
    }
  }

  private sendHeartbeat(threadChatId: string): void {
    const processState = this.activeProcesses.get(threadChatId);
    if (processState) {
      if (processState.isCompleted || processState.isStopping) {
        this.stopHeartbeat(threadChatId);
        return;
      }
      // Reset idle watchdog so it doesn't kill the process during silent operations
      if (processState.watchdog) {
        processState.watchdog.reset();
      }
      // Best-effort POST with empty messages — errors are logged but ignored
      this.sendMessagesToAPI({
        messages: [],
        entryCount: 0,
        timezone:
          Intl.DateTimeFormat().resolvedOptions().timeZone ||
          "America/New_York",
        token: processState.token,
        threadId: processState.threadId,
        threadChatId: processState.threadChatId,
      }).catch((error) => {
        this.runtime.logger.error("Heartbeat failed", {
          threadChatId,
          error: formatError(error),
        });
      });
      return;
    }

    const appServerContext = this.appServerRunContexts.get(threadChatId);
    if (
      !appServerContext ||
      appServerContext.isCompleted ||
      appServerContext.isStopping
    ) {
      this.stopHeartbeat(threadChatId);
      return;
    }

    this.sendMessagesToAPI({
      messages: [],
      entryCount: 0,
      timezone:
        Intl.DateTimeFormat().resolvedOptions().timeZone || "America/New_York",
      token: appServerContext.token,
      threadId: appServerContext.daemonThreadId,
      threadChatId: appServerContext.threadChatId,
    }).catch((error) => {
      this.runtime.logger.error("Heartbeat failed", {
        threadChatId,
        error: formatError(error),
      });
    });
  }

  private async teardown(): Promise<void> {
    // Stop all heartbeat timers
    for (const threadChatId of this.heartbeatTimers.keys()) {
      this.stopHeartbeat(threadChatId);
    }
    // Send any remaining messages in the buffer
    this.killAllActiveProcesses();
    // Wait for any in-progress flush to complete before final flush
    const teardownFlushStart = Date.now();
    while (this.isFlushInProgress && Date.now() - teardownFlushStart < 10_000) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await this.flushMessageBuffer();
    // Send a kill message to the unix socket to flush our blocking listeners.
    await writeToUnixSocket({
      unixSocketPath: this.runtime.unixSocketPath,
      dataStr: JSON.stringify({ type: "kill" }),
    });
    if (this.uptimeReportingTimer) {
      clearInterval(this.uptimeReportingTimer);
    }
    if (this.messageFlushTimer) {
      clearTimeout(this.messageFlushTimer);
    }
  }
}

/**
 * Normalize the `plan` payload from a Codex `turn/plan/updated` notification
 * into the entries shape expected by the `codex-plan` ClaudeMessage. Codex
 * emits unknown-shape objects here (typed as Record<string, unknown>), so we
 * read defensively and drop malformed entries rather than crash the handler.
 */
function normalizeCodexPlanEntries(plan: Record<string, unknown>): Array<{
  id?: string;
  content: string;
  priority: "high" | "medium" | "low";
  status: "pending" | "in_progress" | "completed";
}> {
  const rawEntries = plan["entries"];
  if (!Array.isArray(rawEntries)) return [];
  return rawEntries
    .map((raw) => {
      if (!raw || typeof raw !== "object") return null;
      const r = raw as Record<string, unknown>;
      const content = typeof r["content"] === "string" ? r["content"] : null;
      if (!content) return null;
      const rawStatus = typeof r["status"] === "string" ? r["status"] : null;
      const status: "pending" | "in_progress" | "completed" =
        rawStatus === "in_progress" || rawStatus === "completed"
          ? rawStatus
          : "pending";
      const rawPriority =
        typeof r["priority"] === "string" ? r["priority"] : null;
      const priority: "high" | "medium" | "low" =
        rawPriority === "high" || rawPriority === "low"
          ? rawPriority
          : "medium";
      const id = typeof r["id"] === "string" ? r["id"] : undefined;
      return { ...(id ? { id } : {}), content, priority, status };
    })
    .filter(
      (
        v,
      ): v is {
        id?: string;
        content: string;
        priority: "high" | "medium" | "low";
        status: "pending" | "in_progress" | "completed";
      } => v !== null,
    );
}
