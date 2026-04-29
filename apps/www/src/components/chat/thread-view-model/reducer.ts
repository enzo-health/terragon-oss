import type { BaseEvent } from "@ag-ui/core";
import { EventType } from "@ag-ui/core";
import type {
  DBSystemMessage,
  DBUserMessage,
  ThreadStatus,
  UIMessage,
  UISystemMessage,
} from "@terragon/shared";
import type { ArtifactDescriptor } from "@terragon/shared/db/artifact-descriptors";
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
import { getArtifactDescriptorsForMessages } from "./snapshot-adapter";
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
      return applyAgUiEvent(state, event.event);
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
): ThreadViewModel {
  const splitMessages = splitThreadLifecycleMessages(
    collapseHydrationReplayTextDuplicates(state.transcript.messages),
  );
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

function splitThreadLifecycleMessages(messages: UIMessage[]): {
  transcriptMessages: UIMessage[];
  lifecycleMessages: UISystemMessage[];
} {
  const transcriptMessages: UIMessage[] = [];
  const lifecycleMessages: UISystemMessage[] = [];

  for (const message of messages) {
    if (
      message.role === "system" &&
      message.message_type !== "stop" &&
      message.message_type !== "git-diff" &&
      THREAD_LIFECYCLE_MESSAGE_TYPES.has(message.message_type)
    ) {
      lifecycleMessages.push(message);
      continue;
    }
    transcriptMessages.push(message);
  }

  return { transcriptMessages, lifecycleMessages };
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

    const previousText = getTextOnlyAgentMessageContent(previous);
    const currentText = getTextOnlyAgentMessageContent(message);
    if (
      previousText === null ||
      currentText === null ||
      previousText !== currentText
    ) {
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
      if (previousCanonical) {
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
  const transcript = agUiMessagesReducer(state.transcript, event);
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
    hasLiveTranscriptEvents:
      transcript !== state.transcript || state.hasLiveTranscriptEvents,
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

function getStableArtifactsForMessages({
  previous,
  messages,
  artifactThread,
}: {
  previous: ThreadViewModelState["artifacts"];
  messages: UIMessage[];
  artifactThread: ThreadViewModelState["artifactThread"];
}): ThreadViewModelState["artifacts"] {
  const preservedReferenceDescriptors = previous.descriptors.filter(
    (descriptor) => descriptor.origin.type === "artifact-reference",
  );
  const next = {
    descriptors: mergeArtifactDescriptors([
      ...preservedReferenceDescriptors,
      ...getArtifactDescriptorsForMessages({
        messages,
        artifactThread,
      }),
    ]),
  };
  return areArtifactDescriptorsStable(previous.descriptors, next.descriptors)
    ? previous
    : next;
}

function preserveArtifactReferenceDescriptors(
  current: ThreadViewModelState["artifacts"],
  snapshot: ThreadViewModelState["artifacts"],
): ThreadViewModelState["artifacts"] {
  const referenceDescriptors = current.descriptors.filter(
    (descriptor) => descriptor.origin.type === "artifact-reference",
  );
  if (referenceDescriptors.length === 0) {
    return snapshot;
  }
  const descriptors = mergeArtifactDescriptors([
    ...referenceDescriptors,
    ...snapshot.descriptors,
  ]);
  return areArtifactDescriptorsStable(current.descriptors, descriptors)
    ? current
    : { descriptors };
}

function upsertArtifactReferenceDescriptor(
  artifacts: ThreadViewModelState["artifacts"],
  descriptor: ArtifactDescriptor | null,
): ThreadViewModelState["artifacts"] {
  if (!descriptor) {
    return artifacts;
  }
  const nextDescriptors = mergeArtifactDescriptors([
    descriptor,
    ...artifacts.descriptors,
  ]);
  return areArtifactDescriptorsStable(artifacts.descriptors, nextDescriptors)
    ? artifacts
    : { descriptors: nextDescriptors };
}

function mergeArtifactDescriptors(
  descriptors: ArtifactDescriptor[],
): ArtifactDescriptor[] {
  const seen = new Set<string>();
  const next: ArtifactDescriptor[] = [];
  for (const descriptor of descriptors) {
    if (seen.has(descriptor.id)) {
      continue;
    }
    seen.add(descriptor.id);
    next.push(descriptor);
  }
  return next;
}

function getArtifactReferenceDescriptor(
  event: BaseEvent,
): ArtifactDescriptor | null {
  if (event.type !== EventType.CUSTOM) {
    return null;
  }
  const name = getStringField(event, "name");
  if (name !== "artifact-reference") {
    return null;
  }
  const value = getObjectField(event, "value");
  const artifactId = getStringField(value, "artifactId");
  const artifactType = getStringField(value, "artifactType");
  const title = getStringField(value, "title");
  const status = getStringField(value, "status");
  if (
    !artifactId ||
    artifactType !== "plan" ||
    !title ||
    (status !== null && status !== "ready")
  ) {
    return null;
  }
  const uri = getStringField(value, "uri");
  return {
    id: `artifact:reference:${artifactId}`,
    kind: "plan",
    title,
    status: "ready",
    part: {
      type: "plan",
      title,
      planText: uri ? `${title}\n\n${uri}` : title,
    },
    origin: {
      type: "artifact-reference",
      artifactId,
      artifactType,
      uri,
      fingerprint: artifactId,
    },
    summary: uri ?? undefined,
  };
}

function areArtifactDescriptorsStable(
  previous: ThreadViewModelState["artifacts"]["descriptors"],
  next: ThreadViewModelState["artifacts"]["descriptors"],
): boolean {
  if (previous === next) {
    return true;
  }
  if (previous.length !== next.length) {
    return false;
  }
  for (let index = 0; index < previous.length; index += 1) {
    const left = previous[index]!;
    const right = next[index]!;
    if (
      left.id !== right.id ||
      left.kind !== right.kind ||
      left.status !== right.status ||
      left.title !== right.title ||
      left.updatedAt !== right.updatedAt
    ) {
      return false;
    }
  }
  return true;
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

type JsonPatchOperation =
  | {
      op: "add" | "replace";
      path: string;
      value: unknown;
    }
  | {
      op: "remove";
      path: string;
    };

function applyJsonPatchOperations(
  root: Record<string, unknown>,
  operations: unknown[],
): Record<string, unknown> | null {
  let next: unknown = { ...root };
  for (const operation of operations) {
    const patchOperation = parseJsonPatchOperation(operation);
    if (!patchOperation) {
      return null;
    }
    next = applyJsonPatchOperation(next, patchOperation);
    if (!next || typeof next !== "object" || Array.isArray(next)) {
      return null;
    }
  }
  return next as Record<string, unknown>;
}

function parseJsonPatchOperation(value: unknown): JsonPatchOperation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const op = getStringField(value, "op");
  const path = getJsonPointerPathField(value);
  if (!op || path === null) {
    return null;
  }
  if (op === "remove") {
    return { op, path };
  }
  if (op === "add" || op === "replace") {
    return { op, path, value: Reflect.get(value, "value") };
  }
  return null;
}

function applyJsonPatchOperation(
  root: unknown,
  operation: JsonPatchOperation,
): unknown | null {
  if (operation.path === "") {
    if (operation.op === "remove") {
      return {};
    }
    return getRecordValue(operation.value);
  }

  const tokens = parseJsonPointer(operation.path);
  if (!tokens || tokens.length === 0) {
    return null;
  }
  const clone = cloneContainer(root);
  if (!clone) {
    return null;
  }
  let cursor: unknown = clone;
  for (const token of tokens.slice(0, -1)) {
    const child = getContainerChild(cursor, token);
    const clonedChild = cloneContainer(child);
    if (!clonedChild || !setContainerChild(cursor, token, clonedChild)) {
      return null;
    }
    cursor = clonedChild;
  }
  const finalToken = tokens[tokens.length - 1]!;
  if (operation.op === "remove") {
    return removeContainerChild(cursor, finalToken) ? clone : null;
  }
  return setContainerChild(cursor, finalToken, operation.value, operation.op)
    ? clone
    : null;
}

function parseJsonPointer(path: string): string[] | null {
  if (!path.startsWith("/")) {
    return null;
  }
  const tokens = path
    .slice(1)
    .split("/")
    .map((token) => token.replaceAll("~1", "/").replaceAll("~0", "~"));
  return tokens.every(isSafeJsonPointerToken) ? tokens : null;
}

function isSafeJsonPointerToken(token: string): boolean {
  return (
    token !== "__proto__" && token !== "constructor" && token !== "prototype"
  );
}

function cloneContainer(
  value: unknown,
): Record<string, unknown> | unknown[] | null {
  if (Array.isArray(value)) {
    return value.slice();
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value));
  }
  return null;
}

function getContainerChild(container: unknown, token: string): unknown {
  if (Array.isArray(container)) {
    const index = parseArrayIndex(token, container.length, false);
    return index === null ? undefined : container[index];
  }
  if (container && typeof container === "object") {
    return Object.hasOwn(container, token)
      ? Reflect.get(container, token)
      : undefined;
  }
  return undefined;
}

function setContainerChild(
  container: unknown,
  token: string,
  value: unknown,
  op: "add" | "replace" = "replace",
): boolean {
  if (Array.isArray(container)) {
    const index = parseArrayIndex(token, container.length, op === "add");
    if (index === null) {
      return false;
    }
    if (op === "add") {
      container.splice(index, 0, value);
      return true;
    }
    if (index >= container.length) {
      return false;
    }
    container[index] = value;
    return true;
  }
  if (container && typeof container === "object") {
    if (op === "replace" && !Object.hasOwn(container, token)) {
      return false;
    }
    return Reflect.set(container, token, value);
  }
  return false;
}

function removeContainerChild(container: unknown, token: string): boolean {
  if (Array.isArray(container)) {
    const index = parseArrayIndex(token, container.length, false);
    if (index === null || index >= container.length) {
      return false;
    }
    container.splice(index, 1);
    return true;
  }
  if (container && typeof container === "object") {
    if (!Object.hasOwn(container, token)) {
      return false;
    }
    return Reflect.deleteProperty(container, token);
  }
  return false;
}

function parseArrayIndex(
  token: string,
  length: number,
  allowAppend: boolean,
): number | null {
  if (allowAppend && token === "-") {
    return length;
  }
  if (!/^(0|[1-9]\d*)$/.test(token)) {
    return null;
  }
  const index = Number(token);
  if (!Number.isSafeInteger(index) || index < 0 || index > length) {
    return null;
  }
  return index;
}

function getRecordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}

function getTextOnlyAgentMessageContent(message: UIMessage): string | null {
  if (message.role !== "agent") {
    return null;
  }
  if (message.parts.length === 0) {
    return null;
  }
  let hasTextPart = false;
  let content = "";
  for (const part of message.parts) {
    if (part.type !== "text") {
      return null;
    }
    hasTextPart = true;
    content += part.text;
  }
  return hasTextPart ? content : null;
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
  const entries = Object.entries(value).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  return `{${entries
    .map(
      ([key, entryValue]) =>
        `${JSON.stringify(key)}:${stableSerialize(entryValue)}`,
    )
    .join(",")}}`;
}

function getObjectField(
  value: unknown,
  field: string,
): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = Reflect.get(value, field);
  return candidate && typeof candidate === "object" && !Array.isArray(candidate)
    ? Object.fromEntries(Object.entries(candidate))
    : null;
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

function getJsonPointerPathField(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = Reflect.get(value, "path");
  return typeof candidate === "string" ? candidate : null;
}

function getArrayField(value: unknown, field: string): unknown[] | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = Reflect.get(value, field);
  return Array.isArray(candidate) ? candidate : null;
}

function getBooleanField(value: unknown, field: string): boolean | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = Reflect.get(value, field);
  return typeof candidate === "boolean" ? candidate : null;
}

function getNumberField(value: unknown, field: string): number | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = Reflect.get(value, field);
  return typeof candidate === "number" && Number.isFinite(candidate)
    ? candidate
    : null;
}

function isRenderablePartShape(
  value: Readonly<Record<string, unknown>>,
): boolean {
  const type = getStringField(value, "type");
  switch (type) {
    case "text":
      return typeof value.text === "string";
    case "thinking":
      return typeof value.thinking === "string";
    case "image":
      return typeof value.image_url === "string";
    case "rich-text":
      return Array.isArray(value.nodes);
    case "pdf":
      return typeof value.pdf_url === "string";
    case "text-file":
      return typeof value.file_url === "string";
    case "plan":
      return (
        typeof value.planText === "string" ||
        (Array.isArray(value.entries) &&
          value.entries.every(isRenderablePlanEntry))
      );
    case "tool":
      return (
        typeof value.id === "string" &&
        typeof value.name === "string" &&
        Array.isArray(value.parts)
      );
    case "delegation":
      return (
        typeof value.id === "string" &&
        typeof value.agentName === "string" &&
        typeof value.message === "string" &&
        typeof value.status === "string"
      );
    case "audio":
      return typeof value.mimeType === "string";
    case "resource-link":
      return typeof value.uri === "string" && typeof value.name === "string";
    case "terminal":
      return (
        typeof value.sandboxId === "string" &&
        typeof value.terminalId === "string" &&
        Array.isArray(value.chunks) &&
        value.chunks.every(isRenderableTerminalChunk)
      );
    case "diff":
      return (
        (value.filePath === undefined || typeof value.filePath === "string") &&
        (typeof value.newContent === "string" ||
          typeof value.unifiedDiff === "string" ||
          typeof value.diff === "string") &&
        (value.status === undefined ||
          isDiffStatus(getStringField(value, "status")))
      );
    case "auto-approval-review":
      return (
        typeof value.reviewId === "string" &&
        typeof value.targetItemId === "string" &&
        typeof value.action === "string" &&
        isRiskLevel(getStringField(value, "riskLevel")) &&
        isAutoApprovalReviewStatus(getStringField(value, "status"))
      );
    case "plan-structured":
      return (
        Array.isArray(value.entries) &&
        value.entries.every(isRenderablePlanEntry)
      );
    case "server-tool-use":
      return (
        typeof value.id === "string" &&
        typeof value.name === "string" &&
        value.input !== null &&
        typeof value.input === "object" &&
        !Array.isArray(value.input)
      );
    case "web-search-result":
      return (
        typeof value.toolUseId === "string" &&
        (value.results === undefined ||
          (Array.isArray(value.results) &&
            value.results.every(isRenderableWebSearchResult))) &&
        (value.errorCode === undefined || typeof value.errorCode === "string")
      );
    default:
      const _exhaustiveCheck = type satisfies string | null;
      void _exhaustiveCheck;
      return false;
  }
}

function isRenderableTerminalChunk(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return (
    typeof Reflect.get(value, "streamSeq") === "number" &&
    Number.isInteger(Reflect.get(value, "streamSeq")) &&
    (Reflect.get(value, "kind") === "stdout" ||
      Reflect.get(value, "kind") === "stderr" ||
      Reflect.get(value, "kind") === "interaction") &&
    typeof Reflect.get(value, "text") === "string"
  );
}

function isDiffStatus(value: string | null): boolean {
  return value === "pending" || value === "applied" || value === "rejected";
}

function isRiskLevel(value: string | null): boolean {
  return value === "low" || value === "medium" || value === "high";
}

function isAutoApprovalReviewStatus(value: string | null): boolean {
  return value === "pending" || value === "approved" || value === "denied";
}

function isRenderablePlanEntry(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const priority = Reflect.get(value, "priority");
  const status = Reflect.get(value, "status");
  return (
    typeof Reflect.get(value, "content") === "string" &&
    (priority === "high" || priority === "medium" || priority === "low") &&
    (status === "pending" ||
      status === "in_progress" ||
      status === "completed" ||
      status === "failed")
  );
}

function isRenderableWebSearchResult(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return (
    typeof Reflect.get(value, "url") === "string" &&
    typeof Reflect.get(value, "title") === "string" &&
    (Reflect.get(value, "pageAge") === undefined ||
      typeof Reflect.get(value, "pageAge") === "string") &&
    (Reflect.get(value, "encryptedContent") === undefined ||
      typeof Reflect.get(value, "encryptedContent") === "string")
  );
}

function isThreadStatus(value: string | null): value is ThreadStatus {
  switch (value) {
    case "draft":
    case "scheduled":
    case "queued":
    case "queued-blocked":
    case "queued-tasks-concurrency":
    case "queued-sandbox-creation-rate-limit":
    case "queued-agent-rate-limit":
    case "booting":
    case "working":
    case "stopping":
    case "checkpointing":
    case "working-stopped":
    case "working-error":
    case "working-done":
    case "stopped":
    case "complete":
    case "error":
      return true;
    default:
      const _exhaustiveCheck = value satisfies string | null;
      void _exhaustiveCheck;
      return false;
  }
}
