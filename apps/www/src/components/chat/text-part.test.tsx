import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TextPart } from "./text-part";

const markdownRendererSpy = vi.hoisted(() => vi.fn());

vi.mock("@/components/ai-elements/markdown-renderer", () => ({
  MarkdownRenderer: ({ content }: { content: string }) => {
    markdownRendererSpy(content);
    return <div data-testid="markdown">{content}</div>;
  },
}));

describe("TextPart", () => {
  it("renders plain streaming text without invoking markdown parsing", () => {
    markdownRendererSpy.mockClear();

    const html = renderToStaticMarkup(
      <TextPart
        text={"Streaming a normal sentence without markdown.\nStill plain."}
        streaming
      />,
    );

    expect(html).toContain("Streaming a normal sentence without markdown.");
    expect(html).toContain("whitespace-pre-wrap");
    expect(html).not.toContain('data-testid="markdown"');
    expect(markdownRendererSpy).not.toHaveBeenCalled();
  });

  it("uses markdown rendering when syntax is present", () => {
    markdownRendererSpy.mockClear();

    const html = renderToStaticMarkup(
      <TextPart text={"**Done**\n\n- item"} streaming />,
    );

    expect(html).toContain('data-testid="markdown"');
    expect(markdownRendererSpy).toHaveBeenCalledWith("**Done**\n\n- item");
  });

  it("keeps simple streaming progress lists on the cheap text path", () => {
    markdownRendererSpy.mockClear();

    const html = renderToStaticMarkup(
      <TextPart text={"1. Starting\n2. Still working"} streaming />,
    );

    expect(html).toContain("1. Starting");
    expect(html).toContain("whitespace-pre-wrap");
    expect(html).not.toContain('data-testid="markdown"');
    expect(markdownRendererSpy).not.toHaveBeenCalled();
  });

  it("renders simple progress lists as markdown after streaming completes", () => {
    markdownRendererSpy.mockClear();

    const html = renderToStaticMarkup(
      <TextPart text={"1. Starting\n2. Done"} streaming={false} />,
    );

    expect(html).toContain('data-testid="markdown"');
    expect(markdownRendererSpy).toHaveBeenCalledWith("1. Starting\n2. Done");
  });

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
