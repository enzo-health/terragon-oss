"use client";

import type {
  ThreadAssistantMessage,
  ThreadMessage,
} from "@assistant-ui/react";
import { isTerminalStatus } from "./terragon-runtime-helpers";

export class RuntimeMessageStore {
  private messages: ThreadMessage[] = [];
  private readonly messageIndexById = new Map<string, number>();

  getAll(): readonly ThreadMessage[] {
    return this.messages;
  }

  get length(): number {
    return this.messages.length;
  }

  at(index: number): ThreadMessage | undefined {
    return this.messages[index];
  }

  last(): ThreadMessage | undefined {
    return this.messages.at(-1);
  }

  getIndex(messageId: string): number | undefined {
    const index = this.messageIndexById.get(messageId);
    if (index === undefined || this.messages[index]?.id !== messageId) {
      return undefined;
    }
    return index;
  }

  getById(messageId: string): ThreadMessage | undefined {
    const index = this.getIndex(messageId);
    return index === undefined ? undefined : this.messages[index];
  }

  append(message: ThreadMessage): void {
    const existingIndex = this.getIndex(message.id);
    if (existingIndex !== undefined) {
      const existing = this.messages[existingIndex];
      if (!existing) return;
      const merged = this.mergeDuplicateMessage(existing, message);
      if (merged !== existing) {
        this.replaceAt(existingIndex, merged);
      }
      return;
    }

    this.messages = [...this.messages, message];
    this.messageIndexById.set(message.id, this.messages.length - 1);
  }

  replaceAt(index: number, message: ThreadMessage): void {
    const previous = this.messages[index];
    this.messages = this.messages.slice();
    this.messages[index] = message;
    if (previous?.id !== message.id) {
      this.rebuildIndex();
    }
  }

  removeById(messageId: string): void {
    const index = this.getIndex(messageId);
    if (index === undefined) return;
    this.messages = [
      ...this.messages.slice(0, index),
      ...this.messages.slice(index + 1),
    ];
    this.rebuildIndex();
  }

  replaceAll(messages: readonly ThreadMessage[]): void {
    this.messages = this.dedupeMessages(messages);
    this.rebuildIndex();
  }

  private dedupeMessages(messages: readonly ThreadMessage[]): ThreadMessage[] {
    const nextMessages: ThreadMessage[] = [];
    const nextIndexById = new Map<string, number>();

    for (const message of messages) {
      const existingIndex = nextIndexById.get(message.id);
      if (existingIndex === undefined) {
        nextIndexById.set(message.id, nextMessages.length);
        nextMessages.push(message);
        continue;
      }

      const existing = nextMessages[existingIndex];
      if (!existing) continue;
      nextMessages[existingIndex] = this.mergeDuplicateMessage(
        existing,
        message,
      );
    }

    return nextMessages;
  }

  private mergeDuplicateMessage(
    existing: ThreadMessage,
    incoming: ThreadMessage,
  ): ThreadMessage {
    if (existing.role === "assistant" && incoming.role === "assistant") {
      return this.mergeExternalMessage(existing, incoming);
    }

    return existing;
  }

  mergeExternalMessage(
    existing: ThreadMessage,
    incoming: ThreadMessage,
  ): ThreadMessage {
    if (existing.role !== "assistant" || incoming.role !== "assistant") {
      return existing;
    }

    if (incoming.content.length === 0) {
      return existing;
    }

    if (existing.content.length === 0) {
      return incoming;
    }

    if (this.isIncomingAssistantMoreComplete(existing, incoming)) {
      return incoming;
    }

    return existing;
  }

  private isIncomingAssistantMoreComplete(
    existing: ThreadAssistantMessage,
    incoming: ThreadAssistantMessage,
  ): boolean {
    if (
      !isTerminalStatus(existing.status) &&
      isTerminalStatus(incoming.status)
    ) {
      return true;
    }

    return (
      this.getAssistantContentScore(incoming.content) >
      this.getAssistantContentScore(existing.content)
    );
  }

  private getAssistantContentScore(
    content: ThreadAssistantMessage["content"],
  ): number {
    return content.reduce((score, part) => {
      if (part.type === "text") {
        return score + 1_000 + part.text.length;
      }
      if (part.type === "reasoning") {
        return score + 1_000 + part.text.length;
      }
      if (part.type === "tool-call") {
        return score + ("result" in part && part.result !== undefined ? 2 : 1);
      }
      return score + 1;
    }, 0);
  }

  private rebuildIndex(): void {
    this.messageIndexById.clear();
    this.messages.forEach((message, index) => {
      this.messageIndexById.set(message.id, index);
    });
  }
}
