import type { DBRichTextNode, DBRichTextPart } from "@terragon/shared";
import type {
  ComposerItem,
  ComposerSegment,
  ComposerValue,
} from "@/components/ai/composer-rich";

export function composerValueToRichText(value: ComposerValue): DBRichTextPart {
  const nodes: DBRichTextNode[] = [];

  for (const segment of value.segments) {
    if (segment.type === "chip") {
      const text = segment.item.label || segment.item.id;
      if (text) {
        nodes.push({ type: "mention", text });
      }
      continue;
    }

    const lines = segment.value.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) {
        nodes.push({ type: "text", text: "\n" });
      }
      const line = lines[i]!;
      if (line.length > 0) {
        nodes.push({ type: "text", text: line });
      }
    }
  }

  return { type: "rich-text", nodes };
}

export function richTextToComposerValue(
  richText: DBRichTextPart,
): ComposerValue {
  const segments: ComposerSegment[] = [];
  let text = "";
  let buffer = "";

  const flush = () => {
    if (!buffer) return;
    segments.push({ type: "text", value: buffer });
    buffer = "";
  };

  for (const node of richText.nodes) {
    if (node.type === "mention") {
      flush();
      const item: ComposerItem = { id: node.text, label: node.text };
      segments.push({ type: "chip", trigger: "@", item });
      text += `{{@:${item.id}}}`;
      continue;
    }
    buffer += node.text;
    text += node.text;
  }
  flush();

  return { text, segments };
}
