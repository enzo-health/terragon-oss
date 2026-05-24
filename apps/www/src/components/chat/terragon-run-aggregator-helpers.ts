"use client";

import { EventType, type AGUIEvent } from "@ag-ui/core";
import type { ToolCallMessagePart } from "@assistant-ui/react";
import {
  isReadonlyJSONObject,
  type ReadonlyJSONObject,
} from "./ag-ui-custom-parts";
import type { ToolProgressChunk } from "./tool-progress-chunks";

export type ToolLifecycleStatus =
  | "started"
  | "in_progress"
  | "completed"
  | "failed";

export type ToolCallState = {
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

export type RuntimeToolCallMessagePart =
  ToolCallMessagePart<ReadonlyJSONObject> & {
    progressChunks?: ToolProgressChunk[];
    progressHiddenCount?: number;
    toolStatus?: ToolLifecycleStatus;
  };

export const EMPTY_TOOL_ARGS: ReadonlyJSONObject = Object.freeze({});

export function toolArgsMayBeComplete(text: string): boolean {
  const trimmed = text.trimEnd();
  return trimmed.endsWith("}") || trimmed.endsWith("]");
}

export function tryParseJSON(value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (!value) return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function parseToolArgs(entry: ToolCallState): void {
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

export function toolResultErrorStatus(
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

export function createToolCallState(id: string, name = "tool"): ToolCallState {
  return {
    toolCallId: id,
    toolCallName: name,
    argsText: "",
    parsedArgs: undefined,
    parsedArgsText: undefined,
    progressChunks: [],
    progressHiddenCount: 0,
    toolStatus: "started",
    result: undefined,
    isError: undefined,
  };
}

export function toolCallToMessagePart(
  entry: ToolCallState,
): RuntimeToolCallMessagePart {
  return {
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
}
