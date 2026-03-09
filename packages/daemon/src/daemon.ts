import { AIAgent } from "@terragon/agent/types";
import {
  DaemonServerPostError,
  IDaemonRuntime,
  writeToUnixSocket,
} from "./runtime";
import {
  DaemonMessageClaude,
  DaemonMessageSchema,
  FeatureFlags,
  DaemonEventAPIBody,
  ClaudeMessage,
  DaemonMessage,
  DAEMON_VERSION,
  DaemonTransportMode,
  SdlcSelfDispatchPayload,
  DAEMON_CAPABILITY_SDLC_SELF_DISPATCH,
} from "./shared";
import {
  parseAcpLineToClaudeMessages,
  coalesceAssistantTextMessages,
} from "./acp-adapter";
import { performance } from "node:perf_hooks";
import { RetryBackoff, RetryConfig, DEFAULT_RETRY_CONFIG } from "./retry";
import {
  getAnthropicApiKeyOrNull,
  maybeFixLogsForSessionId,
  claudeCommand,
} from "./claude";
import {
  geminiCommand,
  parseGeminiLine,
  createGeminiParserState,
} from "./gemini";
import {
  MessageBufferEntry,
  killProcessGroup,
  createIdleWatchdog,
  IdleWatchdog,
} from "./utils";
import {
  opencodeCommand,
  getOpencodeApiKeyOrNull,
  parseOpencodeLine,
} from "./opencode";
import { ampCommand, getAmpApiKeyOrNull } from "./amp";
import {
  codexCommand,
  createCodexParserState,
  parseCodexLine,
  buildThreadStartParams,
  buildTurnStartParams,
} from "./codex";
import { CodexAppServerManager, extractThreadEvent } from "./codex-app-server";
import { tryParseAcpAsCodexEvent } from "./acp-codex-adapter";
import { AgentFrontmatterReader } from "./agent-frontmatter";
import { createHash, randomUUID } from "node:crypto";

const DAEMON_EVENT_CLAIM_IN_PROGRESS_RETRY_MS = 5_000;
const ACP_SSE_RECONNECT_DELAY_MS = 150;
const ACP_SSE_MAX_CONSECUTIVE_FAILURES = 10;
const ACP_REQUEST_TIMEOUT_MS = 120_000;
const ACP_SSE_INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000; // 10 min of SSE silence
const ACP_INACTIVITY_CHECK_INTERVAL_MS = 30_000; // check every 30s
const ACP_TERMINAL_QUIESCENCE_MS = 300;
const ACP_TERMINAL_MAX_WAIT_MS = 2_500;
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
  resolveTurnComplete: (result: AppServerTurnCompletion) => void;
  rejectTurnComplete: (error: Error) => void;
  resolveThreadReady: (threadId: string) => void;
};

type DaemonEventRunState = {
  runId: string;
  nextSeq: number;
  coordinatorRoutingEnabled: boolean;
  transportMode: DaemonTransportMode;
  protocolVersion: number;
  acpServerId: string | null;
  acpSessionId: string | null;
  cleanupRequested: boolean;
  pendingEnvelope: {
    messagesFingerprint: string;
    eventId: string;
    seq: number;
    entryCount: number;
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
  private runtime: IDaemonRuntime;
  private mcpConfigPath: string | undefined;

  private activeProcesses: Map<string, ActiveProcessState> = new Map();
  private appServerRunContexts: Map<string, AppServerRunContext> = new Map();
  private heartbeatTimers: Map<string, NodeJS.Timeout> = new Map();
  private daemonEventRunStates: Map<string, DaemonEventRunState> = new Map();
  private appServerCrashTimestamps: number[] = [];

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
    messageFlushDelay = 1000,
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
    coordinatorRoutingEnabled,
  }: {
    input: DaemonMessageClaude;
    coordinatorRoutingEnabled: boolean;
  }): void {
    this.daemonEventRunStates.set(input.threadChatId, {
      runId: input.runId ?? randomUUID(),
      nextSeq: 0,
      coordinatorRoutingEnabled,
      transportMode: input.transportMode ?? "legacy",
      protocolVersion: input.protocolVersion ?? 1,
      acpServerId: input.acpServerId ?? null,
      acpSessionId: input.acpSessionId ?? null,
      cleanupRequested: false,
      pendingEnvelope: null,
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
    }
    const coordinatorRoutingEnabled = this.getFeatureFlag(
      "sdlcLoopCoordinatorRouting",
    );
    this.initializeDaemonEventRunStateForNewRun({
      input,
      coordinatorRoutingEnabled,
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
      if (!this.getFeatureFlag("sandboxAgentAcpTransport")) {
        throw new Error(
          "ACP transport requested but sandboxAgentAcpTransport feature flag is disabled",
        );
      }
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

  private async getOrCreateAppServerManager(
    input: DaemonMessageClaude,
  ): Promise<CodexAppServerManager> {
    return new CodexAppServerManager({
      logger: this.runtime.logger,
      model: input.model,
      useCredits: !!input.useCredits,
      daemonToken: input.token,
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

    try {
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

          const threadEvent = extractThreadEvent(notification);
          if (!threadEvent) {
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
      await manager.send({
        method: "turn/start",
        threadChatId: input.threadChatId,
        params: buildTurnStartParams({
          threadId,
          prompt: input.prompt,
        }),
      });

      processHealthInterval = setInterval(() => {
        if (context.isCompleted || context.isStopping) {
          return;
        }
        if (manager.isAlive()) {
          return;
        }
        context.rejectTurnComplete(
          new Error("codex app-server exited unexpectedly during turn"),
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
            error_info:
              error instanceof Error ? error.message : "Codex app-server error",
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
          sawTerminalEventFromStream = true;
          resolveSseTerminal?.();
          this.updateActiveProcessState(input.threadChatId, {
            isCompleted: true,
          });
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

    // Track that we just restarted so we can suppress expected initial SSE 404s
    let justRestarted = true;

    const sseLoop = (async () => {
      // Brief settle after sandbox-agent restart — ACP endpoints need time to register
      await abortableSleep(300);
      let consecutiveSseFailures = 0;
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
            throw new Error(
              `ACP SSE failed (${response.status} ${response.statusText})`,
            );
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
          consecutiveSseFailures++;
          // Suppress expected 404s right after sandbox-agent restart
          if (justRestarted && consecutiveSseFailures <= 3) {
            this.runtime.logger.debug(
              "ACP SSE not yet available after restart (expected)",
              {
                threadChatId: input.threadChatId,
                serverId,
                consecutiveSseFailures,
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
      const initializeResponse = await postEnvelope({
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
      if (toObject(initializeResponse.error)) {
        throw new Error(
          `ACP initialize failed: ${JSON.stringify(initializeResponse.error)}`,
        );
      }

      let sessionId = input.acpSessionId ?? input.sessionId;
      if (!sessionId) {
        const newSessionResponse = await postEnvelope({
          method: "session/new",
          params: {
            cwd: process.cwd(),
            mcpServers: [],
          },
        });
        if (toObject(newSessionResponse.error)) {
          throw new Error(
            `ACP session/new failed: ${JSON.stringify(newSessionResponse.error)}`,
          );
        }
        const result = toObject(newSessionResponse.result);
        const newSessionId = result?.sessionId;
        if (typeof newSessionId !== "string" || newSessionId.length === 0) {
          throw new Error("ACP session/new returned invalid sessionId");
        }
        sessionId = newSessionId;
      }

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

  private shouldEmitDaemonEventEnvelopeV2(threadChatId: string): boolean {
    const runState = this.daemonEventRunStates.get(threadChatId);
    if (runState) {
      return runState.coordinatorRoutingEnabled;
    }
    return this.getFeatureFlag("sdlcLoopCoordinatorRouting");
  }

  private getMessageFingerprint(messages: ClaudeMessage[]): string {
    return createHash("sha256").update(JSON.stringify(messages)).digest("hex");
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
      coordinatorRoutingEnabled: this.getFeatureFlag(
        "sdlcLoopCoordinatorRouting",
      ),
      transportMode: "legacy",
      protocolVersion: 1,
      acpServerId: null,
      acpSessionId: null,
      cleanupRequested: false,
      pendingEnvelope: null,
    };
    this.daemonEventRunStates.set(threadChatId, created);
    return created;
  }

  private createDaemonEventEnvelope({
    threadChatId,
    messages,
    entryCount,
  }: {
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
    runState.pendingEnvelope = {
      messagesFingerprint,
      eventId,
      seq,
      entryCount,
    };
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

      const { processId, pollInterval } = this.runtime.spawnCommandLine(
        command,
        {
          env: {
            ...process.env,
            ...env,
            DAEMON_TOKEN: input.token,
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
          const outputMessage = JSON.parse(line);
          const sessionId = outputMessage.session_id;
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

    if (this.messageBuffer.length === 0) {
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
    if (this.pendingFlushRequired && this.messageBuffer.length > 0) {
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
      const { payload, originalThreadChatId } = pendingSelfDispatch;
      if (!this.activeProcesses.has(originalThreadChatId)) {
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
      } else {
        this.runtime.logger.warn(
          "Delivery Loop self-dispatch skipped: active process exists",
          { threadChatId: originalThreadChatId },
        );
      }
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
            threadChatId,
            messages,
            entryCount,
          })
        : null;
      const runState = this.getOrCreateDaemonEventRunState(threadChatId);
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
