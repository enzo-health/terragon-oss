import { useRef } from "react";

export function useStablePrefix<T>(items: T[], endExclusive: number): T[] {
  const previousRef = useRef<{ endExclusive: number; prefix: T[] } | null>(
    null,
  );
  const previous = previousRef.current;

  if (
    previous &&
    previous.endExclusive === endExclusive &&
    items.length >= endExclusive &&
    previous.prefix.every((item, index) => items[index] === item)
  ) {
    return previous.prefix;
  }

  const prefix = items.slice(0, endExclusive);
  previousRef.current = { endExclusive, prefix };
  return prefix;
}
