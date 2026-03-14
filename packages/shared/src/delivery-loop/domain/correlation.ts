import type { CorrelationId } from "./workflow";

let counter = 0;

export function generateCorrelationId(): CorrelationId {
  const id =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${++counter}`;
  return id as CorrelationId;
}
