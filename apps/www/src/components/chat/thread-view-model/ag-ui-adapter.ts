import type { BaseEvent } from "@ag-ui/core";

const HYDRATION_AGENT_ID_PATTERN = /^agent-\d+$/;
const CANONICAL_EVENT_MESSAGE_ID_PATTERN = /^[a-f0-9]{64}$/;
const DELTA_STREAM_MESSAGE_ID_PATTERN = /^msg_[a-f0-9]+$/;
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

export function isHydrationAgentMessageId(id: string): boolean {
  return HYDRATION_AGENT_ID_PATTERN.test(id);
}

export function isCanonicalEventMessageId(id: string): boolean {
  return CANONICAL_EVENT_MESSAGE_ID_PATTERN.test(id);
}

export function isDeltaStreamMessageId(id: string): boolean {
  return DELTA_STREAM_MESSAGE_ID_PATTERN.test(id);
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

function stableSerialize(value: unknown): string {
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
