import { describe, expect, it } from "vitest";
import type { TranscriptItem } from "../transcript-store";
import {
  STORE_FLAG_HAS_PENDING_TOOL_CALL,
  STORE_FLAG_HAS_RENDERABLE_AGENT_PARTS,
  getStoreThreadFlags,
} from "./store-thread-flags";

const base = { runId: "r", seq: 0 } as const;

const text: TranscriptItem = {
  ...base,
  kind: "text",
  key: "text:m",
  messageId: "m",
  text: "answer",
  streaming: false,
};

const pendingTool: TranscriptItem = {
  ...base,
  kind: "tool",
  key: "tool:t",
  toolCallId: "t",
  name: "Bash",
  argsText: "",
  parsedArgs: undefined,
  result: null,
  isError: false,
  status: "running",
  streamingArgs: true,
  parentMessageId: null,
};

describe("getStoreThreadFlags", () => {
  it("is empty for whitespace-only text", () => {
    expect(getStoreThreadFlags([{ ...text, text: "   " }])).toBe(0);
  });

  it("marks renderable agent parts for real text", () => {
    expect(
      getStoreThreadFlags([text]) & STORE_FLAG_HAS_RENDERABLE_AGENT_PARTS,
    ).not.toBe(0);
  });

  it("marks a pending tool call while it has no result", () => {
    const flags = getStoreThreadFlags([pendingTool]);
    expect(flags & STORE_FLAG_HAS_PENDING_TOOL_CALL).not.toBe(0);
    expect(flags & STORE_FLAG_HAS_RENDERABLE_AGENT_PARTS).not.toBe(0);
  });

  it("clears the pending flag once the tool resolves", () => {
    const resolved: TranscriptItem = {
      ...pendingTool,
      result: "done",
      status: "success",
      streamingArgs: false,
    };
    expect(
      getStoreThreadFlags([resolved]) & STORE_FLAG_HAS_PENDING_TOOL_CALL,
    ).toBe(0);
  });
});
