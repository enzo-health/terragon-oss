import type { MetricComparison } from "../types";

/**
 * Format MetricComparison[] into a bordered terminal table string.
 */
export function formatComparisonTable(comparisons: MetricComparison[]): string {
  const headers = ["Metric", "Baseline", "Current", "Delta", "Status"];

  // Compute column widths
  const widths = headers.map((h) => h.length);
  for (const row of comparisons) {
    const vals = rowValues(row);
    for (let i = 0; i < vals.length; i++) {
      widths[i] = Math.max(widths[i]!, vals[i]!.length);
    }
  }

  // Add padding
  const pad = 1;
  const colWidths = widths.map((w) => w + pad * 2);

  const lines: string[] = [];

  lines.push(border("top", colWidths));
  lines.push(dataRow(headers, colWidths));
  lines.push(border("mid", colWidths));

  for (const row of comparisons) {
    lines.push(dataRow(rowValues(row), colWidths));
  }

  lines.push(border("bottom", colWidths));

  return lines.join("\n");
}

function rowValues(row: MetricComparison): string[] {
  const status =
    row.improved === true ? "pass" : row.improved === false ? "FAIL" : "=";
  return [
    row.metric,
    String(row.baseline),
    String(row.current),
    row.delta,
    status,
  ];
}

function border(pos: "top" | "mid" | "bottom", widths: number[]): string {
  const left = pos === "top" ? "\u250C" : pos === "mid" ? "\u251C" : "\u2514";
  const right = pos === "top" ? "\u2510" : pos === "mid" ? "\u2524" : "\u2518";
  const cross = pos === "top" ? "\u252C" : pos === "mid" ? "\u253C" : "\u2534";
  const dash = "\u2500";

  return left + widths.map((w) => dash.repeat(w)).join(cross) + right;
}

function dataRow(values: string[], widths: number[]): string {
  const cells = values.map((v, i) => {
    const content =
      v.length < widths[i]! - 1 ? ` ${v}`.padEnd(widths[i]!) : ` ${v} `;
    return content;
  });
  return "\u2502" + cells.join("\u2502") + "\u2502";
}
