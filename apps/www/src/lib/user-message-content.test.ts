import { describe, expect, it } from "vitest";
import { agUiUserContentToDbParts } from "./user-message-content";

describe("agUiUserContentToDbParts", () => {
  it("converts string content to a DB rich-text part", () => {
    expect(agUiUserContentToDbParts("ship it")).toEqual({
      type: "ok",
      parts: [
        {
          type: "rich-text",
          nodes: [{ type: "text", text: "ship it" }],
        },
      ],
    });
  });

  it("converts text and data image content to DB parts", () => {
    expect(
      agUiUserContentToDbParts([
        { type: "text", text: "look" },
        {
          type: "image",
          source: {
            type: "data",
            value: "iVBORw0KGgo=",
            mimeType: "image/png",
          },
        },
      ]),
    ).toEqual({
      type: "ok",
      parts: [
        {
          type: "rich-text",
          nodes: [{ type: "text", text: "look" }],
        },
        {
          type: "image",
          image_url: "data:image/png;base64,iVBORw0KGgo=",
          mime_type: "image/png",
        },
      ],
    });
  });

  it("converts URL image content to a DB image part", () => {
    expect(
      agUiUserContentToDbParts([
        {
          type: "image",
          source: {
            type: "url",
            value: "https://example.com/image.png",
            mimeType: "image/png",
          },
        },
      ]),
    ).toEqual({
      type: "ok",
      parts: [
        {
          type: "image",
          image_url: "https://example.com/image.png",
          mime_type: "image/png",
        },
      ],
    });
  });

  it("rejects binary content instead of silently dropping it", () => {
    expect(
      agUiUserContentToDbParts([
        { type: "text", text: "read this" },
        {
          type: "binary",
          mimeType: "application/pdf",
          data: "JVBERi0xLjQ=",
        },
      ]),
    ).toEqual({
      type: "unsupported",
      reason: "AG-UI binary content is not accepted by follow-up command",
    });
  });
});
