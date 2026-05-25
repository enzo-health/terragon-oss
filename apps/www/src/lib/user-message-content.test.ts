import { describe, expect, it } from "vitest";
import {
  agUiUserContentToDbParts,
  dbUserMessageHasUnsupportedAssistantContent,
  dbUserPartsToAssistantContent,
} from "./user-message-content";

describe("dbUserPartsToAssistantContent", () => {
  it("converts supported DB user parts to assistant-ui user content", () => {
    expect(
      dbUserPartsToAssistantContent([
        { type: "text", text: "plain" },
        { type: "rich-text", nodes: [{ type: "text", text: "hello" }] },
        { type: "rich-text", nodes: [{ type: "mention", text: "src/app.ts" }] },
        {
          type: "image",
          mime_type: "image/png",
          image_url: "https://example.com/image.png",
        },
      ]),
    ).toEqual([
      { type: "text", text: "plain" },
      { type: "text", text: "hello" },
      { type: "text", text: "@src/app.ts" },
      { type: "image", image: "https://example.com/image.png" },
    ]);
  });
});

describe("dbUserMessageHasUnsupportedAssistantContent", () => {
  it("treats pdf and text-file parts as unsupported for runtime append", () => {
    expect(
      dbUserMessageHasUnsupportedAssistantContent({
        type: "user",
        model: null,
        parts: [
          { type: "rich-text", nodes: [{ type: "text", text: "read this" }] },
          {
            type: "text-file",
            mime_type: "text/plain",
            file_url: "https://example.com/file.txt",
            filename: "file.txt",
          },
        ],
      }),
    ).toBe(true);
  });
});

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

  it("round-trips DB URL images through assistant-ui and AG-UI content", () => {
    const assistantContent = dbUserPartsToAssistantContent([
      {
        type: "image",
        image_url: "https://example.com/image.png",
        mime_type: "image/png",
      },
    ]);

    expect(assistantContent).toEqual([
      { type: "image", image: "https://example.com/image.png" },
    ]);
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
