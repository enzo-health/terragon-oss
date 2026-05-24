import type {
  ThreadAssistantMessage,
  ThreadAssistantMessagePart,
} from "@assistant-ui/react";
import { describe, expect, it } from "vitest";
import {
  createRuntimeMessageSnapshot,
  sameRuntimeMessageSnapshot,
} from "./runtime-fingerprint";

const createdAt = new Date("2026-05-23T00:00:00.000Z");

function assistantMessage(
  content: ThreadAssistantMessagePart[],
): ThreadAssistantMessage {
  return {
    id: "assistant-1",
    role: "assistant",
    createdAt,
    content,
    status: { type: "complete", reason: "stop" },
    metadata: {
      unstable_state: null,
      unstable_annotations: [],
      unstable_data: [],
      steps: [],
      custom: {},
    },
  };
}

describe("runtime fingerprinting", () => {
  it("detects middle changes in long artifact strings", () => {
    const leftText = `${"a".repeat(160)}middle-left${"z".repeat(160)}`;
    const rightText = `${"a".repeat(160)}middle-right${"z".repeat(160)}`;
    const left = createRuntimeMessageSnapshot(
      assistantMessage([
        {
          type: "tool-call",
          toolCallId: "tool-1",
          toolName: "Render",
          args: {},
          result: undefined,
          artifact: {
            type: "text",
            planText: leftText,
          },
        } as ThreadAssistantMessagePart,
      ]),
    );
    const right = createRuntimeMessageSnapshot(
      assistantMessage([
        {
          type: "tool-call",
          toolCallId: "tool-1",
          toolName: "Render",
          args: {},
          result: undefined,
          artifact: {
            type: "text",
            planText: rightText,
          },
        } as ThreadAssistantMessagePart,
      ]),
    );

    expect(sameRuntimeMessageSnapshot(left, right)).toBe(false);
  });

  it("detects sampled middle terminal chunk changes without hashing every chunk", () => {
    const chunks = Array.from({ length: 9 }, (_, index) => ({
      streamSeq: index + 1,
      kind: "stdout" as const,
      text: `chunk-${index + 1}`,
    }));
    const changedChunks = chunks.map((chunk, index) =>
      index === 4 ? { ...chunk, text: "changed-middle" } : chunk,
    );
    const terminalPart = (
      terminalChunks: typeof chunks,
    ): ThreadAssistantMessagePart => ({
      type: "data",
      name: "terragon.terminal",
      data: {
        name: "terragon.terminal",
        data: {
          type: "terminal",
          sandboxId: "sandbox-1",
          terminalId: "terminal-1",
          chunks: terminalChunks,
        },
      },
    });
    const left = createRuntimeMessageSnapshot(
      assistantMessage([terminalPart(chunks)]),
    );
    const right = createRuntimeMessageSnapshot(
      assistantMessage([terminalPart(changedChunks)]),
    );

    expect(sameRuntimeMessageSnapshot(left, right)).toBe(false);
  });
});
