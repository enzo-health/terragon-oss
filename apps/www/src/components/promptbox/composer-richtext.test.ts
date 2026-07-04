import type { JSONContent } from "@tiptap/react";
import { describe, expect, it } from "vitest";
import type { ComposerValue } from "@/components/ai/composer-rich";
import {
  composerValueToRichText,
  richTextToComposerValue,
} from "./composer-richtext";
import { tiptapToRichText } from "./tiptap-to-richtext";

type ParityCase = {
  name: string;
  tiptap: JSONContent;
  composer: ComposerValue;
};

const cases: ParityCase[] = [
  {
    name: "plain single-line text",
    tiptap: {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "approve it" }] },
      ],
    },
    composer: {
      text: "approve it",
      segments: [{ type: "text", value: "approve it" }],
    },
  },
  {
    name: "multi-paragraph text",
    tiptap: {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "hello" }] },
        { type: "paragraph", content: [{ type: "text", text: "world" }] },
      ],
    },
    composer: {
      text: "hello\nworld",
      segments: [{ type: "text", value: "hello\nworld" }],
    },
  },
  {
    name: "hard break inside a paragraph",
    tiptap: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "line one" },
            { type: "hardBreak" },
            { type: "text", text: "line two" },
          ],
        },
      ],
    },
    composer: {
      text: "line one\nline two",
      segments: [{ type: "text", value: "line one\nline two" }],
    },
  },
  {
    name: "mention between text",
    tiptap: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "see " },
            { type: "mention", attrs: { id: "src/a.ts", label: "src/a.ts" } },
            { type: "text", text: " now" },
          ],
        },
      ],
    },
    composer: {
      text: "see {{@:src/a.ts}} now",
      segments: [
        { type: "text", value: "see " },
        {
          type: "chip",
          trigger: "@",
          item: { id: "src/a.ts", label: "src/a.ts" },
        },
        { type: "text", value: " now" },
      ],
    },
  },
  {
    name: "mention at the start",
    tiptap: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "mention", attrs: { id: "src/a.ts", label: "src/a.ts" } },
            { type: "text", text: " hello" },
          ],
        },
      ],
    },
    composer: {
      text: "{{@:src/a.ts}} hello",
      segments: [
        {
          type: "chip",
          trigger: "@",
          item: { id: "src/a.ts", label: "src/a.ts" },
        },
        { type: "text", value: " hello" },
      ],
    },
  },
  {
    name: "trailing mention",
    tiptap: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "look at " },
            {
              type: "mention",
              attrs: { id: "docs/readme.md", label: "docs/readme.md" },
            },
          ],
        },
      ],
    },
    composer: {
      text: "look at {{@:docs/readme.md}}",
      segments: [
        { type: "text", value: "look at " },
        {
          type: "chip",
          trigger: "@",
          item: { id: "docs/readme.md", label: "docs/readme.md" },
        },
      ],
    },
  },
  {
    name: "empty content",
    tiptap: { type: "doc", content: [{ type: "paragraph", content: [] }] },
    composer: { text: "", segments: [] },
  },
];

describe("composerValueToRichText parity with tiptapToRichText", () => {
  for (const testCase of cases) {
    it(`matches for ${testCase.name}`, () => {
      expect(composerValueToRichText(testCase.composer)).toEqual(
        tiptapToRichText(testCase.tiptap),
      );
    });
  }
});

describe("richTextToComposerValue", () => {
  it("round-trips through composerValueToRichText for each parity case", () => {
    for (const testCase of cases) {
      const richText = tiptapToRichText(testCase.tiptap);
      expect(
        composerValueToRichText(richTextToComposerValue(richText)),
      ).toEqual(richText);
    }
  });

  it("rebuilds chips and text segments from a mention-bearing rich text", () => {
    expect(
      richTextToComposerValue({
        type: "rich-text",
        nodes: [
          { type: "text", text: "see " },
          { type: "mention", text: "src/a.ts" },
          { type: "text", text: " now" },
        ],
      }),
    ).toEqual({
      text: "see {{@:src/a.ts}} now",
      segments: [
        { type: "text", value: "see " },
        {
          type: "chip",
          trigger: "@",
          item: { id: "src/a.ts", label: "src/a.ts" },
        },
        { type: "text", value: " now" },
      ],
    });
  });
});
