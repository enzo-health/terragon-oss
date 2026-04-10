import { JSONContent } from "@tiptap/react";
import type { DBRichTextPart, DBRichTextNode } from "@leo/shared";

export function tiptapToRichText(tiptapJSON: JSONContent): DBRichTextPart {
  const nodes: DBRichTextNode[] = [];

  if (!tiptapJSON.content || tiptapJSON.content.length === 0) {
    return {
      type: "rich-text",
      nodes,
    };
  }

  for (let i = 0; i < tiptapJSON.content.length; i++) {
    const contentNode = tiptapJSON.content[i];
    if (!contentNode) continue;

    const isLastNode = i === tiptapJSON.content.length - 1;

    // Process different node types
    const processedNodes = processContentNode(contentNode);
    nodes.push(...processedNodes);

    // Add appropriate separation between nodes
    if (!isLastNode && processedNodes.length > 0) {
      // Don't add newline after horizontal rule or if the next node is a horizontal rule
      const nextNode = tiptapJSON.content[i + 1];
      if (
        contentNode.type !== "horizontalRule" &&
        nextNode?.type !== "horizontalRule"
      ) {
        nodes.push({ type: "text", text: "\n" });
      }
    }
  }

  return {
    type: "rich-text",
    nodes,
  };
}

function processContentNode(node: JSONContent): DBRichTextNode[] {
  const nodes: DBRichTextNode[] = [];

  switch (node.type) {
    case "paragraph":
      nodes.push(...processInlineContent(node.content || []));
      break;

    case "heading":
      nodes.push(...processInlineContent(node.content || []));
      break;

    case "blockquote":
      // Process nested content recursively
      if (node.content) {
        for (let i = 0; i < node.content.length; i++) {
          const child = node.content[i];
          if (!child) continue;
          const childNodes = processContentNode(child);
          nodes.push(...childNodes);
          if (i < node.content.length - 1 && childNodes.length > 0) {
            nodes.push({ type: "text", text: "\n" });
          }
        }
      }
      break;

    case "codeBlock":
      // Extract text content from code blocks
      if (node.content) {
        const codeText = node.content
          .filter((n) => n.type === "text")
          .map((n) => n.text || "")
          .join("");
        if (codeText) {
          nodes.push({ type: "text", text: codeText });
        }
      }
      break;

    case "bulletList":
    case "orderedList":
      // Process list items
      if (node.content) {
        for (let i = 0; i < node.content.length; i++) {
          const listItem = node.content[i];
          if (!listItem) continue;
          const listItemNodes = processContentNode(listItem);
          nodes.push(...listItemNodes);
          if (i < node.content.length - 1 && listItemNodes.length > 0) {
            nodes.push({ type: "text", text: "\n" });
          }
        }
      }
      break;

    case "listItem":
      // Process list item content
      if (node.content) {
        for (let i = 0; i < node.content.length; i++) {
          const child = node.content[i];
          if (!child) continue;
          const childNodes = processContentNode(child);
          nodes.push(...childNodes);
          if (i < node.content.length - 1 && childNodes.length > 0) {
            nodes.push({ type: "text", text: "\n" });
          }
        }
      }
      break;

    case "horizontalRule":
      // Horizontal rules don't have text content, skip them
      break;

    case "text":
      // This shouldn't happen at the top level, but handle it just in case
      const text = node.text || "";
      if (text) {
        nodes.push({ type: "text", text });
      }
      break;

    default:
      // For any other node types, try to extract text content recursively
      if (node.content) {
        for (const child of node.content) {
          nodes.push(...processContentNode(child));
        }
      }
      break;
  }

  return nodes;
}

function processInlineContent(content: JSONContent[]): DBRichTextNode[] {
  const nodes: DBRichTextNode[] = [];

  for (const node of content) {
    if (node.type === "text") {
      const text = node.text || "";
      if (text) {
        // Check if this text node has a link mark
        const hasLinkMark = node.marks?.some((mark) => mark.type === "link");
        if (hasLinkMark) {
          nodes.push({ type: "link", text });
        } else {
          nodes.push({ type: "text", text });
        }
      }
    } else if (node.type === "mention") {
      const text = node.attrs?.label || node.attrs?.id || "";
      if (text) {
        nodes.push({ type: "mention", text });
      }
    } else if (node.type === "hardBreak") {
      nodes.push({ type: "text", text: "\n" });
    } else {
      // For any other inline node types, recursively process their content
      if (node.content) {
        nodes.push(...processInlineContent(node.content));
      }
    }
  }

  return nodes;
}

export function richTextToPlainText(richText: DBRichTextPart): string {
  if (!richText.nodes || richText.nodes.length === 0) {
    return "";
  }

  return richText.nodes
    .map((node) => {
      if (node.type === "mention") {
        // Serialize mentions with @ prefix to indicate file/folder reference
        return `@${node.text}`;
      }
      return node.text;
    })
    .join("");
}

export function userMessageToPlainText(message: {
  parts: Array<{ type: string; text?: string; nodes?: DBRichTextNode[] }>;
}): string {
  const textParts: string[] = [];

  for (const part of message.parts) {
    if (part.type === "text" && part.text) {
      textParts.push(part.text);
    } else if (part.type === "rich-text" && part.nodes) {
      const richTextPart: DBRichTextPart = {
        type: "rich-text",
        nodes: part.nodes,
      };
      textParts.push(richTextToPlainText(richTextPart));
    }
  }

  return textParts.join(" ");
}

export function richTextToTiptap(richText: DBRichTextPart): JSONContent {
  const doc: JSONContent = {
    type: "doc",
    content: [],
  };

  if (!richText.nodes || richText.nodes.length === 0) {
    return doc;
  }

  // First pass: identify paragraph boundaries
  // A paragraph boundary occurs when there's a newline that's not inside a paragraph
  // This happens when tiptapToRichText adds "\n" between paragraph nodes

  // First, process all nodes to split text nodes that contain newlines
  const processedNodes: DBRichTextNode[] = [];
  for (let nodeIndex = 0; nodeIndex < richText.nodes.length; nodeIndex++) {
    const node = richText.nodes[nodeIndex]!;
    if (
      node.type === "text" &&
      node.text !== "\n" &&
      node.text.includes("\n")
    ) {
      let text = node.text;
      if (nodeIndex === 0) {
        text = text.trimStart();
      }
      if (nodeIndex === richText.nodes.length - 1) {
        text = text.trimEnd();
      }
      const parts = text.split("\n");
      for (let i = 0; i < parts.length; i++) {
        if (i > 0) {
          // Add newline node between parts
          processedNodes.push({ type: "text", text: "\n" });
        }
        if (parts[i]) {
          processedNodes.push({ type: "text", text: parts[i]! });
        }
      }
    } else {
      processedNodes.push(node);
    }
  }

  // Split nodes into segments based on paragraph-separating newlines
  const segments: DBRichTextNode[][] = [];
  let currentSegment: DBRichTextNode[] = [];

  for (let i = 0; i < processedNodes.length; i++) {
    const node = processedNodes[i];
    if (!node) continue;

    const prevNode = i > 0 ? processedNodes[i - 1] : null;
    const nextNode =
      i < processedNodes.length - 1 ? processedNodes[i + 1] : null;

    // Check if this is a paragraph-separating newline
    // It's a separator if it's between two content nodes (not consecutive newlines)
    if (node.type === "text" && node.text === "\n") {
      const isParagraphSeparator =
        // Previous node exists and is not a newline
        prevNode &&
        !(prevNode.type === "text" && prevNode.text === "\n") &&
        // Next node exists and is not a newline
        nextNode &&
        !(nextNode.type === "text" && nextNode.text === "\n") &&
        // And we have content in current segment
        currentSegment.length > 0;

      if (isParagraphSeparator) {
        // This newline separates paragraphs
        segments.push(currentSegment);
        currentSegment = [];
      } else {
        // This is a hardBreak within a paragraph
        currentSegment.push(node);
      }
    } else {
      currentSegment.push(node);
    }
  }

  // Don't forget the last segment
  if (currentSegment.length > 0) {
    segments.push(currentSegment);
  }

  // Convert each segment to a paragraph
  for (const segment of segments) {
    const paragraphContent: JSONContent[] = [];

    for (const node of segment) {
      if (node.type === "text" && node.text === "\n") {
        // Convert newlines within paragraphs to hardBreaks
        paragraphContent.push({
          type: "hardBreak",
        });
      } else {
        const tiptapNode = convertNodeToTiptap(node);
        if (tiptapNode) {
          paragraphContent.push(tiptapNode);
        }
      }
    }

    if (paragraphContent.length > 0) {
      doc.content!.push({
        type: "paragraph",
        content: paragraphContent,
      });
    }
  }

  // If no paragraphs were created, create an empty one
  if (doc.content!.length === 0) {
    doc.content!.push({
      type: "paragraph",
      content: [],
    });
  }

  return doc;
}

function convertNodeToTiptap(node: DBRichTextNode): JSONContent | null {
  switch (node.type) {
    case "text":
      if (node.text === "") {
        return null;
      }
      return {
        type: "text",
        text: node.text,
      };

    case "mention":
      return {
        type: "mention",
        attrs: {
          id: node.text,
          label: node.text,
        },
      };

    case "link":
      return {
        type: "text",
        marks: [
          {
            type: "link",
            attrs: {
              href: node.text,
              target: "_blank",
              rel: "noopener noreferrer nofollow",
              class: "text-blue-600 underline hover:text-blue-800",
            },
          },
        ],
        text: node.text,
      };

    default:
      // TypeScript exhaustiveness check - this should never happen
      const _exhaustiveCheck: never = node;
      console.error("Unknown node type", _exhaustiveCheck);
      return null;
  }
}
