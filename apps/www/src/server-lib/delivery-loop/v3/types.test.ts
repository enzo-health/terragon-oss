import { describe, expect, it } from "vitest";
import {
  isTerminalState,
  normalizeEffectApprovalPolicy,
  normalizePlanApprovalPolicy,
  type WorkflowState,
} from "./types";

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

describe("plan approval policy normalization", () => {
  it("normalizes persisted human variants to human_required", () => {
    expect(normalizePlanApprovalPolicy("human")).toBe("human_required");
    expect(normalizePlanApprovalPolicy("human_required")).toBe(
      "human_required",
    );
  });

  it("normalizes unknown and empty policies to auto", () => {
    expect(normalizePlanApprovalPolicy("auto")).toBe("auto");
    expect(normalizePlanApprovalPolicy(null)).toBe("auto");
    expect(normalizePlanApprovalPolicy(undefined)).toBe("auto");
    expect(normalizePlanApprovalPolicy("bogus")).toBe("auto");
  });

  it("maps normalized approval policy back to effect-language values", () => {
    expect(normalizeEffectApprovalPolicy("human")).toBe("human");
    expect(normalizeEffectApprovalPolicy("human_required")).toBe("human");
    expect(normalizeEffectApprovalPolicy("auto")).toBe("auto");
    expect(normalizeEffectApprovalPolicy(null)).toBe("auto");
  });
});
