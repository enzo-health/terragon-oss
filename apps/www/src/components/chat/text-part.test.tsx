import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TextPart } from "./text-part";

vi.mock("@/components/ai-elements/markdown-renderer", () => ({
  MarkdownRenderer: ({ content }: { content: string }) => (
    <div data-testid="markdown">{content}</div>
  ),
}));

describe("TextPart", () => {
  it("uses the canonical artifact workspace affordance for complete proposed_plan text", () => {
    const html = renderToStaticMarkup(
      <TextPart
        text={
          "Here is the plan.\n<proposed_plan>\n# Plan\n\n- Task one\n</proposed_plan>\nReady."
        }
        onOpenInArtifactWorkspace={() => undefined}
      />,
    );

    expect(html).toContain("Open plan artifact");
    expect(html).toContain("Here is the plan.");
    expect(html).toContain("Ready.");
    expect(html).not.toContain("proposed_plan");
  });
});
