/* @vitest-environment jsdom */

import type { UIRepoFilePart } from "@terragon/shared";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Stub the lazy Pierre renderer and the streamdown markdown renderer so the
// component renders deterministically. Each stub records the props it was
// called with so the rendered-vs-source switch and the line-range annotation
// wiring can be asserted without pulling in @pierre/diffs or streamdown.
vi.mock("@/components/shared/diff-view", () => ({
  createNoChangePatch: (filePath: string, contents: string) =>
    `PATCH ${filePath}\n${contents}`,
  HighlightedDiffView: ({
    patch,
    renderAnnotation,
    lineAnnotations,
  }: {
    patch: string;
    renderAnnotation?: (annotation: {
      side: "deletions";
      lineNumber: number;
      metadata?: { lineRange: { start: number; end: number } };
    }) => React.ReactNode;
    lineAnnotations?: Array<{
      side: "deletions";
      lineNumber: number;
      metadata: { lineRange: { start: number; end: number } };
    }>;
  }) => (
    <div data-testid="pierre-source">
      {patch}
      {lineAnnotations?.map((annotation, index) => (
        <div data-testid="pierre-annotation" key={index}>
          {renderAnnotation?.(annotation)}
        </div>
      ))}
    </div>
  ),
}));

vi.mock("@/components/ai-elements/markdown-renderer", () => ({
  MarkdownRenderer: ({ content }: { content: string }) => (
    <div data-testid="rendered-markdown">{content}</div>
  ),
}));

const getRepoFileContentAction = vi.fn();
vi.mock("@/server-actions/get-repo-file-content", () => ({
  getRepoFileContentAction: (...args: unknown[]) =>
    getRepoFileContentAction(...args),
}));

import { RepoFileArtifactRenderer } from "./secondary-panel-repo-file";

function renderPart(part: UIRepoFilePart) {
  return renderToStaticMarkup(
    <RepoFileArtifactRenderer repoFilePart={part} threadId="thread-1" />,
  );
}

describe("RepoFileArtifactRenderer file-type branch", () => {
  it("shows the rendered/source toggle for markdown files", () => {
    const html = renderPart({ type: "repo-file", path: "docs/README.md" });
    expect(html).toContain("Rendered");
    expect(html).toContain("Source");
    expect(html).toContain('aria-label="Markdown view mode"');
  });

  it("treats .MDX (case-insensitive) as markdown", () => {
    const html = renderPart({ type: "repo-file", path: "docs/Guide.MDX" });
    expect(html).toContain('aria-label="Markdown view mode"');
  });

  it("omits the toggle for non-markdown source files", () => {
    const html = renderPart({ type: "repo-file", path: "src/config.ts" });
    expect(html).not.toContain('aria-label="Markdown view mode"');
    expect(html).not.toContain("Rendered");
  });

  it("renders the line range in the header when present", () => {
    const html = renderPart({
      type: "repo-file",
      path: "src/config.ts",
      lineRange: { start: 12, end: 34 },
    });
    expect(html).toContain("Lines 12–34");
  });

  it("renders a single line label when start equals end", () => {
    const html = renderPart({
      type: "repo-file",
      path: "src/config.ts",
      lineRange: { start: 7, end: 7 },
    });
    expect(html).toContain("Line 7");
  });
});

describe("RepoFileArtifactRenderer content + fetch flow", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    getRepoFileContentAction.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function mount(
    part: UIRepoFilePart,
    threadId: string | null = "thread-1",
  ) {
    await act(async () => {
      root.render(
        <RepoFileArtifactRenderer
          repoFilePart={part}
          threadId={threadId ?? undefined}
        />,
      );
    });
    // Flush the load() microtasks queued by the effect.
    await act(async () => {
      await Promise.resolve();
    });
  }

  it("renders source via the Pierre view for non-markdown files", async () => {
    getRepoFileContentAction.mockResolvedValue({
      success: true,
      data: {
        status: "ready",
        content: "export const x = 1;",
        path: "src/config.ts",
        ref: "feature",
      },
    });

    await mount({ type: "repo-file", path: "src/config.ts" });

    const source = container.querySelector('[data-testid="pierre-source"]');
    expect(source?.textContent).toContain("export const x = 1;");
    expect(
      container.querySelector('[data-testid="rendered-markdown"]'),
    ).toBeNull();
  });

  it("renders markdown content in the rendered view by default", async () => {
    getRepoFileContentAction.mockResolvedValue({
      success: true,
      data: {
        status: "ready",
        content: "# Title",
        path: "docs/README.md",
        ref: "feature",
      },
    });

    await mount({ type: "repo-file", path: "docs/README.md" });

    const rendered = container.querySelector(
      '[data-testid="rendered-markdown"]',
    );
    expect(rendered?.textContent).toBe("# Title");
    expect(container.querySelector('[data-testid="pierre-source"]')).toBeNull();
  });

  it("renders the line-range highlight annotation in the source view", async () => {
    getRepoFileContentAction.mockResolvedValue({
      success: true,
      data: {
        status: "ready",
        content: "a\nb\nc\nd",
        path: "src/config.ts",
        ref: "feature",
      },
    });

    await mount({
      type: "repo-file",
      path: "src/config.ts",
      lineRange: { start: 2, end: 3 },
    });

    const annotation = container.querySelector(
      '[data-testid="pierre-annotation"]',
    );
    expect(annotation?.textContent).toContain("Lines 2–3");
  });

  it("maps the not-found error category to the not-yet-pushed message", async () => {
    getRepoFileContentAction.mockResolvedValue({
      success: true,
      data: { status: "error", category: "not-found" },
    });

    await mount({ type: "repo-file", path: "src/config.ts" });

    expect(container.textContent).toContain("Preview unavailable");
    expect(container.textContent).toContain(
      "not yet committed and pushed to the branch",
    );
  });

  it("maps the too-large error category to its message", async () => {
    getRepoFileContentAction.mockResolvedValue({
      success: true,
      data: { status: "error", category: "too-large" },
    });

    await mount({ type: "repo-file", path: "src/config.ts" });

    expect(container.textContent).toContain("too large to preview");
  });

  it("surfaces the action-level error message when the action fails", async () => {
    getRepoFileContentAction.mockResolvedValue({
      success: false,
      errorMessage: "Boom",
    });

    await mount({ type: "repo-file", path: "src/config.ts" });

    expect(container.textContent).toContain("Boom");
  });

  it("errors without fetching when threadId is missing", async () => {
    await mount({ type: "repo-file", path: "src/config.ts" }, null);

    expect(getRepoFileContentAction).not.toHaveBeenCalled();
    expect(container.textContent).toContain(
      "A thread is required to preview repo files.",
    );
  });

  it("renders a clickable directory listing and opens an entry on click", async () => {
    getRepoFileContentAction.mockResolvedValue({
      success: true,
      data: {
        status: "directory",
        path: "src/web",
        ref: "feature",
        entries: [
          { type: "dir", name: "routers", path: "src/web/routers" },
          { type: "file", name: "index.ts", path: "src/web/index.ts" },
        ],
      },
    });
    const onOpenRepoFile = vi.fn();

    await act(async () => {
      root.render(
        <RepoFileArtifactRenderer
          repoFilePart={{ type: "repo-file", path: "src/web" }}
          threadId="thread-1"
          onOpenRepoFile={onOpenRepoFile}
        />,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    const buttons = Array.from(container.querySelectorAll("button"));
    const labels = buttons.map((b) => b.textContent?.trim());
    // Parent (..), the directory, then the file, in that order.
    expect(labels).toEqual(["..", "routers", "index.ts"]);

    const routersButton = buttons.find((b) =>
      b.textContent?.includes("routers"),
    );
    await act(async () => {
      routersButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onOpenRepoFile).toHaveBeenCalledWith("src/web/routers");

    const upButton = buttons[0];
    await act(async () => {
      upButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    // ".." resolves to the repo-relative parent of src/web.
    expect(onOpenRepoFile).toHaveBeenCalledWith("src");
  });

  it("omits the up-one entry for a top-level directory", async () => {
    getRepoFileContentAction.mockResolvedValue({
      success: true,
      data: {
        status: "directory",
        path: "apps",
        ref: "feature",
        entries: [{ type: "dir", name: "www", path: "apps/www" }],
      },
    });

    await act(async () => {
      root.render(
        <RepoFileArtifactRenderer
          repoFilePart={{ type: "repo-file", path: "apps" }}
          threadId="thread-1"
          onOpenRepoFile={vi.fn()}
        />,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    const labels = Array.from(container.querySelectorAll("button")).map((b) =>
      b.textContent?.trim(),
    );
    expect(labels).toEqual(["www"]);
  });

  it("ignores a resolved result after the component unmounts (abort)", async () => {
    let resolve: ((value: unknown) => void) | undefined;
    getRepoFileContentAction.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );

    await act(async () => {
      root.render(
        <RepoFileArtifactRenderer
          repoFilePart={{ type: "repo-file", path: "src/config.ts" }}
          threadId="thread-1"
        />,
      );
    });

    // Unmount before the fetch resolves, then resolve. No state update should
    // be applied to the unmounted tree (the AbortController guard short-circuits).
    act(() => root.unmount());
    await act(async () => {
      resolve?.({
        success: true,
        data: {
          status: "ready",
          content: "late",
          path: "src/config.ts",
          ref: "feature",
        },
      });
      await Promise.resolve();
    });

    expect(container.textContent).not.toContain("late");
  });
});
