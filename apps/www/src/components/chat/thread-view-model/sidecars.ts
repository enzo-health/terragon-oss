import { EventType, type BaseEvent } from "@ag-ui/core";

const PRODUCT_META_EVENT_KINDS = new Set([
  "thread.token_usage_updated",
  "account.rate_limits_updated",
  "model.rerouted",
  "mcp_server.startup_status_updated",
]);

export function createThreadViewSidecarEventProjector<
  TEvent extends BaseEvent,
>(): (event: TEvent) => TEvent | null {
  return (event) => (isTranscriptEvent(event) ? null : event);
}

export function createProductSidecarEventProjector<
  TEvent extends BaseEvent,
>(): (event: TEvent) => TEvent | null {
  const projector = createThreadViewSidecarEventProjector<TEvent>();
  return (event) => (isProductSidecarEvent(event) ? projector(event) : null);
}

export function isProductSidecarEvent(event: BaseEvent): boolean {
  switch (event.type) {
    case EventType.RUN_STARTED:
    case EventType.RUN_FINISHED:
    case EventType.RUN_ERROR:
    case EventType.STATE_SNAPSHOT:
    case EventType.STATE_DELTA:
    case EventType.ACTIVITY_SNAPSHOT:
    case EventType.ACTIVITY_DELTA:
      return true;
    case EventType.CUSTOM:
      return isAllowedCustomSidecarEvent(event);
    default:
      return false;
  }
}

function isAllowedCustomSidecarEvent(event: BaseEvent): boolean {
  const name = Reflect.get(event, "name");
  if (name === "thread.status_changed" || name === "artifact-reference") {
    return true;
  }

  const value = Reflect.get(event, "value");
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const kind = Reflect.get(value, "kind");
  return typeof kind === "string" && PRODUCT_META_EVENT_KINDS.has(kind);
}

function isTranscriptEvent(event: BaseEvent): boolean {
  switch (event.type) {
    case EventType.TEXT_MESSAGE_START:
    case EventType.TEXT_MESSAGE_CONTENT:
    case EventType.TEXT_MESSAGE_CHUNK:
    case EventType.TEXT_MESSAGE_END:
    case EventType.REASONING_MESSAGE_START:
    case EventType.REASONING_MESSAGE_CONTENT:
    case EventType.REASONING_MESSAGE_CHUNK:
    case EventType.REASONING_MESSAGE_END:
    case EventType.THINKING_TEXT_MESSAGE_START:
    case EventType.THINKING_TEXT_MESSAGE_CONTENT:
    case EventType.THINKING_TEXT_MESSAGE_END:
    case EventType.TOOL_CALL_START:
    case EventType.TOOL_CALL_ARGS:
    case EventType.TOOL_CALL_CHUNK:
    case EventType.TOOL_CALL_END:
    case EventType.TOOL_CALL_RESULT:
      return true;
    case EventType.CUSTOM: {
      const name = Reflect.get(event, "name");
      return name === "terragon.data-part" || name === "terragon.part";
    }
    default:
      return false;
  }
}
