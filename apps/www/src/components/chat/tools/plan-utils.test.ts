import { describe, expect, it } from "vitest";
import {
  formatPlanForDisplay,
  findPlanFromWriteToolCall,
  resolvePlanText,
} from "./plan-utils";
import type { UIAgentMessage, UIMessage } from "@terragon/shared";

describe("formatPlanForDisplay", () => {
  it("returns raw text for non-JSON plans", () => {
    const plan = "## My Plan\n\n1. Do A\n2. Do B";
    expect(formatPlanForDisplay(plan)).toBe(plan);
  });

  it("converts a JSON plan with planText and tasks to markdown", () => {
    const plan = JSON.stringify({
      planText: "Overview of the plan",
      tasks: [
        { title: "Task One", description: "Do first thing" },
        { title: "Task Two", description: "Do second thing" },
      ],
    });
    const result = formatPlanForDisplay(plan);
    expect(result).toContain("Overview of the plan");
    expect(result).toContain("**Task One**");
    expect(result).toContain("**Task Two**");
    expect(result).toContain("## Tasks");
  });

  it("handles a JSON array of tasks", () => {
    const plan = JSON.stringify([
      { title: "Step 1", description: "First" },
      { title: "Step 2", description: "Second" },
    ]);
    const result = formatPlanForDisplay(plan);
    expect(result).toContain("**Step 1**");
    expect(result).toContain("**Step 2**");
  });

  it("returns raw text for JSON without planText or tasks", () => {
    const plan = JSON.stringify({ foo: "bar" });
    expect(formatPlanForDisplay(plan)).toBe(plan);
  });
});

describe("findPlanFromWriteToolCall", () => {
  it("finds a Write to plans/*.md before ExitPlanMode", () => {
    const messages = agentMessages([
      writeTool("write-1", "/workspace/plans/my-plan.md", "# Plan from Write"),
      exitPlanModeTool("exit-1"),
    ]);

    expect(
      findPlanFromWriteToolCall({
        messages,
        exitPlanModeToolId: "exit-1",
      }),
    ).toBe("# Plan from Write");
  });

  it("returns null when no Write to plans/ is found", () => {
    const messages = agentMessages([exitPlanModeTool("exit-1")]);

    expect(
      findPlanFromWriteToolCall({
        messages,
        exitPlanModeToolId: "exit-1",
      }),
    ).toBeNull();
  });

  it("stops at user messages when searching backwards", () => {
    const messages: UIMessage[] = [
      ...agentMessages([
        writeTool("write-old", "/workspace/plans/old-plan.md", "# Old Plan"),
      ]),
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "new task" }],
      },
      ...agentMessages([exitPlanModeTool("exit-1")]),
    ];

    expect(
      findPlanFromWriteToolCall({
        messages,
        exitPlanModeToolId: "exit-1",
      }),
    ).toBeNull();
  });
});

describe("resolvePlanText", () => {
  it("returns formatted plan from parameters.plan when available", () => {
    const result = resolvePlanText({
      planParam: "## Direct Plan",
      messages: null,
      exitPlanModeToolId: "exit-1",
    });
    expect(result).toBe("## Direct Plan");
  });

  it("falls back to Write tool call when planParam is empty", () => {
    const messages = agentMessages([
      writeTool("write-1", "/workspace/plans/fallback.md", "# Fallback Plan"),
      exitPlanModeTool("exit-1"),
    ]);

    const result = resolvePlanText({
      planParam: "",
      messages,
      exitPlanModeToolId: "exit-1",
    });
    expect(result).toBe("# Fallback Plan");
  });

  it("returns empty string when no plan source is available", () => {
    const result = resolvePlanText({
      planParam: "",
      messages: null,
      exitPlanModeToolId: "exit-1",
    });
    expect(result).toBe("");
  });
});

function agentMessages(parts: UIAgentMessage["parts"]): UIMessage[] {
  return [
    {
      id: "agent-message",
      role: "agent",
      agent: "claudeCode",
      parts,
    },
  ];
}

function writeTool(id: string, filePath: string, content: string) {
  return {
    type: "tool",
    id,
    agent: "claudeCode",
    name: "Write",
    parameters: {
      file_path: filePath,
      content,
    },
    parts: [],
    status: "pending",
  } satisfies UIAgentMessage["parts"][number];
}

function exitPlanModeTool(id: string) {
  return {
    type: "tool",
    id,
    agent: "claudeCode",
    name: "ExitPlanMode",
    parameters: { plan: "" },
    parts: [],
    status: "pending",
  } satisfies UIAgentMessage["parts"][number];
}
