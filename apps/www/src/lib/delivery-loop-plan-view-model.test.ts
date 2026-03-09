import { describe, expect, it } from "vitest";
import {
  buildArtifactFallbackPlanSpecViewModel,
  extractProposedPlanBlock,
  parsePlanSpecViewModelFromText,
} from "./delivery-loop-plan-view-model";

describe("sdlc-plan-view-model", () => {
  it("extracts proposed_plan block content", () => {
    const input = [
      "intro",
      "<proposed_plan>",
      "## Plan",
      "1. First",
      "</proposed_plan>",
    ].join("\n");

    expect(extractProposedPlanBlock(input)).toContain("## Plan");
  });

  it("parses proposed plan markdown to a review model", () => {
    const input = [
      "<proposed_plan>",
      "## SDLC Unstick",
      "### Summary",
      "Keep strict checks with one-time bypass.",
      "### What We\u2019re Adding",
      "1. Recoverable gating",
      "- Add resume action",
      "2. Plan card rendering",
      "- Render structured plan",
      "### Assumptions / Defaults",
      "- Bypass is one-time",
      "</proposed_plan>",
    ].join("\n");

    const result = parsePlanSpecViewModelFromText(input);
    expect(result).not.toBeNull();
    expect(result?.source).toBe("proposed_plan_tag");
    expect(result?.tasks).toHaveLength(2);
    expect(result?.assumptions).toContain("Bypass is one-time");
  });

  it("falls back to json plan parsing", () => {
    const input = JSON.stringify({
      planText: "Plan summary",
      tasks: [
        {
          stableTaskId: "task-1",
          title: "Task title",
          description: "Task description",
          acceptance: ["Criterion"],
        },
      ],
    });

    const result = parsePlanSpecViewModelFromText(input);
    expect(result).not.toBeNull();
    expect(result?.source).toBe("json_plan_spec");
    expect(result?.tasks[0]?.acceptance).toEqual(["Criterion"]);
  });

  it("builds artifact fallback model", () => {
    const result = buildArtifactFallbackPlanSpecViewModel({
      summary: "Fallback",
      tasks: [
        {
          stableTaskId: "task-1",
          title: "Do thing",
          description: null,
          acceptance: [],
        },
      ],
    });

    expect(result).not.toBeNull();
    expect(result?.source).toBe("artifact_fallback");
  });
});
