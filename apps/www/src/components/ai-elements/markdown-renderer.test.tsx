/* @vitest-environment jsdom */

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

describe("MarkdownRenderer link interception", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function mount(content: string, onOpenFile?: (href: string) => void) {
    act(() => {
      root.render(
        <MarkdownRenderer content={content} onOpenFile={onOpenFile} />,
      );
    });
  }

  function clickFirstAnchor(): boolean {
    const anchor = container.querySelector("a");
    if (!anchor) throw new Error("expected a rendered anchor");
    const event = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
    });
    anchor.dispatchEvent(event);
    return event.defaultPrevented;
  }

  it("calls onOpenFile and prevents default for an in-repo file href", () => {
    // Streamdown's `rehype-harden` pass only lets path-relative hrefs
    // (`/`, `./`, `../`) reach the custom `a` renderer and rewrites them to a
    // workspace-root-absolute form; `classifyRepoFileLink` normalizes that.
    const onOpenFile = vi.fn();
    mount("See [config](./src/config.ts#L12-L34) for details.", onOpenFile);

    const defaultPrevented = clickFirstAnchor();

    expect(onOpenFile).toHaveBeenCalledTimes(1);
    expect(onOpenFile).toHaveBeenCalledWith("/src/config.ts#L12-L34");
    expect(defaultPrevented).toBe(true);
  });

  it("falls back to a new-tab anchor when onOpenFile is absent", () => {
    mount("See [config](./src/config.ts) for details.");

    const anchor = container.querySelector("a");
    expect(anchor?.getAttribute("target")).toBe("_blank");
    expect(anchor?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(clickFirstAnchor()).toBe(false);
  });

  it("keeps external hrefs as new-tab even when onOpenFile is provided", () => {
    const onOpenFile = vi.fn();
    mount("See [docs](https://example.com/page) for details.", onOpenFile);

    const anchor = container.querySelector("a");
    expect(anchor?.getAttribute("target")).toBe("_blank");
    expect(clickFirstAnchor()).toBe(false);
    expect(onOpenFile).not.toHaveBeenCalled();
  });

  it("keeps a rewritten github.com citation link as new-tab", () => {
    // convertCitationsToGitHubLinks rewrites 【F:...】 into an absolute
    // github.com blob URL. Those classify as external (https scheme), so they
    // intentionally keep new-tab behavior — coordinating citations with the
    // in-panel preview is a documented follow-up, not part of this slice.
    const onOpenFile = vi.fn();
    mount(
      "See [src/foo.ts:L1-L6](https://github.com/acme/repo/blob/main/src/foo.ts#L1-L6).",
      onOpenFile,
    );

    const anchor = container.querySelector("a");
    expect(anchor?.getAttribute("target")).toBe("_blank");
    expect(clickFirstAnchor()).toBe(false);
    expect(onOpenFile).not.toHaveBeenCalled();
  });
});
