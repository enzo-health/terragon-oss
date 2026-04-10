import { AllToolParts } from "@leo/shared";
import Convert from "ansi-to-html";
import { getAnsiColors } from "@/lib/ansi-colors";

/**
 * Converts ANSI escape codes to HTML
 */
export function ansiToHtml(text: string, theme: "light" | "dark"): string {
  const convert = new Convert({
    fg: "var(--foreground)",
    bg: "var(--background)",
    newline: false,
    escapeXML: true,
    stream: false,
    colors: getAnsiColors(theme),
  });
  return convert.toHtml(text);
}

export function formatToolParameters(
  parameters: AllToolParts["parameters"],
  options: {
    includeKeys?: string[];
    excludeKeys?: string[];
    keyOrder?: string[];
  } = {},
) {
  const entries = Object.entries(parameters).filter(([key]) => {
    if (options.includeKeys) {
      return options.includeKeys.includes(key);
    }
    if (options.excludeKeys) {
      return !options.excludeKeys.includes(key);
    }
    return true;
  });
  if (entries.length === 1) {
    const value = entries[0]![1];
    if (typeof value === "string") {
      return value;
    }
    return JSON.stringify(value);
  }
  return entries
    .sort((a, b) => {
      const aIndex = options.keyOrder?.indexOf(a[0]) ?? -1;
      const bIndex = options.keyOrder?.indexOf(b[0]) ?? -1;
      if (aIndex !== -1 && bIndex !== -1) {
        return aIndex - bIndex;
      }
      if (aIndex !== -1) {
        return -1;
      }
      if (bIndex !== -1) {
      }
      return 0;
    })
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join(", ");
}
