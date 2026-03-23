import { describe, expect, it } from "vitest";
import { isTerminalStateV3, type WorkflowStateV3 } from "./types";

describe("isTerminalStateV3", () => {
  it("returns true for terminal states", () => {
    const terminalStates: WorkflowStateV3[] = ["done", "stopped", "terminated"];

    for (const state of terminalStates) {
      expect(isTerminalStateV3(state)).toBe(true);
    }
  });

  it("returns false for non-terminal states", () => {
    const nonTerminalStates: WorkflowStateV3[] = [
      "planning",
      "implementing",
      "gating_review",
      "gating_ci",
      "awaiting_pr",
      "awaiting_manual_fix",
      "awaiting_operator_action",
    ];

    for (const state of nonTerminalStates) {
      expect(isTerminalStateV3(state)).toBe(false);
    }
  });
});
