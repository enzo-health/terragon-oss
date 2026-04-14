import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DiffPartView } from "./diff-part";
import type { DBDiffPart } from "@terragon/shared";

function makePart(overrides: Partial<DBDiffPart> = {}): DBDiffPart {
  return {
    type: "diff",
    filePath: "src/app/page.tsx",
    newContent: "const x = 1;\n",
    status: "pending",
    ...overrides,
  };
}

describe("DiffPartView", () => {
  it("renders pending status badge", () => {
    const html = renderToStaticMarkup(
      <DiffPartView part={makePart({ status: "pending" })} />,
    );
    expect(html).toContain('data-status="pending"');
    expect(html).toContain("Pending");
  });

  it("renders applied status badge", () => {
    const html = renderToStaticMarkup(
      <DiffPartView part={makePart({ status: "applied" })} />,
    );
    expect(html).toContain('data-status="applied"');
    expect(html).toContain("Applied");
  });

  it("renders rejected status badge", () => {
    const html = renderToStaticMarkup(
      <DiffPartView part={makePart({ status: "rejected" })} />,
    );
    expect(html).toContain('data-status="rejected"');
    expect(html).toContain("Rejected");
  });

  it("renders file path", () => {
    const html = renderToStaticMarkup(
      <DiffPartView part={makePart({ filePath: "src/foo/bar.ts" })} />,
    );
    expect(html).toContain("src/foo/bar.ts");
  });

  it("renders accept/reject buttons only for pending when handlers provided", () => {
    const pending = renderToStaticMarkup(
      <DiffPartView
        part={makePart({ status: "pending" })}
        onAccept={() => {}}
        onReject={() => {}}
      />,
    );
    expect(pending).toContain("Accept");
    expect(pending).toContain("Reject");

    const applied = renderToStaticMarkup(
      <DiffPartView
        part={makePart({ status: "applied" })}
        onAccept={() => {}}
        onReject={() => {}}
      />,
    );
    expect(applied).not.toContain("Accept");
    expect(applied).not.toContain("Reject");
  });
});
