import { describe, it, expect } from "vitest";
import { getThinkingTitle } from "./thinking-part";

describe("getThinkingTitle", () => {
  it("should return 'Thinking' when no bold header is present", () => {
    expect(getThinkingTitle("Some regular thinking text")).toBe("Thinking");
    expect(getThinkingTitle("")).toBe("Thinking");
    expect(getThinkingTitle("*Not bold enough*")).toBe("Thinking");
  });

  it("should extract text from bold markdown header", () => {
    expect(getThinkingTitle("**Custom Header**")).toBe("Custom Header");
    expect(getThinkingTitle("**Analysis**")).toBe("Analysis");
    expect(getThinkingTitle("**Planning Next Steps**")).toBe(
      "Planning Next Steps",
    );
    expect(getThinkingTitle("**My Custom Header**\n\nSome content")).toBe(
      "My Custom Header",
    );
  });

  it("should only match bold header at the beginning", () => {
    expect(getThinkingTitle("Some text **Bold Text** in middle")).toBe(
      "Thinking",
    );
    expect(getThinkingTitle("  **Indented Bold**")).toBe("Thinking");
  });

  it("should handle edge cases with bold markdown", () => {
    expect(getThinkingTitle("**")).toBe("Thinking");
    expect(getThinkingTitle("****")).toBe("Thinking");
    expect(getThinkingTitle("** **")).toBe("Thinking");
    expect(getThinkingTitle("**Header** with more content")).toBe("Header");
  });
});
