import { describe, it, expect } from "vitest";
import {
  tiptapToRichText,
  richTextToPlainText,
  richTextToTiptap,
} from "./tiptap-to-richtext";
import type { DBRichTextPart } from "@leo/shared";

describe("tiptapToRichText", () => {
  it("should convert TipTap JSON with mentions, links, and text to rich text", () => {
    const input = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "mention",
              attrs: {
                id: "src/app/page.tsx",
                label: "src/app/page.tsx",
              },
            },
            {
              type: "text",
              text: " ",
            },
            {
              type: "text",
              marks: [
                {
                  type: "link",
                  attrs: {
                    href: "https://google.com",
                    target: "_blank",
                    rel: "noopener noreferrer nofollow",
                    class: "text-blue-600 underline hover:text-blue-800",
                  },
                },
              ],
              text: "https://google.com",
            },
            {
              type: "text",
              text: " ",
            },
            {
              type: "hardBreak",
            },
            {
              type: "hardBreak",
            },
            {
              type: "text",
              text: "Very cool",
            },
            {
              type: "hardBreak",
            },
            {
              type: "hardBreak",
            },
            {
              type: "text",
              text: "Ultra nice",
            },
          ],
        },
      ],
    };

    const expected: DBRichTextPart = {
      type: "rich-text",
      nodes: [
        { type: "mention", text: "src/app/page.tsx" },
        { type: "text", text: " " },
        { type: "link", text: "https://google.com" },
        { type: "text", text: " " },
        { type: "text", text: "\n" },
        { type: "text", text: "\n" },
        { type: "text", text: "Very cool" },
        { type: "text", text: "\n" },
        { type: "text", text: "\n" },
        { type: "text", text: "Ultra nice" },
      ],
    };
    const result = tiptapToRichText(input);
    expect(result).toEqual(expected);
  });

  it("should handle empty document", () => {
    const input = {
      type: "doc",
      content: [],
    };
    expect(tiptapToRichText(input)).toEqual({
      type: "rich-text",
      nodes: [],
    });
  });

  it("should handle multiple paragraphs", () => {
    const input = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "First paragraph",
            },
          ],
        },
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "Second paragraph",
            },
          ],
        },
      ],
    };
    expect(tiptapToRichText(input)).toEqual({
      type: "rich-text",
      nodes: [
        { type: "text", text: "First paragraph" },
        { type: "text", text: "\n" },
        { type: "text", text: "Second paragraph" },
      ],
    });
  });
});

describe("richTextToPlainText", () => {
  it("should convert DBRichTextPart with mentions, links, and text to plain text", () => {
    const input: DBRichTextPart = {
      type: "rich-text",
      nodes: [
        { type: "mention", text: "src/app/page.tsx" },
        { type: "text", text: " " },
        { type: "link", text: "https://google.com" },
        { type: "text", text: " " },
        { type: "text", text: "\n" },
        { type: "text", text: "\n" },
        { type: "text", text: "Very cool" },
        { type: "text", text: "\n" },
        { type: "text", text: "\n" },
        { type: "text", text: "Ultra nice" },
      ],
    };

    const expected =
      "@src/app/page.tsx https://google.com \n\nVery cool\n\nUltra nice";
    const result = richTextToPlainText(input);
    expect(result).toBe(expected);
  });

  it("should handle empty nodes", () => {
    const input: DBRichTextPart = {
      type: "rich-text",
      nodes: [],
    };
    expect(richTextToPlainText(input)).toBe("");
  });

  it("should handle single node", () => {
    const input: DBRichTextPart = {
      type: "rich-text",
      nodes: [{ type: "text", text: "Hello world" }],
    };
    expect(richTextToPlainText(input)).toBe("Hello world");
  });

  it("should handle mixed node types", () => {
    const input: DBRichTextPart = {
      type: "rich-text",
      nodes: [
        { type: "text", text: "Check out " },
        { type: "link", text: "this link" },
        { type: "text", text: " and " },
        { type: "mention", text: "@user" },
        { type: "text", text: " for more info" },
      ],
    };
    expect(richTextToPlainText(input)).toBe(
      "Check out this link and @@user for more info",
    );
  });

  it("should handle unsupported node types by including their text content", () => {
    const input = {
      type: "doc",
      content: [
        {
          type: "blockquote",
          content: [
            {
              type: "paragraph",
              content: [
                {
                  type: "text",
                  text: "This is a quote",
                },
              ],
            },
          ],
        },
        {
          type: "heading",
          attrs: { level: 1 },
          content: [
            {
              type: "text",
              text: "This is a heading",
            },
          ],
        },
        {
          type: "codeBlock",
          attrs: { language: "javascript" },
          content: [
            {
              type: "text",
              text: "const x = 1;",
            },
          ],
        },
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [
                    {
                      type: "text",
                      text: "Item 1",
                    },
                  ],
                },
              ],
            },
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [
                    {
                      type: "text",
                      text: "Item 2",
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          type: "orderedList",
          attrs: { start: 1 },
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [
                    {
                      type: "text",
                      text: "First item",
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          type: "horizontalRule",
        },
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "After HR",
            },
          ],
        },
      ],
    };

    const result = tiptapToRichText(input);

    // Now all content should be preserved as text nodes
    expect(result).toEqual({
      type: "rich-text",
      nodes: [
        // blockquote content
        { type: "text", text: "This is a quote" },
        { type: "text", text: "\n" },
        // heading content
        { type: "text", text: "This is a heading" },
        { type: "text", text: "\n" },
        // codeBlock content
        { type: "text", text: "const x = 1;" },
        { type: "text", text: "\n" },
        // bulletList content
        { type: "text", text: "Item 1" },
        { type: "text", text: "\n" },
        { type: "text", text: "Item 2" },
        { type: "text", text: "\n" },
        // orderedList content
        { type: "text", text: "First item" },
        // No newline after orderedList because horizontalRule follows
        // horizontalRule has no content
        // No newline before paragraph because horizontalRule precedes it
        { type: "text", text: "After HR" },
      ],
    });
  });

  it("should preserve link and mention nodes while converting other nodes to text", () => {
    const input = {
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 1 },
          content: [
            {
              type: "text",
              text: "Check out ",
            },
            {
              type: "text",
              marks: [
                {
                  type: "link",
                  attrs: {
                    href: "https://example.com",
                  },
                },
              ],
              text: "this link",
            },
            {
              type: "text",
              text: " and ",
            },
            {
              type: "mention",
              attrs: {
                id: "file.txt",
                label: "file.txt",
              },
            },
          ],
        },
        {
          type: "codeBlock",
          content: [
            {
              type: "text",
              text: "// Code with a link: https://example.com",
            },
          ],
        },
      ],
    };

    const result = tiptapToRichText(input);

    expect(result).toEqual({
      type: "rich-text",
      nodes: [
        // Heading content with link and mention preserved
        { type: "text", text: "Check out " },
        { type: "link", text: "this link" },
        { type: "text", text: " and " },
        { type: "mention", text: "file.txt" },
        { type: "text", text: "\n" },
        // Code block content as plain text (no link detection in code blocks)
        { type: "text", text: "// Code with a link: https://example.com" },
      ],
    });
  });
});

describe("richTextToTiptap", () => {
  it("should convert DBRichTextPart back to TipTap JSON", () => {
    const input: DBRichTextPart = {
      type: "rich-text",
      nodes: [
        { type: "mention", text: "src/app/page.tsx" },
        { type: "text", text: " " },
        { type: "link", text: "https://google.com" },
        { type: "text", text: " " },
        { type: "text", text: "\n" },
        { type: "text", text: "\n" },
        { type: "text", text: "Very cool" },
        { type: "text", text: "\n" },
        { type: "text", text: "\n" },
        { type: "text", text: "Ultra nice" },
      ],
    };

    const expected = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "mention",
              attrs: {
                id: "src/app/page.tsx",
                label: "src/app/page.tsx",
              },
            },
            {
              type: "text",
              text: " ",
            },
            {
              type: "text",
              marks: [
                {
                  type: "link",
                  attrs: {
                    href: "https://google.com",
                    target: "_blank",
                    rel: "noopener noreferrer nofollow",
                    class: "text-blue-600 underline hover:text-blue-800",
                  },
                },
              ],
              text: "https://google.com",
            },
            {
              type: "text",
              text: " ",
            },
            {
              type: "hardBreak",
            },
            {
              type: "hardBreak",
            },
            {
              type: "text",
              text: "Very cool",
            },
            {
              type: "hardBreak",
            },
            {
              type: "hardBreak",
            },
            {
              type: "text",
              text: "Ultra nice",
            },
          ],
        },
      ],
    };

    const result = richTextToTiptap(input);
    expect(result).toEqual(expected);
  });

  it("should handle empty rich text", () => {
    const input: DBRichTextPart = {
      type: "rich-text",
      nodes: [],
    };

    const expected = {
      type: "doc",
      content: [],
    };

    expect(richTextToTiptap(input)).toEqual(expected);
  });

  it("should handle single newline within content", () => {
    // A single newline within a paragraph context should become a hardBreak
    // This test case represents content that originated from a single paragraph
    const input: DBRichTextPart = {
      type: "rich-text",
      nodes: [
        { type: "text", text: "Line 1" },
        { type: "text", text: "\n" },
        { type: "text", text: "Line 2" },
      ],
    };

    // When a single newline appears between content, it's ambiguous whether
    // it represents a hardBreak or a paragraph separator. Our implementation
    // treats it as a paragraph separator when it's between non-newline content.
    const expected = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "Line 1",
            },
          ],
        },
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "Line 2",
            },
          ],
        },
      ],
    };

    expect(richTextToTiptap(input)).toEqual(expected);
  });

  it("should handle paragraph separators correctly", () => {
    // This test reflects how tiptapToRichText actually works:
    // Multiple paragraphs are separated by a single "\n" node
    const input: DBRichTextPart = {
      type: "rich-text",
      nodes: [
        { type: "text", text: "First paragraph" },
        { type: "text", text: "\n" }, // This is a paragraph separator
        { type: "text", text: "Second paragraph" },
      ],
    };

    const expected = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "First paragraph",
            },
          ],
        },
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "Second paragraph",
            },
          ],
        },
      ],
    };

    expect(richTextToTiptap(input)).toEqual(expected);
  });

  it("should handle consecutive newlines as hardBreaks within a paragraph", () => {
    // When there are consecutive newlines (like from two hardBreaks),
    // they should stay as hardBreaks within the same paragraph
    const input: DBRichTextPart = {
      type: "rich-text",
      nodes: [
        { type: "text", text: "Line 1" },
        { type: "text", text: "\n" },
        { type: "text", text: "\n" },
        { type: "text", text: "Line 2" },
      ],
    };

    const expected = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "Line 1",
            },
            {
              type: "hardBreak",
            },
            {
              type: "hardBreak",
            },
            {
              type: "text",
              text: "Line 2",
            },
          ],
        },
      ],
    };

    expect(richTextToTiptap(input)).toEqual(expected);
  });
});

describe("roundtrip conversion", () => {
  it("should successfully roundtrip convert TipTap -> RichText -> TipTap", () => {
    const originalTiptap = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "mention",
              attrs: {
                id: "src/app/page.tsx",
                label: "src/app/page.tsx",
              },
            },
            {
              type: "text",
              text: " ",
            },
            {
              type: "text",
              marks: [
                {
                  type: "link",
                  attrs: {
                    href: "https://google.com",
                    target: "_blank",
                    rel: "noopener noreferrer nofollow",
                    class: "text-blue-600 underline hover:text-blue-800",
                  },
                },
              ],
              text: "https://google.com",
            },
            {
              type: "text",
              text: " ",
            },
            {
              type: "hardBreak",
            },
            {
              type: "hardBreak",
            },
            {
              type: "text",
              text: "Very cool",
            },
            {
              type: "hardBreak",
            },
            {
              type: "hardBreak",
            },
            {
              type: "text",
              text: "Ultra nice",
            },
          ],
        },
      ],
    };

    // Convert TipTap -> RichText
    const richText = tiptapToRichText(originalTiptap);

    // Convert RichText -> TipTap
    const convertedTiptap = richTextToTiptap(richText);

    // Should match the original
    expect(convertedTiptap).toEqual(originalTiptap);
  });

  it("should successfully roundtrip convert with multiple paragraphs", () => {
    const originalTiptap = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "First paragraph",
            },
          ],
        },
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "Second paragraph",
            },
          ],
        },
      ],
    };

    const richText = tiptapToRichText(originalTiptap);
    const convertedTiptap = richTextToTiptap(richText);

    expect(convertedTiptap).toEqual(originalTiptap);
  });

  it("should handle empty document in roundtrip", () => {
    const originalTiptap = {
      type: "doc",
      content: [],
    };

    const richText = tiptapToRichText(originalTiptap);
    const convertedTiptap = richTextToTiptap(richText);

    expect(convertedTiptap).toEqual(originalTiptap);
  });

  it("should roundtrip convert mixed content with mentions and links", () => {
    // Note: Links only preserve text content, not href, in the current DBRichTextNode format
    // For perfect roundtrip, href and text must be the same
    const originalTiptap = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "Check out ",
            },
            {
              type: "mention",
              attrs: {
                id: "@user",
                label: "@user",
              },
            },
            {
              type: "text",
              text: " and visit ",
            },
            {
              type: "text",
              marks: [
                {
                  type: "link",
                  attrs: {
                    href: "https://example.com",
                    target: "_blank",
                    rel: "noopener noreferrer nofollow",
                    class: "text-blue-600 underline hover:text-blue-800",
                  },
                },
              ],
              text: "https://example.com",
            },
            {
              type: "text",
              text: " for more info.",
            },
          ],
        },
      ],
    };

    const richText = tiptapToRichText(originalTiptap);
    const convertedTiptap = richTextToTiptap(richText);

    expect(convertedTiptap).toEqual(originalTiptap);
  });

  it("should roundtrip convert paragraph with only hardBreaks", () => {
    const originalTiptap = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "hardBreak",
            },
            {
              type: "hardBreak",
            },
            {
              type: "text",
              text: "Text after breaks",
            },
          ],
        },
      ],
    };

    const richText = tiptapToRichText(originalTiptap);
    const convertedTiptap = richTextToTiptap(richText);

    expect(convertedTiptap).toEqual(originalTiptap);
  });

  it("should roundtrip convert multiple paragraphs with various content", () => {
    const originalTiptap = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "mention",
              attrs: {
                id: "file.ts",
                label: "file.ts",
              },
            },
            {
              type: "text",
              text: " contains the ",
            },
            {
              type: "text",
              marks: [
                {
                  type: "link",
                  attrs: {
                    href: "https://docs.example.com",
                    target: "_blank",
                    rel: "noopener noreferrer nofollow",
                    class: "text-blue-600 underline hover:text-blue-800",
                  },
                },
              ],
              text: "https://docs.example.com",
            },
          ],
        },
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "Second paragraph with a line break",
            },
          ],
        },
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "Third paragraph",
            },
          ],
        },
      ],
    };

    const richText = tiptapToRichText(originalTiptap);
    const convertedTiptap = richTextToTiptap(richText);

    expect(convertedTiptap).toEqual(originalTiptap);
  });

  it("should roundtrip convert single paragraph with multiple hardBreaks and mixed content", () => {
    // Note: Due to how newlines are interpreted, content separated by single hardBreaks
    // may be split into multiple paragraphs during roundtrip conversion
    const originalTiptap = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "Line 1",
            },
            {
              type: "hardBreak",
            },
            {
              type: "hardBreak",
            },
            {
              type: "mention",
              attrs: {
                id: "component.tsx",
                label: "component.tsx",
              },
            },
            {
              type: "hardBreak",
            },
            {
              type: "hardBreak",
            },
            {
              type: "text",
              marks: [
                {
                  type: "link",
                  attrs: {
                    href: "https://github.com",
                    target: "_blank",
                    rel: "noopener noreferrer nofollow",
                    class: "text-blue-600 underline hover:text-blue-800",
                  },
                },
              ],
              text: "https://github.com",
            },
            {
              type: "hardBreak",
            },
            {
              type: "hardBreak",
            },
            {
              type: "text",
              text: "Final line",
            },
          ],
        },
      ],
    };

    const richText = tiptapToRichText(originalTiptap);
    const convertedTiptap = richTextToTiptap(richText);

    expect(convertedTiptap).toEqual(originalTiptap);
  });

  it("should handle text nodes containing newlines", () => {
    const input: DBRichTextPart = {
      type: "rich-text",
      nodes: [{ type: "text", text: "Hello\nworld" }],
    };

    const expected = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "Hello",
            },
          ],
        },
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "world",
            },
          ],
        },
      ],
    };

    expect(richTextToTiptap(input)).toEqual(expected);
  });

  it("should handle text nodes with multiple newlines", () => {
    const input: DBRichTextPart = {
      type: "rich-text",
      nodes: [{ type: "text", text: "Line 1\n\nLine 3\nLine 4" }],
    };

    const expected = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "Line 1",
            },
            {
              type: "hardBreak",
            },
            {
              type: "hardBreak",
            },
            {
              type: "text",
              text: "Line 3",
            },
          ],
        },
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "Line 4",
            },
          ],
        },
      ],
    };

    expect(richTextToTiptap(input)).toEqual(expected);
  });

  it("should handle mixed nodes with embedded newlines", () => {
    const input: DBRichTextPart = {
      type: "rich-text",
      nodes: [
        { type: "mention", text: "file.ts" },
        { type: "text", text: " contains:\ncode here" },
        { type: "text", text: "\n" },
        { type: "link", text: "https://example.com" },
      ],
    };

    const expected = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "mention",
              attrs: {
                id: "file.ts",
                label: "file.ts",
              },
            },
            {
              type: "text",
              text: " contains:",
            },
          ],
        },
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "code here",
            },
          ],
        },
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              marks: [
                {
                  type: "link",
                  attrs: {
                    href: "https://example.com",
                    target: "_blank",
                    rel: "noopener noreferrer nofollow",
                    class: "text-blue-600 underline hover:text-blue-800",
                  },
                },
              ],
              text: "https://example.com",
            },
          ],
        },
      ],
    };

    expect(richTextToTiptap(input)).toEqual(expected);
  });

  it("should handle text nodes with trailing newlines", () => {
    const input: DBRichTextPart = {
      type: "rich-text",
      nodes: [{ type: "text", text: "Hello world\n" }],
    };

    const expected = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "Hello world",
            },
          ],
        },
      ],
    };

    expect(richTextToTiptap(input)).toEqual(expected);
  });

  it("should handle text nodes with leading newlines", () => {
    const input: DBRichTextPart = {
      type: "rich-text",
      nodes: [{ type: "text", text: "\nHello world" }],
    };

    const expected = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "Hello world",
            },
          ],
        },
      ],
    };

    expect(richTextToTiptap(input)).toEqual(expected);
  });

  it("should roundtrip convert edge case with empty paragraphs", () => {
    const originalTiptap = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "First",
            },
          ],
        },
        {
          type: "paragraph",
          content: [],
        },
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "Third",
            },
          ],
        },
      ],
    };

    const richText = tiptapToRichText(originalTiptap);
    const convertedTiptap = richTextToTiptap(richText);

    // Note: Empty paragraphs are not preserved in the roundtrip
    // because they produce no nodes in the rich text format
    const expected = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "First",
            },
          ],
        },
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "Third",
            },
          ],
        },
      ],
    };

    expect(convertedTiptap).toEqual(expected);
  });
});
