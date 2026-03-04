import { describe, it, expect } from "vitest";
import { buildQualityCheckScript } from "./quality-check";

describe("buildQualityCheckScript", () => {
  it("returns a non-empty bash script", () => {
    const script = buildQualityCheckScript();
    expect(script).toBeTruthy();
    expect(script.startsWith("#!/bin/bash")).toBe(true);
  });

  it("contains package manager detection logic", () => {
    const script = buildQualityCheckScript();
    expect(script).toContain("pnpm-lock.yaml");
    expect(script).toContain("bun.lockb");
    expect(script).toContain("yarn.lock");
  });

  it("contains node_modules install check", () => {
    const script = buildQualityCheckScript();
    expect(script).toContain("node_modules");
    expect(script).toContain("$PM install");
  });

  it("checks for lint, typecheck, and test script groups", () => {
    const script = buildQualityCheckScript();
    // Lint group
    expect(script).toContain("for script in lint lint:fix");
    // Typecheck group
    expect(script).toContain("for script in typecheck type-check tsc");
    // Test group
    expect(script).toContain("for script in test");
  });

  it("outputs block JSON on failure", () => {
    const script = buildQualityCheckScript();
    expect(script).toContain('"decision":"block"');
    expect(script).toContain('"reason"');
  });

  it("includes attempt counter with max limit", () => {
    const script = buildQualityCheckScript();
    expect(script).toContain("ATTEMPT_FILE");
    expect(script).toContain("MAX_ATTEMPTS=3");
  });

  it("skips non-JS/TS projects", () => {
    const script = buildQualityCheckScript();
    expect(script).toContain("! -f package.json");
    expect(script).toContain("exit 0");
  });

  it("truncates long output", () => {
    const script = buildQualityCheckScript();
    expect(script).toContain("truncate_output");
    expect(script).toContain("2000");
  });
});
