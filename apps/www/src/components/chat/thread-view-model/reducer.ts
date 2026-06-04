import { type BaseEvent } from "@ag-ui/core";
import type { ThreadStatus } from "@terragon/shared";
import {
  createRepoFileArtifactDescriptor,
  createRepoTreeArtifactDescriptor,
} from "@terragon/shared/db/artifact-descriptors";
import { isPrimaryChatLiveThreadStatus } from "@terragon/shared/model/thread-lifecycle-policy";
import { getAgUiEventDedupeKey, trackSeenAgUiEventKey } from "./ag-ui-adapter";
import {
  getArtifactReferenceDescriptor,
  preserveSynthesizedDescriptors,
  upsertSynthesizedDescriptor,
} from "./artifact-descriptors";
import {
  applyOptimisticUserSubmit,
  applyOptimisticUserSubmitRejected,
} from "./optimistic-events";
import {
  applyLifecycleEvent,
  applyMetaEvent,
  extractThreadLifecycleMessages,
  extractThreadLifecycleMessagesFromAgUiSnapshot,
  getQuarantineEntry,
  mergeMetaSnapshot,
} from "./thread-view-model-lifecycle-events";
import { quarantineNativeRuntimeEvent } from "./thread-view-model-runtime-events";
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
    hasLiveLifecycleEvents: false,
    hasOptimisticUserSubmit: false,
    hasOptimisticQueuedMessages: false,
    hasOptimisticPermissionMode: false,
    optimisticPendingSince: null,
    optimisticSubmission: null,
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
      return applySnapshot(
        state,
        event.snapshot,
        "preserve-active-transcript",
        {
          at: event.at,
        },
      );
    case "server.refetch-reconciled":
      return applySnapshot(state, event.snapshot, "replace-transcript");
    case "ag-ui.event":
      return applyAgUiEvent(state, event.event);
    case "runtime.event":
      return applyAgUiEvent(state, event.event);
    case "optimistic.user-submitted":
      return applyOptimisticUserSubmit(state, event);
    case "optimistic.user-submit-rejected":
      return applyOptimisticUserSubmitRejected(state, event);
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
): ThreadViewModel {
  return {
    threadId: state.threadId,
    threadChatId: state.threadChatId,
    lifecycleMessages: state.lifecycleMessages,
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

/**
 * Statuses where the run is definitively over. DB status is the single client
 * liveness authority: a snapshot carrying one of these is authoritative-terminal
 * and, once the local optimistic latch is past its fresh-grace TTL, wins over it.
 */
const TERMINAL_THREAD_STATUSES = new Set<ThreadStatus>([
  "complete",
  "error",
  "stopped",
]);

/**
 * Client-side TTL for an unconfirmed optimistic "started" latch. A fresh
 * optimistic submit holds the snappy overlay for this window even against a
 * stale-cached terminal snapshot. Once the latch has gone unconfirmed past the
 * window — no live lifecycle event and a non-live (terminal/idle) snapshot —
 * the authoritative DB status reverts the UI so it cannot wedge on `working`.
 * A genuine `booting`/`working` DB status is live and never reverts, so a
 * slow-to-boot run is not prematurely de-latched.
 */
export const OPTIMISTIC_SUBMIT_TTL_MS = 15_000;

function isTerminalThreadStatus(status: ThreadStatus | null): boolean {
  return status !== null && TERMINAL_THREAD_STATUSES.has(status);
}

function isLiveThreadStatus(status: ThreadStatus | null): boolean {
  return status !== null && isPrimaryChatLiveThreadStatus(status);
}

function applySnapshot(
  state: ThreadViewModelState,
  snapshot: ThreadViewSnapshot,
  transcriptMode: "preserve-active-transcript" | "replace-transcript",
  options: { at?: number } = {},
): ThreadViewModelState {
  if (isSnapshotNoOp(state, snapshot, transcriptMode)) {
    return state;
  }

  const shouldReplaceLocalState = transcriptMode === "replace-transcript";

  // DB status is authoritative. An optimistic "started" latch that has gone
  // unconfirmed past the fresh-grace TTL against a non-live snapshot yields to
  // the snapshot's DB status (typically terminal) so the UI cannot wedge on
  // `working`. The TTL grace protects a just-submitted follow-up from a
  // stale-cached terminal snapshot reflecting the previous turn.
  const optimisticLatchIsStale =
    state.optimisticPendingSince !== null &&
    options.at !== undefined &&
    !isLiveThreadStatus(snapshot.threadStatus) &&
    options.at - state.optimisticPendingSince > OPTIMISTIC_SUBMIT_TTL_MS;
  const shouldYieldToAuthoritative =
    !shouldReplaceLocalState &&
    optimisticLatchIsStale &&
    isTerminalThreadStatus(snapshot.threadStatus);

  const shouldPreserveOptimisticUser =
    !shouldReplaceLocalState &&
    !shouldYieldToAuthoritative &&
    state.hasOptimisticUserSubmit;
  const shouldPreserveLocalLifecycle =
    !shouldReplaceLocalState &&
    !shouldYieldToAuthoritative &&
    (state.hasLiveLifecycleEvents || state.hasOptimisticUserSubmit);
  const shouldClearLocalLatch =
    shouldReplaceLocalState || shouldYieldToAuthoritative;
  const lifecycle = shouldPreserveLocalLifecycle
    ? state.lifecycle
    : snapshot.lifecycle;
  const threadStatus = shouldPreserveLocalLifecycle
    ? state.threadStatus
    : snapshot.threadStatus;
  const lifecycleMessages = shouldPreserveLocalLifecycle
    ? state.lifecycleMessages
    : extractThreadLifecycleMessages(snapshot.uiMessages);

  return {
    ...state,
    threadId: snapshot.threadId,
    threadChatId: snapshot.threadChatId,
    dbMessages: shouldPreserveOptimisticUser
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
    artifacts: preserveSynthesizedDescriptors(
      state.artifacts,
      snapshot.artifacts,
    ),
    sidePanel: shouldPreserveOptimisticUser
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
    hasOptimisticUserSubmit: shouldClearLocalLatch
      ? false
      : state.hasOptimisticUserSubmit,
    optimisticPendingSince: shouldClearLocalLatch
      ? null
      : state.optimisticPendingSince,
    optimisticSubmission: shouldClearLocalLatch
      ? null
      : state.optimisticSubmission,
    hasOptimisticQueuedMessages: shouldReplaceLocalState
      ? false
      : state.hasOptimisticQueuedMessages,
    hasOptimisticPermissionMode: shouldReplaceLocalState
      ? false
      : state.hasOptimisticPermissionMode,
    hasLiveLifecycleEvents: shouldClearLocalLatch
      ? false
      : state.hasLiveLifecycleEvents,
  };
}

function isSnapshotNoOp(
  state: ThreadViewModelState,
  snapshot: ThreadViewSnapshot,
  transcriptMode: "preserve-active-transcript" | "replace-transcript",
): boolean {
  if (
    transcriptMode === "replace-transcript" ||
    state.hasLiveLifecycleEvents ||
    state.hasOptimisticUserSubmit ||
    state.hasOptimisticQueuedMessages ||
    state.hasOptimisticPermissionMode ||
    snapshot.quarantine.length > 0
  ) {
    return false;
  }

  return (
    state.threadId === snapshot.threadId &&
    state.threadChatId === snapshot.threadChatId &&
    state.dbMessages === snapshot.dbMessages &&
    state.queuedMessages === snapshot.queuedMessages &&
    state.threadStatus === snapshot.threadStatus &&
    state.permissionMode === snapshot.permissionMode &&
    state.hasCheckpoint === snapshot.hasCheckpoint &&
    state.latestGitDiffTimestamp === snapshot.latestGitDiffTimestamp &&
    sameArtifactThread(state.artifactThread, snapshot.artifactThread) &&
    state.sidePanel.messages === snapshot.sidePanel.messages &&
    state.sidePanel.threadChatId === snapshot.sidePanel.threadChatId &&
    sameMetaSnapshot(state.meta, snapshot.meta) &&
    sameGithubSummary(state.githubSummary, snapshot.githubSummary) &&
    sameLifecycle(state.lifecycle, snapshot.lifecycle)
  );
}

function sameArtifactThread(
  previous: ThreadViewModelState["artifactThread"],
  next: ThreadViewSnapshot["artifactThread"],
): boolean {
  return (
    previous.id === next.id &&
    getTime(previous.updatedAt) === getTime(next.updatedAt) &&
    previous.gitDiff === next.gitDiff &&
    previous.gitDiffStats === next.gitDiffStats
  );
}

function sameMetaSnapshot(
  previous: ThreadViewModelState["meta"],
  next: ThreadViewSnapshot["meta"],
): boolean {
  return (
    previous.tokenUsage === next.tokenUsage &&
    previous.rateLimits === next.rateLimits &&
    previous.modelReroute === next.modelReroute &&
    previous.mcpServerStatus === next.mcpServerStatus &&
    previous.bootSteps === next.bootSteps &&
    previous.installProgress === next.installProgress
  );
}

function sameGithubSummary(
  previous: ThreadViewModelState["githubSummary"],
  next: ThreadViewSnapshot["githubSummary"],
): boolean {
  return (
    previous.prStatus === next.prStatus &&
    previous.prChecksStatus === next.prChecksStatus &&
    previous.githubPRNumber === next.githubPRNumber &&
    previous.githubRepoFullName === next.githubRepoFullName
  );
}

function sameLifecycle(
  previous: ThreadViewModelState["lifecycle"],
  next: ThreadViewSnapshot["lifecycle"],
): boolean {
  return (
    previous.threadStatus === next.threadStatus &&
    previous.runId === next.runId &&
    previous.runStarted === next.runStarted &&
    getNullableTime(previous.threadChatUpdatedAt) ===
      getNullableTime(next.threadChatUpdatedAt)
  );
}

function getNullableTime(value: Date | string | null): number | null {
  return value === null ? null : getTime(value);
}

function getTime(value: Date | string): number {
  return typeof value === "string"
    ? new Date(value).getTime()
    : value.getTime();
}

function applyAgUiEvent(
  state: ThreadViewModelState,
  event: BaseEvent,
): ThreadViewModelState {
  const dedupeKey = getAgUiEventDedupeKey(event);
  if (dedupeKey && state.seenEventKeys.has(dedupeKey)) {
    return state;
  }

  const nativeRuntimeQuarantineEntry = quarantineNativeRuntimeEvent(event);
  if (nativeRuntimeQuarantineEntry) {
    const tracked = trackDedupeKeyIfNeeded(state, dedupeKey);
    return {
      ...state,
      seenEventKeys: tracked.seenEventKeys,
      seenEventOrder: tracked.seenEventOrder,
      quarantine: [...state.quarantine, nativeRuntimeQuarantineEntry],
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
  const snapshotLifecycleMessages =
    extractThreadLifecycleMessagesFromAgUiSnapshot(event);
  const lifecycleMessages =
    snapshotLifecycleMessages.length > 0
      ? snapshotLifecycleMessages
      : state.lifecycleMessages;
  const artifactReferenceDescriptor = getArtifactReferenceDescriptor(event);
  const artifacts = upsertSynthesizedDescriptor(
    state.artifacts,
    artifactReferenceDescriptor,
  );
  if (
    artifacts === state.artifacts &&
    meta === state.meta &&
    lifecycle === state.lifecycle &&
    lifecycleMessages === state.lifecycleMessages
  ) {
    return state;
  }

  const tracked = trackDedupeKeyIfNeeded(state, dedupeKey);
  const statusChanged = lifecycle.threadStatus !== state.threadStatus;
  // An authoritative terminal lifecycle event (RUN_FINISHED / RUN_ERROR / a
  // terminal thread.status_changed) ends the turn: drop the optimistic latch so
  // a later snapshot.hydrated cannot resurrect the stale optimistic status.
  const reachedTerminal = isTerminalThreadStatus(lifecycle.threadStatus);
  return {
    ...state,
    artifacts,
    meta,
    lifecycle,
    lifecycleMessages,
    threadStatus: lifecycle.threadStatus,
    optimisticSubmission:
      statusChanged || reachedTerminal ? null : state.optimisticSubmission,
    hasOptimisticUserSubmit: reachedTerminal
      ? false
      : state.hasOptimisticUserSubmit,
    optimisticPendingSince: reachedTerminal
      ? null
      : state.optimisticPendingSince,
    seenEventKeys: tracked.seenEventKeys,
    seenEventOrder: tracked.seenEventOrder,
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
