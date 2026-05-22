"use client";

import type { AgentSubscriber, HttpAgent } from "@ag-ui/client";
import type { Message as AgUiMessage } from "@ag-ui/core";
import type {
  AddToolResultOptions,
  AppendMessage,
  AssistantRuntime,
  ChatModelRunResult,
  MessageStatus,
  ThreadAssistantMessage,
  ThreadHistoryAdapter,
  ThreadMessage,
  ThreadSystemMessage,
  ThreadUserMessage,
} from "@assistant-ui/react";
import { recordAgentTraceSpan } from "@/lib/agent-trace";
import { agUiMessagesToThreadMessages } from "./ag-ui-history-adapter";
import {
  appendTerragonDataPart,
  terragonDataPartFromCustomEvent,
  type TerragonDataPart,
  type ReadonlyJSONValue,
} from "./ag-ui-custom-parts";
import {
  TerragonRunAggregator,
  type TerragonRunEvent,
} from "./terragon-run-aggregator";
import { createTerragonAgUiSubscriber } from "./terragon-ag-ui-subscriber";
import { toAgUiMessages, toAgUiTools } from "./terragon-ag-ui-conversions";

type Logger = {
  debug?: (message: string, ...args: unknown[]) => void;
  error?: (message: string, ...args: unknown[]) => void;
};

type RunConfig = NonNullable<AppendMessage["runConfig"]>;
type ResumeRunConfig = {
  parentId: string | null;
  sourceId: string | null;
  runConfig: RunConfig;
  stream?: unknown;
};
type TerragonRunIntent = "append" | "resume";
type ScheduledNotifyHandle =
  | { kind: "animation-frame"; id: number }
  | { kind: "timeout"; id: ReturnType<typeof globalThis.setTimeout> };
type AppendFields = Pick<
  AppendMessage,
  "parentId" | "sourceId" | "runConfig" | "startRun"
>;
type AssistantAppendMessage = Omit<ThreadAssistantMessage, "id"> & AppendFields;
type UserAppendMessage = Omit<ThreadUserMessage, "id"> & AppendFields;
type SystemAppendMessage = Omit<ThreadSystemMessage, "id"> & AppendFields;

export type TerragonAgUiRuntimeCoreOptions = {
  agent: HttpAgent;
  logger: Logger;
  showThinking: boolean;
  onError?: (error: Error) => void;
  onCancel?: () => void;
  history?: ThreadHistoryAdapter;
  projectionHintRef?: TerragonRuntimeProjectionHintRef;
  notifyUpdate: () => void;
};

export type TerragonRuntimeProjectionHint = {
  version: number;
  firstChangedRuntimeMessageIndex: number | null;
};

export type TerragonRuntimeProjectionHintRef = {
  current: TerragonRuntimeProjectionHint;
};

const FALLBACK_USER_STATUS = { type: "complete", reason: "unknown" } as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function generateId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)
  );
}

function isAssistantAppendMessage(
  message: AppendMessage,
): message is AssistantAppendMessage {
  return message.role === "assistant";
}

function isUserAppendMessage(
  message: AppendMessage,
): message is UserAppendMessage {
  return message.role === "user";
}

function isSystemAppendMessage(
  message: AppendMessage,
): message is SystemAppendMessage {
  return message.role === "system";
}

export class TerragonAgUiThreadRuntimeCore {
  private agent: HttpAgent;
  private logger: Logger;
  private showThinking: boolean;
  private onError: ((error: Error) => void) | undefined;
  private onCancel: (() => void) | undefined;
  private readonly notifyUpdate: () => void;

  private runtime: AssistantRuntime | undefined;
  private messages: ThreadMessage[] = [];
  private readonly messageIndexById = new Map<string, number>();
  private isRunningFlag = false;
  private abortController: AbortController | null = null;
  private stateSnapshot: ReadonlyJSONValue | undefined;
  private pendingError: Error | null = null;
  private history: ThreadHistoryAdapter | undefined;
  private projectionHintRef: TerragonRuntimeProjectionHintRef | undefined;
  private projectionHintVersion = 0;
  private lastRunConfig: RunConfig | undefined;
  private readonly assistantHistoryParents = new Map<string, string | null>();
  private readonly recordedHistoryIds = new Set<string>();
  private _isLoading = false;
  private _loadPromise: Promise<void> | undefined;
  private _loadKey: string | undefined;
  private loadGeneration = 0;
  private scheduledNotifyHandle: ScheduledNotifyHandle | undefined;

  constructor(options: TerragonAgUiRuntimeCoreOptions) {
    this.agent = options.agent;
    this.logger = options.logger;
    this.showThinking = options.showThinking;
    this.onError = options.onError;
    this.onCancel = options.onCancel;
    this.history = options.history;
    this.projectionHintRef = options.projectionHintRef;
    this.notifyUpdate = options.notifyUpdate;
  }

  updateOptions(options: Omit<TerragonAgUiRuntimeCoreOptions, "notifyUpdate">) {
    const loadSourceChanged = this.agent !== options.agent;
    this.agent = options.agent;
    this.logger = options.logger;
    this.showThinking = options.showThinking;
    this.onError = options.onError;
    this.onCancel = options.onCancel;
    this.history = options.history;
    this.projectionHintRef = options.projectionHintRef;
    if (loadSourceChanged) {
      this.loadGeneration += 1;
      this._loadPromise = undefined;
      this._loadKey = undefined;
      this._isLoading = false;
    }
  }

  attachRuntime(runtime: AssistantRuntime) {
    this.runtime = runtime;
  }

  detachRuntime() {
    this.runtime = undefined;
  }

  getMessages(): readonly ThreadMessage[] {
    return this.messages;
  }

  getState(): ReadonlyJSONValue | undefined {
    return this.stateSnapshot;
  }

  isRunning(): boolean {
    return this.isRunningFlag;
  }

  get isLoading(): boolean {
    return this._isLoading;
  }

  __internal_load(loadKey = "default"): Promise<void> {
    if (this._loadPromise && this._loadKey === loadKey) {
      return this._loadPromise;
    }

    const generation = this.loadGeneration + 1;
    this.loadGeneration = generation;
    const promise = this.history?.load() ?? Promise.resolve(null);

    this._loadKey = loadKey;
    this._isLoading = true;

    let loadFailed = false;
    this._loadPromise = promise
      .then(async (repo) => {
        if (generation !== this.loadGeneration || this._loadKey !== loadKey) {
          return;
        }
        if (!repo) return;

        const messages = repo.messages.map((item) => item.message);
        this.applyExternalMessages(messages);

        if (repo.unstable_resume) {
          if (generation !== this.loadGeneration || this._loadKey !== loadKey) {
            return;
          }
          const parentId = repo.headId ?? messages.at(-1)?.id ?? null;
          await this.startRun(parentId, this.lastRunConfig, "resume");
        }
      })
      .catch((error: unknown) => {
        if (generation !== this.loadGeneration || this._loadKey !== loadKey) {
          return;
        }
        loadFailed = true;
        this.logger.error?.("[agui] failed to load history", error);
        this.onError?.(
          error instanceof Error ? error : new Error(String(error)),
        );
      })
      .finally(() => {
        if (generation !== this.loadGeneration || this._loadKey !== loadKey) {
          return;
        }
        this._isLoading = false;
        if (loadFailed) {
          this._loadPromise = undefined;
          this._loadKey = undefined;
        }
        this.notifyUpdate();
      });

    this.notifyUpdate();
    return this._loadPromise;
  }

  async append(message: AppendMessage): Promise<void> {
    const startRun = message.startRun ?? message.role === "user";
    if (message.sourceId) {
      this.removeMessageById(message.sourceId);
    }
    this.resetHead(message.parentId);

    const threadMessage = this.toThreadMessage(message);
    this.appendRuntimeMessage(threadMessage);
    this.markProjectionChange(this.messages.length - 1);
    this.notifyUpdate();
    this.recordHistoryEntry(message.parentId ?? null, threadMessage);

    if (!startRun) return;
    await this.startRun(threadMessage.id, message.runConfig, "append");
  }

  async edit(message: AppendMessage): Promise<void> {
    await this.append(message);
  }

  async reload(
    parentId: string | null,
    config: { runConfig?: RunConfig } = {},
  ): Promise<void> {
    this.resetHead(parentId);
    this.notifyUpdate();
    await this.startRun(parentId, config.runConfig, "append");
  }

  async cancel(): Promise<void> {
    if (!this.abortController) return;
    this.abortController.abort();
  }

  async resume(config: ResumeRunConfig): Promise<void> {
    if (config.stream) {
      this.logger.debug?.(
        "[agui] resume stream is not supported, falling back to regular run",
      );
    }
    await this.startRun(
      config.parentId,
      config.runConfig ?? this.lastRunConfig,
      "resume",
    );
  }

  findMessageIdForToolCall(toolCallId: string): string | undefined {
    let fallbackMessageId: string | undefined;
    for (let index = this.messages.length - 1; index >= 0; index--) {
      const message = this.messages[index];
      if (!message || message.role !== "assistant") continue;
      for (const part of message.content) {
        if (part.type !== "tool-call" || part.toolCallId !== toolCallId)
          continue;
        if (!("result" in part) || part.result === undefined) {
          return message.id;
        }
        fallbackMessageId ??= message.id;
      }
    }
    return fallbackMessageId;
  }

  addToolResult(options: AddToolResultOptions): void {
    let updated = false;
    let shouldResume = false;
    const changedIndex = this.getMessageIndex(options.messageId);
    const message =
      changedIndex !== undefined ? this.messages[changedIndex] : undefined;
    if (changedIndex !== undefined && message?.role === "assistant") {
      let matchedToolCall = false;
      const content = message.content.map((part) => {
        if (part.type !== "tool-call" || part.toolCallId !== options.toolCallId)
          return part;
        matchedToolCall = true;
        return {
          ...part,
          result: options.result,
          artifact: options.artifact,
          isError: options.isError,
        };
      });
      if (matchedToolCall) {
        updated = true;
        const nextMessage =
          message.status?.type === "requires-action" &&
          message.status.reason === "tool-calls" &&
          content.every(
            (part) =>
              part.type !== "tool-call" ||
              ("result" in part && part.result !== undefined),
          )
            ? {
                ...message,
                content,
                status: {
                  type: "complete" as const,
                  reason: "unknown" as const,
                },
              }
            : {
                ...message,
                content,
              };
        shouldResume = nextMessage.status !== message.status;
        this.replaceMessageAt(changedIndex, nextMessage);
      }
    }

    if (updated) {
      this.markProjectionChange(changedIndex ?? null);
      this.notifyUpdate();

      if (shouldResume) {
        this.persistAssistantHistory(options.messageId);

        if (!this.isRunningFlag) {
          void this.startRun(
            options.messageId,
            this.lastRunConfig,
            "resume",
          ).catch((error: unknown) => {
            this.onError?.(
              error instanceof Error ? error : new Error(String(error)),
            );
          });
        }
      }
    }
  }

  applyExternalMessages(messages: readonly ThreadMessage[]): void {
    this.assistantHistoryParents.clear();
    this.replaceAllMessages(messages);
    this.markUnknownProjectionChange();
    this.recordedHistoryIds.clear();
    for (const message of this.messages) {
      this.recordedHistoryIds.add(message.id);
    }
    this.notifyUpdate();
  }

  loadExternalState(state: ReadonlyJSONValue): void {
    this.stateSnapshot = state;
    this.notifyUpdate();
  }

  private async startRun(
    parentId: string | null,
    runConfig?: RunConfig,
    intent: TerragonRunIntent = "append",
  ): Promise<void> {
    const normalizedRunConfig = runConfig ?? {};
    this.lastRunConfig = normalizedRunConfig;
    this.resetHead(parentId);
    const historicalMessages = [...this.messages];

    const runId = generateId();
    this.pendingError = null;
    const input = this.buildRunInput(
      runId,
      normalizedRunConfig,
      historicalMessages,
      intent,
    );
    recordAgentTraceSpan({
      traceId: runId,
      name: "client.prompt.submitted",
      attributes: {
        threadId: input.threadId,
        runId,
        intent,
        messageCount: input.messages.length,
      },
    });
    const assistantParentId = parentId ?? this.messages.at(-1)?.id ?? null;
    let assistantMessageId: string | undefined;
    const ensureAssistant = (targetMessageId: string | undefined) => {
      if (targetMessageId) {
        const existing = this.getMessageById(targetMessageId);
        if (!existing) {
          this.appendRuntimeMessage(
            this.createAssistantMessage(targetMessageId),
          );
          this.notifyUpdate();
        }
        this.markPendingAssistantHistory(targetMessageId, assistantParentId);
        this.removeEmptySyntheticAssistant(assistantMessageId);
        return targetMessageId;
      }
      if (assistantMessageId) return assistantMessageId;
      const created = this.insertAssistantPlaceholder();
      assistantMessageId = created;
      this.markPendingAssistantHistory(created, assistantParentId ?? null);
      return created;
    };

    const aggregator = new TerragonRunAggregator({
      showThinking: this.showThinking,
      logger: this.logger,
      emit: (update, targetMessageId) =>
        this.updateAssistantMessage(ensureAssistant(targetMessageId), update),
    });
    const dispatch = (event: TerragonRunEvent) =>
      this.handleEvent(aggregator, event);

    const abortController = new AbortController();
    const abortSignal = abortController.signal;
    this.abortController = abortController;

    abortSignal.addEventListener(
      "abort",
      () => {
        dispatch({ type: "RUN_CANCELLED" });
        this.finishRun(abortController);
        this.onCancel?.();
      },
      { once: true },
    );

    const subscriber = createTerragonAgUiSubscriber({
      dispatch,
      runId,
      onRunFailed: (error) => {
        this.pendingError = error;
        this.onError?.(error);
      },
    });

    aggregator.handle({ type: "RUN_STARTED", runId });
    this.setRunning(true);

    try {
      this.agent.messages = input.messages;
      this.agent.threadId = input.threadId;
      await this.runAgent(input, subscriber, abortController);
    } catch (error: unknown) {
      if (!abortSignal.aborted) {
        const err = error instanceof Error ? error : new Error(String(error));
        dispatch({ type: "RUN_ERROR", message: err.message });
        this.onError?.(err);
        this.pendingError = this.pendingError ?? err;
      }
    } finally {
      this.finishRun(abortController);
    }

    if (this.pendingError) {
      const err = this.pendingError;
      this.pendingError = null;
      throw err;
    }
  }

  private buildRunInput(
    runId: string,
    runConfig: RunConfig | undefined,
    historyMessages: readonly ThreadMessage[] | undefined,
    intent: TerragonRunIntent,
  ) {
    const threadId = this.agent.threadId || "main";
    const messages = toAgUiMessages(historyMessages ?? this.messages);
    const context = this.runtime?.thread.getModelContext();
    const forwardedProps: Record<string, unknown> = {
      ...(context?.callSettings ?? {}),
      ...(context?.config ?? {}),
      ...(runConfig?.custom ? { runConfig: runConfig.custom } : {}),
    };
    const directTerragon = isRecord(forwardedProps["terragon"])
      ? forwardedProps["terragon"]
      : {};
    const runConfigProps = isRecord(forwardedProps["runConfig"])
      ? forwardedProps["runConfig"]
      : null;
    const runConfigTerragon = isRecord(runConfigProps?.["terragon"])
      ? runConfigProps["terragon"]
      : {};
    return {
      threadId,
      runId,
      state: this.stateSnapshot ?? null,
      messages,
      tools: toAgUiTools(context?.tools),
      context: context?.system
        ? [{ description: "system", value: context.system }]
        : [],
      forwardedProps: {
        ...forwardedProps,
        ...(runConfigProps !== null
          ? {
              runConfig: {
                ...runConfigProps,
                terragon: {
                  ...runConfigTerragon,
                  intent,
                },
              },
            }
          : {}),
        terragon: {
          ...directTerragon,
          intent,
          traceId: runId,
        },
      },
    };
  }

  private async runAgent(
    input: ReturnType<TerragonAgUiThreadRuntimeCore["buildRunInput"]>,
    subscriber: AgentSubscriber,
    abortController: AbortController,
  ): Promise<void> {
    await this.agent.runAgent(
      {
        runId: input.runId,
        tools: input.tools,
        context: input.context,
        forwardedProps: input.forwardedProps,
        abortController,
      },
      subscriber,
    );
  }

  private setRunning(running: boolean) {
    this.isRunningFlag = running;
    this.notifyUpdate();
  }

  private finishRun(controller: AbortController | null) {
    if (this.abortController === controller) {
      this.abortController = null;
    }
    this.setRunning(false);
  }

  private insertAssistantPlaceholder(): string {
    const id = generateId();
    this.appendRuntimeMessage(this.createAssistantMessage(id));
    this.markProjectionChange(this.messages.length - 1);
    this.notifyUpdate();
    return id;
  }

  private createAssistantMessage(messageId: string): ThreadAssistantMessage {
    return {
      id: messageId,
      role: "assistant",
      createdAt: new Date(),
      status: { type: "running" },
      content: [],
      metadata: {
        unstable_state: this.stateSnapshot ?? null,
        unstable_annotations: [],
        unstable_data: [],
        steps: [],
        custom: {},
      },
    };
  }

  private removeEmptySyntheticAssistant(messageId: string | undefined): void {
    if (!messageId) return;
    const message = this.getMessageById(messageId);
    if (
      !message ||
      message.role !== "assistant" ||
      message.content.length > 0
    ) {
      return;
    }
    this.removeMessageById(messageId);
    this.assistantHistoryParents.delete(messageId);
    this.recordedHistoryIds.delete(messageId);
    this.notifyUpdate();
  }

  private updateAssistantMessage(
    messageId: string,
    update: ChatModelRunResult,
  ) {
    let touched = false;
    let latestStatus: MessageStatus | undefined;
    const changedIndex = this.getMessageIndex(messageId);
    const message =
      changedIndex !== undefined ? this.messages[changedIndex] : undefined;
    if (changedIndex !== undefined && message?.role === "assistant") {
      touched = true;
      const metadata = update.metadata
        ? this.mergeAssistantMetadata(message.metadata, update.metadata)
        : message.metadata;
      latestStatus = update.status ?? message.status;
      const content = update.content
        ? this.mergeAssistantContent(message.content, update.content)
        : message.content;
      this.replaceMessageAt(changedIndex, {
        ...message,
        content,
        status: latestStatus,
        metadata,
      });
    }
    if (touched) {
      this.markProjectionChange(changedIndex ?? null);
      if (this.isTerminalStatus(latestStatus)) {
        this.flushScheduledNotifyUpdate();
        this.notifyUpdate();
        this.persistAssistantHistory(messageId);
        return;
      }
      this.scheduleNotifyUpdate();
    }
  }

  private mergeAssistantContent(
    existing: ThreadAssistantMessage["content"],
    incoming: NonNullable<ChatModelRunResult["content"]>,
  ): ThreadAssistantMessage["content"] {
    if (!existing.some((part) => part.type === "data")) {
      return incoming;
    }
    const existingDataParts = existing.filter((part) => part.type === "data");
    const incomingWithoutData = incoming.filter((part) => part.type !== "data");
    return [...existingDataParts, ...incomingWithoutData];
  }

  private mergeAssistantMetadata(
    current: ThreadAssistantMessage["metadata"],
    incoming: NonNullable<ChatModelRunResult["metadata"]>,
  ): ThreadAssistantMessage["metadata"] {
    const annotations = incoming.unstable_annotations
      ? [...current.unstable_annotations, ...incoming.unstable_annotations]
      : current.unstable_annotations;
    const data = incoming.unstable_data
      ? [...current.unstable_data, ...incoming.unstable_data]
      : current.unstable_data;
    const steps = incoming.steps
      ? [...current.steps, ...incoming.steps]
      : current.steps;
    return {
      unstable_state:
        incoming.unstable_state !== undefined
          ? incoming.unstable_state
          : current.unstable_state,
      unstable_annotations: annotations,
      unstable_data: data,
      steps,
      custom: incoming.custom
        ? { ...current.custom, ...incoming.custom }
        : current.custom,
    };
  }

  private handleEvent(
    aggregator: TerragonRunAggregator,
    event: TerragonRunEvent,
  ) {
    switch (event.type) {
      case "CUSTOM": {
        const dataPart = terragonDataPartFromCustomEvent(event);
        if (!dataPart) {
          aggregator.handle(event);
          return;
        }
        const applied = this.applyTerragonDataPart(dataPart);
        if (applied) {
          this.scheduleNotifyUpdate();
        }
        return;
      }
      case "STATE_SNAPSHOT": {
        this.stateSnapshot = event.snapshot as ReadonlyJSONValue;
        this.notifyUpdate();
        return;
      }
      case "STATE_DELTA": {
        this.logger.debug?.("[agui] state delta event ignored", event.delta);
        return;
      }
      case "MESSAGES_SNAPSHOT": {
        this.importMessagesSnapshot(event.messages);
        return;
      }
      default:
        aggregator.handle(event);
    }
  }

  private importMessagesSnapshot(rawMessages: readonly unknown[]) {
    try {
      const messages = rawMessages.filter(this.isAgUiMessage);
      const converted = agUiMessagesToThreadMessages(messages);
      this.applyExternalMessages(converted);
    } catch (error: unknown) {
      this.logger.error?.("[agui] failed to import messages snapshot", error);
    }
  }

  private isAgUiMessage(message: unknown): message is AgUiMessage {
    return (
      typeof message === "object" &&
      message !== null &&
      "role" in message &&
      typeof (message as { role?: unknown }).role === "string"
    );
  }

  private toThreadMessage(message: AppendMessage): ThreadMessage {
    if (isAssistantAppendMessage(message)) {
      const { parentId, sourceId, runConfig, startRun, ...assistant } = message;
      void parentId;
      void sourceId;
      void runConfig;
      void startRun;
      return {
        ...assistant,
        id: generateId(),
        status: assistant.status ?? FALLBACK_USER_STATUS,
      };
    }
    if (isUserAppendMessage(message)) {
      const { parentId, sourceId, runConfig, startRun, ...user } = message;
      void parentId;
      void sourceId;
      void runConfig;
      void startRun;
      return {
        ...user,
        id: generateId(),
      };
    }
    if (!isSystemAppendMessage(message)) {
      throw new Error(`Unsupported append message role: ${message.role}`);
    }
    const { parentId, sourceId, runConfig, startRun, ...systemMessage } =
      message;
    void parentId;
    void sourceId;
    void runConfig;
    void startRun;
    return {
      ...systemMessage,
      id: generateId(),
    };
  }

  private resetHead(parentId: string | null | undefined) {
    if (!parentId) {
      if (this.messages.length) {
        this.replaceAllMessages([]);
        this.markUnknownProjectionChange();
      }
      return;
    }
    const idx = this.getMessageIndex(parentId);
    if (idx === undefined) return;
    if (idx < this.messages.length - 1) {
      this.replaceAllMessages(this.messages.slice(0, idx + 1));
      this.markUnknownProjectionChange();
    }
  }

  private markProjectionChange(firstChangedRuntimeMessageIndex: number | null) {
    if (!this.projectionHintRef) return;
    this.projectionHintVersion += 1;
    this.projectionHintRef.current = {
      version: this.projectionHintVersion,
      firstChangedRuntimeMessageIndex,
    };
  }

  private markUnknownProjectionChange() {
    this.markProjectionChange(null);
  }

  private applyTerragonDataPart(dataPart: TerragonDataPart): boolean {
    let messageIndex = this.getMessageIndex(dataPart.data.messageId);
    if (messageIndex === undefined) {
      this.appendRuntimeMessage(
        this.createAssistantMessage(dataPart.data.messageId),
      );
      messageIndex = this.messages.length - 1;
    }

    const message = this.messages[messageIndex];
    if (!message || message.role !== "assistant") {
      return false;
    }

    const content = appendTerragonDataPart(message.content, dataPart);
    if (!content) {
      return false;
    }

    this.replaceMessageAt(messageIndex, {
      ...message,
      content,
    });
    this.markProjectionChange(messageIndex);
    return true;
  }

  private scheduleNotifyUpdate(): void {
    if (this.scheduledNotifyHandle !== undefined) {
      return;
    }

    const flush = () => {
      this.scheduledNotifyHandle = undefined;
      this.notifyUpdate();
    };

    if (typeof window !== "undefined" && window.requestAnimationFrame) {
      this.scheduledNotifyHandle = {
        kind: "animation-frame",
        id: window.requestAnimationFrame(flush),
      };
      return;
    }

    this.scheduledNotifyHandle = {
      kind: "timeout",
      id: globalThis.setTimeout(flush, 16),
    };
  }

  private flushScheduledNotifyUpdate(): void {
    const handle = this.scheduledNotifyHandle;
    if (handle === undefined) {
      return;
    }
    this.scheduledNotifyHandle = undefined;
    if (handle.kind === "animation-frame") {
      window.cancelAnimationFrame(handle.id);
    } else {
      globalThis.clearTimeout(handle.id);
    }
  }

  private isTerminalStatus(status?: MessageStatus): boolean {
    return status?.type === "complete" || status?.type === "incomplete";
  }

  private recordHistoryEntry(parentId: string | null, message: ThreadMessage) {
    this.appendHistoryItem(parentId, message);
  }

  private markPendingAssistantHistory(
    messageId: string,
    parentId: string | null,
  ) {
    if (!this.history) return;
    this.assistantHistoryParents.set(messageId, parentId);
  }

  private persistAssistantHistory(messageId: string) {
    if (!this.history) return;
    const parentId = this.assistantHistoryParents.get(messageId);
    if (parentId === undefined) return;
    const message = this.getMessageById(messageId);
    if (!message || message.role !== "assistant") return;
    if (!this.isTerminalStatus(message.status)) return;
    this.assistantHistoryParents.delete(messageId);
    this.appendHistoryItem(parentId, message);
  }

  private appendHistoryItem(parentId: string | null, message: ThreadMessage) {
    if (!this.history || this.recordedHistoryIds.has(message.id)) return;
    this.recordedHistoryIds.add(message.id);
    void this.history.append({ parentId, message }).catch((error: unknown) => {
      this.recordedHistoryIds.delete(message.id);
      this.logger.error?.("[agui] failed to append history entry", error);
    });
  }

  private getMessageIndex(messageId: string): number | undefined {
    const index = this.messageIndexById.get(messageId);
    if (index === undefined || this.messages[index]?.id !== messageId) {
      return undefined;
    }
    return index;
  }

  private getMessageById(messageId: string): ThreadMessage | undefined {
    const index = this.getMessageIndex(messageId);
    return index === undefined ? undefined : this.messages[index];
  }

  private appendRuntimeMessage(message: ThreadMessage): void {
    this.messages = [...this.messages, message];
    this.messageIndexById.set(message.id, this.messages.length - 1);
  }

  private replaceMessageAt(index: number, message: ThreadMessage): void {
    const previous = this.messages[index];
    this.messages = this.messages.slice();
    this.messages[index] = message;
    if (previous?.id !== message.id) {
      this.rebuildMessageIndex();
    }
  }

  private removeMessageById(messageId: string): void {
    const index = this.getMessageIndex(messageId);
    if (index === undefined) return;
    this.messages = [
      ...this.messages.slice(0, index),
      ...this.messages.slice(index + 1),
    ];
    this.rebuildMessageIndex();
    this.markUnknownProjectionChange();
  }

  private replaceAllMessages(messages: readonly ThreadMessage[]): void {
    this.messages = [...messages];
    this.rebuildMessageIndex();
  }

  private rebuildMessageIndex(): void {
    this.messageIndexById.clear();
    this.messages.forEach((message, index) => {
      this.messageIndexById.set(message.id, index);
    });
  }
}
