import { describe, expect, it } from "vitest";
import type { DBMessage } from "@terragon/shared";
import { dbMessagesToAgUiMessages } from "./db-messages-to-ag-ui";

describe("dbMessagesToAgUiMessages", () => {
  it("returns empty array for no messages", () => {
    expect(dbMessagesToAgUiMessages([])).toEqual([]);
  });

  it("converts a user text message", () => {
    const input: DBMessage[] = [
      {
        type: "user",
        model: null,
        parts: [{ type: "text", text: "hello" }],
      },
    ];
    const [out] = dbMessagesToAgUiMessages(input);
    expect(out?.role).toBe("user");
    expect(out?.content).toBe("hello");
    expect(typeof out?.id).toBe("string");
  });

  it("joins multiple user text parts with newlines", () => {
    const input: DBMessage[] = [
      {
        type: "user",
        model: null,
        parts: [
          { type: "text", text: "line 1" },
          { type: "text", text: "line 2" },
        ],
      },
    ];
    const [out] = dbMessagesToAgUiMessages(input);
    expect(out?.content).toBe("line 1\nline 2");
  });

  it("converts an agent message to role=assistant", () => {
    const input: DBMessage[] = [
      {
        type: "agent",
        parent_tool_use_id: null,
        parts: [{ type: "text", text: "response" }],
      },
    ];
    const [out] = dbMessagesToAgUiMessages(input);
    expect(out?.role).toBe("assistant");
    expect(out?.content).toBe("response");
  });

  it("converts a tool-call to an assistant message with toolCalls", () => {
    const input: DBMessage[] = [
      {
        type: "tool-call",
        id: "tc-1",
        name: "Bash",
        parameters: { command: "echo hi" },
        parent_tool_use_id: null,
      },
    ];
    const [out] = dbMessagesToAgUiMessages(input);
    expect(out?.role).toBe("assistant");
    // AG-UI tool calls live on the assistant message. Zod schemas vary in
    // whether `toolCalls` is surfaced; accept either presence or the schema's
    // absence (tolerate variations).
    const toolCalls = (out as { toolCalls?: unknown[] }).toolCalls;
    expect(Array.isArray(toolCalls)).toBe(true);
    expect(toolCalls?.[0]).toMatchObject({
      id: "tc-1",
      type: "function",
      function: { name: "Bash" },
    });
    const fn = (toolCalls?.[0] as { function: { arguments: string } }).function;
    expect(JSON.parse(fn.arguments)).toEqual({ command: "echo hi" });
  });

  it("converts a tool-result to role=tool", () => {
    const input: DBMessage[] = [
      {
        type: "tool-result",
        id: "tc-1",
        is_error: false,
        parent_tool_use_id: null,
        result: "output",
      },
    ];
    const [out] = dbMessagesToAgUiMessages(input);
    expect(out?.role).toBe("tool");
    expect(out?.content).toBe("output");
    expect((out as { toolCallId?: string }).toolCallId).toBe("tc-1");
    // Success case should not attach an `error` field.
    expect((out as { error?: string }).error).toBeUndefined();
  });

  it("surfaces the diagnostic in `error` when tool-result is_error is true", () => {
    const input: DBMessage[] = [
      {
        type: "tool-result",
        id: "tc-err",
        is_error: true,
        parent_tool_use_id: null,
        result: "boom: permission denied",
      },
    ];
    const [out] = dbMessagesToAgUiMessages(input);
    expect(out?.role).toBe("tool");
    expect(out?.content).toBe("boom: permission denied");
    expect((out as { error?: string }).error).toBe("boom: permission denied");
  });

  it("converts a system message with text parts", () => {
    const input: DBMessage[] = [
      {
        type: "system",
        message_type: "clear-context",
        parts: [{ type: "text", text: "context cleared" }],
      },
    ];
    const [out] = dbMessagesToAgUiMessages(input);
    expect(out?.role).toBe("system");
    expect(out?.content).toBe("context cleared");
  });

  it("uses message_type as fallback content for empty system messages", () => {
    const input: DBMessage[] = [
      {
        type: "system",
        message_type: "generic-retry",
        parts: [],
      },
    ];
    const [out] = dbMessagesToAgUiMessages(input);
    expect(out?.content).toBe("[generic-retry]");
  });

  it("converts a delegation message to assistant history", () => {
    const input: DBMessage[] = [
      {
        type: "delegation",
        model: null,
        delegationId: "del-001",
        tool: "spawn",
        status: "running",
        senderThreadId: "thread-1",
        receiverThreadIds: ["agent-1"],
        prompt: "Review the PR",
        delegatedModel: "claude-sonnet",
        agentsStates: { "agent-1": "running" },
      },
    ];
    const [out] = dbMessagesToAgUiMessages(input);
    expect(out).toMatchObject({
      role: "assistant",
      content: "Delegation running: Review the PR",
    });
  });

  it("skips unsupported variants (git-diff, stop, error, meta)", () => {
    const input: DBMessage[] = [
      {
        type: "user",
        model: null,
        parts: [{ type: "text", text: "hello" }],
      },
      { type: "stop" },
      {
        type: "error",
        error_type: "invalid-token-retry",
        error_info: "boom",
      },
      {
        type: "agent",
        parent_tool_use_id: null,
        parts: [{ type: "text", text: "world" }],
      },
    ];
    const out = dbMessagesToAgUiMessages(input);
    expect(out).toHaveLength(2);
    expect(out[0]?.role).toBe("user");
    expect(out[1]?.role).toBe("assistant");
  });

  it("assigns unique synthetic ids to each message", () => {
    const input: DBMessage[] = [
      {
        type: "user",
        model: null,
        parts: [{ type: "text", text: "a" }],
      },
      {
        type: "agent",
        parent_tool_use_id: null,
        parts: [{ type: "text", text: "b" }],
      },
    ];
    const [a, b] = dbMessagesToAgUiMessages(input);
    expect(a?.id).not.toBe(b?.id);
  });

  it("extracts text from rich-text user parts", () => {
    const input: DBMessage[] = [
      {
        type: "user",
        model: null,
        parts: [
          {
            type: "rich-text",
            nodes: [
              { type: "text", text: "hi " },
              { type: "mention", text: "@user" },
              { type: "text", text: " hello" },
            ],
          },
        ],
      },
    ];
    const [out] = dbMessagesToAgUiMessages(input);
    expect(out?.content).toBe("hi @user hello");
  });

  it("returns [] when input contains only unsupported variants", () => {
    // Locks the "skip, don't throw" contract — a thread made exclusively of
    // git-diff / stop / error / meta messages must hydrate to an empty seed.
    const input: DBMessage[] = [
      {
        type: "git-diff",
        diff: "",
      },
      { type: "stop" },
    ];
    expect(dbMessagesToAgUiMessages(input)).toEqual([]);
  });
});
