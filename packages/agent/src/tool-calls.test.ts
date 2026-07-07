import { describe, it, expect } from "vitest";
import { normalizeToolCall } from "./tool-calls";

describe("normalizeToolCall", () => {
  describe("MCP SuggestFollowupTask", () => {
    it("should normalize mcp__terry__SuggestFollowupTask to SuggestFollowupTask", () => {
      const result = normalizeToolCall("claudeCode", {
        name: "mcp__terry__SuggestFollowupTask",
        parameters: { task: "test" },
      });

      expect(result.name).toBe("SuggestFollowupTask");
      expect(result.parameters).toEqual({ task: "test" });
    });
  });

  describe("passthrough", () => {
    it("should leave tool calls unchanged for claudeCode agent", () => {
      const result = normalizeToolCall("claudeCode", {
        name: "Bash",
        parameters: { command: "ls" },
      });

      expect(result.name).toBe("Bash");
      expect(result.parameters).toEqual({ command: "ls" });
    });

    it("should leave tool calls unchanged for codex agent", () => {
      const result = normalizeToolCall("codex", {
        name: "Write",
        parameters: { file_path: "/test.ts", content: "code" },
      });

      expect(result.name).toBe("Write");
      expect(result.parameters).toEqual({
        file_path: "/test.ts",
        content: "code",
      });
    });

    it("should preserve result if present", () => {
      const result = normalizeToolCall("codex", {
        name: "WebSearch",
        parameters: { query: "test" },
        result: "Search results...",
      });

      expect(result.name).toBe("WebSearch");
      expect(result.result).toBe("Search results...");
    });
  });
});
