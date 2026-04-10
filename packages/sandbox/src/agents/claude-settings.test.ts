import { describe, it, expect } from "vitest";
import { buildClaudeCodeSettings } from "./claude-settings";

describe("buildClaudeCodeSettings", () => {
  it("returns valid JSON", () => {
    const settingsJson = buildClaudeCodeSettings();
    const parsed = JSON.parse(settingsJson);
    expect(parsed).toBeDefined();
  });

  it("configures a Stop hook", () => {
    const parsed = JSON.parse(buildClaudeCodeSettings());
    expect(parsed.hooks).toBeDefined();
    expect(parsed.hooks.Stop).toBeDefined();
    expect(Array.isArray(parsed.hooks.Stop)).toBe(true);
    expect(parsed.hooks.Stop.length).toBe(1);
  });

  it("Stop hook matches all events (empty matcher)", () => {
    const parsed = JSON.parse(buildClaudeCodeSettings());
    const stopHook = parsed.hooks.Stop[0];
    expect(stopHook.matcher).toBe("");
  });

  it("Stop hook runs the quality check script", () => {
    const parsed = JSON.parse(buildClaudeCodeSettings());
    const hookConfig = parsed.hooks.Stop[0].hooks[0];
    expect(hookConfig.type).toBe("command");
    expect(hookConfig.command).toBe("/tmp/leo-quality-check.sh");
    expect(hookConfig.timeout).toBe(300);
  });

  it("can disable Stop hook wiring", () => {
    const parsed = JSON.parse(
      buildClaudeCodeSettings({ enableStopHook: false }),
    );
    expect(parsed.hooks.Stop).toEqual([]);
  });
});
