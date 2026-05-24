"use client";

import type {
  AppendMessage,
  MessageStatus,
  ThreadAssistantMessage,
  ThreadSystemMessage,
  ThreadUserMessage,
} from "@assistant-ui/react";

type AppendFields = Pick<
  AppendMessage,
  "parentId" | "sourceId" | "runConfig" | "startRun"
>;
export type AssistantAppendMessage = Omit<ThreadAssistantMessage, "id"> &
  AppendFields;
export type UserAppendMessage = Omit<ThreadUserMessage, "id"> & AppendFields;
export type SystemAppendMessage = Omit<ThreadSystemMessage, "id"> &
  AppendFields;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function generateId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)
  );
}

export function isAssistantAppendMessage(
  message: AppendMessage,
): message is AssistantAppendMessage {
  return message.role === "assistant";
}

export function isUserAppendMessage(
  message: AppendMessage,
): message is UserAppendMessage {
  return message.role === "user";
}

export function isSystemAppendMessage(
  message: AppendMessage,
): message is SystemAppendMessage {
  return message.role === "system";
}

export function isTerminalStatus(status?: MessageStatus): boolean {
  return status?.type === "complete" || status?.type === "incomplete";
}
