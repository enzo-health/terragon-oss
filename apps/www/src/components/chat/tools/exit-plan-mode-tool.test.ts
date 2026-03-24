import { describe, expect, it } from "vitest";
import { truncatePlanPreview } from "./exit-plan-mode-tool";

describe("truncatePlanPreview", () => {
  it("returns text unchanged when shorter than maxChars", () => {
    const text = "Short plan";
    expect(truncatePlanPreview(text)).toBe(text);
  });

  it("returns text unchanged when exactly maxChars", () => {
    const text = "a".repeat(150);
    expect(truncatePlanPreview(text)).toBe(text);
  });

  it("truncates at first paragraph break after maxChars", () => {
    const before = "a".repeat(160);
    const text = `${before}\n\nSecond paragraph`;
    expect(truncatePlanPreview(text)).toBe(`${before}\u2026`);
  });

  it("falls back to maxChars when no paragraph break exists", () => {
    const text = "a".repeat(200);
    expect(truncatePlanPreview(text)).toBe("a".repeat(150) + "\u2026");
  });

  it("uses a custom maxChars value", () => {
    const text = "a".repeat(30);
    expect(truncatePlanPreview(text, 10)).toBe("a".repeat(10) + "\u2026");
  });

  it("finds paragraph break exactly at maxChars boundary", () => {
    const text = "a".repeat(150) + "\n\nMore content";
    expect(truncatePlanPreview(text)).toBe("a".repeat(150) + "\u2026");
  });

  it("preserves content before a late paragraph break", () => {
    const first = "a".repeat(180);
    const text = `${first}\n\nLate break`;
    expect(truncatePlanPreview(text)).toBe(`${first}\u2026`);
  });
});
