import { type BaseEvent, EventType } from "@ag-ui/core";

export type ReplayIdentity = {
  runId?: string;
  eventId?: string;
  idempotencyKey?: string;
  seq?: number;
  projectionIndex?: number;
  projectionCount?: number;
};

export type AgUiStreamEntry = {
  id: string;
  seq: number | null;
  event: BaseEvent | null;
  identity?: ReplayIdentity;
};

const AG_UI_EVENT_TYPES: ReadonlySet<unknown> = new Set(
  Object.values(EventType),
);

export function getStringEventField(
  event: BaseEvent,
  field: string,
): string | null {
  const value = Reflect.get(event, field);
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isAgUiBaseEvent(value: unknown): value is BaseEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return AG_UI_EVENT_TYPES.has(Reflect.get(value, "type"));
}

function readStringField(value: object, field: string): string | null {
  const candidate = Reflect.get(value, field);
  return typeof candidate === "string" && candidate.length > 0
    ? candidate
    : null;
}

export function isValidKnownAgUiEvent(value: unknown): value is BaseEvent {
  if (!isAgUiBaseEvent(value)) {
    return false;
  }

  switch (value.type) {
    case EventType.RUN_STARTED:
    case EventType.RUN_FINISHED:
      return (
        readStringField(value, "threadId") !== null &&
        readStringField(value, "runId") !== null
      );
    case EventType.RUN_ERROR:
      return readStringField(value, "message") !== null;
    case EventType.TEXT_MESSAGE_START:
    case EventType.REASONING_MESSAGE_START:
      return (
        readStringField(value, "messageId") !== null &&
        readStringField(value, "role") !== null
      );
    case EventType.TEXT_MESSAGE_CONTENT:
    case EventType.TEXT_MESSAGE_CHUNK:
    case EventType.REASONING_MESSAGE_CONTENT:
    case EventType.REASONING_MESSAGE_CHUNK:
      return (
        readStringField(value, "messageId") !== null &&
        typeof Reflect.get(value, "delta") === "string"
      );
    case EventType.TEXT_MESSAGE_END:
    case EventType.REASONING_MESSAGE_END:
      return readStringField(value, "messageId") !== null;
    case EventType.TOOL_CALL_START:
      return (
        readStringField(value, "toolCallId") !== null &&
        readStringField(value, "toolCallName") !== null
      );
    case EventType.TOOL_CALL_ARGS:
    case EventType.TOOL_CALL_CHUNK:
      return (
        readStringField(value, "toolCallId") !== null &&
        typeof Reflect.get(value, "delta") === "string"
      );
    case EventType.TOOL_CALL_END:
      return readStringField(value, "toolCallId") !== null;
    case EventType.TOOL_CALL_RESULT:
      return (
        readStringField(value, "toolCallId") !== null &&
        readStringField(value, "messageId") !== null &&
        Reflect.has(value, "content")
      );
    case EventType.CUSTOM:
      return (
        readStringField(value, "name") !== null && Reflect.has(value, "value")
      );
    default:
      return true;
  }
}

function readNumberField(value: object, field: string): number | null {
  const candidate = Reflect.get(value, field);
  return Number.isSafeInteger(candidate) ? candidate : null;
}

function readStringFieldOrUndefined(
  value: object,
  field: string,
): string | undefined {
  const candidate = Reflect.get(value, field);
  return typeof candidate === "string" && candidate.length > 0
    ? candidate
    : undefined;
}

function parseStreamPayload(value: unknown): {
  seq: number | null;
  event: BaseEvent | null;
  identity?: ReplayIdentity;
} {
  if (isValidKnownAgUiEvent(value)) {
    return { seq: null, event: value };
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { seq: null, event: null };
  }

  const seq = readNumberField(value, "seq");
  const payload = Reflect.get(value, "payload");
  if (isValidKnownAgUiEvent(payload)) {
    const projectionIndex = readNumberField(value, "projectionIndex");
    const projectionCount = readNumberField(value, "projectionCount");
    return {
      seq,
      event: payload,
      identity: {
        runId: readStringFieldOrUndefined(value, "runId"),
        eventId: readStringFieldOrUndefined(value, "eventId"),
        idempotencyKey: readStringFieldOrUndefined(value, "idempotencyKey"),
        ...(projectionIndex !== null ? { projectionIndex } : {}),
        ...(projectionCount !== null ? { projectionCount } : {}),
        ...(seq !== null ? { seq } : {}),
      },
    };
  }

  const event = Reflect.get(value, "event");
  if (isValidKnownAgUiEvent(event)) {
    return { seq, event };
  }

  return { seq, event: null };
}

export function parseStreamEntries(raw: unknown): AgUiStreamEntry[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    return [];
  }
  const firstStream = raw[0];
  if (!Array.isArray(firstStream) || firstStream.length < 2) {
    return [];
  }
  const rawEntries = firstStream[1];
  if (!Array.isArray(rawEntries)) {
    return [];
  }

  const entries: AgUiStreamEntry[] = [];
  for (const entry of rawEntries) {
    if (!Array.isArray(entry) || entry.length < 2) {
      continue;
    }
    const [id, rawFields] = entry;
    if (typeof id !== "string") {
      continue;
    }
    const serialized = readEventField(rawFields);
    if (serialized == null) {
      entries.push({ id, seq: null, event: null });
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(serialized);
      const payload = parseStreamPayload(parsed);
      entries.push({
        id,
        seq: payload.seq,
        event: payload.event,
        ...(payload.identity ? { identity: payload.identity } : {}),
      });
    } catch (err) {
      console.warn("[ag-ui] malformed stream entry", { id, err });
      entries.push({ id, seq: null, event: null });
    }
  }
  return entries;
}

function readEventField(rawFields: unknown): string | null {
  if (!Array.isArray(rawFields)) {
    if (rawFields && typeof rawFields === "object") {
      const envelope = Reflect.get(rawFields, "envelope");
      if (typeof envelope === "string") {
        return envelope;
      }
      const value = Reflect.get(rawFields, "event");
      return typeof value === "string" ? value : null;
    }
    return null;
  }
  for (let i = 0; i < rawFields.length; i += 2) {
    if (rawFields[i] === "envelope" && typeof rawFields[i + 1] === "string") {
      return rawFields[i + 1] as string;
    }
  }
  for (let i = 0; i < rawFields.length; i += 2) {
    if (rawFields[i] === "event" && typeof rawFields[i + 1] === "string") {
      return rawFields[i + 1] as string;
    }
  }
  return null;
}
