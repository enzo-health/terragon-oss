import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownRenderer } from "./markdown-renderer";

describe("MarkdownRenderer code rendering", () => {
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
});
