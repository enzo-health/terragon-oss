import { describe, expect, test, vi } from "vitest";
import {
  buildThreadStartParams,
  buildTurnStartParams,
  CODEX_TURN_START_MAX_INPUT_CHARS,
  estimateTurnStartRequestSizeChars,
  codexAppServerStartCommand,
  codexCommand,
  createCodexParserState,
  parseCodexLine,
} from "./codex";
import type { IDaemonRuntime } from "./runtime";

describe("parseCodexLine", () => {
  const mockRuntime: IDaemonRuntime = {
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

  test("should parse thread.started event", () => {
    const line =
      '{"type":"thread.started","thread_id":"0199cb44-d7e2-7fc1-87ca-6f41dbc18d72"}';
    const results = parseCodexLine({ line, runtime: mockRuntime });

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      type: "system",
      subtype: "init",
      session_id: "0199cb44-d7e2-7fc1-87ca-6f41dbc18d72",
      tools: [],
      mcp_servers: [],
    });
  });

  test("should parse reasoning item", () => {
    const line =
      '{"type":"item.completed","item":{"id":"item_0","type":"reasoning","text":"**Preparing greeting response**"}}';
    const results = parseCodexLine({ line, runtime: mockRuntime });

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "**Preparing greeting response**",
            signature: "codex-synthetic-signature",
          },
        ],
      },
      parent_tool_use_id: null,
      session_id: "",
    });
  });

  test("should parse agent_message item", () => {
    const line =
      '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"Hey! What can I help you with today?"}}';
    const results = parseCodexLine({ line, runtime: mockRuntime });

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Hey! What can I help you with today?" },
        ],
      },
      parent_tool_use_id: null,
      session_id: "",
    });
  });

  test("should emit agent_message intermediate content on item.started with non-empty text", () => {
    const line =
      '{"type":"item.started","item":{"id":"item_1","type":"agent_message","text":"Hey!"}}';
    const state = createCodexParserState();
    const results = parseCodexLine({ line, runtime: mockRuntime, state });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Hey!" }],
      },
    });
    // Starting with empty text: should not emit.
    const emptyLine =
      '{"type":"item.started","item":{"id":"item_2","type":"agent_message","text":""}}';
    const emptyResults = parseCodexLine({
      line: emptyLine,
      runtime: mockRuntime,
      state,
    });
    expect(emptyResults).toHaveLength(0);
  });

  test("should emit intermediate agent_message on item.updated when content grows", () => {
    const state = createCodexParserState();
    const firstLine =
      '{"type":"item.updated","item":{"id":"item_1","type":"agent_message","text":"Hey!"}}';
    const firstResults = parseCodexLine({
      line: firstLine,
      runtime: mockRuntime,
      state,
    });
    expect(firstResults).toHaveLength(1);

    // Cumulative update: should emit again since content grew.
    const secondLine =
      '{"type":"item.updated","item":{"id":"item_1","type":"agent_message","text":"Hey! What can I"}}';
    const secondResults = parseCodexLine({
      line: secondLine,
      runtime: mockRuntime,
      state,
    });
    expect(secondResults).toHaveLength(1);
    expect(secondResults[0]).toMatchObject({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Hey! What can I" }],
      },
    });

    // Re-emission of the SAME cumulative text should be deduped.
    const dupResults = parseCodexLine({
      line: secondLine,
      runtime: mockRuntime,
      state,
    });
    expect(dupResults).toHaveLength(0);
  });

  test("should suppress agent_message item.completed when identical to last emitted", () => {
    const state = createCodexParserState();
    const updateLine =
      '{"type":"item.updated","item":{"id":"item_1","type":"agent_message","text":"Final text."}}';
    const completedLine =
      '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"Final text."}}';
    parseCodexLine({ line: updateLine, runtime: mockRuntime, state });
    const completedResults = parseCodexLine({
      line: completedLine,
      runtime: mockRuntime,
      state,
    });
    // Already emitted identical text on item.updated; item.completed dedups.
    expect(completedResults).toHaveLength(0);
  });

  test("should emit intermediate reasoning chunks on item.started", () => {
    const line =
      '{"type":"item.started","item":{"id":"item_0","type":"reasoning","text":"Thinking..."}}';
    const state = createCodexParserState();
    const results = parseCodexLine({ line, runtime: mockRuntime, state });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "Thinking...",
            signature: "codex-synthetic-signature",
          },
        ],
      },
    });
  });

  test("should emit intermediate reasoning content on item.updated when content grows", () => {
    const state = createCodexParserState();
    const firstLine =
      '{"type":"item.updated","item":{"id":"item_0","type":"reasoning","text":"Thinking..."}}';
    const secondLine =
      '{"type":"item.updated","item":{"id":"item_0","type":"reasoning","text":"Thinking about the problem..."}}';
    const firstResults = parseCodexLine({
      line: firstLine,
      runtime: mockRuntime,
      state,
    });
    expect(firstResults).toHaveLength(1);
    const secondResults = parseCodexLine({
      line: secondLine,
      runtime: mockRuntime,
      state,
    });
    expect(secondResults).toHaveLength(1);
    expect(secondResults[0]).toMatchObject({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          expect.objectContaining({
            type: "thinking",
            thinking: "Thinking about the problem...",
          }),
        ],
      },
    });
    // Identical resend: deduped.
    const dupResults = parseCodexLine({
      line: secondLine,
      runtime: mockRuntime,
      state,
    });
    expect(dupResults).toHaveLength(0);
  });

  test("should parse command_execution with in_progress status", () => {
    const line =
      '{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"bash -lc ls","aggregated_output":"","status":"in_progress"}}';
    const results = parseCodexLine({ line, runtime: mockRuntime });
    expect(results).toHaveLength(1);
    const result = results[0];
    expect(result).toBeDefined();
    expect(result?.type).toBe("assistant");
    if (result?.type === "assistant") {
      const content = result.message.content;
      expect(Array.isArray(content)).toBe(true);
      if (Array.isArray(content)) {
        expect(content[0]).toMatchObject({
          type: "tool_use",
          name: "Bash",
          input: { command: "bash -lc ls" },
          id: "item_1",
        });
      }
    }
  });

  test("should parse command_execution with completed status (success)", () => {
    const line =
      '{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"bash -lc ls","aggregated_output":"AGENTS.md\\napps\\n","exit_code":0,"status":"completed"}}';
    const results = parseCodexLine({ line, runtime: mockRuntime });
    expect(results).toHaveLength(1);
    const result = results[0];

    expect(result).toBeDefined();
    expect(result?.type).toBe("user");
    if (result?.type === "user") {
      const content = result.message.content;
      expect(Array.isArray(content)).toBe(true);
      if (Array.isArray(content)) {
        expect(content[0]).toMatchObject({
          type: "tool_result",
          tool_use_id: "item_1",
          content: "AGENTS.md\napps\n",
          is_error: false,
        });
      }
    }
  });

  test("should parse command_execution with completed status (error) and include exit code", () => {
    const line =
      '{"type":"item.completed","item":{"id":"item_2","type":"command_execution","command":"bash -lc \'cat nonexistent\'","aggregated_output":"cat: nonexistent: No such file or directory\\n","exit_code":1,"status":"completed"}}';
    const results = parseCodexLine({ line, runtime: mockRuntime });
    expect(results).toHaveLength(1);
    const result = results[0];

    expect(result).toBeDefined();
    expect(result?.type).toBe("user");
    if (result?.type === "user") {
      const content = result.message.content;
      expect(Array.isArray(content)).toBe(true);
      if (Array.isArray(content)) {
        expect(content[0]).toMatchObject({
          type: "tool_result",
          tool_use_id: "item_2",
          is_error: true,
        });
        if (
          content[0] &&
          typeof content[0] === "object" &&
          "content" in content[0]
        ) {
          expect(content[0].content).toContain("[exit code: 1]");
          expect(content[0].content).toContain(
            "cat: nonexistent: No such file or directory",
          );
        }
      }
    }
  });

  test("should parse command_execution with declined status as non-error", () => {
    const line =
      '{"type":"item.completed","item":{"id":"item_3","type":"command_execution","command":"bash -lc dangerous","aggregated_output":"Command was denied","status":"declined"}}';
    const results = parseCodexLine({ line, runtime: mockRuntime });

    expect(results).toHaveLength(1);
    const result = results[0];

    expect(result).toBeDefined();
    expect(result?.type).toBe("user");
    if (result?.type === "user") {
      const content = result.message.content;
      expect(Array.isArray(content)).toBe(true);
      if (Array.isArray(content)) {
        expect(content[0]).toMatchObject({
          type: "tool_result",
          tool_use_id: "item_3",
          content: "Command was denied",
          is_error: false,
        });
      }
    }
  });

  test("should return null for turn.started", () => {
    const line = '{"type":"turn.started"}';
    const results = parseCodexLine({ line, runtime: mockRuntime });
    expect(results).toHaveLength(0);
  });

  test("should return null for turn.completed and log usage", () => {
    const line =
      '{"type":"turn.completed","usage":{"input_tokens":6450,"cached_input_tokens":2048,"output_tokens":16}}';
    const results = parseCodexLine({ line, runtime: mockRuntime });

    expect(results).toHaveLength(0);
    expect(mockRuntime.logger.debug).toHaveBeenCalledWith("Codex token usage", {
      input_tokens: 6450,
      cached_input_tokens: 2048,
      output_tokens: 16,
    });
  });

  test("should surface file_change as FileChange tool call", () => {
    const line =
      '{"type":"item.completed","item":{"id":"item_7","type":"file_change","changes":[{"path":"/Users/michael/Projects/test-project/src/math.ts","kind":"update"}],"status":"completed"}}';
    const results = parseCodexLine({ line, runtime: mockRuntime });

    expect(results).toHaveLength(2);

    const [toolUse, toolResult] = results;
    expect(toolUse?.type).toBe("assistant");
    if (toolUse?.type === "assistant") {
      const content = toolUse.message.content;
      expect(Array.isArray(content)).toBe(true);
      if (Array.isArray(content)) {
        expect(content[0]).toMatchObject({
          type: "tool_use",
          name: "FileChange",
          id: "item_7",
          input: {
            files: [
              {
                path: "/Users/michael/Projects/test-project/src/math.ts",
                action: "modified",
              },
            ],
          },
        });
      }
    }

    expect(toolResult?.type).toBe("user");
    if (toolResult?.type === "user") {
      const content = toolResult.message.content;
      expect(Array.isArray(content)).toBe(true);
      if (Array.isArray(content)) {
        expect(content[0]).toMatchObject({
          type: "tool_result",
          tool_use_id: "item_7",
          content: "/Users/michael/Projects/test-project/src/math.ts",
          is_error: false,
        });
      }
    }
  });

  test("should return empty for file_change with no changes", () => {
    const line =
      '{"type":"item.completed","item":{"id":"item_8","type":"file_change","changes":[],"status":"completed"}}';
    const results = parseCodexLine({ line, runtime: mockRuntime });
    expect(results).toHaveLength(0);
  });

  test("should handle invalid JSON as text", () => {
    const line = "not valid json";
    const results = parseCodexLine({ line, runtime: mockRuntime });

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      type: "assistant",
      message: {
        role: "assistant",
        content: "not valid json",
      },
      parent_tool_use_id: null,
      session_id: "",
    });
  });

  test("should handle JSON without type field as text", () => {
    const line = '{"some":"data"}';
    const results = parseCodexLine({ line, runtime: mockRuntime });

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      type: "assistant",
      message: {
        role: "assistant",
        content: '{"some":"data"}',
      },
      parent_tool_use_id: null,
      session_id: "",
    });
  });

  test("should warn and return null for unknown item type", () => {
    const line =
      '{"type":"item.completed","item":{"id":"item_1","type":"unknown_type","data":"test"}}';
    const results = parseCodexLine({ line, runtime: mockRuntime });

    expect(results).toHaveLength(0);
    expect(mockRuntime.logger.warn).toHaveBeenCalledWith(
      "Unknown Codex item type",
      expect.objectContaining({
        type: "unknown_type",
      }),
    );
  });

  test("should parse full conversation from user logs", () => {
    const lines = [
      '{"type":"thread.started","thread_id":"0199cb44-d7e2-7fc1-87ca-6f41dbc18d72"}',
      '{"type":"turn.started"}',
      '{"type":"item.completed","item":{"id":"item_0","type":"reasoning","text":"**Preparing to read README**"}}',
      '{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"bash -lc ls","aggregated_output":"","status":"in_progress"}}',
      '{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"bash -lc ls","aggregated_output":"AGENTS.md\\napps\\nCLAUDE.local.md\\n","exit_code":0,"status":"completed"}}',
      '{"type":"item.completed","item":{"id":"item_2","type":"reasoning","text":"**Viewing README file**"}}',
      '{"type":"item.started","item":{"id":"item_3","type":"command_execution","command":"bash -lc \'cat README.md\'","aggregated_output":"","status":"in_progress"}}',
      '{"type":"item.completed","item":{"id":"item_3","type":"command_execution","command":"bash -lc \'cat README.md\'","aggregated_output":"# Terragon\\n\\nDelegation platform\\n","exit_code":0,"status":"completed"}}',
      '{"type":"item.completed","item":{"id":"item_4","type":"reasoning","text":"**Preparing summary**"}}',
      '{"type":"item.completed","item":{"id":"item_5","type":"agent_message","text":"Terragon is a delegation platform"}}',
      '{"type":"turn.completed","usage":{"input_tokens":20854,"cached_input_tokens":19584,"output_tokens":294}}',
    ];

    const results = lines.flatMap((line) =>
      parseCodexLine({ line, runtime: mockRuntime }),
    );

    // Should have: init, reasoning, bash, bash_result, reasoning, bash, bash_result, reasoning, agent_message
    expect(results).toHaveLength(9);

    // Verify sequence
    expect(results[0]?.type).toBe("system");
    expect(results[1]?.type).toBe("assistant"); // reasoning
    expect(results[2]?.type).toBe("assistant"); // bash tool_use
    expect(results[3]?.type).toBe("user"); // bash tool_result
    expect(results[4]?.type).toBe("assistant"); // reasoning
    expect(results[5]?.type).toBe("assistant"); // bash tool_use
    expect(results[6]?.type).toBe("user"); // bash tool_result
    expect(results[7]?.type).toBe("assistant"); // reasoning
    expect(results[8]?.type).toBe("assistant"); // agent_message

    // Verify first init message
    if (results[0]?.type === "system") {
      expect(results[0].session_id).toBe(
        "0199cb44-d7e2-7fc1-87ca-6f41dbc18d72",
      );
    }

    // Verify tool uses have correct IDs
    if (results[2]?.type === "assistant") {
      const content = results[2].message.content;
      if (Array.isArray(content) && content[0]?.type === "tool_use") {
        expect(content[0].id).toBe("item_1");
      }
    }

    // Verify tool results match tool use IDs
    if (results[3]?.type === "user") {
      const content = results[3].message.content;
      if (Array.isArray(content) && content[0]?.type === "tool_result") {
        expect(content[0].tool_use_id).toBe("item_1");
      }
    }
  });

  test("should parse web_search item started and completed with structured results", () => {
    const startedLine =
      '{"type":"item.started","item":{"id":"item_web","type":"web_search","query":"latest ai news"}}';
    const completedLine =
      '{"type":"item.completed","item":{"id":"item_web","type":"web_search","query":"latest ai news","results":[{"title":"AI News","url":"https://example.com","snippet":"Latest updates"}]}}';

    const started = parseCodexLine({
      line: startedLine,
      runtime: mockRuntime,
    });
    const completed = parseCodexLine({
      line: completedLine,
      runtime: mockRuntime,
    });

    expect(started).toHaveLength(1);
    const startedMessage = started[0];
    expect(startedMessage).toBeDefined();
    expect(startedMessage?.type).toBe("assistant");
    if (startedMessage?.type === "assistant") {
      const content = startedMessage.message.content;
      expect(Array.isArray(content)).toBe(true);
      if (Array.isArray(content)) {
        expect(content[0]).toMatchObject({
          type: "tool_use",
          name: "WebSearch",
          id: "item_web",
          input: { query: "latest ai news" },
        });
      }
    }

    expect(completed).toHaveLength(1);
    const completedMessage = completed[0];
    expect(completedMessage).toBeDefined();
    expect(completedMessage?.type).toBe("user");
    if (completedMessage?.type === "user") {
      const content = completedMessage.message.content;
      expect(Array.isArray(content)).toBe(true);
      if (Array.isArray(content)) {
        expect(content[0]).toMatchObject({
          type: "tool_result",
          tool_use_id: "item_web",
          is_error: false,
        });
        if (
          content[0] &&
          typeof content[0] === "object" &&
          "content" in content[0]
        ) {
          expect(content[0].content).toContain("AI News");
          expect(content[0].content).toContain("https://example.com");
          expect(content[0].content).toContain("Latest updates");
        }
      }
    }
  });

  test("should parse error item into result message", () => {
    const line =
      '{"type":"item.completed","item":{"id":"item_err","type":"error","message":"Something went wrong"}}';
    const results = parseCodexLine({ line, runtime: mockRuntime });

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      session_id: "",
      error: "Something went wrong",
      num_turns: 0,
      duration_ms: 0,
    });
  });

  test("should parse mcp_tool_call started and completed", () => {
    const startedLine =
      '{"type":"item.started","item":{"id":"item_mcp","type":"mcp_tool_call","server":"ide","tool":"getDiagnostics","status":"in_progress"}}';
    const completedLine =
      '{"type":"item.completed","item":{"id":"item_mcp","type":"mcp_tool_call","server":"ide","tool":"getDiagnostics","status":"completed","result":{"diagnostics":0}}}';

    const started = parseCodexLine({
      line: startedLine,
      runtime: mockRuntime,
    });
    const completed = parseCodexLine({
      line: completedLine,
      runtime: mockRuntime,
    });

    expect(started).toHaveLength(1);
    const startedMessage = started[0];
    expect(startedMessage).toBeDefined();
    expect(startedMessage?.type).toBe("assistant");
    if (startedMessage?.type === "assistant") {
      const content = startedMessage.message.content;
      expect(Array.isArray(content)).toBe(true);
      if (Array.isArray(content)) {
        expect(content[0]).toMatchObject({
          type: "tool_use",
          name: "MCPTool",
          input: { server: "ide", tool: "getDiagnostics" },
          id: "item_mcp",
        });
      }
    }

    expect(completed).toHaveLength(1);
    const completedMessage = completed[0];
    expect(completedMessage).toBeDefined();
    expect(completedMessage?.type).toBe("user");
    if (completedMessage?.type === "user") {
      const content = completedMessage.message.content;
      expect(Array.isArray(content)).toBe(true);
      if (Array.isArray(content)) {
        expect(content[0]).toMatchObject({
          type: "tool_result",
          tool_use_id: "item_mcp",
          is_error: false,
        });
        if (
          content[0] &&
          typeof content[0] === "object" &&
          "content" in content[0]
        ) {
          expect(content[0].content).toContain("diagnostics");
        }
      }
    }
  });

  test("should transform todo_list started into TodoRead tool call", () => {
    const line =
      '{"type":"item.started","item":{"id":"item_todo","type":"todo_list","items":[{"text":"Write tests","completed":false},{"text":"Fix bug","completed":true}]}}';
    const results = parseCodexLine({ line, runtime: mockRuntime });

    expect(results).toHaveLength(2);

    const [toolUse, toolResult] = results;

    expect(toolUse).toBeDefined();
    expect(toolUse?.type).toBe("assistant");
    if (toolUse?.type === "assistant") {
      const content = toolUse.message.content;
      expect(Array.isArray(content)).toBe(true);
      if (Array.isArray(content)) {
        expect(content[0]).toMatchObject({
          type: "tool_use",
          name: "TodoRead",
          input: {},
          id: "item_todo-read",
        });
      }
    }

    expect(toolResult).toBeDefined();
    expect(toolResult?.type).toBe("user");
    if (toolResult?.type === "user") {
      const content = toolResult.message.content;
      expect(Array.isArray(content)).toBe(true);
      if (Array.isArray(content)) {
        expect(content[0]).toMatchObject({
          type: "tool_result",
          tool_use_id: "item_todo-read",
          is_error: false,
        });
        if (
          content[0] &&
          typeof content[0] === "object" &&
          "content" in content[0]
        ) {
          expect(content[0].content).toContain("Write tests");
          expect(content[0].content).toContain("Fix bug");
        }
      }
    }
  });

  test("should transform todo_list completed into TodoWrite tool call", () => {
    const line =
      '{"type":"item.completed","item":{"id":"item_todo","type":"todo_list","items":[{"text":"Write tests","completed":false},{"text":"Fix bug","completed":true}]}}';
    const results = parseCodexLine({ line, runtime: mockRuntime });

    expect(results).toHaveLength(2);

    const [toolUse, toolResult] = results;

    expect(toolUse).toBeDefined();
    expect(toolUse?.type).toBe("assistant");
    if (toolUse?.type === "assistant") {
      const content = toolUse.message.content;
      expect(Array.isArray(content)).toBe(true);
      if (Array.isArray(content)) {
        expect(content[0]).toMatchObject({
          type: "tool_use",
          name: "TodoWrite",
          id: "item_todo-write",
        });
        if (
          content[0] &&
          typeof content[0] === "object" &&
          "input" in content[0]
        ) {
          expect(content[0].input).toMatchObject({
            todos: [
              { id: "1", content: "Write tests", status: "pending" },
              { id: "2", content: "Fix bug", status: "completed" },
            ],
          });
        }
      }
    }

    expect(toolResult).toBeDefined();
    expect(toolResult?.type).toBe("user");
    if (toolResult?.type === "user") {
      const content = toolResult.message.content;
      expect(Array.isArray(content)).toBe(true);
      if (Array.isArray(content)) {
        expect(content[0]).toMatchObject({
          type: "tool_result",
          tool_use_id: "item_todo-write",
          is_error: false,
        });
        if (
          content[0] &&
          typeof content[0] === "object" &&
          "content" in content[0]
        ) {
          expect(content[0].content).toContain("Updated todo list");
        }
      }
    }
  });

  test("should emit todo_list item.updated when content changes", () => {
    const state = createCodexParserState();
    const firstLine =
      '{"type":"item.updated","item":{"id":"item_todo","type":"todo_list","items":[{"text":"Write tests","completed":false}]}}';
    const firstResults = parseCodexLine({
      line: firstLine,
      runtime: mockRuntime,
      state,
    });
    // Intermediate todo update now emits a TodoWrite tool_use + tool_result
    // pair so users see live progress.
    expect(firstResults).toHaveLength(2);
    expect(firstResults[0]).toMatchObject({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          expect.objectContaining({
            type: "tool_use",
            name: "TodoWrite",
          }),
        ],
      },
    });

    // Same list emitted again: deduped by content hash.
    const dupResults = parseCodexLine({
      line: firstLine,
      runtime: mockRuntime,
      state,
    });
    expect(dupResults).toHaveLength(0);

    // List changed (item marked complete): emits a new pair.
    const changedLine =
      '{"type":"item.updated","item":{"id":"item_todo","type":"todo_list","items":[{"text":"Write tests","completed":true}]}}';
    const changedResults = parseCodexLine({
      line: changedLine,
      runtime: mockRuntime,
      state,
    });
    expect(changedResults).toHaveLength(2);
  });

  test("should parse top-level error event into result message", () => {
    const line =
      '{"type":"error","message":"API key not found in environment"}';
    const results = parseCodexLine({ line, runtime: mockRuntime });

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      type: "result",
      subtype: "error_during_execution",
      session_id: "",
      error: "API key not found in environment",
      is_error: true,
      num_turns: 0,
      duration_ms: 0,
    });
  });

  test("should handle error event without message field", () => {
    const line = '{"type":"error"}';
    const results = parseCodexLine({ line, runtime: mockRuntime });

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      type: "result",
      subtype: "error_during_execution",
      session_id: "",
      error: "Codex reported an error.",
      is_error: true,
      num_turns: 0,
      duration_ms: 0,
    });
  });

  test("should ignore top-level unstable feature warning error", () => {
    const line =
      '{"type":"error","message":"Under-development features enabled: child_agents_md."}';
    const results = parseCodexLine({ line, runtime: mockRuntime });

    expect(results).toHaveLength(0);
  });

  test("should ignore non-json unstable feature warning line", () => {
    const line =
      "Under-development features enabled: child_agents_md. Under-development features are incomplete and may behave unpredictably.";
    const results = parseCodexLine({ line, runtime: mockRuntime });

    expect(results).toHaveLength(0);
  });

  test("should ignore item error for unstable feature warning", () => {
    const line =
      '{"type":"item.completed","item":{"id":"item_warning","type":"error","message":"Under-development features enabled: child_agents_md."}}';
    const results = parseCodexLine({ line, runtime: mockRuntime });

    expect(results).toHaveLength(0);
  });

  test("should parse collab send_input events into Task tool events", () => {
    const state = createCodexParserState();
    const startedLine =
      '{"type":"item.started","item":{"id":"item_collab","type":"collab_tool_call","tool":"send_input","sender_thread_id":"thread_parent","receiver_thread_ids":["thread_child"],"prompt":"Investigate deployment failure","agents_states":{},"status":"in_progress"}}';
    const completedLine =
      '{"type":"item.completed","item":{"id":"item_collab","type":"collab_tool_call","tool":"send_input","sender_thread_id":"thread_parent","receiver_thread_ids":["thread_child"],"prompt":"Investigate deployment failure","agents_states":{"thread_child":{"status":"completed","message":"done"}},"status":"completed"}}';

    const started = parseCodexLine({
      line: startedLine,
      runtime: mockRuntime,
      state,
    });
    const completed = parseCodexLine({
      line: completedLine,
      runtime: mockRuntime,
      state,
    });

    expect(started).toHaveLength(1);
    expect(started[0]?.type).toBe("assistant");
    if (started[0]?.type === "assistant") {
      const content = started[0].message.content;
      expect(Array.isArray(content)).toBe(true);
      if (Array.isArray(content)) {
        expect(content[0]).toMatchObject({
          type: "tool_use",
          name: "Task",
          id: "item_collab",
          input: {
            prompt: "Investigate deployment failure",
            subagent_type: "codex-subagent",
          },
        });
      }
    }

    expect(completed).toHaveLength(1);
    expect(completed[0]?.type).toBe("user");
    if (completed[0]?.type === "user") {
      const content = completed[0].message.content;
      expect(Array.isArray(content)).toBe(true);
      if (Array.isArray(content)) {
        expect(content[0]).toMatchObject({
          type: "tool_result",
          tool_use_id: "item_collab",
          is_error: false,
        });
      }
    }
  });

  test("should parse failed collab send_input events with error flag", () => {
    const state = createCodexParserState();
    const startedLine =
      '{"type":"item.started","item":{"id":"item_collab_failed","type":"collab_tool_call","tool":"send_input","sender_thread_id":"thread_parent","receiver_thread_ids":["thread_child"],"prompt":"Investigate deployment failure","agents_states":{},"status":"in_progress"}}';
    const failedLine =
      '{"type":"item.completed","item":{"id":"item_collab_failed","type":"collab_tool_call","tool":"send_input","sender_thread_id":"thread_parent","receiver_thread_ids":["thread_child"],"prompt":"Investigate deployment failure","agents_states":{"thread_child":{"status":"failed","message":"Something went wrong"}},"status":"failed"}}';

    parseCodexLine({
      line: startedLine,
      runtime: mockRuntime,
      state,
    });
    const failed = parseCodexLine({
      line: failedLine,
      runtime: mockRuntime,
      state,
    });

    expect(failed).toHaveLength(1);
    expect(failed[0]?.type).toBe("user");
    if (failed[0]?.type === "user") {
      const content = failed[0].message.content;
      expect(Array.isArray(content)).toBe(true);
      if (Array.isArray(content)) {
        expect(content[0]).toMatchObject({
          type: "tool_result",
          tool_use_id: "item_collab_failed",
          is_error: true,
        });
        if (
          content[0] &&
          typeof content[0] === "object" &&
          "content" in content[0] &&
          typeof content[0].content === "string"
        ) {
          expect(content[0].content).toContain("Something went wrong");
        }
      }
    }
  });

  test("should not emit duplicate Task start if item.updated arrives before item.started", () => {
    const state = createCodexParserState();
    const updated = parseCodexLine({
      line: '{"type":"item.updated","item":{"id":"item_collab_dup","type":"collab_tool_call","tool":"send_input","sender_thread_id":"thread_parent","receiver_thread_ids":["thread_child"],"prompt":"Investigate race condition","agents_states":{},"status":"in_progress"}}',
      runtime: mockRuntime,
      state,
    });
    const started = parseCodexLine({
      line: '{"type":"item.started","item":{"id":"item_collab_dup","type":"collab_tool_call","tool":"send_input","sender_thread_id":"thread_parent","receiver_thread_ids":["thread_child"],"prompt":"Investigate race condition","agents_states":{},"status":"in_progress"}}',
      runtime: mockRuntime,
      state,
    });

    expect(updated).toHaveLength(1);
    expect(started).toHaveLength(0);
  });

  test("should nest child tool events under active collab Task", () => {
    const state = createCodexParserState();
    parseCodexLine({
      line: '{"type":"item.started","item":{"id":"item_collab","type":"collab_tool_call","tool":"send_input","sender_thread_id":"thread_parent","receiver_thread_ids":["thread_child"],"prompt":"Debug flaky test","agents_states":{},"status":"in_progress"}}',
      runtime: mockRuntime,
      state,
    });

    const commandStarted = parseCodexLine({
      line: '{"type":"item.started","item":{"id":"item_cmd","type":"command_execution","command":"bash -lc ls","aggregated_output":"","status":"in_progress"}}',
      runtime: mockRuntime,
      state,
    });
    const commandCompleted = parseCodexLine({
      line: '{"type":"item.completed","item":{"id":"item_cmd","type":"command_execution","command":"bash -lc ls","aggregated_output":"apps\\npackages\\n","exit_code":0,"status":"completed"}}',
      runtime: mockRuntime,
      state,
    });

    expect(commandStarted).toHaveLength(1);
    expect(
      commandStarted[0] && "parent_tool_use_id" in commandStarted[0]
        ? commandStarted[0].parent_tool_use_id
        : null,
    ).toBe("item_collab");
    expect(commandCompleted).toHaveLength(1);
    expect(
      commandCompleted[0] && "parent_tool_use_id" in commandCompleted[0]
        ? commandCompleted[0].parent_tool_use_id
        : null,
    ).toBe("item_collab");

    parseCodexLine({
      line: '{"type":"item.completed","item":{"id":"item_collab","type":"collab_tool_call","tool":"send_input","sender_thread_id":"thread_parent","receiver_thread_ids":["thread_child"],"prompt":"Debug flaky test","agents_states":{"thread_child":{"status":"completed"}},"status":"completed"}}',
      runtime: mockRuntime,
      state,
    });

    const nextCommand = parseCodexLine({
      line: '{"type":"item.started","item":{"id":"item_cmd_2","type":"command_execution","command":"bash -lc pwd","aggregated_output":"","status":"in_progress"}}',
      runtime: mockRuntime,
      state,
    });
    expect(nextCommand).toHaveLength(1);
    expect(
      nextCommand[0] && "parent_tool_use_id" in nextCommand[0]
        ? nextCommand[0].parent_tool_use_id
        : null,
    ).toBeNull();
  });

  test("should preserve active collab task parent context across turn boundaries", () => {
    const state = createCodexParserState();
    parseCodexLine({
      line: '{"type":"item.started","item":{"id":"item_cross_turn","type":"collab_tool_call","tool":"send_input","sender_thread_id":"thread_parent","receiver_thread_ids":["thread_child"],"prompt":"Long-running delegated task","agents_states":{},"status":"in_progress"}}',
      runtime: mockRuntime,
      state,
    });

    parseCodexLine({
      line: '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}',
      runtime: mockRuntime,
      state,
    });

    const commandStarted = parseCodexLine({
      line: '{"type":"item.started","item":{"id":"item_cross_turn_cmd","type":"command_execution","command":"bash -lc ls","aggregated_output":"","status":"in_progress"}}',
      runtime: mockRuntime,
      state,
    });

    expect(commandStarted).toHaveLength(1);
    expect(
      commandStarted[0] && "parent_tool_use_id" in commandStarted[0]
        ? commandStarted[0].parent_tool_use_id
        : null,
    ).toBe("item_cross_turn");
  });

  test("should nest delegated collab tasks under parent collab task", () => {
    const state = createCodexParserState();
    const parentStart = parseCodexLine({
      line: '{"type":"item.started","item":{"id":"item_parent_collab","type":"collab_tool_call","tool":"send_input","sender_thread_id":"thread_parent","receiver_thread_ids":["thread_child_1"],"prompt":"Parent delegation","agents_states":{},"status":"in_progress"}}',
      runtime: mockRuntime,
      state,
    });
    const childStart = parseCodexLine({
      line: '{"type":"item.started","item":{"id":"item_child_collab","type":"collab_tool_call","tool":"send_input","sender_thread_id":"thread_child_1","receiver_thread_ids":["thread_child_2"],"prompt":"Child delegation","agents_states":{},"status":"in_progress"}}',
      runtime: mockRuntime,
      state,
    });
    const childCommand = parseCodexLine({
      line: '{"type":"item.started","item":{"id":"item_child_cmd","type":"command_execution","command":"bash -lc pwd","aggregated_output":"","status":"in_progress"}}',
      runtime: mockRuntime,
      state,
    });
    const childComplete = parseCodexLine({
      line: '{"type":"item.completed","item":{"id":"item_child_collab","type":"collab_tool_call","tool":"send_input","sender_thread_id":"thread_child_1","receiver_thread_ids":["thread_child_2"],"prompt":"Child delegation","agents_states":{"thread_child_2":{"status":"completed"}},"status":"completed"}}',
      runtime: mockRuntime,
      state,
    });

    expect(parentStart).toHaveLength(1);
    expect(childStart).toHaveLength(1);
    expect(childCommand).toHaveLength(1);
    expect(childComplete).toHaveLength(1);

    expect(
      childStart[0] && "parent_tool_use_id" in childStart[0]
        ? childStart[0].parent_tool_use_id
        : null,
    ).toBe("item_parent_collab");
    expect(
      childCommand[0] && "parent_tool_use_id" in childCommand[0]
        ? childCommand[0].parent_tool_use_id
        : null,
    ).toBe("item_child_collab");
    expect(
      childComplete[0] && "parent_tool_use_id" in childComplete[0]
        ? childComplete[0].parent_tool_use_id
        : null,
    ).toBe("item_parent_collab");
  });

  test("turn.diff_updated produces codex-diff message with stable idempotency key", () => {
    const state = createCodexParserState();
    // thread.started captures thread id used in the idempotency key.
    parseCodexLine({
      line: '{"type":"thread.started","thread_id":"thread_abc"}',
      runtime: mockRuntime,
      state,
    });
    // turn.started bumps the turn counter.
    parseCodexLine({
      line: '{"type":"turn.started"}',
      runtime: mockRuntime,
      state,
    });
    const diffLine = JSON.stringify({
      type: "turn.diff_updated",
      diff: "diff --git a/foo b/foo\n@@\n-old\n+new\n",
    });
    const firstResults = parseCodexLine({
      line: diffLine,
      runtime: mockRuntime,
      state,
    });
    expect(firstResults).toHaveLength(1);
    expect(firstResults[0]).toMatchObject({
      type: "codex-diff",
      session_id: "thread_abc",
      diff: "diff --git a/foo b/foo\n@@\n-old\n+new\n",
      idempotencyKey: "codex-diff:thread_abc:1",
    });

    // Identical diff re-emitted within the same turn: deduped.
    const dupResults = parseCodexLine({
      line: diffLine,
      runtime: mockRuntime,
      state,
    });
    expect(dupResults).toHaveLength(0);

    // A changed diff in the same turn: emits with the SAME idempotency key.
    const updatedDiffLine = JSON.stringify({
      type: "turn.diff_updated",
      diff: "diff --git a/foo b/foo\n@@\n-old\n+newer\n",
    });
    const updatedResults = parseCodexLine({
      line: updatedDiffLine,
      runtime: mockRuntime,
      state,
    });
    expect(updatedResults).toHaveLength(1);
    expect(updatedResults[0]).toMatchObject({
      type: "codex-diff",
      idempotencyKey: "codex-diff:thread_abc:1",
    });

    // A new turn bumps the key index.
    parseCodexLine({
      line: '{"type":"turn.started"}',
      runtime: mockRuntime,
      state,
    });
    const turn2Results = parseCodexLine({
      line: updatedDiffLine,
      runtime: mockRuntime,
      state,
    });
    expect(turn2Results).toHaveLength(1);
    expect(turn2Results[0]).toMatchObject({
      type: "codex-diff",
      idempotencyKey: "codex-diff:thread_abc:2",
    });
  });

  test("turn.diff_updated with empty diff string emits nothing", () => {
    const state = createCodexParserState();
    parseCodexLine({
      line: '{"type":"thread.started","thread_id":"t1"}',
      runtime: mockRuntime,
      state,
    });
    parseCodexLine({
      line: '{"type":"turn.started"}',
      runtime: mockRuntime,
      state,
    });
    const results = parseCodexLine({
      line: '{"type":"turn.diff_updated","diff":""}',
      runtime: mockRuntime,
      state,
    });
    expect(results).toHaveLength(0);
  });
});

describe("transformAutoApprovalReview via parseCodexLine", () => {
  // auto_approval_review items flow through parseCodexItem's switch to
  // transformAutoApprovalReview. Unit-testing via parseCodexLine covers
  // both the switch case registration and the transform output shape.
  const mockRuntime = {
    logger: {
      info: vi.fn<(message: string, data?: Record<string, unknown>) => void>(),
      warn: vi.fn<(message: string, data?: Record<string, unknown>) => void>(),
      error: vi.fn<(message: string, data?: Record<string, unknown>) => void>(),
      debug: vi.fn<(message: string, data?: Record<string, unknown>) => void>(),
    },
  } as unknown as IDaemonRuntime;

  function runReview(
    eventType: "item.started" | "item.updated" | "item.completed",
    item: Record<string, unknown>,
  ) {
    return parseCodexLine({
      line: JSON.stringify({ type: eventType, item }),
      runtime: mockRuntime,
      state: createCodexParserState(),
    });
  }

  test("emits pending codex-auto-approval-review on item.started", () => {
    const messages = runReview("item.started", {
      id: "rev_1",
      type: "auto_approval_review",
      reviewId: "rev_1",
      targetItemId: "cmd_1",
      riskLevel: "high",
      action: "rm -rf node_modules",
      status: "pending",
    });
    expect(messages).toHaveLength(1);
    const m = messages[0];
    expect(m?.type).toBe("codex-auto-approval-review");
    if (m?.type !== "codex-auto-approval-review") return;
    expect(m.status).toBe("pending");
    expect(m.riskLevel).toBe("high");
    expect(m.decision).toBeUndefined();
  });

  test("emits approved codex-auto-approval-review on item.completed", () => {
    const messages = runReview("item.completed", {
      id: "rev_1",
      type: "auto_approval_review",
      reviewId: "rev_1",
      targetItemId: "cmd_1",
      riskLevel: "high",
      action: "rm -rf node_modules",
      decision: "approved",
      rationale: "Safe — only touches node_modules",
      status: "approved",
    });
    expect(messages).toHaveLength(1);
    const m = messages[0];
    if (m?.type !== "codex-auto-approval-review") {
      throw new Error("wrong message type");
    }
    expect(m.status).toBe("approved");
    expect(m.decision).toBe("approved");
    expect(m.rationale).toBe("Safe — only touches node_modules");
    // Critical: risk level from completed event MUST be preserved, not
    // defaulted. Regression guard for the "silent medium default" bug.
    expect(m.riskLevel).toBe("high");
  });

  test("emits denied codex-auto-approval-review when decision is denied", () => {
    const messages = runReview("item.completed", {
      id: "rev_2",
      type: "auto_approval_review",
      reviewId: "rev_2",
      targetItemId: "cmd_2",
      decision: "denied",
      status: "denied",
    });
    const m = messages[0];
    if (m?.type !== "codex-auto-approval-review") {
      throw new Error("wrong message type");
    }
    expect(m.status).toBe("denied");
    expect(m.decision).toBe("denied");
  });

  test("drops item.updated to avoid duplicate DB rows", () => {
    const messages = runReview("item.updated", {
      id: "rev_1",
      type: "auto_approval_review",
      reviewId: "rev_1",
      targetItemId: "cmd_1",
      status: "pending",
    });
    expect(messages).toEqual([]);
  });

  test("falls back to decision when status is absent (defense-in-depth)", () => {
    // The normalizer sets status explicitly, but if a future code path
    // emits a completed event without it, we use decision. This is a
    // regression guard for the `status ?? decision ?? "approved"` chain.
    const messages = runReview("item.completed", {
      id: "rev_3",
      type: "auto_approval_review",
      reviewId: "rev_3",
      targetItemId: "cmd_3",
      decision: "denied",
    });
    const m = messages[0];
    if (m?.type !== "codex-auto-approval-review") {
      throw new Error("wrong message type");
    }
    // Must be denied, NOT approved (the earlier bug defaulted to approved
    // when status was missing even though decision said denied).
    expect(m.status).toBe("denied");
  });
});

describe("codexCommand", () => {
  const mockRuntime: IDaemonRuntime = {
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

  test("should generate command for gpt-5 without reasoning effort config", () => {
    const command = codexCommand({
      runtime: mockRuntime,
      prompt: "test prompt",
      model: "gpt-5",
      sessionId: null,
    });
    expect(
      command.replace(/codex-prompt-.*.txt/, "codex-prompt-*.txt"),
    ).toMatchInlineSnapshot(
      `"cat /tmp/codex-prompt-*.txt | codex exec --dangerously-bypass-approvals-and-sandbox --json -c features.multi_agent=true -c features.child_agents_md=true -c agents.max_threads=6 -c suppress_unstable_features_warning=true --model gpt-5"`,
    );
  });

  test("should generate command for gpt-5-low with low reasoning effort", () => {
    const command = codexCommand({
      runtime: mockRuntime,
      prompt: "test prompt",
      model: "gpt-5-low",
      sessionId: null,
    });
    expect(
      command.replace(/codex-prompt-.*.txt/, "codex-prompt-*.txt"),
    ).toMatchInlineSnapshot(
      `"cat /tmp/codex-prompt-*.txt | codex exec --dangerously-bypass-approvals-and-sandbox --json -c features.multi_agent=true -c features.child_agents_md=true -c agents.max_threads=6 -c suppress_unstable_features_warning=true --model gpt-5 --config model_reasoning_effort=low"`,
    );
  });

  test("should generate command for gpt-5-high with high reasoning effort", () => {
    const command = codexCommand({
      runtime: mockRuntime,
      prompt: "test prompt",
      model: "gpt-5-high",
      sessionId: null,
    });
    expect(
      command.replace(/codex-prompt-.*.txt/, "codex-prompt-*.txt"),
    ).toMatchInlineSnapshot(
      `"cat /tmp/codex-prompt-*.txt | codex exec --dangerously-bypass-approvals-and-sandbox --json -c features.multi_agent=true -c features.child_agents_md=true -c agents.max_threads=6 -c suppress_unstable_features_warning=true --model gpt-5 --config model_reasoning_effort=high"`,
    );
  });

  test("should generate command for gpt-5-codex-low with low reasoning effort", () => {
    const command = codexCommand({
      runtime: mockRuntime,
      prompt: "test prompt",
      model: "gpt-5-codex-low",
      sessionId: null,
    });
    expect(
      command.replace(/codex-prompt-.*.txt/, "codex-prompt-*.txt"),
    ).toMatchInlineSnapshot(
      `"cat /tmp/codex-prompt-*.txt | codex exec --dangerously-bypass-approvals-and-sandbox --json -c features.multi_agent=true -c features.child_agents_md=true -c agents.max_threads=6 -c suppress_unstable_features_warning=true --model gpt-5-codex --config model_reasoning_effort=low"`,
    );
  });

  test("should generate command for gpt-5-codex-medium with medium reasoning effort", () => {
    const command = codexCommand({
      runtime: mockRuntime,
      prompt: "test prompt",
      model: "gpt-5-codex-medium",
      sessionId: null,
    });
    expect(
      command.replace(/codex-prompt-.*.txt/, "codex-prompt-*.txt"),
    ).toMatchInlineSnapshot(
      `"cat /tmp/codex-prompt-*.txt | codex exec --dangerously-bypass-approvals-and-sandbox --json -c features.multi_agent=true -c features.child_agents_md=true -c agents.max_threads=6 -c suppress_unstable_features_warning=true --model gpt-5-codex --config model_reasoning_effort=medium"`,
    );
  });

  test("should generate command for gpt-5-codex-high with high reasoning effort", () => {
    const command = codexCommand({
      runtime: mockRuntime,
      prompt: "test prompt",
      model: "gpt-5-codex-high",
      sessionId: null,
    });
    expect(
      command.replace(/codex-prompt-.*.txt/, "codex-prompt-*.txt"),
    ).toMatchInlineSnapshot(
      `"cat /tmp/codex-prompt-*.txt | codex exec --dangerously-bypass-approvals-and-sandbox --json -c features.multi_agent=true -c features.child_agents_md=true -c agents.max_threads=6 -c suppress_unstable_features_warning=true --model gpt-5-codex --config model_reasoning_effort=high"`,
    );
  });

  test("should generate command for gpt-5.4 with medium reasoning effort", () => {
    const command = codexCommand({
      runtime: mockRuntime,
      prompt: "test prompt",
      model: "gpt-5.4",
      sessionId: null,
    });
    expect(
      command.replace(/codex-prompt-.*.txt/, "codex-prompt-*.txt"),
    ).toMatchInlineSnapshot(
      `"cat /tmp/codex-prompt-*.txt | codex exec --dangerously-bypass-approvals-and-sandbox --json -c features.multi_agent=true -c features.child_agents_md=true -c agents.max_threads=6 -c suppress_unstable_features_warning=true --model gpt-5.4 --config model_reasoning_effort=medium"`,
    );
  });

  test("should generate command for gpt-5.4-mini-high with high reasoning effort", () => {
    const command = codexCommand({
      runtime: mockRuntime,
      prompt: "test prompt",
      model: "gpt-5.4-mini-high",
      sessionId: null,
    });
    expect(
      command.replace(/codex-prompt-.*.txt/, "codex-prompt-*.txt"),
    ).toMatchInlineSnapshot(
      `"cat /tmp/codex-prompt-*.txt | codex exec --dangerously-bypass-approvals-and-sandbox --json -c features.multi_agent=true -c features.child_agents_md=true -c agents.max_threads=6 -c suppress_unstable_features_warning=true --model gpt-5.4-mini --config model_reasoning_effort=high"`,
    );
  });

  test("should generate command for gpt-5.4-nano-low with low reasoning effort", () => {
    const command = codexCommand({
      runtime: mockRuntime,
      prompt: "test prompt",
      model: "gpt-5.4-nano-low",
      sessionId: null,
    });
    expect(
      command.replace(/codex-prompt-.*.txt/, "codex-prompt-*.txt"),
    ).toMatchInlineSnapshot(
      `"cat /tmp/codex-prompt-*.txt | codex exec --dangerously-bypass-approvals-and-sandbox --json -c features.multi_agent=true -c features.child_agents_md=true -c agents.max_threads=6 -c suppress_unstable_features_warning=true --model gpt-5.4-nano --config model_reasoning_effort=low"`,
    );
  });

  test("should generate command for gpt-5.1-codex-max-low with low reasoning effort", () => {
    const command = codexCommand({
      runtime: mockRuntime,
      prompt: "test prompt",
      model: "gpt-5.1-codex-max-low",
      sessionId: null,
    });
    expect(
      command.replace(/codex-prompt-.*.txt/, "codex-prompt-*.txt"),
    ).toMatchInlineSnapshot(
      `"cat /tmp/codex-prompt-*.txt | codex exec --dangerously-bypass-approvals-and-sandbox --json -c features.multi_agent=true -c features.child_agents_md=true -c agents.max_threads=6 -c suppress_unstable_features_warning=true --model gpt-5.1-codex-max --config model_reasoning_effort=low"`,
    );
  });

  test("should generate command for gpt-5.1-codex-max with medium reasoning effort", () => {
    const command = codexCommand({
      runtime: mockRuntime,
      prompt: "test prompt",
      model: "gpt-5.1-codex-max",
      sessionId: null,
    });
    expect(
      command.replace(/codex-prompt-.*.txt/, "codex-prompt-*.txt"),
    ).toMatchInlineSnapshot(
      `"cat /tmp/codex-prompt-*.txt | codex exec --dangerously-bypass-approvals-and-sandbox --json -c features.multi_agent=true -c features.child_agents_md=true -c agents.max_threads=6 -c suppress_unstable_features_warning=true --model gpt-5.1-codex-max --config model_reasoning_effort=medium"`,
    );
  });

  test("should generate command for gpt-5.1-codex-max-xhigh with xhigh reasoning effort", () => {
    const command = codexCommand({
      runtime: mockRuntime,
      prompt: "test prompt",
      model: "gpt-5.1-codex-max-xhigh",
      sessionId: null,
    });
    expect(
      command.replace(/codex-prompt-.*.txt/, "codex-prompt-*.txt"),
    ).toMatchInlineSnapshot(
      `"cat /tmp/codex-prompt-*.txt | codex exec --dangerously-bypass-approvals-and-sandbox --json -c features.multi_agent=true -c features.child_agents_md=true -c agents.max_threads=6 -c suppress_unstable_features_warning=true --model gpt-5.1-codex-max --config model_reasoning_effort=xhigh"`,
    );
  });

  test("should include terry model provider flag when useCredits is true", () => {
    const command = codexCommand({
      runtime: mockRuntime,
      prompt: "test prompt",
      model: "gpt-5",
      sessionId: null,
      useCredits: true,
    });
    expect(
      command.replace(/codex-prompt-.*.txt/, "codex-prompt-*.txt"),
    ).toMatchInlineSnapshot(
      `"cat /tmp/codex-prompt-*.txt | codex exec --dangerously-bypass-approvals-and-sandbox --json -c features.multi_agent=true -c features.child_agents_md=true -c agents.max_threads=6 -c suppress_unstable_features_warning=true --model gpt-5 -c model_provider="terry""`,
    );
  });

  test("should disable multi-agent flags when CODEX_DISABLE_MULTI_AGENT is set", () => {
    const previousValue = process.env.CODEX_DISABLE_MULTI_AGENT;
    process.env.CODEX_DISABLE_MULTI_AGENT = "true";
    const command = codexCommand({
      runtime: mockRuntime,
      prompt: "test prompt",
      model: "gpt-5",
      sessionId: null,
    });
    if (previousValue === undefined) {
      delete process.env.CODEX_DISABLE_MULTI_AGENT;
    } else {
      process.env.CODEX_DISABLE_MULTI_AGENT = previousValue;
    }

    expect(command).not.toContain("features.multi_agent=true");
    expect(command).not.toContain("features.child_agents_md=true");
    expect(command).not.toContain("agents.max_threads=6");
  });

  test("should disable multi-agent flags for common truthy env values", () => {
    const previousValue = process.env.CODEX_DISABLE_MULTI_AGENT;
    process.env.CODEX_DISABLE_MULTI_AGENT = "yes";
    const command = codexCommand({
      runtime: mockRuntime,
      prompt: "test prompt",
      model: "gpt-5",
      sessionId: null,
    });
    if (previousValue === undefined) {
      delete process.env.CODEX_DISABLE_MULTI_AGENT;
    } else {
      process.env.CODEX_DISABLE_MULTI_AGENT = previousValue;
    }

    expect(command).not.toContain("features.multi_agent=true");
    expect(command).not.toContain("features.child_agents_md=true");
    expect(command).not.toContain("agents.max_threads=6");
  });

  test("should write prompt to temporary file", () => {
    codexCommand({
      runtime: mockRuntime,
      prompt: "test prompt content",
      model: "gpt-5",
      sessionId: null,
    });
    expect(mockRuntime.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining("/tmp/codex-prompt-"),
      "test prompt content",
    );
  });

  test("should handle unknown model as gpt-5 default", () => {
    const command = codexCommand({
      runtime: mockRuntime,
      prompt: "test prompt",
      model: "unknown-model",
      sessionId: null,
    });
    expect(
      command.replace(/codex-prompt-.*.txt/, "codex-prompt-*.txt"),
    ).toMatchInlineSnapshot(
      `"cat /tmp/codex-prompt-*.txt | codex exec --dangerously-bypass-approvals-and-sandbox --json -c features.multi_agent=true -c features.child_agents_md=true -c agents.max_threads=6 -c suppress_unstable_features_warning=true --model gpt-5.4 --config model_reasoning_effort=medium"`,
    );
  });
});

describe("codexAppServerStartCommand", () => {
  test("generates codex app-server command with model and reasoning effort", () => {
    const [command, args] = codexAppServerStartCommand({
      model: "gpt-5.1-codex-max-xhigh",
    });

    expect(command).toBe("codex");
    expect(args).toEqual([
      "app-server",
      "-c",
      'model="gpt-5.1-codex-max"',
      "-c",
      'model_reasoning_effort="xhigh"',
    ]);
  });

  test("includes terry model provider when credits mode is enabled", () => {
    const [command, args] = codexAppServerStartCommand({
      model: "gpt-5",
      useCredits: true,
    });

    expect(command).toBe("codex");
    expect(args).toEqual([
      "app-server",
      "-c",
      'model="gpt-5"',
      "-c",
      'model_provider="terry"',
    ]);
  });

  test("maps gpt-5.4-mini to app-server model and reasoning effort", () => {
    const [command, args] = codexAppServerStartCommand({
      model: "gpt-5.4-mini",
    });

    expect(command).toBe("codex");
    expect(args).toEqual([
      "app-server",
      "-c",
      'model="gpt-5.4-mini"',
      "-c",
      'model_reasoning_effort="medium"',
    ]);
  });
});

describe("buildThreadStartParams", () => {
  test("builds thread/start params with sandbox and approval defaults", () => {
    const params = buildThreadStartParams({
      model: "gpt-5.2-codex-high",
      instructions: "System instructions",
    });

    expect(params).toEqual({
      model: "gpt-5.2-codex",
      modelReasoningEffort: "high",
      stream: true,
      instructions: "System instructions",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    });
  });

  test("builds thread/start params for gpt-5.4 models", () => {
    const params = buildThreadStartParams({
      model: "gpt-5.4-xhigh",
      instructions: "System instructions",
    });

    expect(params).toEqual({
      model: "gpt-5.4",
      modelReasoningEffort: "xhigh",
      stream: true,
      instructions: "System instructions",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    });
  });

  test("omits modelReasoningEffort when model has no explicit effort", () => {
    const params = buildThreadStartParams({
      model: "gpt-5",
      instructions: "No effort override",
    });

    expect(params).toEqual({
      model: "gpt-5",
      stream: true,
      instructions: "No effort override",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    });
  });
});

describe("buildTurnStartParams", () => {
  test("builds turn/start params with thread id, prompt, and sandbox policy", () => {
    const params = buildTurnStartParams({
      threadId: "thread-123",
      prompt: "Implement this task",
    });

    expect(params).toEqual({
      threadId: "thread-123",
      input: [{ type: "text", text: "Implement this task" }],
      sandboxPolicy: { type: "externalSandbox", networkAccess: "enabled" },
    });
  });
});

describe("estimateTurnStartRequestSizeChars", () => {
  test("returns deterministic serialized request size", () => {
    const params = buildTurnStartParams({
      threadId: "thread-123",
      prompt: "Implement this task",
    });
    const size = estimateTurnStartRequestSizeChars(params);
    expect(size).toBeGreaterThan(0);
    expect(size).toBe(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "turn/start",
        params,
      }).length,
    );
  });

  test("exceeds max input chars when prompt is oversized", () => {
    const params = buildTurnStartParams({
      threadId: "thread-123",
      prompt: "x".repeat(CODEX_TURN_START_MAX_INPUT_CHARS),
    });
    const size = estimateTurnStartRequestSizeChars(params);
    expect(size).toBeGreaterThan(CODEX_TURN_START_MAX_INPUT_CHARS);
  });
});
