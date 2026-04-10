import { describe, it, expect } from "vitest";
import { getMessagesToProcess } from "./compact";
import { DBMessage } from "@leo/shared";

describe("getMessagesToProcess", () => {
  it("returns all messages when no compact-result or clear-context exists", () => {
    const messages: DBMessage[] = [
      {
        type: "user",
        model: "sonnet",
        parts: [{ type: "text", text: "Hello" }],
      },
      {
        type: "agent",
        parent_tool_use_id: null,
        parts: [{ type: "text", text: "Hi there" }],
      },
    ];

    const result = getMessagesToProcess(messages);
    expect(result).toHaveLength(2);
    expect(result).toEqual(messages);
  });

  it("returns only messages after clear-context", () => {
    const messages: DBMessage[] = [
      {
        type: "user",
        model: "sonnet",
        parts: [{ type: "text", text: "Old message 1" }],
      },
      {
        type: "agent",
        parent_tool_use_id: null,
        parts: [{ type: "text", text: "Old response 1" }],
      },
      {
        type: "system",
        message_type: "clear-context",
        parts: [],
        timestamp: new Date().toISOString(),
      },
      {
        type: "user",
        model: "sonnet",
        parts: [{ type: "text", text: "New message 1" }],
      },
      {
        type: "agent",
        parent_tool_use_id: null,
        parts: [{ type: "text", text: "New response 1" }],
      },
    ];

    const result = getMessagesToProcess(messages);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      type: "user",
      parts: [{ type: "text", text: "New message 1" }],
    });
    expect(result[1]).toMatchObject({
      type: "agent",
      parts: [{ type: "text", text: "New response 1" }],
    });
  });

  it("returns only messages after compact-result", () => {
    const messages: DBMessage[] = [
      {
        type: "user",
        model: "sonnet",
        parts: [{ type: "text", text: "Old message 1" }],
      },
      {
        type: "agent",
        parent_tool_use_id: null,
        parts: [{ type: "text", text: "Old response 1" }],
      },
      {
        type: "system",
        message_type: "compact-result",
        parts: [{ type: "text", text: "Summary of previous messages" }],
        timestamp: new Date().toISOString(),
      },
      {
        type: "user",
        model: "sonnet",
        parts: [{ type: "text", text: "New message 1" }],
      },
      {
        type: "agent",
        parent_tool_use_id: null,
        parts: [{ type: "text", text: "New response 1" }],
      },
    ];

    const result = getMessagesToProcess(messages);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      type: "user",
      parts: [{ type: "text", text: "New message 1" }],
    });
    expect(result[1]).toMatchObject({
      type: "agent",
      parts: [{ type: "text", text: "New response 1" }],
    });
  });

  it("respects the last clear-context when multiple exist", () => {
    const messages: DBMessage[] = [
      {
        type: "user",
        model: "sonnet",
        parts: [{ type: "text", text: "Message 1" }],
      },
      {
        type: "system",
        message_type: "clear-context",
        parts: [],
        timestamp: new Date().toISOString(),
      },
      {
        type: "user",
        model: "sonnet",
        parts: [{ type: "text", text: "Message 2" }],
      },
      {
        type: "system",
        message_type: "clear-context",
        parts: [],
        timestamp: new Date().toISOString(),
      },
      {
        type: "user",
        model: "sonnet",
        parts: [{ type: "text", text: "Message 3" }],
      },
    ];

    const result = getMessagesToProcess(messages);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: "user",
      parts: [{ type: "text", text: "Message 3" }],
    });
  });

  it("prefers clear-context over compact-result when clear is later", () => {
    const messages: DBMessage[] = [
      {
        type: "user",
        model: "sonnet",
        parts: [{ type: "text", text: "Message 1" }],
      },
      {
        type: "system",
        message_type: "compact-result",
        parts: [{ type: "text", text: "Summary 1" }],
        timestamp: new Date().toISOString(),
      },
      {
        type: "user",
        model: "sonnet",
        parts: [{ type: "text", text: "Message 2" }],
      },
      {
        type: "system",
        message_type: "clear-context",
        parts: [],
        timestamp: new Date().toISOString(),
      },
      {
        type: "user",
        model: "sonnet",
        parts: [{ type: "text", text: "Message 3" }],
      },
    ];

    const result = getMessagesToProcess(messages);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: "user",
      parts: [{ type: "text", text: "Message 3" }],
    });
  });

  it("prefers compact-result over clear-context when compact is later", () => {
    const messages: DBMessage[] = [
      {
        type: "user",
        model: "sonnet",
        parts: [{ type: "text", text: "Message 1" }],
      },
      {
        type: "system",
        message_type: "clear-context",
        parts: [],
        timestamp: new Date().toISOString(),
      },
      {
        type: "user",
        model: "sonnet",
        parts: [{ type: "text", text: "Message 2" }],
      },
      {
        type: "system",
        message_type: "compact-result",
        parts: [{ type: "text", text: "Summary 1" }],
        timestamp: new Date().toISOString(),
      },
      {
        type: "user",
        model: "sonnet",
        parts: [{ type: "text", text: "Message 3" }],
      },
    ];

    const result = getMessagesToProcess(messages);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: "user",
      parts: [{ type: "text", text: "Message 3" }],
    });
  });

  it("filters out tool result messages with parent_tool_use_id", () => {
    const messages: DBMessage[] = [
      {
        type: "user",
        model: "sonnet",
        parts: [{ type: "text", text: "Hello" }],
      },
      {
        type: "agent",
        parent_tool_use_id: null,
        parts: [{ type: "text", text: "Hi" }],
      },
      {
        type: "tool-call",
        name: "Bash",
        id: "tool_1",
        parameters: { command: "ls" },
        parent_tool_use_id: null,
      },
      {
        type: "tool-result",
        id: "tool_1",
        result: "file.txt",
        is_error: false,
        parent_tool_use_id: "tool_1",
      },
      {
        type: "agent",
        parent_tool_use_id: null,
        parts: [{ type: "text", text: "Done" }],
      },
    ];

    const result = getMessagesToProcess(messages);
    expect(result).toHaveLength(4);
    expect(result.find((m) => m.type === "tool-result")).toBeUndefined();
  });

  it("handles empty messages array", () => {
    const messages: DBMessage[] = [];
    const result = getMessagesToProcess(messages);
    expect(result).toHaveLength(0);
  });

  it("returns empty array when only clear-context exists", () => {
    const messages: DBMessage[] = [
      {
        type: "system",
        message_type: "clear-context",
        parts: [],
        timestamp: new Date().toISOString(),
      },
    ];

    const result = getMessagesToProcess(messages);
    expect(result).toHaveLength(0);
  });
});
