import { EventType, type BaseEvent, type CustomEvent } from "@ag-ui/core";
import type {
  DataMessagePart,
  ThreadAssistantMessage,
  ThreadAssistantMessagePart,
  ThreadMessage,
} from "@assistant-ui/react";

export const TERRAGON_DATA_PART_EVENT_NAME = "terragon.data-part";

export type TerragonCustomPartEvent = CustomEvent & {
  readonly name: typeof TERRAGON_DATA_PART_EVENT_NAME;
};

export type ReadonlyJSONValue =
  | string
  | number
  | boolean
  | null
  | readonly ReadonlyJSONValue[]
  | ReadonlyJSONObject;
export type ReadonlyJSONObject = { readonly [key: string]: ReadonlyJSONValue };

export type TerragonDataPartPayload = ReadonlyJSONObject & {
  readonly name: string;
  readonly messageId: string;
  readonly partIndex: number;
  readonly data: ReadonlyJSONObject;
};

export type TerragonDataPart = DataMessagePart<TerragonDataPartPayload>;

function isReadonlyJSONValue(value: unknown): value is ReadonlyJSONValue {
  if (value === null) {
    return true;
  }

  switch (typeof value) {
    case "string":
    case "number":
    case "boolean":
      return true;
    case "object":
      if (Array.isArray(value)) {
        return value.every(isReadonlyJSONValue);
      }
      return isReadonlyJSONObject(value);
    default:
      return false;
  }
}

export function isReadonlyJSONObject(
  value: unknown,
): value is ReadonlyJSONObject {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(isReadonlyJSONValue)
  );
}

export function getReadonlyJSONObjectField(
  value: ReadonlyJSONObject,
  key: string,
): ReadonlyJSONObject | null {
  const field = value[key];
  return isReadonlyJSONObject(field) ? field : null;
}

export function getStringField(
  value: ReadonlyJSONObject,
  key: string,
): string | null {
  const field = value[key];
  return typeof field === "string" ? field : null;
}

export function getNumberField(
  value: ReadonlyJSONObject,
  key: string,
): number | null {
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) ? field : null;
}

export function terragonDataPart(params: {
  name: string;
  messageId: string;
  partIndex: number;
  data: ReadonlyJSONObject;
}): TerragonDataPart {
  return {
    type: "data",
    name: params.name,
    data: {
      name: params.name,
      messageId: params.messageId,
      partIndex: params.partIndex,
      data: params.data,
    },
  };
}

export function sameTerragonDataPart(
  existing: ThreadAssistantMessagePart,
  next: TerragonDataPart,
): boolean {
  if (existing.type !== "data") {
    return false;
  }
  const existingData: unknown = existing.data;
  const nextData: unknown = next.data;
  if (!isReadonlyJSONObject(existingData) || !isReadonlyJSONObject(nextData)) {
    return false;
  }
  return (
    existing.name === next.name &&
    getStringField(existingData, "messageId") ===
      getStringField(nextData, "messageId") &&
    getNumberField(existingData, "partIndex") ===
      getNumberField(nextData, "partIndex")
  );
}

export function terragonDataPartFromCustomEvent(
  event: BaseEvent,
): TerragonDataPart | null {
  if (event.type !== EventType.CUSTOM) {
    return null;
  }
  const name = "name" in event ? event.name : null;
  if (name !== TERRAGON_DATA_PART_EVENT_NAME) {
    return null;
  }
  const value: unknown = "value" in event ? event.value : null;
  if (!isReadonlyJSONObject(value)) {
    return null;
  }
  const payloadName = getStringField(value, "name");
  const messageId = getStringField(value, "messageId");
  const partIndex = getNumberField(value, "partIndex");
  const data = getReadonlyJSONObjectField(value, "data");
  if (!payloadName || !messageId || partIndex === null || !data) {
    return null;
  }

  return terragonDataPart({
    name: payloadName,
    messageId,
    partIndex,
    data,
  });
}

export function appendTerragonDataPart(
  content: readonly ThreadAssistantMessagePart[],
  dataPart: TerragonDataPart,
): readonly ThreadAssistantMessagePart[] | null {
  if (content.some((part) => sameTerragonDataPart(part, dataPart))) {
    return null;
  }
  return [...content, dataPart];
}

export function applyCustomPartEvent(params: {
  messages: ThreadMessage[];
  event: BaseEvent;
  createAssistantMessage: (messageId: string) => ThreadAssistantMessage;
}): boolean {
  const { messages, event, createAssistantMessage } = params;
  const dataPart = terragonDataPartFromCustomEvent(event);
  if (!dataPart) {
    return false;
  }

  let messageIndex = messages.findIndex(
    (message) =>
      message.role === "assistant" && message.id === dataPart.data.messageId,
  );
  if (messageIndex === -1) {
    messages.push(createAssistantMessage(dataPart.data.messageId));
    messageIndex = messages.length - 1;
  }

  const message = messages[messageIndex];
  if (!message || message.role !== "assistant") {
    return false;
  }
  const content = appendTerragonDataPart(message.content, dataPart);
  if (!content) {
    return false;
  }
  messages[messageIndex] = {
    ...message,
    content,
  };
  return true;
}
