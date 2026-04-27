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
} from "@terragon/shared";
import type { ArtifactDescriptor } from "@terragon/shared/db/artifact-descriptors";
import type { ThreadPageChat } from "@terragon/shared/db/types";
import type { AgUiMessagesState } from "../ag-ui-messages-reducer";
import type { ThreadMetaSnapshot } from "../meta-chips/use-thread-meta-events";

/*
 * Projection contract:
 * - Event order is snapshot hydration, then optimistic local intent, then
 *   canonical/live AG-UI events; server refetch may reconcile the snapshot.
 * - Source precedence is canonical/live event > optimistic local intent >
 *   collection snapshot > React Query snapshot > legacy DB message fallback.
 * - `legacy-db-message-adapter` and `ag-ui-adapter` are read-only historical
 *   adapters. New runs must write canonical runtime events, not new DBMessage
 *   transcript variants or assistant-ui internal message state.
 * - Adapter deletion criteria: remove the DB adapter when all thread snapshots
 *   hydrate from canonical event replay; remove the AG-UI adapter when runtime
 *   events are consumed directly by this reducer.
 */

export type ThreadViewSnapshotSource = "collection" | "react-query";

export type ThreadViewSnapshot = {
  source: ThreadViewSnapshotSource;
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
  messages: UIMessage[];
  dbMessages: DBMessage[];
  queuedMessages: DBUserMessage[] | null;
  threadStatus: ThreadStatus | null;
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
      type: "server.refetch-reconciled";
      snapshot: ThreadViewSnapshot;
    };

export type ThreadViewModelState = {
  threadId: string;
  threadChatId: string;
  transcript: AgUiMessagesState;
  dbMessages: DBMessage[];
  queuedMessages: DBUserMessage[] | null;
  threadStatus: ThreadStatus | null;
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
  hasLiveTranscriptEvents: boolean;
  hasLiveLifecycleEvents: boolean;
  hasOptimisticTranscriptEvents: boolean;
  hasOptimisticQueuedMessages: boolean;
  hasOptimisticPermissionMode: boolean;
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

export type ThreadViewQuarantineEntry = {
  reason: "malformed-rich-part" | "reducer-error";
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
