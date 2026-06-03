import type { BaseEvent } from "@ag-ui/core";
import { stableSerialize } from "@/lib/stable-serialize";

const NO_FALLBACK_DEDUPE_EVENT_TYPES = new Set<string>([
  "TEXT_MESSAGE_CONTENT",
  "REASONING_MESSAGE_CONTENT",
  "TOOL_CALL_ARGS",
]);
export const MAX_SEEN_THREAD_VIEW_EVENT_KEYS = 2048;

export function getAgUiEventDedupeKey(event: BaseEvent): string | null {
  return (
    getIdentityFirstEventDedupeKey(event) ??
    getStructuralFallbackEventDedupeKey(event)
  );
}

export function trackSeenAgUiEventKey(params: {
  seenEventKeys: Set<string>;
  seenEventOrder: string[];
  key: string;
}): void {
  const { seenEventKeys, seenEventOrder, key } = params;
  if (seenEventKeys.has(key)) {
    return;
  }
  seenEventKeys.add(key);
  seenEventOrder.push(key);

  if (seenEventOrder.length <= MAX_SEEN_THREAD_VIEW_EVENT_KEYS) {
    return;
  }

  const overflow = seenEventOrder.length - MAX_SEEN_THREAD_VIEW_EVENT_KEYS;
  const evicted = seenEventOrder.splice(0, overflow);
  for (const oldKey of evicted) {
    seenEventKeys.delete(oldKey);
  }
}

function getIdentityFirstEventDedupeKey(event: BaseEvent): string | null {
  const runId = getStringField(event, "runId");
  const eventId = getStringField(event, "eventId");
  if (runId && eventId) {
    return `run-event:${runId}:${eventId}`;
  }
  if (eventId) {
    return `event:${eventId}`;
  }

  const idempotencyKey = getStringField(event, "idempotencyKey");
  if (runId && idempotencyKey) {
    return `run-idempotency:${runId}:${idempotencyKey}`;
  }
  if (idempotencyKey) {
    return `idempotency:${idempotencyKey}`;
  }

  const seq = getIntegerField(event, "seq");
  if (runId && seq !== null) {
    return `run-seq:${runId}:${seq}`;
  }

  const messageId = getStringField(event, "messageId");
  const deltaSeq = getIntegerField(event, "deltaSeq");
  if (messageId && deltaSeq !== null) {
    return `message-delta:${event.type}:${messageId}:${deltaSeq}`;
  }

  return null;
}

function getStructuralFallbackEventDedupeKey(event: BaseEvent): string | null {
  if (NO_FALLBACK_DEDUPE_EVENT_TYPES.has(event.type)) {
    return null;
  }
  return `event:${stableSerialize(event)}`;
}

function getStringField(value: unknown, field: string): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = Reflect.get(value, field);
  return typeof candidate === "string" && candidate.length > 0
    ? candidate
    : null;
}

function getIntegerField(value: unknown, field: string): number | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = Reflect.get(value, field);
  return typeof candidate === "number" && Number.isInteger(candidate)
    ? candidate
    : null;
}
