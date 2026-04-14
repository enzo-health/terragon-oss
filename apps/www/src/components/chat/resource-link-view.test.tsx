import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ResourceLinkView } from "./resource-link-view";
import type { DBResourceLinkPart } from "@terragon/shared";

function makePart(
  overrides: Partial<DBResourceLinkPart> = {},
): DBResourceLinkPart {
  return {
    type: "resource-link",
    uri: "https://example.com/doc.pdf",
    name: "doc.pdf",
    ...overrides,
  };
}

describe("ResourceLinkView", () => {
  it("renders clickable link with URI", () => {
    const html = renderToStaticMarkup(<ResourceLinkView part={makePart()} />);
    expect(html).toContain("https://example.com/doc.pdf");
    expect(html).toContain("<a");
  });

  it("renders title when provided", () => {
    const html = renderToStaticMarkup(
      <ResourceLinkView
        part={makePart({ title: "API Documentation", name: "api-docs" })}
      />,
    );
    expect(html).toContain("API Documentation");
  });

  it("renders description", () => {
    const html = renderToStaticMarkup(
      <ResourceLinkView
        part={makePart({ description: "Full API reference guide" })}
      />,
    );
    expect(html).toContain("Full API reference guide");
  });

  it("renders mimeType badge", () => {
    const html = renderToStaticMarkup(
      <ResourceLinkView part={makePart({ mimeType: "application/pdf" })} />,
    );
    expect(html).toContain("application/pdf");
  });

  it("renders size badge formatted", () => {
    const html = renderToStaticMarkup(
      <ResourceLinkView part={makePart({ size: 1024 })} />,
    );
    expect(html).toContain("1.0 KB");
  });
});
