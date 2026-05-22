/* @vitest-environment jsdom */

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalPartView } from "./terminal-part-view";
import type { DBTerminalPart } from "@terragon/shared";

function makePart(overrides: Partial<DBTerminalPart> = {}): DBTerminalPart {
  return {
    type: "terminal",
    sandboxId: "sandbox-abc123",
    terminalId: "term-1",
    chunks: [],
    ...overrides,
  };
}

function makeChunks(count: number): DBTerminalPart["chunks"] {
  return Array.from({ length: count }, (_, index) => ({
    streamSeq: index,
    kind: "stdout" as const,
    text: `line ${index}`,
  }));
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function mount(part: DBTerminalPart): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(<TerminalPartView part={part} />);
  });
}

function renderPart(part: DBTerminalPart): void {
  act(() => {
    root?.render(<TerminalPartView part={part} />);
  });
}

function terminalOutput(): HTMLElement {
  const output = container?.querySelector<HTMLElement>(
    '[data-testid="terminal-output"]',
  );
  if (!output) {
    throw new Error("Expected terminal output element");
  }
  return output;
}

function defineScrollMetrics(
  element: HTMLElement,
  metrics: {
    scrollHeight: number;
    clientHeight: number;
    scrollTop: number;
  },
): void {
  Object.defineProperties(element, {
    scrollHeight: {
      configurable: true,
      value: metrics.scrollHeight,
    },
    clientHeight: {
      configurable: true,
      value: metrics.clientHeight,
    },
    scrollTop: {
      configurable: true,
      writable: true,
      value: metrics.scrollTop,
    },
  });
}

describe("TerminalPartView", () => {
  beforeEach(() => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 0;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
      root = null;
    }
    container?.remove();
    container = null;
    vi.restoreAllMocks();
  });

  it("renders chunks with correct kind styling", () => {
    const part = makePart({
      chunks: [
        { streamSeq: 0, kind: "stdout", text: "Hello, stdout!" },
        { streamSeq: 1, kind: "stderr", text: "Error occurred" },
        { streamSeq: 2, kind: "interaction", text: "User input" },
      ],
    });
    const html = renderToStaticMarkup(<TerminalPartView part={part} />);

    expect(html).toContain("Hello, stdout!");
    expect(html).toContain("Error occurred");
    expect(html).toContain("User input");

    // Each chunk has correct data-kind attribute
    expect(html).toContain('data-kind="stdout"');
    expect(html).toContain('data-kind="stderr"');
    expect(html).toContain('data-kind="interaction"');
  });

  it("renders stderr with red styling class", () => {
    const part = makePart({
      chunks: [{ streamSeq: 0, kind: "stderr", text: "fatal error" }],
    });
    const html = renderToStaticMarkup(<TerminalPartView part={part} />);
    expect(html).toContain("text-error");
  });

  it("renders interaction with blue styling class", () => {
    const part = makePart({
      chunks: [{ streamSeq: 0, kind: "interaction", text: "yes" }],
    });
    const html = renderToStaticMarkup(<TerminalPartView part={part} />);
    expect(html).toContain("text-coral");
  });

  it("shows empty state when no chunks", () => {
    const html = renderToStaticMarkup(<TerminalPartView part={makePart()} />);
    expect(html).toContain("No output");
  });

  it("renders only the latest terminal chunks by default", () => {
    const chunks = makeChunks(170);
    const html = renderToStaticMarkup(
      <TerminalPartView part={makePart({ chunks })} />,
    );

    expect(html).toContain("Show 10 earlier lines");
    expect(html).not.toContain("line 0");
    expect(html).toContain("line 169");
  });

  it("sticks to the latest output when already near the bottom", () => {
    mount(makePart({ chunks: makeChunks(1) }));
    const output = terminalOutput();
    defineScrollMetrics(output, {
      scrollHeight: 500,
      clientHeight: 240,
      scrollTop: 255,
    });

    renderPart(makePart({ chunks: makeChunks(2) }));

    expect(output.scrollTop).toBe(500);
  });

  it("does not force-scroll when the user is reading older output", () => {
    mount(makePart({ chunks: makeChunks(1) }));
    const output = terminalOutput();
    defineScrollMetrics(output, {
      scrollHeight: 500,
      clientHeight: 240,
      scrollTop: 100,
    });

    renderPart(makePart({ chunks: makeChunks(2) }));

    expect(output.scrollTop).toBe(100);
  });
});
