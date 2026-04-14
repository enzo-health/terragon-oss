import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ImagePartView } from "./image-part-view";
import type { DBImagePart } from "@terragon/shared";

describe("ImagePartView", () => {
  it("renders an img tag with the image_url", () => {
    const part: DBImagePart = {
      type: "image",
      mime_type: "image/png",
      image_url: "https://example.com/test.png",
    };
    const html = renderToStaticMarkup(<ImagePartView part={part} />);
    expect(html).toContain("https://example.com/test.png");
    expect(html).toContain("<img");
  });

  it("renders a base64 data URL", () => {
    const part: DBImagePart = {
      type: "image",
      mime_type: "image/jpeg",
      image_url: "data:image/jpeg;base64,/9j/4AAQSkZJRg==",
    };
    const html = renderToStaticMarkup(<ImagePartView part={part} />);
    expect(html).toContain("data:image/jpeg;base64,");
  });
});
