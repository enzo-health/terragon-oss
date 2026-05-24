"use client";

import { EventType, type AGUIEvent } from "@ag-ui/core";
import type {
  ChatModelRunResult,
  ThreadAssistantMessagePart,
  ToolCallMessagePart,
} from "@assistant-ui/react";
import {
  appendTerragonDataPart,
  isReadonlyJSONObject,
  terragonDataPartFromCustomEvent,
  type ReadonlyJSONObject,
  type TerragonDataPart,
} from "./ag-ui-custom-parts";
import {
  MAX_PROGRESS_CHUNKS,
  type ToolProgressChunk,
} from "./tool-progress-chunks";

type Emit = (
  update: ChatModelRunResult,
  targetMessageId: string | undefined,
) => void;
type Logger = {
  debug?: (message: string, ...args: unknown[]) => void;
};

type ToolCallState = {
  toolCallId: string;
  toolCallName: string;
  argsText: string;
  parsedArgs: ReadonlyJSONObject | undefined;
  parsedArgsText: string | undefined;
  progressChunks: ToolProgressChunk[];
  progressHiddenCount: number;
  toolStatus: ToolLifecycleStatus | undefined;
  result: unknown;
  isError: boolean | undefined;
  parentMessageId?: string;
};

type ToolLifecycleStatus = "started" | "in_progress" | "completed" | "failed";
type RuntimeToolCallMessagePart = ToolCallMessagePart<ReadonlyJSONObject> & {
  progressChunks?: ToolProgressChunk[];
  progressHiddenCount?: number;
  toolStatus?: ToolLifecycleStatus;
};
const EMPTY_TOOL_ARGS: ReadonlyJSONObject = Object.freeze({});

function toolArgsMayBeComplete(text: string): boolean {
  const trimmed = text.trimEnd();
  return trimmed.endsWith("}") || trimmed.endsWith("]");
}

type RunLifecycleEvent =
  | { type: "RUN_STARTED"; runId: string }
  | { type: "RUN_FINISHED"; runId: string }
  | { type: "RUN_CANCELLED"; runId?: string }
  | { type: "RUN_ERROR"; message?: string; code?: string };

export type TerragonRunEvent = AGUIEvent | RunLifecycleEvent;

export type TerragonRunAggregatorOptions = {
  showThinking: boolean;
  logger: Logger;
  emit: Emit;
};

type OrderedPart =
  | { kind: "text"; key: string }
  | { kind: "reasoning" }
  | { kind: "tool-call"; toolCallId: string }
  | { kind: "data"; key: string };

export class TerragonRunAggregator {
  private readonly emitUpdate: Emit;
  private readonly showThinking: boolean;
  private readonly logger: Logger;

  private status: ChatModelRunResult["status"] | undefined;
  private readonly textParts = new Map<
    string,
    { buffer: string; touched: boolean }
  >();
  private activeTextMessageId: string | undefined;
  private reasoningBuffer = "";
  private reasoningActive = false;
  private readonly toolCalls = new Map<string, ToolCallState>();
  private readonly dataParts = new Map<string, TerragonDataPart>();
  private readonly partOrder: OrderedPart[] = [];
  private hasReasoningPart = false;
  private textPartCounter = 0;
  private lastTargetMessageId: string | undefined;

  constructor(options: TerragonRunAggregatorOptions) {
    this.emitUpdate = options.emit;
    this.showThinking = options.showThinking;
    this.logger = options.logger;
  }

  handle(event: TerragonRunEvent): void {
    switch (event.type) {
      case EventType.RUN_STARTED: {
        this.reset();
        this.status = { type: "running" };
        this.emit(undefined);
        break;
      }
      case EventType.RUN_FINISHED: {
        this.finishUnresolvedToolCalls("Tool call ended without a result.");
        this.status = { type: "complete", reason: "unknown" };
        this.emit(this.lastTargetMessageId);
        break;
      }
      case "RUN_ERROR": {
        this.finishUnresolvedToolCalls(
          event.message ?? "Run ended before this tool returned a result.",
        );
        this.status = {
          type: "incomplete",
          reason: "error",
          ...(event.message !== undefined ? { error: event.message } : {}),
        };
        this.emit(this.lastTargetMessageId);
        break;
      }
      case "RUN_CANCELLED": {
        this.finishUnresolvedToolCalls(
          "Run was cancelled before this tool returned a result.",
        );
        this.status = { type: "incomplete", reason: "cancelled" };
        this.emit(this.lastTargetMessageId);
        break;
      }

      case EventType.TEXT_MESSAGE_START: {
        const id = this.startTextMessage(event.messageId);
        this.markTextPartTouched(id);
        this.emit(this.targetMessageIdForText(id));
        break;
      }
      case EventType.TEXT_MESSAGE_CONTENT:
      case EventType.TEXT_MESSAGE_CHUNK: {
        if (!event.delta) break;
        const id = this.resolveTextMessageId(
          "messageId" in event ? event.messageId : undefined,
        );
        this.appendText(id, event.delta);
        this.scheduleEmit(this.targetMessageIdForText(id));
        break;
      }
      case EventType.TEXT_MESSAGE_END: {
        const targetMessageId = event.messageId
          ? this.targetMessageIdForText(event.messageId)
          : this.lastTargetMessageId;
        if (event.messageId && this.activeTextMessageId === event.messageId) {
          this.activeTextMessageId = undefined;
        }
        this.emit(targetMessageId);
        break;
      }

      case EventType.CUSTOM: {
        this.appendCustomPart(event);
        break;
      }

      case EventType.THINKING_START:
      case EventType.THINKING_TEXT_MESSAGE_START:
      case EventType.REASONING_START:
      case EventType.REASONING_MESSAGE_START:
        this.handleReasoningStart();
        break;
      case EventType.THINKING_TEXT_MESSAGE_CONTENT:
      case EventType.REASONING_MESSAGE_CONTENT:
      case EventType.REASONING_MESSAGE_CHUNK:
        this.handleReasoningContent(event.delta ?? "");
        break;
      case EventType.THINKING_TEXT_MESSAGE_END:
      case EventType.THINKING_END:
      case EventType.REASONING_MESSAGE_END:
      case EventType.REASONING_END:
        this.handleReasoningEnd();
        break;

      case EventType.TOOL_CALL_START: {
        this.startToolCall(
          event.toolCallId,
          event.toolCallName,
          event.parentMessageId,
        );
        this.emit(this.lastTargetMessageId);
        break;
      }
      case EventType.TOOL_CALL_ARGS: {
        if (!event.delta) break;
        this.appendToolArgs(event.toolCallId, event.delta);
        this.scheduleEmit(this.targetMessageIdForToolCall(event.toolCallId));
        break;
      }
      case EventType.TOOL_CALL_CHUNK: {
        if (!event.delta) break;
        this.appendToolProgress(event.toolCallId, event.delta);
        this.scheduleEmit(this.targetMessageIdForToolCall(event.toolCallId));
        break;
      }
      case EventType.TOOL_CALL_END: {
        this.finalizeToolArgs(event.toolCallId);
        this.emit(this.targetMessageIdForToolCall(event.toolCallId));
        break;
      }
      case EventType.TOOL_CALL_RESULT: {
        this.finishToolCall(
          event.toolCallId,
          "content" in event ? event.content : "",
          this.toolResultErrorStatus(event),
        );
        this.emit(this.targetMessageIdForToolCall(event.toolCallId));
        break;
      }

      default: {
        this.logger.debug?.("[agui] aggregator ignored event", event);
      }
    }
  }

  private reset(): void {
    this.textParts.clear();
    this.reasoningBuffer = "";
    this.reasoningActive = false;
    this.toolCalls.clear();
    this.dataParts.clear();
    this.partOrder.length = 0;
    this.hasReasoningPart = false;
    this.textPartCounter = 0;
    this.activeTextMessageId = undefined;
    this.lastTargetMessageId = undefined;
  }

  private generateTextKey(): string {
    this.textPartCounter += 1;
    return `text-${this.textPartCounter}`;
  }

  private startTextMessage(messageId?: string): string {
    const id = messageId ?? this.generateTextKey();
    this.ensureTextPart(id);
    this.activeTextMessageId = id;
    if (messageId) {
      this.lastTargetMessageId = messageId;
    } else {
      this.lastTargetMessageId = undefined;
    }
    return id;
  }

  private resolveTextMessageId(messageId?: string): string {
    if (messageId) {
      this.ensureTextPart(messageId);
      this.activeTextMessageId = messageId;
      this.lastTargetMessageId = messageId;
      return messageId;
    }

    if (this.activeTextMessageId) {
      return this.activeTextMessageId;
    }

    const generated = this.generateTextKey();
    this.ensureTextPart(generated);
    this.activeTextMessageId = generated;
    this.lastTargetMessageId = undefined;
    return generated;
  }

  private ensureTextPart(id: string): void {
    if (!this.textParts.has(id)) {
      this.textParts.set(id, { buffer: "", touched: false });
      if (
        !this.partOrder.some((part) => part.kind === "text" && part.key === id)
      ) {
        this.partOrder.push({ kind: "text", key: id });
      }
    }
  }

  private markTextPartTouched(id: string): void {
    const entry = this.textParts.get(id);
    if (!entry) return;
    entry.touched = true;
  }

  private appendText(id: string, delta: string): void {
    this.ensureTextPart(id);
    const entry = this.textParts.get(id);
    if (!entry) return;
    entry.buffer += delta;
    entry.touched = true;
  }

  private targetMessageIdForText(id: string): string | undefined {
    return id === this.activeTextMessageId ? this.lastTargetMessageId : id;
  }

  private appendCustomPart(event: AGUIEvent): void {
    const dataPart = terragonDataPartFromCustomEvent(event);
    if (!dataPart) {
      this.logger.debug?.("[agui] aggregator ignored custom event", event);
      return;
    }

    const key = this.dataPartKey(dataPart);
    if (this.dataParts.has(key)) {
      return;
    }

    const nextContent = appendTerragonDataPart(
      Array.from(this.dataParts.values()),
      dataPart,
    );
    if (!nextContent) {
      return;
    }

    this.dataParts.set(key, dataPart);
    this.partOrder.push({ kind: "data", key });
    this.emit(dataPart.data.messageId);
  }

  private dataPartKey(dataPart: TerragonDataPart): string {
    return `${dataPart.name}:${dataPart.data.messageId}:${dataPart.data.partIndex}`;
  }

  private startToolCall(
    id: string | undefined,
    name?: string,
    parentMessageId?: string,
  ): void {
    if (!id) return;
    if (
      !this.partOrder.some(
        (part) => part.kind === "tool-call" && part.toolCallId === id,
      )
    ) {
      this.partOrder.push({ kind: "tool-call", toolCallId: id });
    }
    const parentTool = parentMessageId
      ? this.toolCalls.get(parentMessageId)
      : undefined;
    const resolvedParentMessageId =
      parentTool?.parentMessageId ??
      parentMessageId ??
      this.lastTargetMessageId;
    const state: ToolCallState = {
      toolCallId: id,
      toolCallName: name ?? "tool",
      argsText: "",
      parsedArgs: undefined,
      parsedArgsText: undefined,
      progressChunks: [],
      progressHiddenCount: 0,
      toolStatus: "started",
      result: undefined,
      isError: undefined,
    };
    if (resolvedParentMessageId) {
      state.parentMessageId = resolvedParentMessageId;
      this.lastTargetMessageId = resolvedParentMessageId;
    }
    this.toolCalls.set(id, state);
  }

  private targetMessageIdForToolCall(
    id: string | undefined,
  ): string | undefined {
    const entry = id ? this.toolCalls.get(id) : undefined;
    if (entry?.parentMessageId) {
      this.lastTargetMessageId = entry.parentMessageId;
      return entry.parentMessageId;
    }
    return this.lastTargetMessageId;
  }

  private appendToolArgs(id: string | undefined, delta: string): void {
    const entry = id ? this.toolCalls.get(id) : undefined;
    if (!entry) return;
    entry.argsText += delta;
    if (toolArgsMayBeComplete(entry.argsText)) {
      this.parseToolArgs(entry);
    }
  }

  private appendToolProgress(id: string | undefined, text: string): void {
    const entry = id ? this.toolCalls.get(id) : undefined;
    if (!entry) return;
    const seq = (entry.progressChunks.at(-1)?.seq ?? 0) + 1;
    const chunk = { seq, text };
    if (entry.progressChunks.length >= MAX_PROGRESS_CHUNKS) {
      entry.progressHiddenCount += 1;
      entry.progressChunks.shift();
      entry.progressChunks.push(chunk);
    } else {
      entry.progressChunks.push(chunk);
    }
    entry.toolStatus = "in_progress";
  }

  private finalizeToolArgs(id: string | undefined): void {
    const entry = id ? this.toolCalls.get(id) : undefined;
    if (!entry) return;
    this.parseToolArgs(entry);
  }

  private toolResultErrorStatus(
    event: Extract<AGUIEvent, { type: EventType.TOOL_CALL_RESULT }>,
  ): boolean | undefined {
    if ("isError" in event && typeof event.isError === "boolean") {
      return event.isError;
    }
    const status = Reflect.get(event, "status");
    if (status === "error") return true;
    const error = Reflect.get(event, "error");
    return typeof error === "string" ? true : undefined;
  }

  private finishToolCall(
    id: string,
    content: unknown,
    isError?: boolean,
  ): void {
    if (!id) return;
    let entry = this.toolCalls.get(id);
    if (!entry) {
      entry = {
        toolCallId: id,
        toolCallName: "tool",
        argsText: "",
        parsedArgs: undefined,
        parsedArgsText: undefined,
        progressChunks: [],
        progressHiddenCount: 0,
        toolStatus: "started",
        result: undefined,
        isError: undefined,
      };
      this.toolCalls.set(id, entry);
    }
    if (
      !this.partOrder.some(
        (part) => part.kind === "tool-call" && part.toolCallId === id,
      )
    ) {
      this.partOrder.push({ kind: "tool-call", toolCallId: id });
    }
    this.parseToolArgs(entry);
    entry.result = this.tryParseJSON(content);
    entry.isError = isError;
    entry.toolStatus = isError ? "failed" : "completed";
  }

  private finishUnresolvedToolCalls(content: string): void {
    for (const entry of this.toolCalls.values()) {
      if (entry.result !== undefined) continue;
      entry.result = content;
      entry.isError = true;
      entry.toolStatus = "failed";
    }
  }

  private tryParseJSON(value: unknown): unknown {
    if (typeof value !== "string") return value;
    if (!value) return value;
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }

  private parseToolArgs(entry: ToolCallState): void {
    if (entry.parsedArgsText === entry.argsText) {
      return;
    }
    entry.parsedArgsText = entry.argsText;
    if (!entry.argsText) {
      entry.parsedArgs = undefined;
      return;
    }
    try {
      const parsed: unknown = JSON.parse(entry.argsText);
      entry.parsedArgs = isReadonlyJSONObject(parsed) ? parsed : undefined;
    } catch {
      entry.parsedArgs = undefined;
    }
  }

  private emit(targetMessageId: string | undefined): void {
    const snapshot: ThreadAssistantMessagePart[] = [];

    for (const part of this.partOrder) {
      if (part.kind === "reasoning") {
        if (
          this.showThinking &&
          (this.reasoningActive || this.reasoningBuffer.length > 0)
        ) {
          snapshot.push({
            type: "reasoning",
            text: this.reasoningBuffer,
          });
        }
        continue;
      }

      if (part.kind === "text") {
        const entry = this.textParts.get(part.key);
        if (entry?.touched) {
          snapshot.push({ type: "text", text: entry.buffer });
        }
        continue;
      }

      if (part.kind === "data") {
        const dataPart = this.dataParts.get(part.key);
        if (dataPart) {
          snapshot.push(dataPart);
        }
        continue;
      }

      const entry = this.toolCalls.get(part.toolCallId);
      if (!entry) continue;
      const toolPart: RuntimeToolCallMessagePart = {
        type: "tool-call",
        toolCallId: entry.toolCallId,
        toolName: entry.toolCallName,
        args: entry.parsedArgs ?? EMPTY_TOOL_ARGS,
        argsText: entry.argsText,
        ...(entry.progressChunks.length > 0
          ? { progressChunks: entry.progressChunks.slice() }
          : {}),
        ...(entry.progressHiddenCount > 0
          ? { progressHiddenCount: entry.progressHiddenCount }
          : {}),
        ...(entry.progressChunks.length > 0 && entry.toolStatus
          ? { toolStatus: entry.toolStatus }
          : {}),
        ...(entry.result !== undefined ? { result: entry.result } : {}),
        ...(entry.isError !== undefined ? { isError: entry.isError } : {}),
        ...(entry.parentMessageId ? { parentId: entry.parentMessageId } : {}),
      };
      snapshot.push(toolPart);
    }

    const result: ChatModelRunResult = {
      content: snapshot,
      ...(this.status ? { status: this.status } : undefined),
    };
    this.emitUpdate(result, targetMessageId);
  }

  private scheduleEmit(targetMessageId: string | undefined): void {
    this.emit(targetMessageId);
  }

  private handleReasoningStart(): void {
    if (!this.showThinking) return;
    this.reasoningActive = true;
    this.ensureReasoningPart();
    this.emit(this.lastTargetMessageId);
  }

  private handleReasoningContent(delta: string): void {
    if (!this.showThinking || !delta) return;
    this.reasoningBuffer += delta;
    this.ensureReasoningPart();
    this.scheduleEmit(this.lastTargetMessageId);
  }

  private handleReasoningEnd(): void {
    if (!this.showThinking) return;
    this.emit(this.lastTargetMessageId);
  }

  private ensureReasoningPart(): void {
    if (this.hasReasoningPart) return;
    const textIndex = this.partOrder.findIndex((part) => part.kind === "text");
    if (textIndex === -1) {
      this.partOrder.push({ kind: "reasoning" });
    } else {
      this.partOrder.splice(textIndex, 0, { kind: "reasoning" });
    }
    this.hasReasoningPart = true;
  }
}
