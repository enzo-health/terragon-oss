import { describe, expect, it } from "vitest";
import { truncateAtWordBoundary } from "./exit-plan-mode-tool";

describe("truncateAtWordBoundary", () => {
  it("returns text unchanged when shorter than maxChars", () => {
    const text = "Short plan";
    expect(truncateAtWordBoundary(text)).toBe(text);
  });

  it("returns text unchanged when exactly maxChars", () => {
    const text = "a".repeat(300);
    expect(truncateAtWordBoundary(text)).toBe(text);
  });

  it("truncates at word boundary when possible", () => {
    const text = "word ".repeat(80); // 400 chars
    const result = truncateAtWordBoundary(text);
    expect(result.endsWith("...")).toBe(true);
    expect(result.length).toBeLessThanOrEqual(303); // 300 + "..."
    // Should not end with a partial word (trailing space is ok)
    const withoutEllipsis = result.slice(0, -3);
    expect(withoutEllipsis.endsWith(" ") || withoutEllipsis.endsWith("d")).toBe(
      true,
    );
  });

  it("falls back to maxChars when no good word boundary exists", () => {
    const text = "a".repeat(400);
    expect(truncateAtWordBoundary(text)).toBe("a".repeat(300) + "...");
  });

  it("uses a custom maxChars value", () => {
    const text = "hello world this is a test of truncation";
    const result = truncateAtWordBoundary(text, 15);
    expect(result.endsWith("...")).toBe(true);
    const withoutEllipsis = result.slice(0, -3);
    expect(withoutEllipsis.length).toBeLessThanOrEqual(15);
  });

  it("breaks at last space before maxChars", () => {
    const text = "The quick brown fox jumps over the lazy dog";
    const result = truncateAtWordBoundary(text, 20);
    expect(result).toBe("The quick brown fox...");
  });
});
