/**
 * Sprint 4: Claude Code adapter — streaming deltas + system init
 *
 * Tests for ClaudeCodeParser and parseMcpToolName (claude.ts).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { ClaudeCodeParser, parseMcpToolName } from "./claude";

// ---------------------------------------------------------------------------
// Fixture loader
// ---------------------------------------------------------------------------
function loadFixture(name: string): string {
  return readFileSync(
    join(__dirname, "__fixtures__/claude-code", name),
    "utf-8",
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeParser(): ClaudeCodeParser {
  return new ClaudeCodeParser();
}

// ---------------------------------------------------------------------------
// parseMcpToolName unit tests
// ---------------------------------------------------------------------------
describe("parseMcpToolName", () => {
  it("parses a simple mcp tool name", () => {
    expect(parseMcpToolName("mcp__terry__SuggestFollowupTask")).toEqual({
      server: "terry",
      tool: "SuggestFollowupTask",
    });
  });

  it("parses a tool with underscores in tool name", () => {
    expect(parseMcpToolName("mcp__github__search_repos")).toEqual({
      server: "github",
      tool: "search_repos",
    });
  });

  it("returns null for non-mcp tool names", () => {
    expect(parseMcpToolName("bash")).toBeNull();
    expect(parseMcpToolName("Read")).toBeNull();
    expect(parseMcpToolName("mcp_no_double_underscore")).toBeNull();
  });

  it("returns null when tool segment is empty", () => {
    expect(parseMcpToolName("mcp__server__")).toBeNull();
  });

  it("returns null when server segment is empty", () => {
    expect(parseMcpToolName("mcp____tool")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Task 4.1 — Parse system/init → session.initialized meta event
// ---------------------------------------------------------------------------
describe("Task 4.1: system/init → session.initialized", () => {
  it("emits session.initialized meta event from fixture", () => {
    const parser = makeParser();
    const line = loadFixture("system-init.json");
    const result = parser.parseClaudeCodeLine(line);

    expect(result.metaEvents).toHaveLength(1);
    const event = result.metaEvents[0]!;
    expect(event.kind).toBe("session.initialized");
    if (event.kind === "session.initialized") {
      expect(event.tools).toEqual([
        "bash",
        "read_file",
        "write_file",
        "edit_file",
      ]);
      expect(event.mcpServers).toEqual(["github", "filesystem"]);
    }
  });

  it("also passes the system message through to messages array", () => {
    const parser = makeParser();
    const line = loadFixture("system-init.json");
    const result = parser.parseClaudeCodeLine(line);

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.type).toBe("system");
  });

  it("produces no deltas for system/init", () => {
    const parser = makeParser();
    const line = loadFixture("system-init.json");
    const result = parser.parseClaudeCodeLine(line);

    expect(result.deltas).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Task 4.2 — Parse text_delta → delta buffer entry
// ---------------------------------------------------------------------------
describe("Task 4.2: content_block_delta text_delta → delta", () => {
  it("produces a text delta from fixture", () => {
    const parser = makeParser();
    const line = loadFixture("stream-event-text-delta.json");
    const result = parser.parseClaudeCodeLine(line);

    expect(result.deltas).toHaveLength(1);
    const delta = result.deltas[0]!;
    expect(delta.kind).toBe("text");
    expect(delta.text).toBe(
      "The refactored authentication middleware should follow these best practices:",
    );
    expect(delta.blockIndex).toBe(0);
  });

  it("produces no messages for stream_event lines", () => {
    const parser = makeParser();
    const line = loadFixture("stream-event-text-delta.json");
    const result = parser.parseClaudeCodeLine(line);

    expect(result.messages).toHaveLength(0);
  });

  it("produces no meta events for text_delta", () => {
    const parser = makeParser();
    const line = loadFixture("stream-event-text-delta.json");
    const result = parser.parseClaudeCodeLine(line);

    expect(result.metaEvents).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Task 4.3 — Parse input_json_delta → tool-call progress
// ---------------------------------------------------------------------------
describe("Task 4.3: content_block_delta input_json_delta → tool progress", () => {
  it("produces a tool progress entry from fixture", () => {
    const parser = makeParser();
    const line = loadFixture("stream-event-input-json-delta.json");
    const result = parser.parseClaudeCodeLine(line);

    expect(result.toolProgress).toHaveLength(1);
    const progress = result.toolProgress[0]!;
    expect(progress.chunk).toBe(
      '{"path": "/tmp", "permissions": "755", "recursive": tr',
    );
    expect(progress.accumulatedJson).toBe(progress.chunk);
  });

  it("accumulates across multiple fragments", () => {
    const parser = makeParser();
    const fragment1 = JSON.stringify({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"a":' },
      },
    });
    const fragment2 = JSON.stringify({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '"hello"}' },
      },
    });

    parser.parseClaudeCodeLine(fragment1);
    const result2 = parser.parseClaudeCodeLine(fragment2);

    expect(result2.toolProgress[0]!.accumulatedJson).toBe('{"a":"hello"}');
  });

  it("produces no deltas for input_json_delta", () => {
    const parser = makeParser();
    const line = loadFixture("stream-event-input-json-delta.json");
    const result = parser.parseClaudeCodeLine(line);

    expect(result.deltas).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Task 4.4 — Parse thinking_delta → thinking delta buffer entry
// ---------------------------------------------------------------------------
describe("Task 4.4: content_block_delta thinking_delta → thinking delta", () => {
  it("produces a thinking delta (synthesised fixture)", () => {
    const parser = makeParser();
    const syntheticLine = JSON.stringify({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 1,
        delta: {
          type: "thinking_delta",
          thinking: "I should examine the existing middleware code first.",
        },
      },
    });

    const result = parser.parseClaudeCodeLine(syntheticLine);

    expect(result.deltas).toHaveLength(1);
    const delta = result.deltas[0]!;
    expect(delta.kind).toBe("thinking");
    expect(delta.text).toBe(
      "I should examine the existing middleware code first.",
    );
    expect(delta.blockIndex).toBe(1);
  });

  it("produces no messages or meta events for thinking_delta", () => {
    const parser = makeParser();
    const syntheticLine = JSON.stringify({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "thinking..." },
      },
    });

    const result = parser.parseClaudeCodeLine(syntheticLine);
    expect(result.messages).toHaveLength(0);
    expect(result.metaEvents).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Task 4.5 — Parse message_delta → usage.incremental + message.stop
// ---------------------------------------------------------------------------
describe("Task 4.5: message_delta → usage.incremental + message.stop", () => {
  it("emits usage.incremental and message.stop from synthetic message_delta", () => {
    const parser = makeParser();
    const syntheticLine = JSON.stringify({
      type: "stream_event",
      event: {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: {
          output_tokens: 42,
          cache_creation_input_tokens: 10,
          cache_read_input_tokens: 5,
        },
      },
    });

    const result = parser.parseClaudeCodeLine(syntheticLine);

    const stopEvent = result.metaEvents.find((e) => e.kind === "message.stop");
    expect(stopEvent).toBeDefined();
    if (stopEvent?.kind === "message.stop") {
      expect(stopEvent.reason).toBe("end_turn");
    }

    const usageEvent = result.metaEvents.find(
      (e) => e.kind === "usage.incremental",
    );
    expect(usageEvent).toBeDefined();
    if (usageEvent?.kind === "usage.incremental") {
      expect(usageEvent.outputTokens).toBe(42);
      expect(usageEvent.cacheCreation).toBe(10);
      expect(usageEvent.cacheRead).toBe(5);
      expect(usageEvent.inputTokens).toBe(0);
    }
  });

  it("emits only usage.incremental when no stop_reason", () => {
    const parser = makeParser();
    const syntheticLine = JSON.stringify({
      type: "stream_event",
      event: {
        type: "message_delta",
        usage: { output_tokens: 7 },
      },
    });

    const result = parser.parseClaudeCodeLine(syntheticLine);

    expect(result.metaEvents.some((e) => e.kind === "message.stop")).toBe(
      false,
    );
    expect(result.metaEvents.some((e) => e.kind === "usage.incremental")).toBe(
      true,
    );
  });

  it("produces no messages or deltas for message_delta", () => {
    const parser = makeParser();
    const syntheticLine = JSON.stringify({
      type: "stream_event",
      event: {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 1 },
      },
    });

    const result = parser.parseClaudeCodeLine(syntheticLine);
    expect(result.messages).toHaveLength(0);
    expect(result.deltas).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Task 4.6 — Unify MCP tool metadata on tool-call parts
// ---------------------------------------------------------------------------
describe("Task 4.6: MCP tool metadata on assistant tool_use blocks", () => {
  it("attaches mcpMetadata when tool name matches mcp__ pattern (fixture)", () => {
    const parser = makeParser();
    const line = loadFixture("assistant-tool-use-mcp.json");
    const result = parser.parseClaudeCodeLine(line);

    expect(result.messages).toHaveLength(1);
    const msg = result.messages[0]! as any;
    expect(msg.type).toBe("assistant");
    const toolUseBlock = msg.message.content.find(
      (b: any) => b.type === "tool_use",
    );
    expect(toolUseBlock).toBeDefined();
    expect(toolUseBlock.mcpMetadata).toEqual({
      server: "github",
      tool: "search_repos",
    });
  });

  it("attaches mcpMetadata for mcp__terry__SuggestFollowupTask", () => {
    const parser = makeParser();
    const syntheticLine = JSON.stringify({
      type: "assistant",
      session_id: "sess-1",
      parent_tool_use_id: null,
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tu_1",
            name: "mcp__terry__SuggestFollowupTask",
            input: { tasks: ["refactor auth"] },
          },
        ],
      },
    });

    const result = parser.parseClaudeCodeLine(syntheticLine);
    const msg = result.messages[0]! as any;
    const block = msg.message.content[0];
    expect(block.mcpMetadata).toEqual({
      server: "terry",
      tool: "SuggestFollowupTask",
    });
  });

  it("does NOT attach mcpMetadata for non-mcp tool names", () => {
    const parser = makeParser();
    const line = loadFixture("assistant-tool-use-builtin.json");
    const result = parser.parseClaudeCodeLine(line);

    const msg = result.messages[0]! as any;
    const toolUseBlock = msg.message.content.find(
      (b: any) => b.type === "tool_use",
    );
    expect(toolUseBlock).toBeDefined();
    expect(toolUseBlock.mcpMetadata).toBeUndefined();
  });

  it("does not add mcpMetadata when no tool_use blocks present", () => {
    const parser = makeParser();
    const line = loadFixture("assistant-text.json");
    const result = parser.parseClaudeCodeLine(line);

    expect(result.messages).toHaveLength(1);
    // No error thrown, mcpMetadata is simply absent
    const msg = result.messages[0]! as any;
    expect(
      msg.message.content.every((b: any) => b.mcpMetadata === undefined),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Edge-case and pass-through tests
// ---------------------------------------------------------------------------
describe("ClaudeCodeParser: pass-through and edge cases", () => {
  it("passes through result messages unchanged", () => {
    const parser = makeParser();
    const line = loadFixture("result-success.json");
    const result = parser.parseClaudeCodeLine(line);

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.type).toBe("result");
    expect(result.metaEvents).toHaveLength(0);
    expect(result.deltas).toHaveLength(0);
  });

  it("passes through custom-stop messages", () => {
    const parser = makeParser();
    const line = loadFixture("custom-stop.json");
    const result = parser.parseClaudeCodeLine(line);

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.type).toBe("custom-stop");
  });

  it("passes through user tool-result messages", () => {
    const parser = makeParser();
    const line = loadFixture("user-tool-result.json");
    const result = parser.parseClaudeCodeLine(line);

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.type).toBe("user");
  });

  it("returns empty result for invalid JSON", () => {
    const parser = makeParser();
    const result = parser.parseClaudeCodeLine("not valid json {{{");
    expect(result.messages).toHaveLength(0);
    expect(result.metaEvents).toHaveLength(0);
    expect(result.deltas).toHaveLength(0);
    expect(result.toolProgress).toHaveLength(0);
  });

  it("returns empty result for empty line", () => {
    const parser = makeParser();
    const result = parser.parseClaudeCodeLine("");
    expect(result.messages).toHaveLength(0);
  });

  it("maintains independent state across multiple parser instances", () => {
    const parser1 = makeParser();
    const parser2 = makeParser();

    const fragment = JSON.stringify({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"key":' },
      },
    });

    parser1.parseClaudeCodeLine(fragment);
    const result2 = parser2.parseClaudeCodeLine(fragment);

    // parser2 should NOT have parser1's accumulated state
    expect(result2.toolProgress[0]!.accumulatedJson).toBe('{"key":');
  });
});
