import { describe, expect, it } from "vitest";
import {
  assistantToolCallPropsToToolPart,
  type RuntimeToolCallProps,
} from "./runtime-tool-renderer";

function toolProps(
  overrides: Partial<RuntimeToolCallProps> = {},
): RuntimeToolCallProps {
  return {
    type: "tool-call",
    toolCallId: "tool-1",
    toolName: "Bash",
    args: { command: "pnpm test" },
    argsText: '{"command":"pnpm test"}',
    status: { type: "running" },
    addResult: () => undefined,
    resume: () => undefined,
    ...overrides,
  };
}

describe("assistantToolCallPropsToToolPart", () => {
  it("projects running assistant-ui tool calls to pending Terragon tool parts", () => {
    expect(assistantToolCallPropsToToolPart(toolProps(), "codex")).toEqual({
      type: "tool",
      id: "tool-1",
      agent: "codex",
      name: "Bash",
      parameters: { command: "pnpm test" },
      parts: [],
      status: "pending",
    });
  });

  it("preserves unknown tool names for DefaultTool fallback", () => {
    const toolPart = assistantToolCallPropsToToolPart(
      toolProps({
        toolName: "mcp__linear__create_issue",
        args: { title: "Bug" },
        result: { id: "LIN-1" },
        status: { type: "complete" },
      }),
      "claudeCode",
    );

    expect(toolPart).toMatchObject({
      name: "mcp__linear__create_issue",
      parameters: { title: "Bug" },
      status: "completed",
      result: '{"id":"LIN-1"}',
    });
  });

  it("maps incomplete tool-call status to an error result", () => {
    expect(
      assistantToolCallPropsToToolPart(
        toolProps({
          status: { type: "incomplete", reason: "error", error: "failed" },
        }),
        "amp",
      ),
    ).toMatchObject({
      status: "error",
      result: "failed",
    });
  });
});
