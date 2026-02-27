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
} from "./shared";
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
} from "./utils";
import {
  opencodeCommand,
  getOpencodeApiKeyOrNull,
  parseOpencodeLine,
} from "./opencode";
import { ampCommand, getAmpApiKeyOrNull } from "./amp";
import { codexCommand, createCodexParserState, parseCodexLine } from "./codex";
import { AgentFrontmatterReader } from "./agent-frontmatter";
import { createHash, randomUUID } from "node:crypto";

const DAEMON_EVENT_CLAIM_IN_PROGRESS_RETRY_MS = 5_000;

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

type ActiveProcessState = {
  agent: AIAgent;
  threadId: string;
  threadChatId: string;
  token: string;
  processId: number | null;
  sessionId: string | null;
  startTime: number;
  stderr: string[];
  isWorking: boolean;
  isStopping: boolean;
  isCompleted: boolean;
  pollInterval: NodeJS.Timeout | null;
};

type DaemonEventRunState = {
  runId: string;
  nextSeq: number;
  coordinatorRoutingEnabled: boolean;
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
  private daemonEventRunStates: Map<string, DaemonEventRunState> = new Map();

  private messageHandleDelay: number = 0;
  private messageFlushDelay: number = 0;
  private messageFlushTimer: NodeJS.Timeout | null = null;
  private uptimeReportingInterval: number = 0;
  private uptimeReportingTimer: NodeJS.Timeout | null = null;
  private isFlushInProgress: boolean = false;
  private pendingFlushRequired: boolean = false;
  private retryBackoff: RetryBackoff;

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
    this.retryBackoff = new RetryBackoff(retryConfig);
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
      this.activeProcesses.delete(threadChatId);
      this.markDaemonEventRunStateForCleanup(threadChatId);
    }
  }

  private killAllActiveProcesses() {
    for (const threadChatId of this.activeProcesses.keys()) {
      this.killActiveProcess(threadChatId);
    }
  }

  private hasBufferedEntriesForThread(threadChatId: string): boolean {
    return this.messageBuffer.some(
      (entry) => entry.threadChatId === threadChatId,
    );
  }

  private initializeDaemonEventRunStateForNewRun({
    threadChatId,
    coordinatorRoutingEnabled,
  }: {
    threadChatId: string;
    coordinatorRoutingEnabled: boolean;
  }): void {
    const existingRunState = this.daemonEventRunStates.get(threadChatId);
    if (
      existingRunState &&
      (existingRunState.pendingEnvelope ||
        this.hasBufferedEntriesForThread(threadChatId))
    ) {
      this.runtime.logger.debug(
        "Preserving daemon event run state due to pending envelope or buffered entries",
        {
          threadChatId,
          hasPendingEnvelope: existingRunState.pendingEnvelope != null,
          hasBufferedEntries: this.hasBufferedEntriesForThread(threadChatId),
        },
      );
      return;
    }

    this.daemonEventRunStates.set(threadChatId, {
      runId: randomUUID(),
      nextSeq: 0,
      coordinatorRoutingEnabled,
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
    // Kill any existing process for this threadChatId
    this.killActiveProcess(input.threadChatId);
    const coordinatorRoutingEnabled = this.getFeatureFlag(
      "sdlcLoopCoordinatorRouting",
    );
    // Create new process state for this threadChatId
    const newProcessState: ActiveProcessState = {
      processId: null,
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
    };
    this.activeProcesses.set(input.threadChatId, newProcessState);
    this.initializeDaemonEventRunStateForNewRun({
      threadChatId: input.threadChatId,
      coordinatorRoutingEnabled,
    });
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
    return undefined;
  };

  private getProcessDurationMs = (threadChatId: string) => {
    const activeProcessState = this.activeProcesses.get(threadChatId);
    if (activeProcessState?.startTime) {
      return Math.round(Date.now() - activeProcessState.startTime);
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
      this.runtime.logger.info("Spawned agent process", {
        agentName,
        processId,
      });
      if (processId) {
        spawnedProcessId = processId;
        this.updateActiveProcessState(input.threadChatId, {
          processId,
          pollInterval,
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
    this.retryBackoff.reset();
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
        const isTerminalBatch = processedEntriesToSend.some(({ message }) =>
          this.isTerminalMessage(message),
        );
        await this.sendMessagesToAPI({
          messages: processedEntriesToSend.map((e) => e.message),
          entryCount: entriesToSend.length,
          timezone,
          token,
          threadId,
          threadChatId,
          isTerminalBatch,
        });
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

    let retryDelayOverrideMs: number | null = null;
    if (failedGroups.length > 0) {
      const allClaimInProgress = failedGroups.every((failedGroup) =>
        isDaemonEventClaimInProgressError(failedGroup.error),
      );
      if (allClaimInProgress) {
        this.retryBackoff.reset();
        retryDelayOverrideMs = DAEMON_EVENT_CLAIM_IN_PROGRESS_RETRY_MS;
        for (const failedGroup of failedGroups) {
          this.runtime.logger.warn(
            "Daemon event claim is in progress; preserving payload identity and retrying",
            {
              error: formatError(failedGroup.error),
              messageCount: failedGroup.messageCount,
              threadId: failedGroup.threadId,
              threadChatId: failedGroup.threadChatId,
              retryingIn: retryDelayOverrideMs,
            },
          );
        }
        this.pendingFlushRequired = true;
      } else {
        this.retryBackoff.increment();
        const retryInOrNull = this.retryBackoff.retryIn();
        if (retryInOrNull === null) {
          for (const failedGroup of failedGroups) {
            this.runtime.logger.error(
              "Max retries reached for this message group, will wait for next trigger",
              {
                error: formatError(failedGroup.error),
                messageCount: failedGroup.messageCount,
                threadId: failedGroup.threadId,
                threadChatId: failedGroup.threadChatId,
                attempt: this.retryBackoff.retryAttempt,
              },
            );
          }
          // Don't set pendingFlushRequired - wait for next natural trigger
        } else {
          for (const failedGroup of failedGroups) {
            this.runtime.logger.error(
              "API call failed for message group, will retry messages",
              {
                error: formatError(failedGroup.error),
                messageCount: failedGroup.messageCount,
                threadId: failedGroup.threadId,
                threadChatId: failedGroup.threadChatId,
                retryingIn: retryInOrNull,
                attempt: this.retryBackoff.retryAttempt,
              },
            );
          }
          this.pendingFlushRequired = true;
        }
      }
    } else if (handledEntries.size > 0) {
      this.retryBackoff.reset();
    } else if (handledEntries.size === 0) {
      this.runtime.logger.info("All messages filtered out, nothing to send");
    }

    this.isFlushInProgress = false;
    // If new messages arrived while we were flushing, or if we need to retry
    if (this.pendingFlushRequired && this.messageBuffer.length > 0) {
      const retryInOrNull = this.retryBackoff.retryIn();
      const delay =
        retryDelayOverrideMs ?? retryInOrNull ?? this.messageFlushDelay;
      this.messageFlushTimer = setTimeout(() => {
        this.flushMessageBuffer();
      }, delay);
    }
    this.maybeCleanupAllDaemonEventRunStates();
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
    isTerminalBatch,
  }: {
    messages: ClaudeMessage[];
    entryCount: number;
    timezone: string;
    token: string;
    threadId: string;
    threadChatId: string;
    isTerminalBatch: boolean;
  }): Promise<void> {
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
      const endSha =
        envelopeV2 && isTerminalBatch ? this.resolveRunEndSha() : undefined;
      const payload: DaemonEventAPIBody = {
        messages,
        threadId,
        timezone,
        threadChatId,
        ...(envelopeV2 ?? {}),
        ...(typeof endSha === "undefined" ? {} : { endSha }),
      };

      await this.runtime.serverPost(payload, token);
      if (envelopeV2) {
        this.markDaemonEventEnvelopeDelivered({
          threadChatId,
          eventId: envelopeV2.eventId,
        });
      }
      this.runtime.logger.info("Messages sent successfully", {
        messageCount: messages.length,
      });
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

  private isTerminalMessage(message: ClaudeMessage): boolean {
    return (
      message.type === "custom-stop" ||
      message.type === "custom-error" ||
      message.type === "result"
    );
  }

  private resolveRunEndSha(): string | null {
    try {
      const output = this.runtime.execSync("git rev-parse HEAD");
      const sha = output.trim().split("\n").at(-1)?.trim() ?? "";
      return sha || null;
    } catch {
      return null;
    }
  }

  private async teardown(): Promise<void> {
    // Send any remaining messages in the buffer
    this.killAllActiveProcesses();
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
