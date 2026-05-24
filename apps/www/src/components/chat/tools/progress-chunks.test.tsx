import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProgressChunks } from "./progress-chunks";

const COLLAPSED_LIMIT = 3;

describe("ProgressChunks", () => {
  it("renders nothing for empty chunks", () => {
    const html = renderToStaticMarkup(<ProgressChunks chunks={[]} />);
    expect(html).toBe("");
  });

  it("renders chunk text", () => {
    const html = renderToStaticMarkup(
      <ProgressChunks
        chunks={[
          { seq: 0, text: "Reading file..." },
          { seq: 1, text: "Processing..." },
        ]}
      />,
    );
    expect(html).toContain("Reading file...");
    expect(html).toContain("Processing...");
  });

  it("shows collapse button when more than limit chunks", () => {
    const chunks = Array.from({ length: COLLAPSED_LIMIT + 2 }, (_, i) => ({
      seq: i,
      text: `chunk ${i}`,
    }));
    const html = renderToStaticMarkup(<ProgressChunks chunks={chunks} />);
    expect(html).toContain("Show 2 earlier retained updates");
    expect(html).not.toContain("chunk 0");
    expect(html).not.toContain("chunk 1");
    expect(html).toContain(`chunk ${COLLAPSED_LIMIT - 1}`);
    expect(html).toContain(`chunk ${COLLAPSED_LIMIT}`);
  });

  it("does not show collapse button when within limit", () => {
    const chunks = Array.from({ length: COLLAPSED_LIMIT }, (_, i) => ({
      seq: i,
      text: `chunk ${i}`,
    }));
    const html = renderToStaticMarkup(<ProgressChunks chunks={chunks} />);
    expect(html).not.toContain("more chunk");
  });

  it("distinguishes omitted progress from expandable retained progress", () => {
    const chunks = Array.from({ length: COLLAPSED_LIMIT + 1 }, (_, i) => ({
      seq: i,
      text: `chunk ${i}`,
    }));
    const html = renderToStaticMarkup(
      <ProgressChunks chunks={chunks} hiddenCount={50} />,
    );
    expect(html).toContain("50 older updates omitted");
    expect(html).toContain("Show 1 earlier retained update");
  });
});
