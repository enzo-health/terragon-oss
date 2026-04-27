import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ThinkingPart } from "./thinking-part";

describe("ThinkingPart", () => {
  it("renders collapsed state by default for non-latest messages", () => {
    const html = renderToStaticMarkup(
      <ThinkingPart
        thinking="**Planning** First pass details"
        isLatest={false}
      />,
    );

    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("Planning");
  });

  it("renders expanded state for latest messages and strips duplicate title from body", () => {
    const html = renderToStaticMarkup(
      <ThinkingPart thinking="**Planning** First pass details" isLatest />,
    );

    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("Planning");
    expect(html).toContain("First pass details");
    expect(html).not.toContain("**Planning** First pass details");
  });
});
