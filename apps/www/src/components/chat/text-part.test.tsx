/* @vitest-environment jsdom */

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  detectMarkdownSyntax,
  processTextForRendering,
  shouldScanCodeBlocks,
  TextPart,
} from "./text-part";

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

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function renderClient(element: React.ReactElement): void {
  if (!container) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }
  act(() => {
    root!.render(element);
  });
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  markdownRendererSpy.mockClear();
});

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

  it("keeps append-only plain streams on the non-markdown path", () => {
    const first = detectMarkdownSyntax({
      text: "Writing a long plain sentence",
      streaming: true,
      previous: null,
    });
    const second = detectMarkdownSyntax({
      text: `${first.text} with more ordinary words and no formatting.`,
      streaming: true,
      previous: first,
    });

    expect(first.hasMarkdownSyntax).toBe(false);
    expect(second.hasMarkdownSyntax).toBe(false);
  });

  it("uses incremental processing for plain streaming appends", () => {
    const first = processTextForRendering({
      text: "Writing a normal streaming sentence",
      streaming: true,
      previous: null,
      context: { hasArtifactWorkspace: false },
    });
    const second = processTextForRendering({
      text: `${first.text} with more ordinary words.`,
      streaming: true,
      previous: first,
      context: { hasArtifactWorkspace: false },
    });

    expect(first.usedIncrementalAppend).toBe(false);
    expect(second.usedIncrementalAppend).toBe(true);
    expect(second.processedText).toBe(
      "Writing a normal streaming sentence with more ordinary words.",
    );
  });

  it("keeps appending incrementally after an early converted file citation", () => {
    const first = processTextForRendering({
      text: "See 【F:src/foo.ts†L1】 for the entry point.",
      streaming: true,
      previous: null,
      context: {
        githubRepoFullName: "acme/app",
        baseBranchName: "main",
        hasArtifactWorkspace: false,
      },
    });
    const second = processTextForRendering({
      text: `${first.text} More ordinary streaming text follows.`,
      streaming: true,
      previous: first,
      context: {
        githubRepoFullName: "acme/app",
        baseBranchName: "main",
        hasArtifactWorkspace: false,
      },
    });

    expect(first.usedIncrementalAppend).toBe(false);
    expect(first.processedText).toContain(
      "[src/foo.ts:L1](https://github.com/acme/app/blob/main/src/foo.ts#L1)",
    );
    expect(second.usedIncrementalAppend).toBe(true);
    expect(second.processedText).toContain(
      "[src/foo.ts:L1](https://github.com/acme/app/blob/main/src/foo.ts#L1)",
    );
    expect(second.processedText).toContain(
      "More ordinary streaming text follows.",
    );
  });

  it("falls back to full processing when a streaming append introduces markdown", () => {
    const first = processTextForRendering({
      text: "Writing a normal streaming sentence",
      streaming: true,
      previous: null,
      context: { hasArtifactWorkspace: false },
    });
    const second = processTextForRendering({
      text: `${first.text}\n\n**Done**`,
      streaming: true,
      previous: first,
      context: { hasArtifactWorkspace: false },
    });

    expect(second.usedIncrementalAppend).toBe(false);
  });

  it("continues incomplete proposed_plan streams with incremental appends", () => {
    const first = processTextForRendering({
      text: "Starting\n\n<proposed_plan>\n# Plan",
      streaming: true,
      previous: null,
      context: { hasArtifactWorkspace: true },
    });
    const second = processTextForRendering({
      text: `${first.text}\n\n- Task one`,
      streaming: true,
      previous: first,
      context: { hasArtifactWorkspace: true },
    });

    expect(first.hasProposedPlanStart).toBe(true);
    expect(first.hasCompleteProposedPlan).toBe(false);
    expect(second.usedIncrementalAppend).toBe(true);
    expect(second.hasProposedPlanStart).toBe(true);
    expect(second.hasCompleteProposedPlan).toBe(false);
  });

  it("detects proposed_plan close tags split across append boundaries", () => {
    const first = processTextForRendering({
      text: "<proposed_plan>\n# Plan\n</proposed",
      streaming: true,
      previous: null,
      context: { hasArtifactWorkspace: true },
    });
    const second = processTextForRendering({
      text: `${first.text}_plan>`,
      streaming: true,
      previous: first,
      context: { hasArtifactWorkspace: true },
    });

    expect(second.usedIncrementalAppend).toBe(false);
    expect(second.hasCompleteProposedPlan).toBe(true);
    expect(second.processedText).toBe("# Plan");
  });

  it("falls back to full processing for citation markers split inside proposed_plan", () => {
    const first = processTextForRendering({
      text: "<proposed_plan>\nSee 【F",
      streaming: true,
      previous: null,
      context: {
        githubRepoFullName: "acme/app",
        baseBranchName: "main",
        hasArtifactWorkspace: true,
      },
    });
    const second = processTextForRendering({
      text: `${first.text}:src/foo.ts†L1】`,
      streaming: true,
      previous: first,
      context: {
        githubRepoFullName: "acme/app",
        baseBranchName: "main",
        hasArtifactWorkspace: true,
      },
    });

    expect(second.usedIncrementalAppend).toBe(false);
    expect(second.processedText).toContain(
      "[src/foo.ts:L1](https://github.com/acme/app/blob/main/src/foo.ts#L1)",
    );
  });

  it("keeps incomplete proposed_plan appends on the plain streaming path", () => {
    markdownRendererSpy.mockClear();

    renderClient(
      <TextPart text={"Starting\n\n<proposed_plan>\n# Plan"} streaming />,
    );
    renderClient(
      <TextPart
        text={"Starting\n\n<proposed_plan>\n# Plan\n\n- Task one"}
        streaming
      />,
    );

    expect(container?.textContent).toContain("Starting");
    expect(container?.textContent).toContain("# Plan");
    expect(container?.textContent).toContain("- Task one");
    expect(container?.textContent).not.toContain("proposed_plan");
    expect(markdownRendererSpy).not.toHaveBeenCalled();
  });

  it("promotes completed proposed_plan streams without leaking raw tags", () => {
    markdownRendererSpy.mockClear();

    renderClient(
      <TextPart
        text={"<proposed_plan>\nPlain"}
        streaming
        onOpenInArtifactWorkspace={() => undefined}
      />,
    );
    renderClient(
      <TextPart
        text={"<proposed_plan>\nPlain body</proposed_plan>"}
        streaming
        onOpenInArtifactWorkspace={() => undefined}
      />,
    );

    expect(container?.textContent).toContain("Open plan artifact");
    expect(container?.textContent).toContain("Plain body");
    expect(container?.textContent).not.toContain("proposed_plan");
  });

  it("detects streaming markdown that appears across an append boundary", () => {
    const first = detectMarkdownSyntax({
      text: "Preparing [artifact link",
      streaming: true,
      previous: null,
    });
    const second = detectMarkdownSyntax({
      text: `${first.text}](artifact://plan)`,
      streaming: true,
      previous: first,
    });

    expect(first.hasMarkdownSyntax).toBe(false);
    expect(second.hasMarkdownSyntax).toBe(true);
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

  it("does not markdown-parse markdown-heavy incomplete proposed_plan streams", () => {
    markdownRendererSpy.mockClear();

    const planBody = Array.from(
      { length: 80 },
      (_, index) =>
        `- [ ] Task ${index}: inspect \`src/file-${index}.ts\` and **verify**`,
    ).join("\n");

    const html = renderToStaticMarkup(
      <TextPart
        text={`Starting\n\n<proposed_plan>\n# Plan\n${planBody}`}
        streaming
      />,
    );

    expect(html).toContain("# Plan");
    expect(html).toContain("Task 79");
    expect(html).not.toContain("proposed_plan");
    expect(markdownRendererSpy).not.toHaveBeenCalled();
  });
});
