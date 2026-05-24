import type { BaseEvent } from "@ag-ui/core";
import { EventType } from "@ag-ui/core";
import type {
  DBSystemMessage,
  DBUserMessage,
  UIMessage,
  UISystemMessage,
} from "@terragon/shared";
import {
  agUiMessagesReducer,
  createInitialAgUiMessagesState,
} from "../ag-ui-messages-reducer";
import { terragonDataPartFromCustomEvent } from "../ag-ui-custom-parts";
import {
  getAgUiEventDedupeKey,
  isCanonicalEventMessageId,
  isDeltaStreamMessageId,
  isHydrationAgentMessageId,
  trackSeenAgUiEventKey,
} from "./ag-ui-adapter";
import {
  getArtifactReferenceDescriptor,
  getStableArtifactsForMessages,
  preserveArtifactReferenceDescriptors,
  upsertArtifactReferenceDescriptor,
} from "./artifact-descriptors";
import { applyJsonPatchOperations } from "./json-patch";
import {
  getArrayField,
  getBooleanField,
  getNumberField,
  getObjectField,
  getStringField,
  isRenderablePartShape,
  isThreadStatus,
  stableSerialize,
} from "./renderable-part-shape";
import type {
  ThreadViewEvent,
  ThreadViewModel,
  ThreadViewModelState,
  ThreadViewQuarantineEntry,
  ThreadViewRuntimeActivities,
  ThreadViewRuntimeState,
  ThreadViewSnapshot,
} from "./types";

export function createInitialThreadViewModelState(
  snapshot: ThreadViewSnapshot,
): ThreadViewModelState {
  return {
    threadId: snapshot.threadId,
    threadChatId: snapshot.threadChatId,
    transcript: createInitialAgUiMessagesState(
      snapshot.agent,
      snapshot.uiMessages,
    ),
    runtimeState: {},
    runtimeActivities: {},
    dbMessages: snapshot.dbMessages,
    queuedMessages: snapshot.queuedMessages,
    threadStatus: snapshot.threadStatus,
    permissionMode: snapshot.permissionMode,
    hasCheckpoint: snapshot.hasCheckpoint,
    latestGitDiffTimestamp: snapshot.latestGitDiffTimestamp,
    artifactThread: snapshot.artifactThread,
    artifacts: snapshot.artifacts,
    sidePanel: snapshot.sidePanel,
    meta: snapshot.meta,
    githubSummary: snapshot.githubSummary,
    lifecycle: snapshot.lifecycle,
    quarantine: snapshot.quarantine,
    hasLiveTranscriptEvents: false,
    hasLiveLifecycleEvents: false,
    hasOptimisticTranscriptEvents: false,
    hasOptimisticQueuedMessages: false,
    hasOptimisticPermissionMode: false,
    seenEventKeys: new Set(),
    seenEventOrder: [],
  };
}

export function threadViewModelReducer(
  state: ThreadViewModelState,
  event: ThreadViewEvent,
): ThreadViewModelState {
  switch (event.type) {
    case "snapshot.hydrated":
      return applySnapshot(state, event.snapshot, "preserve-active-transcript");
    case "server.refetch-reconciled":
      return applySnapshot(state, event.snapshot, "replace-transcript");
    case "ag-ui.event":
    case "runtime.event":
      return applyAgUiEvent(
        state,
        event.event,
        event.projectTranscript ?? true,
      );
    case "optimistic.user-submitted":
      return applyOptimisticUserSubmit(state, event);
    case "optimistic.queued-messages-updated":
      return {
        ...state,
        queuedMessages: event.messages.length > 0 ? event.messages : null,
        hasOptimisticQueuedMessages: true,
      };
    case "optimistic.permission-mode-updated":
      return {
        ...state,
        permissionMode: event.permissionMode,
        hasOptimisticPermissionMode: true,
      };
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

export function projectThreadViewModel(
  state: ThreadViewModelState,
  options?: { includeTranscriptMessages?: boolean },
): ThreadViewModel {
  const includeTranscriptMessages = options?.includeTranscriptMessages ?? true;
  const splitMessages = includeTranscriptMessages
    ? splitThreadLifecycleMessages(
        collapseHydrationReplayTextDuplicates(state.transcript.messages),
      )
    : {
        transcriptMessages: [],
        lifecycleMessages: extractThreadLifecycleMessages(
          state.transcript.messages,
        ),
      };
  return {
    threadId: state.threadId,
    threadChatId: state.threadChatId,
    messages: splitMessages.transcriptMessages,
    lifecycleMessages: splitMessages.lifecycleMessages,
    runtimeState: state.runtimeState,
    runtimeActivities: state.runtimeActivities,
    dbMessages: state.dbMessages,
    queuedMessages: state.queuedMessages,
    threadStatus: state.threadStatus,
    permissionMode: state.permissionMode,
    hasCheckpoint: state.hasCheckpoint,
    latestGitDiffTimestamp: state.latestGitDiffTimestamp,
    artifactThread: state.artifactThread,
    artifacts: state.artifacts,
    sidePanel: state.sidePanel,
    meta: state.meta,
    githubSummary: state.githubSummary,
    lifecycle: state.lifecycle,
    quarantine: state.quarantine,
  };
}

const THREAD_LIFECYCLE_MESSAGE_TYPES = new Set<DBSystemMessage["message_type"]>(
  [
    "retry-git-commit-and-push",
    "fix-github-checks",
    "generic-retry",
    "invalid-token-retry",
    "cancel-schedule",
    "agent-error-retry",
    "follow-up-retry-failed",
  ],
);

function isThreadLifecycleMessage(
  message: UIMessage,
): message is UISystemMessage {
  return (
    message.role === "system" &&
    message.message_type !== "stop" &&
    message.message_type !== "git-diff" &&
    THREAD_LIFECYCLE_MESSAGE_TYPES.has(message.message_type)
  );
}

function splitThreadLifecycleMessages(messages: UIMessage[]): {
  transcriptMessages: UIMessage[];
  lifecycleMessages: UISystemMessage[];
} {
  const transcriptMessages: UIMessage[] = [];
  const lifecycleMessages: UISystemMessage[] = [];

  for (const message of messages) {
    if (isThreadLifecycleMessage(message)) {
      lifecycleMessages.push(message);
      continue;
    }
    transcriptMessages.push(message);
  }

  return { transcriptMessages, lifecycleMessages };
}

function extractThreadLifecycleMessages(
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

export function collapseHydrationReplayTextDuplicates(
  messages: UIMessage[],
): UIMessage[] {
  if (messages.length < 2) {
    return messages;
  }

  const next: UIMessage[] = [];
  let changed = false;

  for (const message of messages) {
    const previous = next[next.length - 1];
    if (!previous) {
      next.push(message);
      continue;
    }

    const previousText = getAgentMessageTextContent(previous);
    const currentText = getAgentMessageTextContent(message);
    const textMatches =
      previousText !== null &&
      currentText !== null &&
      (previousText === currentText ||
        previousText.startsWith(currentText) ||
        currentText.startsWith(previousText));
    if (!textMatches) {
      next.push(message);
      continue;
    }

    const previousSynthetic = isHydrationAgentMessageId(previous.id);
    const currentSynthetic = isHydrationAgentMessageId(message.id);
    if (previousSynthetic !== currentSynthetic) {
      changed = true;
      if (previousSynthetic) {
        next[next.length - 1] = message;
      }
      continue;
    }

    const previousCanonical = isCanonicalEventMessageId(previous.id);
    const currentCanonical = isCanonicalEventMessageId(message.id);
    const previousDelta = isDeltaStreamMessageId(previous.id);
    const currentDelta = isDeltaStreamMessageId(message.id);
    if (
      (previousCanonical && currentDelta) ||
      (previousDelta && currentCanonical)
    ) {
      changed = true;
      if (
        shouldPreferHydrationReplayMessage({
          previous,
          current: message,
          previousIsCanonical: previousCanonical,
        })
      ) {
        next[next.length - 1] = message;
      }
      continue;
    }

    next.push(message);
  }

  return changed ? next : messages;
}

function applySnapshot(
  state: ThreadViewModelState,
  snapshot: ThreadViewSnapshot,
  transcriptMode: "preserve-active-transcript" | "replace-transcript",
): ThreadViewModelState {
  const shouldReplaceTranscript =
    transcriptMode === "replace-transcript" ||
    (!state.hasLiveTranscriptEvents && !state.hasOptimisticTranscriptEvents);
  const shouldReplaceLocalState = transcriptMode === "replace-transcript";
  const shouldPreserveLocalTranscriptState =
    !shouldReplaceLocalState && state.hasOptimisticTranscriptEvents;
  const shouldPreserveLocalLifecycle =
    !shouldReplaceLocalState &&
    (state.hasLiveLifecycleEvents || state.hasOptimisticTranscriptEvents);
  const lifecycle = shouldPreserveLocalLifecycle
    ? state.lifecycle
    : snapshot.lifecycle;
  const threadStatus = shouldPreserveLocalLifecycle
    ? state.threadStatus
    : snapshot.threadStatus;

  return {
    ...state,
    threadId: snapshot.threadId,
    threadChatId: snapshot.threadChatId,
    transcript: shouldReplaceTranscript
      ? createInitialAgUiMessagesState(snapshot.agent, snapshot.uiMessages)
      : state.transcript,
    dbMessages: shouldPreserveLocalTranscriptState
      ? state.dbMessages
      : snapshot.dbMessages,
    queuedMessages:
      !shouldReplaceLocalState && state.hasOptimisticQueuedMessages
        ? state.queuedMessages
        : snapshot.queuedMessages,
    threadStatus,
    permissionMode:
      transcriptMode === "replace-transcript" ||
      !state.hasOptimisticPermissionMode
        ? snapshot.permissionMode
        : state.permissionMode,
    hasCheckpoint: snapshot.hasCheckpoint,
    latestGitDiffTimestamp: snapshot.latestGitDiffTimestamp,
    artifactThread: snapshot.artifactThread,
    artifacts: shouldReplaceTranscript
      ? preserveArtifactReferenceDescriptors(
          state.artifacts,
          snapshot.artifacts,
        )
      : getArtifactsForStateMessages(state, snapshot.artifactThread),
    sidePanel: shouldPreserveLocalTranscriptState
      ? state.sidePanel
      : snapshot.sidePanel,
    meta: mergeMetaSnapshot(state.meta, snapshot.meta),
    githubSummary: snapshot.githubSummary,
    lifecycle,
    quarantine:
      snapshot.quarantine.length > 0
        ? [...state.quarantine, ...snapshot.quarantine]
        : state.quarantine,
    hasOptimisticTranscriptEvents: shouldReplaceTranscript
      ? false
      : state.hasOptimisticTranscriptEvents,
    hasOptimisticQueuedMessages: shouldReplaceLocalState
      ? false
      : state.hasOptimisticQueuedMessages,
    hasOptimisticPermissionMode: shouldReplaceLocalState
      ? false
      : state.hasOptimisticPermissionMode,
    hasLiveTranscriptEvents: shouldReplaceLocalState
      ? false
      : state.hasLiveTranscriptEvents,
    hasLiveLifecycleEvents: shouldReplaceLocalState
      ? false
      : state.hasLiveLifecycleEvents,
  };
}

function applyAgUiEvent(
  state: ThreadViewModelState,
  event: BaseEvent,
  projectTranscript: boolean,
): ThreadViewModelState {
  const dedupeKey = getAgUiEventDedupeKey(event);
  if (dedupeKey && state.seenEventKeys.has(dedupeKey)) {
    return state;
  }

  const seenEventKeys = dedupeKey
    ? new Set(state.seenEventKeys)
    : state.seenEventKeys;
  const seenEventOrder = dedupeKey
    ? state.seenEventOrder.slice()
    : state.seenEventOrder;
  if (dedupeKey) {
    trackSeenAgUiEventKey({
      seenEventKeys,
      seenEventOrder,
      key: dedupeKey,
    });
  }

  const nativeRuntimeProjection = applyNativeRuntimeEvent(state, event);
  if (nativeRuntimeProjection?.quarantineEntry) {
    return {
      ...state,
      seenEventKeys,
      seenEventOrder,
      quarantine: [
        ...state.quarantine,
        nativeRuntimeProjection.quarantineEntry,
      ],
    };
  }

  const quarantineEntry = getQuarantineEntry(event);
  if (quarantineEntry) {
    return {
      ...state,
      seenEventKeys,
      seenEventOrder,
      quarantine: [...state.quarantine, quarantineEntry],
    };
  }

  const meta = applyMetaEvent(state.meta, event);
  const lifecycle = applyLifecycleEvent(state.lifecycle, event);
  const transcript = projectTranscript
    ? agUiMessagesReducer(state.transcript, event)
    : state.transcript;
  const runtimeState =
    nativeRuntimeProjection?.runtimeState ?? state.runtimeState;
  const runtimeActivities =
    nativeRuntimeProjection?.runtimeActivities ?? state.runtimeActivities;
  const artifactReferenceDescriptor = getArtifactReferenceDescriptor(event);
  const artifacts =
    transcript === state.transcript
      ? upsertArtifactReferenceDescriptor(
          state.artifacts,
          artifactReferenceDescriptor,
        )
      : upsertArtifactReferenceDescriptor(
          getStableArtifactsForMessages({
            previous: state.artifacts,
            messages: collapseHydrationReplayTextDuplicates(
              transcript.messages,
            ),
            artifactThread: state.artifactThread,
          }),
          artifactReferenceDescriptor,
        );
  if (
    transcript === state.transcript &&
    artifacts === state.artifacts &&
    meta === state.meta &&
    lifecycle === state.lifecycle &&
    runtimeState === state.runtimeState &&
    runtimeActivities === state.runtimeActivities &&
    seenEventKeys === state.seenEventKeys &&
    seenEventOrder === state.seenEventOrder
  ) {
    return state;
  }

  return {
    ...state,
    transcript,
    artifacts,
    meta,
    lifecycle,
    runtimeState,
    runtimeActivities,
    threadStatus: lifecycle.threadStatus,
    seenEventKeys,
    seenEventOrder,
    hasLiveTranscriptEvents: projectTranscript
      ? transcript !== state.transcript || state.hasLiveTranscriptEvents
      : state.hasLiveTranscriptEvents,
    hasLiveLifecycleEvents:
      lifecycle !== state.lifecycle || state.hasLiveLifecycleEvents,
  };
}

function applyOptimisticUserSubmit(
  state: ThreadViewModelState,
  event: Extract<ThreadViewEvent, { type: "optimistic.user-submitted" }>,
): ThreadViewModelState {
  const uiMessage = dbUserMessageToUiMessage({
    message: event.message,
    id: `user-optimistic-${state.threadChatId}-${state.dbMessages.length}`,
  });

  const duplicate = state.transcript.messages.some((message) =>
    isSameUserMessage(message, uiMessage),
  );
  const transcript = duplicate
    ? state.transcript
    : {
        ...state.transcript,
        messages: [...state.transcript.messages, uiMessage],
      };

  return {
    ...state,
    transcript,
    dbMessages: [...state.dbMessages, event.message],
    sidePanel: {
      ...state.sidePanel,
      messages: [...state.sidePanel.messages, event.message],
    },
    threadStatus: event.optimisticStatus,
    lifecycle: {
      ...state.lifecycle,
      threadStatus: event.optimisticStatus,
      runStarted: event.optimisticStatus !== "complete",
    },
    hasOptimisticTranscriptEvents: true,
  };
}

function dbUserMessageToUiMessage({
  message,
  id,
}: {
  message: DBUserMessage;
  id: string;
}): Extract<UIMessage, { role: "user" }> {
  return {
    id,
    role: "user",
    parts: message.parts,
    timestamp: message.timestamp,
    model: message.model,
  };
}

function getArtifactsForStateMessages(
  state: ThreadViewModelState,
  artifactThread = state.artifactThread,
) {
  return getStableArtifactsForMessages({
    previous: state.artifacts,
    messages: collapseHydrationReplayTextDuplicates(state.transcript.messages),
    artifactThread,
  });
}

function applyLifecycleEvent(
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

function applyMetaEvent(
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

function mergeMetaSnapshot(
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

function getQuarantineEntry(
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

function isUnsupportedNativeRuntimeEvent(event: BaseEvent): boolean {
  switch (event.type) {
    case EventType.RAW:
      return true;
    default:
      return false;
  }
}

function applyNativeRuntimeEvent(
  state: ThreadViewModelState,
  event: BaseEvent,
):
  | {
      runtimeState: ThreadViewRuntimeState;
      runtimeActivities: ThreadViewRuntimeActivities;
      quarantineEntry?: undefined;
    }
  | {
      quarantineEntry: ThreadViewQuarantineEntry;
    }
  | null {
  switch (event.type) {
    case EventType.STATE_SNAPSHOT: {
      const snapshot = getObjectField(event, "snapshot");
      if (!snapshot) {
        return malformedNativeRuntimeEvent(event);
      }
      return {
        runtimeState: { ...snapshot },
        runtimeActivities: state.runtimeActivities,
      };
    }
    case EventType.STATE_DELTA: {
      const delta = getArrayField(event, "delta");
      if (!delta) {
        return malformedNativeRuntimeEvent(event);
      }
      const runtimeState = applyJsonPatchOperations(state.runtimeState, delta);
      if (!runtimeState) {
        return malformedNativeRuntimeEvent(event);
      }
      return {
        runtimeState,
        runtimeActivities: state.runtimeActivities,
      };
    }
    case EventType.ACTIVITY_SNAPSHOT: {
      const messageId = getStringField(event, "messageId");
      const activityType = getStringField(event, "activityType");
      const content = getObjectField(event, "content");
      if (!messageId || !activityType || !content) {
        return malformedNativeRuntimeEvent(event);
      }
      const key = getRuntimeActivityKey(messageId, activityType);
      const replace = getBooleanField(event, "replace") ?? true;
      const previousContent = state.runtimeActivities[key]?.content;
      return {
        runtimeState: state.runtimeState,
        runtimeActivities: {
          ...state.runtimeActivities,
          [key]: {
            messageId,
            activityType,
            content:
              replace || !previousContent
                ? { ...content }
                : { ...previousContent, ...content },
          },
        },
      };
    }
    case EventType.ACTIVITY_DELTA: {
      const messageId = getStringField(event, "messageId");
      const activityType = getStringField(event, "activityType");
      const patch = getArrayField(event, "patch");
      if (!messageId || !activityType || !patch) {
        return malformedNativeRuntimeEvent(event);
      }
      const key = getRuntimeActivityKey(messageId, activityType);
      const previous = state.runtimeActivities[key];
      const content = applyJsonPatchOperations(previous?.content ?? {}, patch);
      if (!content) {
        return malformedNativeRuntimeEvent(event);
      }
      return {
        runtimeState: state.runtimeState,
        runtimeActivities: {
          ...state.runtimeActivities,
          [key]: { messageId, activityType, content },
        },
      };
    }
    default:
      return null;
  }
}

function malformedNativeRuntimeEvent(event: BaseEvent): {
  quarantineEntry: ThreadViewQuarantineEntry;
} {
  return {
    quarantineEntry: {
      reason: "malformed-native-runtime-event",
      eventType: String(event.type),
    },
  };
}

function getRuntimeActivityKey(
  messageId: string,
  activityType: string,
): string {
  return `${encodeURIComponent(messageId)}:${encodeURIComponent(activityType)}`;
}

function getAgentMessageTextContent(message: UIMessage): string | null {
  if (message.role !== "agent") {
    return null;
  }
  if (message.parts.length === 0) {
    return null;
  }
  let hasTextPart = false;
  let content = "";
  for (const part of message.parts) {
    if (part.type === "text") {
      hasTextPart = true;
      content += part.text;
    }
  }
  return hasTextPart ? content : null;
}

function shouldPreferHydrationReplayMessage({
  previous,
  current,
  previousIsCanonical,
}: {
  previous: UIMessage;
  current: UIMessage;
  previousIsCanonical: boolean;
}): boolean {
  if (previous.role !== "agent" || current.role !== "agent") {
    return false;
  }
  if (previousIsCanonical) {
    return true;
  }
  return (
    countRenderableAgentParts(current) >= countRenderableAgentParts(previous)
  );
}

function countRenderableAgentParts(message: UIMessage & { role: "agent" }) {
  return message.parts.filter((part) => part.type !== "text").length;
}

function isSameUserMessage(left: UIMessage, right: UIMessage): boolean {
  if (left.role !== "user" || right.role !== "user") {
    return false;
  }
  if (left.timestamp && right.timestamp && left.timestamp === right.timestamp) {
    return true;
  }
  return stableSerialize(left.parts) === stableSerialize(right.parts);
}
