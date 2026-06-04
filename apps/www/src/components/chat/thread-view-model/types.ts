import type { BaseEvent, Message } from "@ag-ui/core";
import type { AIAgent } from "@terragon/agent/types";
import type {
  DBMessage,
  DBUserMessage,
  GitDiffStats,
  GithubCheckStatus,
  GithubPRStatus,
  ThreadStatus,
  UIMessage,
  UISystemMessage,
} from "@terragon/shared";
import type { ArtifactDescriptor } from "@terragon/shared/db/artifact-descriptors";
import type { ThreadPageChat } from "@terragon/shared/db/types";
import type { RepoFileLineRange } from "@terragon/shared/utils/repo-file-link";
import type { ThreadMetaSnapshot } from "../meta-chips/use-thread-meta-events";

/*
 * Projection contract:
 * - Event order is snapshot hydration, then optimistic local intent, then
 *   canonical/live AG-UI events; server refetch may reconcile the snapshot.
 * - Source precedence is canonical/live event > optimistic local intent >
 *   canonical projectedMessages > collection snapshot > React Query snapshot.
 * - `snapshot-adapter` is the thread snapshot boundary. Canonical snapshots
 *   must be self-contained in `projectedMessages`.
 * - Thread lifecycle notices such as retry/schedule/error system messages are
 *   projected into `lifecycleMessages`, not merged back into AG-UI replay.
 * - `ag-ui-adapter` remains the read-only historical event adapter. New runs
 *   must write canonical runtime events, not assistant-ui internal state.
 */

export type ThreadViewSnapshotSource = "collection" | "react-query";

export type ThreadViewSnapshot = {
  source: ThreadViewSnapshotSource;
  transcriptSource: "ag-ui-replay";
  threadId: string;
  threadChatId: string;
  dbMessages: DBMessage[];
  uiMessages: UIMessage[];
  agUiInitialMessages: Message[];
  agent: AIAgent;
  threadStatus: ThreadStatus | null;
  queuedMessages: DBUserMessage[] | null;
  permissionMode: ThreadPageChat["permissionMode"];
  hasCanonicalProjectionSeed: boolean;
  hasCheckpoint: boolean;
  latestGitDiffTimestamp: string | null;
  artifactThread: ThreadViewArtifactThread;
  artifacts: {
    descriptors: ArtifactDescriptor[];
  };
  sidePanel: {
    messages: DBMessage[];
    threadChatId: string;
  };
  meta: ThreadMetaSnapshot;
  githubSummary: ThreadViewGithubSummary;
  lifecycle: ThreadViewLifecycle;
  quarantine: ThreadViewQuarantineEntry[];
};

export type ThreadViewModel = {
  threadId: string;
  threadChatId: string;
  lifecycleMessages: UISystemMessage[];
  dbMessages: DBMessage[];
  queuedMessages: DBUserMessage[] | null;
  threadStatus: ThreadStatus | null;
  // clientSubmissionId of the single in-flight optimistic submit, or null. Read
  // by chat-ui's onAppendRejected to correlate a rollback once the onError
  // payload carries the id (P4-B); replaces the separate ref then.
  pendingClientSubmissionId: string | null;
  permissionMode: ThreadPageChat["permissionMode"];
  hasCheckpoint: boolean;
  latestGitDiffTimestamp: string | null;
  artifactThread: ThreadViewArtifactThread;
  artifacts: {
    descriptors: ArtifactDescriptor[];
  };
  sidePanel: {
    messages: DBMessage[];
    threadChatId: string;
  };
  meta: ThreadMetaSnapshot;
  githubSummary: ThreadViewGithubSummary;
  lifecycle: ThreadViewLifecycle;
  quarantine: ThreadViewQuarantineEntry[];
};

export type ThreadViewEvent =
  | {
      type: "snapshot.hydrated";
      snapshot: ThreadViewSnapshot;
    }
  | {
      type: "ag-ui.event";
      event: BaseEvent;
    }
  | {
      type: "runtime.event";
      event: BaseEvent;
    }
  | {
      type: "optimistic.user-submitted";
      message: DBUserMessage;
      optimisticStatus: ThreadStatus;
      clientSubmissionId: string;
    }
  | {
      type: "optimistic.user-submit-rejected";
      clientSubmissionId: string;
    }
  | {
      type: "optimistic.queued-messages-updated";
      messages: DBUserMessage[];
    }
  | {
      type: "optimistic.permission-mode-updated";
      permissionMode: ThreadPageChat["permissionMode"];
    }
  | {
      type: "repo-file.opened";
      path: string;
      ref?: string;
      lineRange?: RepoFileLineRange;
    }
  | {
      type: "repo-tree.opened";
      ref?: string;
    }
  | {
      type: "server.refetch-reconciled";
      snapshot: ThreadViewSnapshot;
    };

export type ThreadViewModelState = {
  threadId: string;
  threadChatId: string;
  dbMessages: DBMessage[];
  queuedMessages: DBUserMessage[] | null;
  // Status lives only on `lifecycle.threadStatus`. The public ThreadViewModel
  // exposes a top-level `threadStatus` derived from it in projectThreadViewModel.
  permissionMode: ThreadPageChat["permissionMode"];
  hasCheckpoint: boolean;
  latestGitDiffTimestamp: string | null;
  artifactThread: ThreadViewArtifactThread;
  artifacts: {
    descriptors: ArtifactDescriptor[];
  };
  sidePanel: {
    messages: DBMessage[];
    threadChatId: string;
  };
  meta: ThreadMetaSnapshot;
  githubSummary: ThreadViewGithubSummary;
  lifecycle: ThreadViewLifecycle;
  lifecycleMessages: UISystemMessage[];
  quarantine: ThreadViewQuarantineEntry[];
  hasLiveLifecycleEvents: boolean;
  optimisticOverlay: OptimisticOverlay;
  seenEventKeys: Set<string>;
  seenEventOrder: string[];
};

export type ThreadViewGithubSummary = {
  prStatus: GithubPRStatus | null;
  prChecksStatus: GithubCheckStatus | null;
  githubPRNumber: number | null;
  githubRepoFullName: string;
};

export type ThreadViewLifecycle = {
  threadStatus: ThreadStatus | null;
  runId: string | null;
  runStarted: boolean;
  threadChatUpdatedAt: Date | string | null;
};

export type OptimisticUserSubmitOverlay = {
  clientSubmissionId: string;
  message: DBUserMessage;
  priorLifecycle: ThreadViewLifecycle;
};

export type OptimisticQueuedMessagesOverlay = {
  queuedMessages: DBUserMessage[] | null;
};

export type OptimisticPermissionModeOverlay = {
  permissionMode: ThreadPageChat["permissionMode"];
};

// One nullable slot per optimistic concern. The struct of three nulls is the
// "no overlay" state. Slots coexist (a queued update rides on top of an
// in-flight submit); a single-arm union could not represent that.
export type OptimisticOverlay = {
  userSubmit: OptimisticUserSubmitOverlay | null;
  queuedMessages: OptimisticQueuedMessagesOverlay | null;
  permissionMode: OptimisticPermissionModeOverlay | null;
};

export type ThreadViewQuarantineEntry = {
  reason:
    | "malformed-rich-part"
    | "malformed-native-runtime-event"
    | "reducer-error"
    | "unsupported-ag-ui-event";
  eventType: string;
  messageId?: string;
  partType?: string;
};

export type ThreadViewArtifactThread = {
  id: string;
  updatedAt: Date | string;
  gitDiff: string | null;
  gitDiffStats: GitDiffStats | null;
};
