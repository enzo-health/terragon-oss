import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  MarkdownRenderer,
  splitStreamingMarkdownContent,
} from "./markdown-renderer";

describe("MarkdownRenderer code rendering", () => {
  const longParagraph = "This paragraph is safely complete. ".repeat(18);

  it("renders fenced code as a code block container with copy action", () => {
    const html = renderToStaticMarkup(
      <MarkdownRenderer
        content={"```ts\nconst value = 42;\nconsole.log(value)\n```"}
        controls={{ code: true }}
      />,
    );

    expect(html).toContain("<pre");
    expect(html).toContain("<code");
    expect(html).toContain('aria-label="Copy code"');
    expect(html).toContain("const value = 42;");
  });

  it("keeps inline code styled as inline code without block wrapper", () => {
    const html = renderToStaticMarkup(
      <MarkdownRenderer content={"Use `pnpm lint` before pushing."} />,
    );

    expect(html).not.toContain("<pre");
    expect(html).toContain("bg-muted");
    expect(html).toContain("pnpm lint");
  });

  it("splits long streaming markdown by Streamdown block boundaries", () => {
    const content = `# Summary\n\n${longParagraph}\n\n## Live\n\nStill streaming`;

    expect(splitStreamingMarkdownContent(content)).toEqual({
      stablePrefix: `# Summary\n\n${longParagraph}\n\n## Live\n\n`,
      liveTail: "Still streaming",
    });
  });

  it("keeps open code fences in the live tail with the fence opener", () => {
    const content = `# Summary\n\n${longParagraph}\n\n\`\`\`ts\nconst value =`;

    expect(splitStreamingMarkdownContent(content)).toEqual({
      stablePrefix: `# Summary\n\n${longParagraph}\n\n`,
      liveTail: "```ts\nconst value =",
    });
  });

  it("keeps loose lists together as the live tail", () => {
    const content = `# Summary\n\n${longParagraph}\n\n- first\n\n- second`;

    expect(splitStreamingMarkdownContent(content)).toEqual({
      stablePrefix: `# Summary\n\n${longParagraph}\n\n`,
      liveTail: "- first\n\n- second",
    });
  });

  it("keeps tables together as the live tail", () => {
    const content = `# Summary\n\n${longParagraph}\n\n| A | B |\n|---|---|\n| 1 | 2 |`;

    expect(splitStreamingMarkdownContent(content)).toEqual({
      stablePrefix: `# Summary\n\n${longParagraph}\n\n`,
      liveTail: "| A | B |\n|---|---|\n| 1 | 2 |",
    });
  });

  it("does not split raw html or reference-style markdown", () => {
    expect(
      splitStreamingMarkdownContent(
        `# Summary\n\n${longParagraph}\n\n<details>\nmore`,
      ),
    ).toBeNull();
    expect(
      splitStreamingMarkdownContent(
        `# Summary\n\n${longParagraph}\n\n[docs]: https://example.com`,
      ),
    ).toBeNull();
  });

  it("renders segmented streaming markdown as static prefix plus live tail", () => {
    const content = `# Summary\n\n${longParagraph}\n\nStill streaming`;

    const html = renderToStaticMarkup(
      <MarkdownRenderer content={content} streaming />,
    );

    expect(html).toContain("[&amp;&gt;*:last-child]:mb-2");
    expect(html).toContain("Still streaming");
  });
});
