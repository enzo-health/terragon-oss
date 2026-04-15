import { describe, test, expect } from "vitest";
import { toDBMessage } from "./toDBMessage";
import { ClaudeMessage } from "@terragon/daemon/shared";

describe("toDBMessage", () => {
  describe("user messages", () => {
    test("converts simple string user message", () => {
      const claudeMessage: ClaudeMessage = {
        type: "user",
        message: {
          role: "user",
          content: "Hello, how are you?",
        },
        parent_tool_use_id: null,
        session_id: "test-session-123",
      };

      const result = toDBMessage(claudeMessage);
      expect(result).toEqual([
        {
          type: "user",
          model: null,
          parts: [
            {
              type: "text",
              text: "Hello, how are you?",
            },
          ],
        },
      ]);
    });

    test("converts local command stdout wrapper to agent code block", () => {
      const claudeMessage: ClaudeMessage = {
        type: "user",
        message: {
          role: "user",
          content:
            "<local-command-stdout>line one\nline two\nline three</local-command-stdout>",
        },
        parent_tool_use_id: null,
        session_id: "test-session-123",
      };

      const result = toDBMessage(claudeMessage);
      expect(result).toEqual([
        {
          type: "agent",
          parent_tool_use_id: null,
          parts: [
            {
              type: "text",
              text: "```\nline one\nline two\nline three\n```",
            },
          ],
        },
      ]);
    });

    test("falls back to user message when stdout wrapper is empty", () => {
      const claudeMessage: ClaudeMessage = {
        type: "user",
        message: {
          role: "user",
          content: "<local-command-stdout></local-command-stdout>",
        },
        parent_tool_use_id: null,
        session_id: "test-session-123",
      };

      const result = toDBMessage(claudeMessage);
      expect(result).toEqual([
        {
          type: "user",
          model: null,
          parts: [
            {
              type: "text",
              text: "<local-command-stdout></local-command-stdout>",
            },
          ],
        },
      ]);
    });

    test("converts user message with text array", () => {
      const claudeMessage: ClaudeMessage = {
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "text", text: "First part" },
            { type: "text", text: "Second part" },
          ],
        },
        parent_tool_use_id: null,
        session_id: "test-session-123",
      };

      const result = toDBMessage(claudeMessage);
      expect(result).toEqual([
        {
          type: "user",
          model: null,
          parts: [
            { type: "text", text: "First part" },
            { type: "text", text: "Second part" },
          ],
        },
      ]);
    });

    test("handles empty user message content array", () => {
      const claudeMessage: ClaudeMessage = {
        type: "user",
        message: {
          role: "user",
          content: [],
        },
        parent_tool_use_id: null,
        session_id: "test-session-123",
      };

      const result = toDBMessage(claudeMessage);
      expect(result).toEqual([]);
    });

    test("converts user message with tool results", () => {
      const claudeMessage: ClaudeMessage = {
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "text", text: "Here's the result:" },
            {
              type: "tool_result",
              tool_use_id: "tool_123",
              content: "Tool execution successful",
            },
          ],
        },
        parent_tool_use_id: null,
        session_id: "test-session-123",
      };

      const result = toDBMessage(claudeMessage);
      expect(result).toEqual([
        {
          type: "user",
          model: null,
          parts: [{ type: "text", text: "Here's the result:" }],
        },
        {
          type: "tool-result",
          id: "tool_123",
          is_error: null,
          result: "Tool execution successful",
          parent_tool_use_id: null,
        },
      ]);
    });

    test("converts user message with only tool results (no text)", () => {
      const claudeMessage: ClaudeMessage = {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_01WnH12PqWRvrjvu6rPtx3GS",
              content: "Todos have been modified successfully",
            },
          ],
        },
        parent_tool_use_id: null,
        session_id: "test-session-123",
      };

      const result = toDBMessage(claudeMessage);
      expect(result).toEqual([
        {
          type: "tool-result",
          id: "toolu_01WnH12PqWRvrjvu6rPtx3GS",
          is_error: null,
          result: "Todos have been modified successfully",
          parent_tool_use_id: null,
        },
      ]);
    });

    test("converts user message with tool result containing array content", () => {
      const claudeMessage: ClaudeMessage = {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool_456",
              content: [
                { type: "text", text: "Result text" },
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: "image/png",
                    data: "base64data",
                  },
                },
              ],
            },
          ],
        },
        parent_tool_use_id: null,
        session_id: "test-session-123",
      };

      const result = toDBMessage(claudeMessage);
      expect(result).toEqual([
        {
          type: "tool-result",
          id: "tool_456",
          is_error: null,
          result: JSON.stringify([
            { type: "text", text: "Result text" },
            { type: "image", source: "..." },
          ]),
          parent_tool_use_id: null,
        },
      ]);
    });

    test("converts user message with multiple tool results", () => {
      const claudeMessage: ClaudeMessage = {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool1",
              content: "First result",
            },
            {
              type: "tool_result",
              tool_use_id: "tool2",
              content: "Second result",
            },
          ],
        },
        parent_tool_use_id: null,
        session_id: "test-session-123",
      };

      const result = toDBMessage(claudeMessage);
      expect(result).toEqual([
        {
          type: "tool-result",
          id: "tool1",
          is_error: null,
          result: "First result",
          parent_tool_use_id: null,
        },
        {
          type: "tool-result",
          id: "tool2",
          is_error: null,
          result: "Second result",
          parent_tool_use_id: null,
        },
      ]);
    });

    test("converts user message with tool result marked as error", () => {
      const claudeMessage: ClaudeMessage = {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool_error",
              is_error: true,
              content: "Error: File not found",
            },
          ],
        },
        parent_tool_use_id: null,
        session_id: "test-session-123",
      };

      const result = toDBMessage(claudeMessage);
      expect(result).toEqual([
        {
          type: "tool-result",
          id: "tool_error",
          is_error: true,
          result: "Error: File not found",
          parent_tool_use_id: null,
        },
      ]);
    });

    test("converts user message with tool result explicitly marked as not error", () => {
      const claudeMessage: ClaudeMessage = {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool_success",
              is_error: false,
              content: "Operation completed successfully",
            },
          ],
        },
        parent_tool_use_id: null,
        session_id: "test-session-123",
      };

      const result = toDBMessage(claudeMessage);
      expect(result).toEqual([
        {
          type: "tool-result",
          id: "tool_success",
          is_error: false,
          result: "Operation completed successfully",
          parent_tool_use_id: null,
        },
      ]);
    });

    test("converts user message with mixed error and success tool results", () => {
      const claudeMessage: ClaudeMessage = {
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "text", text: "Results from multiple operations:" },
            {
              type: "tool_result",
              tool_use_id: "tool1",
              is_error: false,
              content: "File read successfully",
            },
            {
              type: "tool_result",
              tool_use_id: "tool2",
              is_error: true,
              content: "Error: Permission denied",
            },
            {
              type: "tool_result",
              tool_use_id: "tool3",
              content: "No error flag specified",
            },
          ],
        },
        parent_tool_use_id: null,
        session_id: "test-session-123",
      };

      const result = toDBMessage(claudeMessage);
      expect(result).toEqual([
        {
          type: "user",
          model: null,
          parts: [{ type: "text", text: "Results from multiple operations:" }],
        },
        {
          type: "tool-result",
          id: "tool1",
          is_error: false,
          result: "File read successfully",
          parent_tool_use_id: null,
        },
        {
          type: "tool-result",
          id: "tool2",
          is_error: true,
          result: "Error: Permission denied",
          parent_tool_use_id: null,
        },
        {
          type: "tool-result",
          id: "tool3",
          is_error: null,
          result: "No error flag specified",
          parent_tool_use_id: null,
        },
      ]);
    });

    test("converts user message with error tool result containing array content", () => {
      const claudeMessage: ClaudeMessage = {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool_complex_error",
              is_error: true,
              content: [
                { type: "text", text: "Multiple errors occurred:" },
                { type: "text", text: "1. Network timeout" },
                { type: "text", text: "2. Invalid credentials" },
              ],
            },
          ],
        },
        parent_tool_use_id: null,
        session_id: "test-session-123",
      };

      const result = toDBMessage(claudeMessage);
      expect(result).toEqual([
        {
          type: "tool-result",
          id: "tool_complex_error",
          is_error: true,
          result: JSON.stringify([
            { type: "text", text: "Multiple errors occurred:" },
            { type: "text", text: "1. Network timeout" },
            { type: "text", text: "2. Invalid credentials" },
          ]),
          parent_tool_use_id: null,
        },
      ]);
    });
  });

  describe("assistant messages", () => {
    test("converts simple string assistant message", () => {
      const claudeMessage: ClaudeMessage = {
        type: "assistant",
        message: {
          role: "assistant",
          content: "I can help you with that.",
        },
        session_id: "test-session-123",
        parent_tool_use_id: null,
      };

      const result = toDBMessage(claudeMessage);
      expect(result).toEqual([
        {
          type: "agent",
          parts: [
            {
              type: "text",
              text: "I can help you with that.",
            },
          ],
          parent_tool_use_id: null,
        },
      ]);
    });

    test("converts assistant message with text array", () => {
      const claudeMessage: ClaudeMessage = {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Let me help you." },
            { type: "text", text: "Here's the solution." },
          ],
        },
        parent_tool_use_id: null,
        session_id: "test-session-123",
      };

      const result = toDBMessage(claudeMessage);
      expect(result).toEqual([
        {
          type: "agent",
          parts: [
            { type: "text", text: "Let me help you." },
            { type: "text", text: "Here's the solution." },
          ],
          parent_tool_use_id: null,
        },
      ]);
    });

    test("converts assistant message with tool calls", () => {
      const claudeMessage: ClaudeMessage = {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Let me search for that." },
            {
              type: "tool_use",
              id: "search_123",
              name: "search",
              input: { query: "test query" },
            },
          ],
        },
        parent_tool_use_id: null,
        session_id: "test-session-123",
      };

      const result = toDBMessage(claudeMessage);
      expect(result).toEqual([
        {
          type: "agent",
          parts: [{ type: "text", text: "Let me search for that." }],
          parent_tool_use_id: null,
        },
        {
          type: "tool-call",
          id: "search_123",
          name: "search",
          parameters: { query: "test query" },
          parent_tool_use_id: null,
        },
      ]);
    });

    test("converts assistant message with multiple tool calls", () => {
      const claudeMessage: ClaudeMessage = {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool1",
              name: "read_file",
              input: { path: "/file1.txt" },
            },
            {
              type: "tool_use",
              id: "tool2",
              name: "write_file",
              input: { path: "/file2.txt", content: "data" },
            },
          ],
        },
        parent_tool_use_id: null,
        session_id: "test-session-123",
      };

      const result = toDBMessage(claudeMessage);
      expect(result).toEqual([
        {
          type: "tool-call",
          id: "tool1",
          name: "read_file",
          parameters: { path: "/file1.txt" },
          parent_tool_use_id: null,
        },
        {
          type: "tool-call",
          id: "tool2",
          name: "write_file",
          parameters: { path: "/file2.txt", content: "data" },
          parent_tool_use_id: null,
        },
      ]);
    });

    test("handles tool call with undefined input", () => {
      const claudeMessage: ClaudeMessage = {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool_no_input",
              name: "get_time",
              input: undefined as any,
            },
          ],
        },
        parent_tool_use_id: null,
        session_id: "test-session-123",
      };

      const result = toDBMessage(claudeMessage);
      expect(result).toEqual([
        {
          type: "tool-call",
          id: "tool_no_input",
          name: "get_time",
          parameters: {},
          parent_tool_use_id: null,
        },
      ]);
    });

    test("handles empty assistant message content array", () => {
      const claudeMessage: ClaudeMessage = {
        type: "assistant",
        message: {
          role: "assistant",
          content: [],
        },
        parent_tool_use_id: null,
        session_id: "test-session-123",
      };

      const result = toDBMessage(claudeMessage);
      expect(result).toEqual([]);
    });

    describe("nested tool calls with parent_tool_use_id", () => {
      test("converts assistant message with single nested tool call", () => {
        const claudeMessage: ClaudeMessage = {
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "toolu_nested_id",
                name: "Glob",
                input: { pattern: "**/*config*" },
              },
            ],
          },
          parent_tool_use_id: "toolu_parent_id",
          session_id: "test-session-123",
        };

        const result = toDBMessage(claudeMessage);
        expect(result).toEqual([
          {
            type: "tool-call",
            id: "toolu_nested_id",
            name: "Glob",
            parameters: { pattern: "**/*config*" },
            parent_tool_use_id: "toolu_parent_id",
          },
        ]);
      });

      test("handles assistant message with both text and tool calls from nested agent", () => {
        const claudeMessage: ClaudeMessage = {
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "I found config files:" },
              {
                type: "tool_use",
                id: "toolu_nested",
                name: "Read",
                input: { file_path: "/config.json" },
              },
            ],
          },
          parent_tool_use_id: "toolu_parent_id",
          session_id: "test-session-123",
        };

        const result = toDBMessage(claudeMessage);
        expect(result).toEqual([
          {
            type: "agent",
            parts: [{ type: "text", text: "I found config files:" }],
            parent_tool_use_id: "toolu_parent_id",
          },
          {
            type: "tool-call",
            id: "toolu_nested",
            name: "Read",
            parameters: { file_path: "/config.json" },
            parent_tool_use_id: "toolu_parent_id",
          },
        ]);
      });

      test("handles multiple nested tool calls", () => {
        const claudeMessage: ClaudeMessage = {
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "toolu_nested_1",
                name: "Read",
                input: { file_path: "/file1.txt" },
              },
              {
                type: "tool_use",
                id: "toolu_nested_2",
                name: "Write",
                input: { file_path: "/file2.txt", content: "test" },
              },
            ],
          },
          parent_tool_use_id: "toolu_parent_task",
          session_id: "test-session-123",
        };

        const result = toDBMessage(claudeMessage);
        expect(result).toEqual([
          {
            type: "tool-call",
            id: "toolu_nested_1",
            name: "Read",
            parameters: { file_path: "/file1.txt" },
            parent_tool_use_id: "toolu_parent_task",
          },
          {
            type: "tool-call",
            id: "toolu_nested_2",
            name: "Write",
            parameters: { file_path: "/file2.txt", content: "test" },
            parent_tool_use_id: "toolu_parent_task",
          },
        ]);
      });

      test("filters out user message with parent_tool_use_id containing only text (Task tool prompt)", () => {
        const claudeMessage: ClaudeMessage = {
          type: "user",
          message: {
            role: "user",
            content: [
              {
                type: "text",
                text: "I need to understand the current desktop renderer structure to plan implementing a new three-pane notes UI design...",
              },
            ],
          },
          parent_tool_use_id: "toolu_01CucKVt7ziQbHkffX7BRzTK",
          session_id: "test-session-123",
        };

        const result = toDBMessage(claudeMessage);
        // Task tool prompts should be filtered out
        expect(result).toEqual([]);
      });

      test("handles user message with tool result for nested tool", () => {
        const claudeMessage: ClaudeMessage = {
          type: "user",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_nested_read",
                content: "File contents from nested read",
              },
            ],
          },
          parent_tool_use_id: "toolu_parent_task",
          session_id: "test-session-123",
        };

        const result = toDBMessage(claudeMessage);
        expect(result).toEqual([
          {
            type: "tool-result",
            id: "toolu_nested_read",
            is_error: null,
            result: "File contents from nested read",
            parent_tool_use_id: "toolu_parent_task",
          },
        ]);
      });

      test("handles user message with both text and tool result for nested tool", () => {
        const claudeMessage: ClaudeMessage = {
          type: "user",
          message: {
            role: "user",
            content: [
              {
                type: "text",
                text: "Task completed:",
              },
              {
                type: "tool_result",
                tool_use_id: "toolu_nested_task",
                content: "Task result output",
              },
            ],
          },
          parent_tool_use_id: "toolu_parent_task",
          session_id: "test-session-123",
        };

        const result = toDBMessage(claudeMessage);
        // Should keep both the text and tool result when tool results are present
        expect(result).toEqual([
          {
            type: "user",
            model: null,
            parts: [{ type: "text", text: "Task completed:" }],
          },
          {
            type: "tool-result",
            id: "toolu_nested_task",
            is_error: null,
            result: "Task result output",
            parent_tool_use_id: "toolu_parent_task",
          },
        ]);
      });

      test("handles user message with error tool result for nested tool", () => {
        const claudeMessage: ClaudeMessage = {
          type: "user",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_nested_error",
                is_error: true,
                content: "Error: Access denied in nested operation",
              },
            ],
          },
          parent_tool_use_id: "toolu_parent_task",
          session_id: "test-session-123",
        };

        const result = toDBMessage(claudeMessage);
        expect(result).toEqual([
          {
            type: "tool-result",
            id: "toolu_nested_error",
            is_error: true,
            result: "Error: Access denied in nested operation",
            parent_tool_use_id: "toolu_parent_task",
          },
        ]);
      });

      test("preserves parent_tool_use_id as null for top-level messages", () => {
        const claudeMessage: ClaudeMessage = {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Top level message" }],
          },
          parent_tool_use_id: null,
          session_id: "test-session-123",
        };

        const result = toDBMessage(claudeMessage);
        expect(result).toEqual([
          {
            type: "agent",
            parts: [{ type: "text", text: "Top level message" }],
            parent_tool_use_id: null,
          },
        ]);
      });
    });
  });

  describe("custom-stop messages", () => {
    test("converts custom-stop message", () => {
      const claudeMessage: ClaudeMessage = {
        type: "custom-stop",
        session_id: null,
        duration_ms: 1000,
      };

      const result = toDBMessage(claudeMessage);
      expect(result).toEqual([{ type: "stop" }]);
    });
  });

  describe("result and system messages", () => {
    test("converts result success message to DBMetaMessage", () => {
      const claudeMessage: ClaudeMessage = {
        type: "result",
        subtype: "success",
        total_cost_usd: 0.01,
        duration_ms: 1000,
        duration_api_ms: 500,
        is_error: false,
        num_turns: 1,
        result: "test",
        session_id: "test-session-123",
      };

      const result = toDBMessage(claudeMessage);
      expect(result).toEqual([
        {
          type: "meta",
          subtype: "result-success",
          cost_usd: 0.01,
          duration_ms: 1000,
          duration_api_ms: 500,
          is_error: false,
          num_turns: 1,
          result: "test",
          session_id: "test-session-123",
        },
      ]);
    });

    test("converts result error_max_turns message to DBMetaMessage", () => {
      const claudeMessage: ClaudeMessage = {
        type: "result",
        subtype: "error_max_turns",
        total_cost_usd: 0.05,
        duration_ms: 5000,
        duration_api_ms: 3000,
        is_error: true,
        num_turns: 10,
        session_id: "test-session-123",
      };

      const result = toDBMessage(claudeMessage);
      expect(result).toEqual([
        {
          type: "meta",
          subtype: "result-error-max-turns",
          cost_usd: 0.05,
          duration_ms: 5000,
          duration_api_ms: 3000,
          is_error: true,
          num_turns: 10,
          result: undefined,
          session_id: "test-session-123",
        },
      ]);
    });

    test("converts system init message to DBMetaMessage", () => {
      const claudeMessage: ClaudeMessage = {
        type: "system",
        subtype: "init",
        session_id: "test-session-123",
        tools: ["tool1", "tool2"],
        mcp_servers: [{ name: "server1", status: "connected" }],
      };

      const result = toDBMessage(claudeMessage);
      expect(result).toEqual([
        {
          type: "meta",
          subtype: "system-init",
          session_id: "test-session-123",
          tools: ["tool1", "tool2"],
          mcp_servers: [{ name: "server1", status: "connected" }],
        },
      ]);
    });
  });

  describe("real-world message streams", () => {
    test("converts complex nested tool usage with Task agent", () => {
      const input: ClaudeMessage[] = [
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "toolu_01GKLEkUWeCqNRrwnjNZaS8V",
                name: "LS",
                input: {
                  path: "/workspace/repo",
                },
              },
            ],
          },
          parent_tool_use_id: null,
          session_id: "7ea4397a-da41-4b30-9f73-7e382e44325f",
        },
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "toolu_01CgPFfrLkPFHCd87kY6PG8h",
                name: "Task",
                input: {
                  description: "Summarize project README",
                  prompt:
                    "Please read the README.md file in the root directory and provide a concise summary.",
                },
              },
            ],
          },
          parent_tool_use_id: null,
          session_id: "7ea4397a-da41-4b30-9f73-7e382e44325f",
        },
        {
          type: "user",
          message: {
            role: "user",
            content: [
              {
                tool_use_id: "toolu_01GKLEkUWeCqNRrwnjNZaS8V",
                type: "tool_result",
                content: "- /workspace/repo/ - CLAUDE.md - README.md",
              },
            ],
          },
          parent_tool_use_id: null,
          session_id: "7ea4397a-da41-4b30-9f73-7e382e44325f",
        },
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "toolu_0197Eg9mB1TUyNLrhNDCR3Q7",
                name: "Read",
                input: {
                  file_path: "/workspace/repo/README.md",
                },
              },
            ],
          },
          parent_tool_use_id: "toolu_01CgPFfrLkPFHCd87kY6PG8h",
          session_id: "7ea4397a-da41-4b30-9f73-7e382e44325f",
        },
        {
          type: "user",
          message: {
            role: "user",
            content: [
              {
                tool_use_id: "toolu_0197Eg9mB1TUyNLrhNDCR3Q7",
                type: "tool_result",
                content: "README_CONTENTS",
              },
            ],
          },
          parent_tool_use_id: "toolu_01CgPFfrLkPFHCd87kY6PG8h",
          session_id: "7ea4397a-da41-4b30-9f73-7e382e44325f",
        },
        {
          type: "user",
          message: {
            role: "user",
            content: [
              {
                tool_use_id: "toolu_01CgPFfrLkPFHCd87kY6PG8h",
                type: "tool_result",
                content: [
                  {
                    type: "text",
                    text: "Based on the README.md file, here's a concise summary...",
                  },
                ],
              },
            ],
          },
          parent_tool_use_id: null,
          session_id: "7ea4397a-da41-4b30-9f73-7e382e44325f",
        },
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              {
                type: "text",
                text: "**Directory listing:** Contains CLAUDE.md, ...**README Summary:** Terragon is a...",
              },
            ],
          },
          parent_tool_use_id: null,
          session_id: "7ea4397a-da41-4b30-9f73-7e382e44325f",
        },
      ];
      const result = input.map(toDBMessage).flat();
      expect(result).toEqual([
        {
          id: "toolu_01GKLEkUWeCqNRrwnjNZaS8V",
          name: "LS",
          parameters: {
            path: "/workspace/repo",
          },
          parent_tool_use_id: null,
          type: "tool-call",
        },
        {
          id: "toolu_01CgPFfrLkPFHCd87kY6PG8h",
          name: "Task",
          parameters: {
            description: "Summarize project README",
            prompt:
              "Please read the README.md file in the root directory and provide a concise summary.",
          },
          parent_tool_use_id: null,
          type: "tool-call",
        },
        {
          id: "toolu_01GKLEkUWeCqNRrwnjNZaS8V",
          is_error: null,
          parent_tool_use_id: null,
          result: "- /workspace/repo/ - CLAUDE.md - README.md",
          type: "tool-result",
        },
        {
          id: "toolu_0197Eg9mB1TUyNLrhNDCR3Q7",
          name: "Read",
          parameters: {
            file_path: "/workspace/repo/README.md",
          },
          parent_tool_use_id: "toolu_01CgPFfrLkPFHCd87kY6PG8h",
          type: "tool-call",
        },
        {
          id: "toolu_0197Eg9mB1TUyNLrhNDCR3Q7",
          is_error: null,
          parent_tool_use_id: "toolu_01CgPFfrLkPFHCd87kY6PG8h",
          result: "README_CONTENTS",
          type: "tool-result",
        },
        {
          id: "toolu_01CgPFfrLkPFHCd87kY6PG8h",
          is_error: null,
          parent_tool_use_id: null,
          result:
            '[{"type":"text","text":"Based on the README.md file, here\'s a concise summary..."}]',
          type: "tool-result",
        },
        {
          parent_tool_use_id: null,
          parts: [
            {
              text: "**Directory listing:** Contains CLAUDE.md, ...**README Summary:** Terragon is a...",
              type: "text",
            },
          ],
          type: "agent",
        },
      ]);
    });
  });

  describe("Claude SDK content-block coverage (Wave 2)", () => {
    test("preserves thinking signature for multi-turn continuations", () => {
      const claudeMessage: ClaudeMessage = {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: "reasoning about the problem",
              signature: "enc-sig-abc123",
            },
            { type: "text", text: "Here's the answer." },
          ],
        },
        parent_tool_use_id: null,
        session_id: "s1",
      };

      const result = toDBMessage(claudeMessage);
      expect(result).toEqual([
        {
          type: "agent",
          parent_tool_use_id: null,
          parts: [
            {
              type: "thinking",
              thinking: "reasoning about the problem",
              signature: "enc-sig-abc123",
            },
            { type: "text", text: "Here's the answer." },
          ],
        },
      ]);
    });

    test("omits signature field when not emitted by SDK", () => {
      // Cast content to `any` — the Anthropic ThinkingBlockParam type requires
      // signature, but we want to verify the translator handles the case where
      // the SDK emits a thinking block without one (e.g. older models).
      const claudeMessage: ClaudeMessage = {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "no sig" } as never],
        },
        parent_tool_use_id: null,
        session_id: "s1",
      };
      const [agent] = toDBMessage(claudeMessage) as Array<{
        parts: Array<Record<string, unknown>>;
      }>;
      expect(agent?.parts[0]).toEqual({
        type: "thinking",
        thinking: "no sig",
      });
    });

    test("converts server_tool_use block into DBServerToolUsePart", () => {
      const claudeMessage: ClaudeMessage = {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "server_tool_use",
              id: "srvtoolu_1",
              name: "web_search",
              input: { query: "capital of France" },
            } as never,
          ],
        },
        parent_tool_use_id: null,
        session_id: "s1",
      };

      const result = toDBMessage(claudeMessage);
      expect(result).toEqual([
        {
          type: "agent",
          parent_tool_use_id: null,
          parts: [
            {
              type: "server-tool-use",
              id: "srvtoolu_1",
              name: "web_search",
              input: { query: "capital of France" },
            },
          ],
        },
      ]);
    });

    test("converts web_search_tool_result success into DBWebSearchResultPart", () => {
      const claudeMessage: ClaudeMessage = {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "web_search_tool_result",
              tool_use_id: "srvtoolu_1",
              content: [
                {
                  type: "web_search_result",
                  url: "https://example.com/a",
                  title: "Result A",
                  page_age: "2 days ago",
                  encrypted_content: "enc-a",
                },
                {
                  type: "web_search_result",
                  url: "https://example.com/b",
                  title: "Result B",
                  // encrypted_content intentionally omitted — the translator
                  // treats it as optional; type-cast to silence the API
                  // requirement so we exercise the optional path.
                } as never,
              ],
            } as never,
          ],
        },
        parent_tool_use_id: null,
        session_id: "s1",
      };

      const [agent] = toDBMessage(claudeMessage) as Array<{
        parts: Array<Record<string, unknown>>;
      }>;
      expect(agent?.parts[0]).toEqual({
        type: "web-search-result",
        toolUseId: "srvtoolu_1",
        results: [
          {
            url: "https://example.com/a",
            title: "Result A",
            pageAge: "2 days ago",
            encryptedContent: "enc-a",
          },
          { url: "https://example.com/b", title: "Result B" },
        ],
      });
    });

    test("converts web_search_tool_result error into errorCode-only part", () => {
      const claudeMessage: ClaudeMessage = {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "web_search_tool_result",
              tool_use_id: "srvtoolu_2",
              content: {
                type: "web_search_tool_result_error",
                error_code: "max_uses_exceeded",
              },
            } as never,
          ],
        },
        parent_tool_use_id: null,
        session_id: "s1",
      };

      const [agent] = toDBMessage(claudeMessage) as Array<{
        parts: Array<Record<string, unknown>>;
      }>;
      expect(agent?.parts[0]).toEqual({
        type: "web-search-result",
        toolUseId: "srvtoolu_2",
        errorCode: "max_uses_exceeded",
      });
    });

    test("keeps client tool_use blocks as DBToolCall (distinct from server-tool-use)", () => {
      const claudeMessage: ClaudeMessage = {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_1",
              name: "Bash",
              input: { command: "ls" },
            },
          ],
        },
        parent_tool_use_id: null,
        session_id: "s1",
      };
      const result = toDBMessage(claudeMessage);
      expect(result).toEqual([
        {
          type: "tool-call",
          id: "toolu_1",
          name: "Bash",
          parameters: { command: "ls" },
          parent_tool_use_id: null,
        },
      ]);
    });
  });
});
