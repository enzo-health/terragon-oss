import { describe, it, expect } from "vitest";
import { extractLatestPlanText } from "../checkpoint-thread-internal";
import type { DBMessage } from "@terragon/shared";

// ---------------------------------------------------------------------------
// Helpers to build minimal message mocks
// ---------------------------------------------------------------------------

function toolCall(
  name: string,
  parameters: Record<string, any>,
  id = "tc-1",
): DBMessage {
  return {
    type: "tool-call",
    id,
    name,
    parameters,
    parent_tool_use_id: null,
  } as DBMessage;
}

function agentText(
  text: string,
  parentToolUseId: string | null = null,
): DBMessage {
  return {
    type: "agent",
    parent_tool_use_id: parentToolUseId,
    parts: [{ type: "text", text }],
  } as DBMessage;
}

function userMessage(text = "do something"): DBMessage {
  return {
    type: "user",
    model: null,
    parts: [{ type: "text", text }],
  } as DBMessage;
}

function toolResult(id = "tc-1", result = "ok"): DBMessage {
  return {
    type: "tool-result",
    id,
    is_error: false,
    parent_tool_use_id: null,
    result,
  } as DBMessage;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("extractLatestPlanText", () => {
  // ---- Priority 1: ExitPlanMode tool call ----

  describe("ExitPlanMode tool call (Priority 1)", () => {
    it("extracts plan text from ExitPlanMode parameters", () => {
      const planText = "## Plan\n- Step 1\n- Step 2";
      const messages: DBMessage[] = [
        userMessage(),
        agentText("I will create a plan"),
        toolCall("ExitPlanMode", { plan: planText }),
      ];

      const result = extractLatestPlanText(messages);

      expect(result).toEqual({ text: planText, source: "exit_plan_mode" });
    });

    it("extracts JSON plan from ExitPlanMode", () => {
      const jsonPlan = JSON.stringify({
        tasks: [
          { id: 1, title: "Refactor module", status: "pending" },
          { id: 2, title: "Add tests", status: "pending" },
        ],
      });
      const messages: DBMessage[] = [
        userMessage(),
        toolCall("ExitPlanMode", { plan: jsonPlan }),
      ];

      const result = extractLatestPlanText(messages);

      expect(result).toEqual({ text: jsonPlan, source: "exit_plan_mode" });
    });

    it("trims whitespace from ExitPlanMode plan text", () => {
      const messages: DBMessage[] = [
        toolCall("ExitPlanMode", { plan: "  plan with spaces  " }),
      ];

      const result = extractLatestPlanText(messages);

      expect(result).toEqual({
        text: "plan with spaces",
        source: "exit_plan_mode",
      });
    });

    it("falls through when ExitPlanMode plan param is empty string", () => {
      const messages: DBMessage[] = [
        userMessage(),
        agentText("Here is the plan as agent text"),
        toolCall("ExitPlanMode", { plan: "" }),
      ];

      const result = extractLatestPlanText(messages);

      // Should fall through to agent_text since plan is empty
      expect(result).not.toBeNull();
      expect(result!.source).toBe("agent_text");
    });

    it("falls through when ExitPlanMode plan param is whitespace-only", () => {
      const messages: DBMessage[] = [
        userMessage(),
        agentText("Fallback agent text"),
        toolCall("ExitPlanMode", { plan: "   " }),
      ];

      const result = extractLatestPlanText(messages);

      expect(result).not.toBeNull();
      expect(result!.source).toBe("agent_text");
    });
  });

  // ---- Priority 2: Write tool to plans/*.md ----

  describe("Write tool to plans/*.md (Priority 2)", () => {
    it("extracts plan from Write tool call paired with ExitPlanMode", () => {
      const planContent = "# Implementation Plan\n\n- Task A\n- Task B";
      const exitId = "exit-1";
      const messages: DBMessage[] = [
        userMessage(),
        toolCall(
          "Write",
          { file_path: "plans/plan.md", content: planContent },
          "write-1",
        ),
        toolResult("write-1"),
        toolCall("ExitPlanMode", { plan: "" }, exitId),
      ];

      // ExitPlanMode has empty plan, so findPlanFromWriteToolCall should find the Write
      const result = extractLatestPlanText(messages);

      expect(result).toEqual({ text: planContent, source: "write_tool" });
    });

    it("extracts standalone Write to plans/*.md without ExitPlanMode", () => {
      const planContent = "# Plan\n- Do the thing";
      const messages: DBMessage[] = [
        userMessage(),
        agentText("Writing plan"),
        toolCall(
          "Write",
          { file_path: "plans/my-plan.md", content: planContent },
          "w-1",
        ),
        toolResult("w-1"),
      ];

      const result = extractLatestPlanText(messages);

      expect(result).toEqual({ text: planContent, source: "write_tool" });
    });

    it("does not detect Write to non-plans path", () => {
      const messages: DBMessage[] = [
        userMessage(),
        toolCall(
          "Write",
          { file_path: "src/index.ts", content: "code" },
          "w-1",
        ),
        toolResult("w-1"),
      ];

      const result = extractLatestPlanText(messages);

      // No ExitPlanMode, no plans/*.md Write, no agent text => null
      expect(result).toBeNull();
    });

    it("does not detect Write to plans/ with non-.md extension", () => {
      const messages: DBMessage[] = [
        userMessage(),
        toolCall(
          "Write",
          { file_path: "plans/data.json", content: "{}" },
          "w-1",
        ),
        toolResult("w-1"),
      ];

      const result = extractLatestPlanText(messages);

      expect(result).toBeNull();
    });

    it("standalone Write to plans/*.md stops at user message boundary", () => {
      const planContent = "# Old Plan";
      const messages: DBMessage[] = [
        toolCall(
          "Write",
          { file_path: "plans/old.md", content: planContent },
          "w-old",
        ),
        toolResult("w-old"),
        userMessage("new instruction"),
        // No agent messages after user message
      ];

      const result = extractLatestPlanText(messages);

      // The Write is before the user message boundary, so standalone scan should not find it
      expect(result).toBeNull();
    });
  });

  // ---- Priority 3: Concatenated agent text (Codex path) ----

  describe("Agent text fallback (Priority 3)", () => {
    it("extracts single agent text message", () => {
      const messages: DBMessage[] = [
        userMessage(),
        agentText("Here is my plan for the implementation"),
      ];

      const result = extractLatestPlanText(messages);

      expect(result).toEqual({
        text: "Here is my plan for the implementation",
        source: "agent_text",
      });
    });

    it("concatenates consecutive top-level agent messages (Codex streaming)", () => {
      const messages: DBMessage[] = [
        userMessage(),
        agentText("Part 1: "),
        agentText("Part 2: "),
        agentText("Part 3"),
      ];

      const result = extractLatestPlanText(messages);

      expect(result).not.toBeNull();
      expect(result!.source).toBe("agent_text");
      expect(result!.text).toBe("Part 1:Part 2:Part 3");
    });

    it("extracts agent text with JSON code block containing tasks", () => {
      const jsonPlan =
        '```json\n{"tasks": [{"id": 1, "title": "Fix bug"}]}\n```';
      const messages: DBMessage[] = [userMessage(), agentText(jsonPlan)];

      const result = extractLatestPlanText(messages);

      expect(result).toEqual({ text: jsonPlan, source: "agent_text" });
    });

    it("extracts plain prose agent text", () => {
      const prose = "I will refactor the module and add comprehensive tests.";
      const messages: DBMessage[] = [userMessage(), agentText(prose)];

      const result = extractLatestPlanText(messages);

      expect(result).toEqual({ text: prose, source: "agent_text" });
    });

    it("ignores nested agent messages (with parent_tool_use_id)", () => {
      const messages: DBMessage[] = [
        userMessage(),
        agentText("nested response", "parent-tool-1"),
      ];

      const result = extractLatestPlanText(messages);

      // Nested agent messages are skipped
      expect(result).toBeNull();
    });

    it("only concatenates the last consecutive run of agent messages", () => {
      const messages: DBMessage[] = [
        userMessage(),
        agentText("Old agent text"),
        toolCall("Bash", { command: "echo hi" }, "bash-1"),
        toolResult("bash-1", "hi"),
        agentText("Recent text 1"),
        agentText("Recent text 2"),
      ];

      const result = extractLatestPlanText(messages);

      expect(result).not.toBeNull();
      expect(result!.text).toBe("Recent text 1Recent text 2");
      expect(result!.source).toBe("agent_text");
    });
  });

  // ---- Edge cases ----

  describe("Edge cases", () => {
    it("returns null for null messages", () => {
      expect(extractLatestPlanText(null)).toBeNull();
    });

    it("returns null for empty messages array", () => {
      expect(extractLatestPlanText([])).toBeNull();
    });

    it("returns null when only user messages exist", () => {
      const messages: DBMessage[] = [
        userMessage("hello"),
        userMessage("world"),
      ];

      expect(extractLatestPlanText(messages)).toBeNull();
    });

    it("returns null when agent messages have empty text", () => {
      const messages: DBMessage[] = [
        userMessage(),
        agentText(""),
        agentText("   "),
      ];

      expect(extractLatestPlanText(messages)).toBeNull();
    });

    it("ExitPlanMode takes priority over agent text", () => {
      const messages: DBMessage[] = [
        userMessage(),
        agentText("Agent text that should be ignored"),
        toolCall("ExitPlanMode", { plan: "ExitPlanMode plan" }),
      ];

      const result = extractLatestPlanText(messages);

      expect(result).toEqual({
        text: "ExitPlanMode plan",
        source: "exit_plan_mode",
      });
    });

    it("Write tool takes priority over agent text", () => {
      const messages: DBMessage[] = [
        userMessage(),
        toolCall(
          "Write",
          { file_path: "plans/p.md", content: "Write plan" },
          "w-1",
        ),
        toolResult("w-1"),
        agentText("Agent text after write"),
      ];

      // Standalone Write to plans/*.md (Priority 2) should beat agent text (Priority 3)
      const result = extractLatestPlanText(messages);

      expect(result).toEqual({ text: "Write plan", source: "write_tool" });
    });

    it("mixed message types — only extracts appropriate plan source", () => {
      const messages: DBMessage[] = [
        userMessage(),
        agentText("thinking..."),
        toolCall("Bash", { command: "ls" }, "b-1"),
        toolResult("b-1", "file.ts"),
        agentText("Here is the result"),
        toolCall("Read", { file_path: "src/index.ts" }, "r-1"),
        toolResult("r-1", "content"),
        agentText("Final agent message"),
      ];

      const result = extractLatestPlanText(messages);

      // Should get the last consecutive agent text run
      expect(result).toEqual({
        text: "Final agent message",
        source: "agent_text",
      });
    });

    it("handles messages with only tool calls and results (no agent text)", () => {
      const messages: DBMessage[] = [
        userMessage(),
        toolCall("Bash", { command: "echo test" }, "b-1"),
        toolResult("b-1", "test"),
      ];

      expect(extractLatestPlanText(messages)).toBeNull();
    });
  });
});
