import { describe, expect, it } from "vitest";
import {
  formatPlanForDisplay,
  findPlanFromWriteToolCall,
  resolvePlanText,
} from "./plan-utils";
import type { DBMessage } from "@leo/shared";

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
    const messages: DBMessage[] = [
      {
        id: "write-1",
        type: "tool-call",
        name: "Write",
        parameters: {
          file_path: "/workspace/plans/my-plan.md",
          content: "# Plan from Write",
        },
      } as unknown as DBMessage,
      {
        id: "exit-1",
        type: "tool-call",
        name: "ExitPlanMode",
        parameters: { plan: "" },
      } as unknown as DBMessage,
    ];

    expect(
      findPlanFromWriteToolCall({
        messages,
        exitPlanModeToolId: "exit-1",
      }),
    ).toBe("# Plan from Write");
  });

  it("returns null when no Write to plans/ is found", () => {
    const messages: DBMessage[] = [
      {
        id: "exit-1",
        type: "tool-call",
        name: "ExitPlanMode",
        parameters: { plan: "" },
      } as unknown as DBMessage,
    ];

    expect(
      findPlanFromWriteToolCall({
        messages,
        exitPlanModeToolId: "exit-1",
      }),
    ).toBeNull();
  });

  it("stops at user messages when searching backwards", () => {
    const messages: DBMessage[] = [
      {
        id: "write-old",
        type: "tool-call",
        name: "Write",
        parameters: {
          file_path: "/workspace/plans/old-plan.md",
          content: "# Old Plan",
        },
      } as unknown as DBMessage,
      {
        id: "user-1",
        type: "user",
      } as unknown as DBMessage,
      {
        id: "exit-1",
        type: "tool-call",
        name: "ExitPlanMode",
        parameters: { plan: "" },
      } as unknown as DBMessage,
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
    const messages: DBMessage[] = [
      {
        id: "write-1",
        type: "tool-call",
        name: "Write",
        parameters: {
          file_path: "/workspace/plans/fallback.md",
          content: "# Fallback Plan",
        },
      } as unknown as DBMessage,
      {
        id: "exit-1",
        type: "tool-call",
        name: "ExitPlanMode",
        parameters: { plan: "" },
      } as unknown as DBMessage,
    ];

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
