import { describe, expect, test, vi } from "vitest";
import { tryParseAcpAsCodexEvent } from "./acp-codex-adapter";
import { createCodexParserState } from "./codex";
import type { IDaemonRuntime } from "./runtime";

function createMockRuntime(): IDaemonRuntime {
  return {
    logger: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
    execSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    appendFileSync: vi.fn(),
  } as any;
}

/** Wrap a Codex ThreadEvent in an ACP session/update envelope. */
function wrapInAcpEnvelope(codexEvent: Record<string, unknown>): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "test-session",
      update: {
        sessionUpdate: "agent_message",
        content: codexEvent,
      },
    },
  });
}

describe("tryParseAcpAsCodexEvent", () => {
  const sessionId = "test-session-123";

  test("returns null for non-JSON payload", () => {
    const state = createCodexParserState();
    const runtime = createMockRuntime();
    const result = tryParseAcpAsCodexEvent(
      "not json",
      sessionId,
      state,
      runtime,
    );
    expect(result).toBeNull();
  });

  test("returns null for non-session/update method", () => {
    const state = createCodexParserState();
    const runtime = createMockRuntime();
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      method: "session/prompt",
      params: {},
    });
    const result = tryParseAcpAsCodexEvent(payload, sessionId, state, runtime);
    expect(result).toBeNull();
  });

  test("returns null for regular text sessionUpdate", () => {
    const state = createCodexParserState();
    const runtime = createMockRuntime();
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: "Hello, world!",
        },
      },
    });
    const result = tryParseAcpAsCodexEvent(payload, sessionId, state, runtime);
    expect(result).toBeNull();
  });

  test("parses command_execution in_progress as Bash tool_use", () => {
    const state = createCodexParserState();
    const runtime = createMockRuntime();
    const payload = wrapInAcpEnvelope({
      type: "item.started",
      item: {
        id: "item_1",
        type: "command_execution",
        command: "bash -lc ls",
        aggregated_output: "",
        status: "in_progress",
      },
    });

    const result = tryParseAcpAsCodexEvent(payload, sessionId, state, runtime);
    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    expect(result![0]!.type).toBe("assistant");
    if (result![0]!.type === "assistant") {
      const content = result![0]!.message.content;
      expect(Array.isArray(content)).toBe(true);
      if (Array.isArray(content)) {
        expect(content[0]).toMatchObject({
          type: "tool_use",
          name: "Bash",
          id: "item_1",
          input: { command: "bash -lc ls" },
        });
      }
    }
  });

  test("parses command_execution completed as tool_result", () => {
    const state = createCodexParserState();
    const runtime = createMockRuntime();
    const payload = wrapInAcpEnvelope({
      type: "item.completed",
      item: {
        id: "item_1",
        type: "command_execution",
        command: "bash -lc ls",
        aggregated_output: "file1.ts\nfile2.ts\n",
        exit_code: 0,
        status: "completed",
      },
    });

    const result = tryParseAcpAsCodexEvent(payload, sessionId, state, runtime);
    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    expect(result![0]!.type).toBe("user");
    if (result![0]!.type === "user") {
      const content = result![0]!.message.content;
      expect(Array.isArray(content)).toBe(true);
      if (Array.isArray(content)) {
        expect(content[0]).toMatchObject({
          type: "tool_result",
          tool_use_id: "item_1",
          content: "file1.ts\nfile2.ts\n",
          is_error: false,
        });
      }
    }
  });

  test("parses file_change as Write tool_use + tool_result", () => {
    const state = createCodexParserState();
    const runtime = createMockRuntime();
    const payload = wrapInAcpEnvelope({
      type: "item.completed",
      item: {
        id: "item_7",
        type: "file_change",
        changes: [{ path: "/src/math.ts", kind: "update" }],
        status: "completed",
      },
    });

    const result = tryParseAcpAsCodexEvent(payload, sessionId, state, runtime);
    expect(result).not.toBeNull();
    expect(result).toHaveLength(2);

    const [toolUse, toolResult] = result!;
    expect(toolUse!.type).toBe("assistant");
    if (toolUse!.type === "assistant") {
      const content = toolUse!.message.content;
      if (Array.isArray(content)) {
        expect(content[0]).toMatchObject({
          type: "tool_use",
          name: "FileChange",
          id: "item_7",
          input: { files: [{ path: "/src/math.ts", action: "modified" }] },
        });
      }
    }
    expect(toolResult!.type).toBe("user");
  });

  test("parses web_search started and completed", () => {
    const state = createCodexParserState();
    const runtime = createMockRuntime();

    const startPayload = wrapInAcpEnvelope({
      type: "item.started",
      item: {
        id: "item_ws",
        type: "web_search",
        query: "latest ai news",
      },
    });

    const startResult = tryParseAcpAsCodexEvent(
      startPayload,
      sessionId,
      state,
      runtime,
    );
    expect(startResult).not.toBeNull();
    expect(startResult).toHaveLength(1);
    expect(startResult![0]!.type).toBe("assistant");
    if (startResult![0]!.type === "assistant") {
      const content = startResult![0]!.message.content;
      if (Array.isArray(content)) {
        expect(content[0]).toMatchObject({
          type: "tool_use",
          name: "WebSearch",
          input: { query: "latest ai news" },
        });
      }
    }

    const completedPayload = wrapInAcpEnvelope({
      type: "item.completed",
      item: {
        id: "item_ws",
        type: "web_search",
        query: "latest ai news",
        results: [
          { title: "AI Update", url: "https://example.com", snippet: "Latest" },
        ],
      },
    });

    const completedResult = tryParseAcpAsCodexEvent(
      completedPayload,
      sessionId,
      state,
      runtime,
    );
    expect(completedResult).not.toBeNull();
    expect(completedResult).toHaveLength(1);
    expect(completedResult![0]!.type).toBe("user");
  });

  test("parses agent_message item as assistant text", () => {
    const state = createCodexParserState();
    const runtime = createMockRuntime();
    const payload = wrapInAcpEnvelope({
      type: "item.completed",
      item: {
        id: "item_msg",
        type: "agent_message",
        text: "Here's the result",
      },
    });

    const result = tryParseAcpAsCodexEvent(payload, sessionId, state, runtime);
    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    expect(result![0]!.type).toBe("assistant");
    if (result![0]!.type === "assistant") {
      const content = result![0]!.message.content;
      if (Array.isArray(content)) {
        expect(content[0]).toMatchObject({
          type: "text",
          text: "Here's the result",
        });
      }
    }
  });

  test("parses reasoning item as thinking block", () => {
    const state = createCodexParserState();
    const runtime = createMockRuntime();
    const payload = wrapInAcpEnvelope({
      type: "item.completed",
      item: {
        id: "item_think",
        type: "reasoning",
        text: "**Analyzing the code**",
      },
    });

    const result = tryParseAcpAsCodexEvent(payload, sessionId, state, runtime);
    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    expect(result![0]!.type).toBe("assistant");
    if (result![0]!.type === "assistant") {
      const content = result![0]!.message.content;
      if (Array.isArray(content)) {
        expect(content[0]).toMatchObject({
          type: "thinking",
          thinking: "**Analyzing the code**",
        });
      }
    }
  });

  test("parses thread.started as system init", () => {
    const state = createCodexParserState();
    const runtime = createMockRuntime();
    const payload = wrapInAcpEnvelope({
      type: "thread.started",
      thread_id: "codex-thread-abc",
    });

    const result = tryParseAcpAsCodexEvent(payload, sessionId, state, runtime);
    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    expect(result![0]).toMatchObject({
      type: "system",
      subtype: "init",
      session_id: "codex-thread-abc",
    });
  });

  test("returns empty array for turn.started/turn.completed", () => {
    const state = createCodexParserState();
    const runtime = createMockRuntime();

    const turnStarted = tryParseAcpAsCodexEvent(
      wrapInAcpEnvelope({ type: "turn.started" }),
      sessionId,
      state,
      runtime,
    );
    expect(turnStarted).toEqual([]);

    const turnCompleted = tryParseAcpAsCodexEvent(
      wrapInAcpEnvelope({
        type: "turn.completed",
        usage: { input_tokens: 100 },
      }),
      sessionId,
      state,
      runtime,
    );
    expect(turnCompleted).toEqual([]);
  });

  test("parses top-level error event", () => {
    const state = createCodexParserState();
    const runtime = createMockRuntime();
    const payload = wrapInAcpEnvelope({
      type: "error",
      message: "API key expired",
    });

    const result = tryParseAcpAsCodexEvent(payload, sessionId, state, runtime);
    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    expect(result![0]).toMatchObject({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      error: "API key expired",
    });
  });

  test("parses collab_tool_call (Task) events", () => {
    const state = createCodexParserState();
    const runtime = createMockRuntime();

    const startPayload = wrapInAcpEnvelope({
      type: "item.started",
      item: {
        id: "item_collab",
        type: "collab_tool_call",
        tool: "send_input",
        sender_thread_id: "parent",
        receiver_thread_ids: ["child"],
        prompt: "Fix the tests",
        agents_states: {},
        status: "in_progress",
      },
    });

    const started = tryParseAcpAsCodexEvent(
      startPayload,
      sessionId,
      state,
      runtime,
    );
    expect(started).not.toBeNull();
    expect(started).toHaveLength(1);
    expect(started![0]!.type).toBe("assistant");
    if (started![0]!.type === "assistant") {
      const content = started![0]!.message.content;
      if (Array.isArray(content)) {
        expect(content[0]).toMatchObject({
          type: "tool_use",
          name: "Task",
          id: "item_collab",
        });
      }
    }
  });

  test("parses mcp_tool_call events", () => {
    const state = createCodexParserState();
    const runtime = createMockRuntime();

    const startPayload = wrapInAcpEnvelope({
      type: "item.started",
      item: {
        id: "item_mcp",
        type: "mcp_tool_call",
        server: "ide",
        tool: "getDiagnostics",
        status: "in_progress",
      },
    });

    const started = tryParseAcpAsCodexEvent(
      startPayload,
      sessionId,
      state,
      runtime,
    );
    expect(started).not.toBeNull();
    expect(started).toHaveLength(1);
    expect(started![0]!.type).toBe("assistant");
    if (started![0]!.type === "assistant") {
      const content = started![0]!.message.content;
      if (Array.isArray(content)) {
        expect(content[0]).toMatchObject({
          type: "tool_use",
          name: "MCPTool",
          input: { server: "ide", tool: "getDiagnostics" },
        });
      }
    }
  });

  test("parses todo_list started into TodoRead", () => {
    const state = createCodexParserState();
    const runtime = createMockRuntime();

    const payload = wrapInAcpEnvelope({
      type: "item.started",
      item: {
        id: "item_todo",
        type: "todo_list",
        items: [
          { text: "Write tests", completed: false },
          { text: "Fix bug", completed: true },
        ],
      },
    });

    const result = tryParseAcpAsCodexEvent(payload, sessionId, state, runtime);
    expect(result).not.toBeNull();
    expect(result).toHaveLength(2);
    expect(result![0]!.type).toBe("assistant");
    if (result![0]!.type === "assistant") {
      const content = result![0]!.message.content;
      if (Array.isArray(content)) {
        expect(content[0]).toMatchObject({
          type: "tool_use",
          name: "TodoRead",
        });
      }
    }
  });

  test("handles JSON-stringified Codex event in content", () => {
    const state = createCodexParserState();
    const runtime = createMockRuntime();

    // Content is a JSON string containing the Codex event
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "test",
        update: {
          sessionUpdate: "agent_message",
          content: JSON.stringify({
            type: "item.completed",
            item: {
              id: "item_str",
              type: "agent_message",
              text: "Stringified event",
            },
          }),
        },
      },
    });

    const result = tryParseAcpAsCodexEvent(payload, sessionId, state, runtime);
    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    expect(result![0]!.type).toBe("assistant");
    if (result![0]!.type === "assistant") {
      const content = result![0]!.message.content;
      if (Array.isArray(content)) {
        expect(content[0]).toMatchObject({
          type: "text",
          text: "Stringified event",
        });
      }
    }
  });

  test("falls through for terminal result response", () => {
    const state = createCodexParserState();
    const runtime = createMockRuntime();

    // Terminal response is NOT a session/update — it's a JSON-RPC result
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { stopReason: "end_turn" },
    });

    const result = tryParseAcpAsCodexEvent(payload, sessionId, state, runtime);
    // Should return null to fall through to generic ACP adapter
    expect(result).toBeNull();
  });

  test("nests child events under active collab Task", () => {
    const state = createCodexParserState();
    const runtime = createMockRuntime();

    // Start a collab task
    tryParseAcpAsCodexEvent(
      wrapInAcpEnvelope({
        type: "item.started",
        item: {
          id: "collab_parent",
          type: "collab_tool_call",
          tool: "send_input",
          prompt: "Sub-task",
          agents_states: {},
          status: "in_progress",
        },
      }),
      sessionId,
      state,
      runtime,
    );

    // A command under the collab task
    const cmd = tryParseAcpAsCodexEvent(
      wrapInAcpEnvelope({
        type: "item.started",
        item: {
          id: "cmd_under_collab",
          type: "command_execution",
          command: "bash -lc ls",
          aggregated_output: "",
          status: "in_progress",
        },
      }),
      sessionId,
      state,
      runtime,
    );

    expect(cmd).not.toBeNull();
    expect(cmd).toHaveLength(1);
    if (cmd![0] && "parent_tool_use_id" in cmd![0]) {
      expect(cmd![0].parent_tool_use_id).toBe("collab_parent");
    }
  });
});
