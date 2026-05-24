import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { shouldScanCodeBlocks, TextPart } from "./text-part";

const markdownRendererSpy = vi.hoisted(() => vi.fn());

vi.mock("@/components/ai-elements/markdown-renderer", () => ({
  MarkdownRenderer: ({
    content,
    streaming,
    streamingSegmentation,
    className,
  }: {
    content: string;
    streaming?: boolean;
    streamingSegmentation?: "auto" | "off";
    className?: string;
  }) => {
    markdownRendererSpy({
      className,
      content,
      streaming,
      streamingSegmentation,
    });
    return (
      <div data-streaming={String(streaming)} data-testid="markdown">
        {content}
      </div>
    );
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
    expect(markdownRendererSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "**Done**\n\n- item",
        streaming: true,
      }),
    );
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
    expect(markdownRendererSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "1. Starting\n2. Done",
        streaming: false,
      }),
    );
  });

  it("keeps inline code on the cheap text path while streaming", () => {
    markdownRendererSpy.mockClear();

    const html = renderToStaticMarkup(
      <TextPart text={"Then run `pwd` and keep going."} streaming />,
    );

    expect(html).toContain("Then run `pwd` and keep going.");
    expect(html).toContain("whitespace-pre-wrap");
    expect(html).not.toContain('data-testid="markdown"');
    expect(markdownRendererSpy).not.toHaveBeenCalled();
  });

  it("renders inline code as markdown after streaming completes", () => {
    markdownRendererSpy.mockClear();

    const html = renderToStaticMarkup(
      <TextPart text={"Then run `pwd` and stop."} streaming={false} />,
    );

    expect(html).toContain('data-testid="markdown"');
    expect(markdownRendererSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "Then run `pwd` and stop.",
        streaming: false,
      }),
    );
  });

  it("waits until streaming completes before scanning rendered code blocks", () => {
    expect(
      shouldScanCodeBlocks({ hasPossibleCodeBlock: true, streaming: true }),
    ).toBe(false);
    expect(
      shouldScanCodeBlocks({ hasPossibleCodeBlock: true, streaming: false }),
    ).toBe(true);
  });

  it("uses the canonical artifact workspace affordance for complete proposed_plan text", () => {
    markdownRendererSpy.mockClear();

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
    expect(markdownRendererSpy).not.toHaveBeenCalled();
  });

  it("keeps pure proposed_plan responses visible after artifact promotion", () => {
    markdownRendererSpy.mockClear();

    const html = renderToStaticMarkup(
      <TextPart
        text={"<proposed_plan>\n# Plan\n\n- Task one\n</proposed_plan>"}
        onOpenInArtifactWorkspace={() => undefined}
      />,
    );

    expect(html).toContain("Open plan artifact");
    expect(html).toContain('data-testid="markdown"');
    expect(markdownRendererSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "# Plan\n\n- Task one",
      }),
    );
  });

  it("disables streaming segmentation for incomplete proposed_plan streams", () => {
    markdownRendererSpy.mockClear();

    renderToStaticMarkup(
      <TextPart text={"Starting\n\n<proposed_plan>\n# Plan"} streaming />,
    );

    expect(markdownRendererSpy).toHaveBeenCalledWith(
      expect.objectContaining({ streamingSegmentation: "off" }),
    );
  });
});
