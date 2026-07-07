import type {
  ComposerItem,
  ComposerSegment,
  ComposerValue,
} from "@/components/ai/composer-rich";

export const EMPTY_COMPOSER_VALUE: ComposerValue = { text: "", segments: [] };

export function isComposerValueEmpty(value: ComposerValue): boolean {
  for (const segment of value.segments) {
    if (segment.type === "chip") return false;
    if (segment.value.trim().length > 0) return false;
  }
  return true;
}

function segmentsToText(segments: ComposerSegment[]): string {
  let text = "";
  for (const segment of segments) {
    if (segment.type === "chip") {
      text += `{{${segment.trigger}:${segment.item.id}}}`;
    } else {
      text += segment.value;
    }
  }
  return text;
}

export function composerValueFromSegments(
  segments: ComposerSegment[],
): ComposerValue {
  return { text: segmentsToText(segments), segments };
}

export function appendText(value: ComposerValue, text: string): ComposerValue {
  if (!text) return value;
  const segments = [...value.segments];
  const last = segments[segments.length - 1];
  if (last && last.type === "text") {
    segments[segments.length - 1] = {
      type: "text",
      value: last.value + text,
    };
  } else {
    segments.push({ type: "text", value: text });
  }
  return composerValueFromSegments(segments);
}

export function appendChip(
  value: ComposerValue,
  item: ComposerItem,
  trigger = "@",
): ComposerValue {
  const withChip = composerValueFromSegments([
    ...value.segments,
    { type: "chip", trigger, item },
  ]);
  return appendText(withChip, " ");
}

export function appendSlashCommand(
  value: ComposerValue,
  query: string,
  name: string,
): ComposerValue {
  const segments = [...value.segments];
  const last = segments[segments.length - 1];
  const suffix = `/${query}`;
  if (last && last.type === "text" && last.value.endsWith(suffix)) {
    segments[segments.length - 1] = {
      type: "text",
      value: last.value.slice(0, last.value.length - suffix.length),
    };
  }
  return appendText(composerValueFromSegments(segments), `/${name} `);
}
