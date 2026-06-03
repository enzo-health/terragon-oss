import type { BaseEvent } from "@ag-ui/core";
import { EventType } from "@ag-ui/core";
import type {
  DBSystemMessage,
  UIMessage,
  UISystemMessage,
} from "@terragon/shared";
import { terragonDataPartFromCustomEvent } from "../ag-ui-custom-parts";
import {
  getNumberField,
  getObjectField,
  getStringField,
  isRenderablePartShape,
  isThreadStatus,
} from "./renderable-part-shape";
import { isUnsupportedNativeRuntimeEvent } from "./thread-view-model-runtime-events";
import type { ThreadViewModelState, ThreadViewQuarantineEntry } from "./types";

const THREAD_LIFECYCLE_MESSAGE_TYPES: DBSystemMessage["message_type"][] = [
  "retry-git-commit-and-push",
  "fix-github-checks",
  "generic-retry",
  "invalid-token-retry",
  "cancel-schedule",
  "agent-error-retry",
  "follow-up-retry-failed",
];

const THREAD_LIFECYCLE_MESSAGE_TYPE_SET = new Set<
  DBSystemMessage["message_type"]
>(THREAD_LIFECYCLE_MESSAGE_TYPES);

const THREAD_LIFECYCLE_MESSAGE_TYPE_BY_ID = new Map<
  string,
  DBSystemMessage["message_type"]
>(
  THREAD_LIFECYCLE_MESSAGE_TYPES.map((messageType) => [
    messageType,
    messageType,
  ]),
);

function isThreadLifecycleMessage(
  message: UIMessage,
): message is UISystemMessage {
  return (
    message.role === "system" &&
    message.message_type !== "stop" &&
    message.message_type !== "git-diff" &&
    THREAD_LIFECYCLE_MESSAGE_TYPE_SET.has(message.message_type)
  );
}

export function extractThreadLifecycleMessages(
  messages: UIMessage[],
): UISystemMessage[] {
  const lifecycleMessages: UISystemMessage[] = [];
  for (const message of messages) {
    if (isThreadLifecycleMessage(message)) {
      lifecycleMessages.push(message);
    }
  }
  return lifecycleMessages;
}

export function extractThreadLifecycleMessagesFromAgUiSnapshot(
  event: BaseEvent,
): UISystemMessage[] {
  if (event.type !== EventType.MESSAGES_SNAPSHOT) {
    return [];
  }
  const messages = Reflect.get(event, "messages");
  if (!Array.isArray(messages)) {
    return [];
  }
  const lifecycleMessages: UISystemMessage[] = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") {
      continue;
    }
    const id = getStringField(message, "id");
    const role = getStringField(message, "role");
    if (!id || role !== "system") {
      continue;
    }
    const messageType = sideEffectSystemMessageTypeFromId(id);
    if (!messageType || !THREAD_LIFECYCLE_MESSAGE_TYPE_SET.has(messageType)) {
      continue;
    }
    lifecycleMessages.push({
      id,
      role: "system",
      message_type: messageType,
      parts: [{ type: "text", text: snapshotContentToText(message) }],
    });
  }
  return lifecycleMessages;
}

function sideEffectSystemMessageTypeFromId(
  id: string,
): DBSystemMessage["message_type"] | null {
  const match = /^side-effect-system:(.+)-\d+-[a-f0-9]{12}$/.exec(id);
  const messageType = match?.[1];
  return messageType
    ? (THREAD_LIFECYCLE_MESSAGE_TYPE_BY_ID.get(messageType) ?? null)
    : null;
}

function snapshotContentToText(message: object): string {
  const content = Reflect.get(message, "content");
  if (typeof content === "string") {
    return content;
  }
  if (content === null || content === undefined) {
    return "";
  }
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

export function applyLifecycleEvent(
  lifecycle: ThreadViewModelState["lifecycle"],
  event: BaseEvent,
): ThreadViewModelState["lifecycle"] {
  switch (event.type) {
    case EventType.RUN_STARTED: {
      const runId = getStringField(event, "runId") ?? lifecycle.runId;
      return {
        ...lifecycle,
        runId,
        runStarted: true,
        threadStatus: "working",
      };
    }
    case EventType.RUN_FINISHED:
      return {
        ...lifecycle,
        runStarted: false,
        threadStatus: "complete",
      };
    case EventType.RUN_ERROR:
      return {
        ...lifecycle,
        runStarted: false,
        threadStatus: "error",
      };
    case EventType.CUSTOM:
      return applyLifecycleCustomEvent(lifecycle, event);
    default:
      return lifecycle;
  }
}

function applyLifecycleCustomEvent(
  lifecycle: ThreadViewModelState["lifecycle"],
  event: BaseEvent,
): ThreadViewModelState["lifecycle"] {
  const name = getStringField(event, "name");
  if (name !== "thread.status_changed") {
    return lifecycle;
  }
  const value = getObjectField(event, "value");
  const status = getStringField(value, "status") ?? getStringField(value, "to");
  if (!isThreadStatus(status)) {
    return lifecycle;
  }
  return {
    ...lifecycle,
    threadStatus: status,
    runStarted: status === "working" || status === "booting",
  };
}

export function applyMetaEvent(
  meta: ThreadViewModelState["meta"],
  event: BaseEvent,
): ThreadViewModelState["meta"] {
  if (event.type !== EventType.CUSTOM) {
    return meta;
  }
  const value = getObjectField(event, "value");
  const kind = getStringField(value, "kind");
  switch (kind) {
    case "thread.token_usage_updated": {
      const usage = getObjectField(value, "usage");
      const inputTokens = getNumberField(usage, "inputTokens");
      const cachedInputTokens = getNumberField(usage, "cachedInputTokens");
      const outputTokens = getNumberField(usage, "outputTokens");
      if (
        inputTokens === null ||
        cachedInputTokens === null ||
        outputTokens === null
      ) {
        return meta;
      }
      return {
        ...meta,
        tokenUsage: { inputTokens, cachedInputTokens, outputTokens },
      };
    }
    case "account.rate_limits_updated": {
      const rateLimits = getObjectField(value, "rateLimits");
      return rateLimits ? { ...meta, rateLimits } : meta;
    }
    case "model.rerouted": {
      const originalModel = getStringField(value, "originalModel");
      const reroutedModel = getStringField(value, "reroutedModel");
      const reason = getStringField(value, "reason");
      if (!originalModel || !reroutedModel || !reason) {
        return meta;
      }
      return {
        ...meta,
        modelReroute: { originalModel, reroutedModel, reason },
      };
    }
    case "mcp_server.startup_status_updated": {
      const serverName = getStringField(value, "serverName");
      const status = getStringField(value, "status");
      if (
        !serverName ||
        (status !== "loading" && status !== "ready" && status !== "error")
      ) {
        return meta;
      }
      return {
        ...meta,
        mcpServerStatus: {
          ...meta.mcpServerStatus,
          [serverName]: status,
        },
      };
    }
    default:
      return meta;
  }
}

export function mergeMetaSnapshot(
  current: ThreadViewModelState["meta"],
  snapshot: ThreadViewModelState["meta"],
): ThreadViewModelState["meta"] {
  return {
    tokenUsage: current.tokenUsage ?? snapshot.tokenUsage,
    rateLimits: current.rateLimits ?? snapshot.rateLimits,
    modelReroute: current.modelReroute ?? snapshot.modelReroute,
    mcpServerStatus:
      Object.keys(current.mcpServerStatus).length > 0
        ? current.mcpServerStatus
        : snapshot.mcpServerStatus,
    bootSteps:
      current.bootSteps.length > 0 ? current.bootSteps : snapshot.bootSteps,
    installProgress: current.installProgress ?? snapshot.installProgress,
  };
}

export function getQuarantineEntry(
  event: BaseEvent,
): ThreadViewQuarantineEntry | null {
  if (isUnsupportedNativeRuntimeEvent(event)) {
    return {
      reason: "unsupported-ag-ui-event",
      eventType: String(event.type),
    };
  }

  if (event.type !== EventType.CUSTOM) {
    return null;
  }
  const name = getStringField(event, "name");
  if (name !== "terragon.data-part") {
    return null;
  }
  const value = getObjectField(event, "value");
  const messageId = getStringField(value, "messageId") ?? undefined;
  const dataPart = terragonDataPartFromCustomEvent(event);
  const part = dataPart ? dataPart.data.data : getObjectField(value, "data");
  const partType = part
    ? (getStringField(part, "type") ?? undefined)
    : undefined;
  if (dataPart && part && isRenderablePartShape(part)) {
    return null;
  }
  return {
    reason: "malformed-rich-part",
    eventType: String(event.type),
    messageId,
    partType,
  };
}
