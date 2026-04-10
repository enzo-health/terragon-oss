import type { Story, StoryDefault } from "@ladle/react";
import { RichTextPart } from "./rich-text-part";
import { UIRichTextPart } from "@leo/shared";

export default {
  title: "Chat/RichTextPart",
} satisfies StoryDefault;

export const Simple: Story = () => {
  const richTextPart: UIRichTextPart = {
    type: "rich-text",
    nodes: [{ type: "text", text: "This is a simple text message." }],
  };

  return (
    <div className="p-4 max-w-2xl">
      <RichTextPart richTextPart={richTextPart} />
    </div>
  );
};

export const WithMentionsAndLinks: Story = () => {
  const richTextPart: UIRichTextPart = {
    type: "rich-text",
    nodes: [
      { type: "text", text: "Check out " },
      { type: "mention", text: "src/app/page.tsx" },
      { type: "text", text: " and visit " },
      { type: "link", text: "https://google.com" },
      { type: "text", text: " for more information." },
    ],
  };

  return (
    <div className="p-4 max-w-2xl">
      <RichTextPart richTextPart={richTextPart} />
    </div>
  );
};

export const WithNewlines: Story = () => {
  const richTextPart: UIRichTextPart = {
    type: "rich-text",
    nodes: [
      { type: "text", text: "First line of text" },
      { type: "text", text: "\n\n" },
      { type: "text", text: "Second line after double newline" },
      { type: "text", text: "\n" },
      { type: "text", text: "Third line after single newline" },
    ],
  };

  return (
    <div className="p-4 max-w-2xl">
      <RichTextPart richTextPart={richTextPart} />
    </div>
  );
};

export const ComplexExample: Story = () => {
  const richTextPart: UIRichTextPart = {
    type: "rich-text",
    nodes: [
      { type: "text", text: "Please update " },
      { type: "mention", text: "src/components/button.tsx" },
      { type: "text", text: " and " },
      { type: "mention", text: "src/components/input.tsx" },
      { type: "text", text: " to match the design at " },
      { type: "link", text: "https://figma.com/design/xyz" },
      { type: "text", text: "." },
      { type: "text", text: "\n\n" },
      { type: "text", text: "Also check:" },
      { type: "text", text: "\n" },
      { type: "text", text: "- Documentation at " },
      { type: "link", text: "https://docs.example.com" },
      { type: "text", text: "\n" },
      { type: "text", text: "- Related issue: " },
      { type: "link", text: "https://github.com/org/repo/issues/123" },
    ],
  };

  return (
    <div className="p-4 max-w-2xl">
      <RichTextPart richTextPart={richTextPart} />
    </div>
  );
};

export const MultipleMentions: Story = () => {
  const richTextPart: UIRichTextPart = {
    type: "rich-text",
    nodes: [
      { type: "text", text: "Review these files: " },
      { type: "mention", text: "package.json" },
      { type: "text", text: ", " },
      { type: "mention", text: "tsconfig.json" },
      { type: "text", text: ", " },
      { type: "mention", text: "vite.config.ts" },
      { type: "text", text: ", and " },
      { type: "mention", text: ".env.example" },
      { type: "text", text: "." },
    ],
  };

  return (
    <div className="p-4 max-w-2xl">
      <RichTextPart richTextPart={richTextPart} />
    </div>
  );
};

export const LongText: Story = () => {
  const richTextPart: UIRichTextPart = {
    type: "rich-text",
    nodes: [
      {
        type: "text",
        text: "This is a longer text message to demonstrate how the component handles wrapping and formatting. ",
      },
      { type: "text", text: "It includes a mention to " },
      {
        type: "mention",
        text: "src/very/long/path/to/some/deeply/nested/component/file.tsx",
      },
      { type: "text", text: " and a link to " },
      {
        type: "link",
        text: "https://example.com/very/long/url/that/might/need/to/wrap/in/the/ui",
      },
      { type: "text", text: "." },
      { type: "text", text: "\n\n" },
      {
        type: "text",
        text: "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.",
      },
    ],
  };

  return (
    <div className="p-4 max-w-2xl">
      <RichTextPart richTextPart={richTextPart} />
    </div>
  );
};

export const EmptyContent: Story = () => {
  const richTextPart: UIRichTextPart = {
    type: "rich-text",
    nodes: [],
  };

  return (
    <div className="p-4 max-w-2xl border border-dashed">
      <p className="text-muted-foreground text-sm mb-2">Empty rich text:</p>
      <RichTextPart richTextPart={richTextPart} />
    </div>
  );
};
