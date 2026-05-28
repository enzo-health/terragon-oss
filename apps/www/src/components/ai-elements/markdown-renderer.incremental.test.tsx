/* @vitest-environment jsdom */

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const streamdownLog = vi.hoisted(() => ({
  parseInputs: [] as string[],
  staticChildren: [] as string[],
  streamingChildren: [] as string[],
}));

vi.mock("streamdown", async (importOriginal) => {
  const actual = await importOriginal<typeof import("streamdown")>();
  const react = await import("react");

  return {
    ...actual,
    parseMarkdownIntoBlocks: (content: string) => {
      streamdownLog.parseInputs.push(content);
      return actual.parseMarkdownIntoBlocks(content);
    },
    Streamdown: ({
      children,
      mode,
    }: {
      children?: React.ReactNode;
      mode?: string;
    }) => {
      const text = typeof children === "string" ? children : "";
      if (mode === "static") {
        streamdownLog.staticChildren.push(text);
      } else {
        streamdownLog.streamingChildren.push(text);
      }
      return react.createElement("div", { "data-mode": mode }, children);
    },
  };
});

import { MarkdownRenderer } from "./markdown-renderer";

const longParagraph = "This paragraph is safely complete. ".repeat(18);

describe("MarkdownRenderer incremental streaming segmentation", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    streamdownLog.parseInputs = [];
    streamdownLog.staticChildren = [];
    streamdownLog.streamingChildren = [];
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(content: string) {
    act(() => {
      root.render(<MarkdownRenderer content={content} streaming />);
    });
  }

  it("keeps stable markdown out of parse and render work during tail-only appends", () => {
    let content = `# Summary\n\n${longParagraph}\n\nStreaming tail`;
    const stablePrefix = `# Summary\n\n${longParagraph}\n\n`;
    render(content);

    for (let index = 0; index < 100; index += 1) {
      content = `${content} token`;
      render(content);
    }

    expect(streamdownLog.staticChildren).toEqual([stablePrefix]);
    expect(streamdownLog.streamingChildren.at(-1)?.endsWith(" token")).toBe(
      true,
    );
    expect(streamdownLog.parseInputs[0]).toBe(
      `# Summary\n\n${longParagraph}\n\nStreaming tail`,
    );
    for (const parsedInput of streamdownLog.parseInputs.slice(1)) {
      expect(parsedInput.startsWith(stablePrefix)).toBe(false);
    }
  });
});
