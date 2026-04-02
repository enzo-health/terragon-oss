import { describe, expect, it } from "vitest";
import { isTerminalState, type WorkflowState } from "./types";

describe("isTerminalState", () => {
  it("returns true for terminal states", () => {
    const terminalStates: WorkflowState[] = ["done", "stopped", "terminated"];

    for (const state of terminalStates) {
      expect(isTerminalState(state)).toBe(true);
    }
  });

  it("returns false for non-terminal states", () => {
    const nonTerminalStates: WorkflowState[] = [
      "planning",
      "implementing",
      "gating_review",
      "gating_ci",
      "awaiting_pr_creation",
      "awaiting_pr_lifecycle",
      "awaiting_manual_fix",
      "awaiting_operator_action",
    ];

    for (const state of nonTerminalStates) {
      expect(isTerminalState(state)).toBe(false);
    }
  });
});
