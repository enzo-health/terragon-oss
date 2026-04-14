import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
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

describe("TerminalPartView", () => {
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
    expect(html).toContain("text-red-400");
  });

  it("renders interaction with blue styling class", () => {
    const part = makePart({
      chunks: [{ streamSeq: 0, kind: "interaction", text: "yes" }],
    });
    const html = renderToStaticMarkup(<TerminalPartView part={part} />);
    expect(html).toContain("text-blue-400");
  });

  it("shows empty state when no chunks", () => {
    const html = renderToStaticMarkup(<TerminalPartView part={makePart()} />);
    expect(html).toContain("No output");
  });
});
