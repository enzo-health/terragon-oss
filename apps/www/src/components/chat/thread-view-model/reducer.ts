import { EventType, type BaseEvent } from "@ag-ui/core";
import type { UIMessage } from "@terragon/shared";
import {
  createRepoFileArtifactDescriptor,
  createRepoTreeArtifactDescriptor,
} from "@terragon/shared/db/artifact-descriptors";
import {
  agUiMessagesReducer,
  createInitialAgUiMessagesState,
} from "../ag-ui-messages-reducer";
import { getField } from "../ag-ui-reducer-utils";
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
  preserveSynthesizedDescriptors,
  upsertSynthesizedDescriptor,
} from "./artifact-descriptors";
import { applyOptimisticUserSubmit } from "./optimistic-events";
import {
  applyLifecycleEvent,
  applyMetaEvent,
  extractThreadLifecycleMessages,
  getQuarantineEntry,
  mergeMetaSnapshot,
  splitThreadLifecycleMessages,
} from "./thread-view-model-lifecycle-events";
import { applyNativeRuntimeEvent } from "./thread-view-model-runtime-events";
import type {
  ThreadViewEvent,
  ThreadViewModel,
  ThreadViewModelState,
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
    lifecycleMessages: extractThreadLifecycleMessages(snapshot.uiMessages),
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
    case "repo-file.opened":
      return {
        ...state,
        artifacts: upsertSynthesizedDescriptor(
          state.artifacts,
          createRepoFileArtifactDescriptor({
            path: event.path,
            ref: event.ref,
            lineRange: event.lineRange,
          }),
        ),
      };
    case "repo-tree.opened":
      return {
        ...state,
        artifacts: upsertSynthesizedDescriptor(
          state.artifacts,
          createRepoTreeArtifactDescriptor({ ref: event.ref }),
        ),
      };
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

export function projectThreadViewModel(
  state: ThreadViewModelState,
  options: { includeTranscriptMessages?: boolean } = {},
): ThreadViewModel {
  const baseProjection = {
    threadId: state.threadId,
    threadChatId: state.threadChatId,
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

  if (options.includeTranscriptMessages === false) {
    return {
      ...baseProjection,
      messages: [],
      lifecycleMessages: state.lifecycleMessages,
    };
  }

  const splitMessages = splitThreadLifecycleMessages(
    collapseHydrationReplayTextDuplicates(state.transcript.messages),
  );
  return {
    ...baseProjection,
    messages: splitMessages.transcriptMessages,
    lifecycleMessages: splitMessages.lifecycleMessages,
  };
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
  const lifecycleMessages = shouldReplaceTranscript
    ? extractThreadLifecycleMessages(snapshot.uiMessages)
    : state.lifecycleMessages;

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
      ? preserveSynthesizedDescriptors(state.artifacts, snapshot.artifacts)
      : getArtifactsForStateMessages(state, snapshot.artifactThread),
    sidePanel: shouldPreserveLocalTranscriptState
      ? state.sidePanel
      : snapshot.sidePanel,
    meta: mergeMetaSnapshot(state.meta, snapshot.meta),
    githubSummary: snapshot.githubSummary,
    lifecycle,
    lifecycleMessages,
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

  const nativeRuntimeProjection = applyNativeRuntimeEvent(state, event);
  if (nativeRuntimeProjection?.quarantineEntry) {
    const tracked = trackDedupeKeyIfNeeded(state, dedupeKey);
    return {
      ...state,
      seenEventKeys: tracked.seenEventKeys,
      seenEventOrder: tracked.seenEventOrder,
      quarantine: [
        ...state.quarantine,
        nativeRuntimeProjection.quarantineEntry,
      ],
    };
  }

  const quarantineEntry = getQuarantineEntry(event);
  if (quarantineEntry) {
    const tracked = trackDedupeKeyIfNeeded(state, dedupeKey);
    return {
      ...state,
      seenEventKeys: tracked.seenEventKeys,
      seenEventOrder: tracked.seenEventOrder,
      quarantine: [...state.quarantine, quarantineEntry],
    };
  }

  const meta = applyMetaEvent(state.meta, event);
  const lifecycle = applyLifecycleEvent(state.lifecycle, event);
  const transcript = agUiMessagesReducer(state.transcript, event);
  const transcriptChanged = transcript !== state.transcript;
  const lifecycleMessages =
    transcriptChanged && shouldRefreshLifecycleMessagesForEvent(event)
      ? extractThreadLifecycleMessages(transcript.messages)
      : state.lifecycleMessages;
  const runtimeState =
    nativeRuntimeProjection?.runtimeState ?? state.runtimeState;
  const runtimeActivities =
    nativeRuntimeProjection?.runtimeActivities ?? state.runtimeActivities;
  const artifactReferenceDescriptor = getArtifactReferenceDescriptor(event);
  const artifactBase =
    transcriptChanged && shouldRefreshArtifactsForEvent(state, event)
      ? getStableArtifactsForMessages({
          previous: state.artifacts,
          messages: collapseHydrationReplayTextDuplicates(transcript.messages),
          artifactThread: state.artifactThread,
        })
      : state.artifacts;
  const artifacts = upsertSynthesizedDescriptor(
    artifactBase,
    artifactReferenceDescriptor,
  );
  if (
    !transcriptChanged &&
    artifacts === state.artifacts &&
    meta === state.meta &&
    lifecycle === state.lifecycle &&
    runtimeState === state.runtimeState &&
    runtimeActivities === state.runtimeActivities &&
    lifecycleMessages === state.lifecycleMessages
  ) {
    return state;
  }

  const tracked = trackDedupeKeyIfNeeded(state, dedupeKey);
  return {
    ...state,
    transcript,
    artifacts,
    meta,
    lifecycle,
    runtimeState,
    runtimeActivities,
    lifecycleMessages,
    threadStatus: lifecycle.threadStatus,
    seenEventKeys: tracked.seenEventKeys,
    seenEventOrder: tracked.seenEventOrder,
    hasLiveTranscriptEvents: transcriptChanged || state.hasLiveTranscriptEvents,
    hasLiveLifecycleEvents:
      lifecycle !== state.lifecycle || state.hasLiveLifecycleEvents,
  };
}

function trackDedupeKeyIfNeeded(
  state: ThreadViewModelState,
  dedupeKey: string | null,
): Pick<ThreadViewModelState, "seenEventKeys" | "seenEventOrder"> {
  if (!dedupeKey) {
    return {
      seenEventKeys: state.seenEventKeys,
      seenEventOrder: state.seenEventOrder,
    };
  }

  const seenEventKeys = new Set(state.seenEventKeys);
  const seenEventOrder = state.seenEventOrder.slice();
  trackSeenAgUiEventKey({
    seenEventKeys,
    seenEventOrder,
    key: dedupeKey,
  });
  return { seenEventKeys, seenEventOrder };
}

function shouldRefreshLifecycleMessagesForEvent(event: BaseEvent): boolean {
  return event.type === EventType.MESSAGES_SNAPSHOT;
}

function shouldRefreshArtifactsForEvent(
  state: ThreadViewModelState,
  event: BaseEvent,
): boolean {
  switch (event.type) {
    case EventType.MESSAGES_SNAPSHOT:
    case EventType.TOOL_CALL_RESULT:
      return true;
    case EventType.TOOL_CALL_START:
      return getField<string>(event, "toolCallName") === "ExitPlanMode";
    case EventType.TEXT_MESSAGE_CONTENT:
      return textDeltaCompletesProposedPlanArtifact(state, event);
    case EventType.CUSTOM:
      return getField<string>(event, "name") === "terragon.data-part";
    default:
      return false;
  }
}

function textDeltaCompletesProposedPlanArtifact(
  state: ThreadViewModelState,
  event: BaseEvent,
): boolean {
  const messageId = getField<string>(event, "messageId");
  const delta = getField<string>(event, "delta");
  if (!messageId || !delta) {
    return false;
  }
  const previousText = getAgentMessageTextContentById(state, messageId);
  if (previousText === null) {
    return delta.toLowerCase().includes(PROPOSED_PLAN_END_TAG);
  }
  const previousCloseCount = countProposedPlanCloseTags(previousText);
  const nextCloseCount = countProposedPlanCloseTags(previousText + delta);
  return nextCloseCount > previousCloseCount;
}

const PROPOSED_PLAN_END_TAG = "</proposed_plan>";

function getAgentMessageTextContentById(
  state: ThreadViewModelState,
  messageId: string,
): string | null {
  const messageIndex = state.transcript.assistantMessageIndexes[messageId];
  const message =
    messageIndex === undefined
      ? undefined
      : state.transcript.messages[messageIndex];
  return message ? getAgentMessageTextContent(message) : null;
}

function countProposedPlanCloseTags(text: string): number {
  const lower = text.toLowerCase();
  let count = 0;
  let index = 0;
  while (true) {
    const nextIndex = lower.indexOf(PROPOSED_PLAN_END_TAG, index);
    if (nextIndex === -1) {
      return count;
    }
    count += 1;
    index = nextIndex + PROPOSED_PLAN_END_TAG.length;
  }
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
