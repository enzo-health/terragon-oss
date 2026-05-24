import type { UIPart } from "@terragon/shared";
import type { ArtifactDescriptor } from "@terragon/shared/db/artifact-descriptors";

function stableValue(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value === "string") return value;
  if (typeof value !== "object") return JSON.stringify(value) ?? "";
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableValue(entry)).join(",")}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableValue(entry)}`)
    .join(",")}}`;
}

export function isEqualPlanMap(
  a: Map<UIPart, number>,
  b: Map<UIPart, number>,
): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const [key, value] of a) {
    if (b.get(key) !== value) return false;
  }
  return true;
}

export function isEqualArtifactList(
  a: ArtifactDescriptor[],
  b: ArtifactDescriptor[],
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const prev = a[i]!;
    const next = b[i]!;
    if (
      prev.id !== next.id ||
      prev.kind !== next.kind ||
      prev.status !== next.status ||
      prev.title !== next.title ||
      prev.updatedAt !== next.updatedAt ||
      prev.summary !== next.summary ||
      stableValue(prev.origin) !== stableValue(next.origin) ||
      stableValue(prev.part) !== stableValue(next.part)
    ) {
      return false;
    }
  }
  return true;
}
