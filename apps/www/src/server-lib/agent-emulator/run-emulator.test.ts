import { describe, expect, it } from "vitest";
import { applyRunScopedStepIds } from "./run-emulator";
import { DEFAULT_EMULATOR_SCENARIO, type EmulatorStep } from "./scenarios";

function collectIds(steps: EmulatorStep[]): string[] {
  const ids: string[] = [];
  for (const step of steps) {
    if (step.type === "thinking" || step.type === "text") {
      ids.push(step.messageId);
    } else if (step.type === "tool-call") {
      ids.push(step.toolCallId);
    }
  }
  return ids;
}

describe("applyRunScopedStepIds", () => {
  it("produces disjoint id sets across two runs of the same scenario", () => {
    const runA = "run-aaaaaaaa";
    const runB = "run-bbbbbbbb";
    const stepsA = applyRunScopedStepIds(
      DEFAULT_EMULATOR_SCENARIO.build("hello"),
      runA,
    );
    const stepsB = applyRunScopedStepIds(
      DEFAULT_EMULATOR_SCENARIO.build("hello"),
      runB,
    );

    const idsA = collectIds(stepsA);
    const idsB = collectIds(stepsB);

    expect(idsA.length).toBeGreaterThan(0);
    expect(new Set(idsA).size).toBe(idsA.length);
    expect(idsA.every((id) => id.endsWith(runA))).toBe(true);
    expect(idsB.every((id) => id.endsWith(runB))).toBe(true);

    const overlap = idsA.filter((id) => idsB.includes(id));
    expect(overlap).toEqual([]);
  });

  it("leaves system-init and terminal steps untouched", () => {
    const steps = applyRunScopedStepIds(
      DEFAULT_EMULATOR_SCENARIO.build("hello"),
      "run-xyz",
    );
    expect(steps.some((step) => step.type === "system-init")).toBe(true);
    expect(steps.some((step) => step.type === "terminal")).toBe(true);
  });
});
