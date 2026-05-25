export function stableSerialize(value: unknown): string {
  if (value === null || value === undefined) {
    return String(value);
  }
  if (typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(
    ([left], [right]) => left.localeCompare(right),
  );
  const serializedEntries = entries.map(
    ([key, entryValue]) =>
      `${JSON.stringify(key)}:${stableSerialize(entryValue)}`,
  );
  return `{${serializedEntries.join(",")}}`;
}
