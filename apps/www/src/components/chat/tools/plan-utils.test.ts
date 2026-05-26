import { describe, expect, it } from "vitest";
import type { DBMessage } from "@terragon/shared";
import {
  formatPlanForDisplay,
  resolvePlanTextFromLegacyMessages,
} from "./plan-utils";

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

describe("resolvePlanTextFromLegacyMessages", () => {
  const writePlan: DBMessage = {
    type: "tool-call",
    id: "write-plan",
    name: "Write",
    parameters: {
      file_path: "docs/plans/implementation.md",
      content: "# Legacy write plan\n\n- Keep it readable",
    },
    parent_tool_use_id: null,
  };
  const exitPlanMode: DBMessage = {
    type: "tool-call",
    id: "exit-plan",
    name: "ExitPlanMode",
    parameters: {},
    parent_tool_use_id: null,
  };

  it("prefers the explicit ExitPlanMode plan parameter", () => {
    expect(
      resolvePlanTextFromLegacyMessages({
        planParam: "Explicit plan",
        messages: [writePlan, exitPlanMode],
        exitPlanModeToolId: "exit-plan",
      }),
    ).toBe("Explicit plan");
  });

  it("falls back to the preceding legacy Write plan for secondary-panel artifacts", () => {
    expect(
      resolvePlanTextFromLegacyMessages({
        messages: [writePlan, exitPlanMode],
        exitPlanModeToolId: "exit-plan",
      }),
    ).toBe("# Legacy write plan\n\n- Keep it readable");
  });

  it("stops scanning legacy writes at the previous user turn", () => {
    const userMessage: DBMessage = {
      type: "user",
      model: null,
      parts: [{ type: "text", text: "new turn" }],
    };

    expect(
      resolvePlanTextFromLegacyMessages({
        messages: [writePlan, userMessage, exitPlanMode],
        exitPlanModeToolId: "exit-plan",
      }),
    ).toBe("");
  });

  it("returns an empty string when no matching legacy Write exists", () => {
    expect(
      resolvePlanTextFromLegacyMessages({
        messages: [exitPlanMode],
        exitPlanModeToolId: "exit-plan",
      }),
    ).toBe("");
  });
});
