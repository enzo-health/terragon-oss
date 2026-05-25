import { describe, expect, it } from "vitest";
import { capToolResultContent, MAX_TOOL_RESULT_CHARS } from "./tool-output-cap";

describe("capToolResultContent", () => {
  it("returns short content unchanged", () => {
    const content = "hello world";
    expect(capToolResultContent(content)).toBe(content);
  });

  it("returns content at exactly the cap unchanged", () => {
    const content = "x".repeat(MAX_TOOL_RESULT_CHARS);
    expect(capToolResultContent(content)).toBe(content);
  });

  it("middle-truncates oversized content with a marker", () => {
    const content = "x".repeat(MAX_TOOL_RESULT_CHARS * 2);
    const capped = capToolResultContent(content);
    expect(capped.length).toBeLessThanOrEqual(MAX_TOOL_RESULT_CHARS);
    expect(capped).toContain("characters truncated");
  });

  it("keeps the head and the tail, drops the middle", () => {
    const head = "HEAD".repeat(2000);
    const middle = "M".repeat(40_000);
    const tail = "TAIL".repeat(2000);
    const capped = capToolResultContent(head + middle + tail);
    expect(capped.startsWith("HEAD")).toBe(true);
    expect(capped.endsWith("TAIL")).toBe(true);
    expect(capped).not.toContain(middle);
  });

  it("reports the number of characters removed", () => {
    const content = "a".repeat(MAX_TOOL_RESULT_CHARS + 5000);
    const capped = capToolResultContent(content);
    // Removed count is original minus what survives; marker uses locale commas.
    expect(capped).toMatch(/…[\d,]+ characters truncated…/);
  });

  it("respects a custom cap", () => {
    const capped = capToolResultContent("y".repeat(1000), 100);
    expect(capped.length).toBeLessThanOrEqual(100);
    expect(capped).toContain("characters truncated");
  });

  it("handles the 840 KB incident size", () => {
    const capped = capToolResultContent("z".repeat(840_978));
    expect(capped.length).toBeLessThanOrEqual(MAX_TOOL_RESULT_CHARS);
  });
});
