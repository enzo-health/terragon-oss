import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ReasoningBlock, getReasoningTitle } from "./reasoning-block";

describe("ReasoningBlock", () => {
  it("extracts a leading bold title", () => {
    expect(getReasoningTitle("**Planning**\n\nBody")).toBe("Planning");
  });

  it("falls back to Thinking for malformed or empty bold prefix", () => {
    expect(getReasoningTitle("**** body")).toBe("Thinking");
    expect(getReasoningTitle("** **\nBody")).toBe("Thinking");
  });

  it("renders expanded content without duplicating the bold title", () => {
    const html = renderToStaticMarkup(
      <ReasoningBlock
        thinking={"**Planning**\n\nFirst step.\nSecond step."}
        isLatest
        isAgentWorking={false}
      />,
    );

    expect(html).toContain("Planning");
    expect(html).toContain("First step.");
    expect(html).toContain("Second step.");
    expect(html).not.toContain("<strong>Planning</strong>");
  });
});
