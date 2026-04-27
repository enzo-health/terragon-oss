import type { AIAgent } from "@terragon/agent/types";
import type {
  DBMessage,
  DBUserMessage,
  GithubCheckStatus,
  GithubPRStatus,
  GitDiffStats,
  ThreadStatus,
  UIMessage,
} from "@terragon/shared";
import { getArtifactDescriptors } from "@terragon/shared/db/artifact-descriptors";
import type { ThreadPageChat } from "@terragon/shared/db/types";
import { dbMessagesToAgUiMessages } from "../db-messages-to-ag-ui";
import type { ThreadMetaSnapshot } from "../meta-chips/use-thread-meta-events";
import { toUIMessages } from "../toUIMessages";
import type { ThreadViewSnapshot, ThreadViewSnapshotSource } from "./types";

export function createEmptyThreadViewSnapshot({
  agent,
  initialMessages = [],
}: {
  agent: AIAgent;
  initialMessages?: UIMessage[];
}): ThreadViewSnapshot {
  const artifactThread = {
    id: "thread-view-model-compat-thread",
    updatedAt: new Date(0),
    gitDiff: null,
    gitDiffStats: null,
  };
  return {
    source: "react-query",
    transcriptSource: "ag-ui-replay",
    threadId: artifactThread.id,
    threadChatId: "thread-view-model-compat-chat",
    dbMessages: [],
    uiMessages: initialMessages,
    agUiInitialMessages: [],
    agent,
    threadStatus: null,
    queuedMessages: null,
    permissionMode: null,
    hasCanonicalProjectionSeed: false,
    hasCheckpoint: false,
    latestGitDiffTimestamp: null,
    artifactThread,
    artifacts: {
      descriptors: getArtifactDescriptors({
        messages: initialMessages,
        thread: artifactThread,
      }),
    },
    sidePanel: {
      messages: [],
      threadChatId: "thread-view-model-compat-chat",
    },
    meta: createInitialThreadMetaSnapshot(),
    githubSummary: {
      prStatus: null,
      prChecksStatus: null,
      githubPRNumber: null,
      githubRepoFullName: "",
    },
    lifecycle: {
      threadStatus: null,
      runId: null,
      runStarted: false,
      threadChatUpdatedAt: null,
    },
    quarantine: [],
  };
}

export function selectThreadViewDbMessages(threadChat: ThreadPageChat): {
  dbMessages: DBMessage[];
  hasCanonicalProjectionSeed: boolean;
} {
  const projected = threadChat.projectedMessages as DBMessage[] | null;
  const isCanonicalProjection = Boolean(threadChat.isCanonicalProjection);
  const dbMessages = projected ?? [];

  return {
    dbMessages,
    hasCanonicalProjectionSeed: isCanonicalProjection && dbMessages.length > 0,
  };
}

export function createThreadViewSnapshot({
  threadChat,
  agent,
  source,
  artifactThread,
  githubSummary,
  meta,
  runId,
}: {
  threadChat: ThreadPageChat;
  agent: AIAgent;
  source: ThreadViewSnapshotSource;
  artifactThread: {
    id: string;
    updatedAt: Date | string;
    gitDiff: string | null;
    gitDiffStats: GitDiffStats | null;
  };
  githubSummary: {
    prStatus: GithubPRStatus | null;
    prChecksStatus: GithubCheckStatus | null;
    githubPRNumber: number | null;
    githubRepoFullName: string;
  };
  meta?: ThreadMetaSnapshot;
  runId?: string | null;
}): ThreadViewSnapshot {
  const { dbMessages, hasCanonicalProjectionSeed } =
    selectThreadViewDbMessages(threadChat);
  const threadStatus = normalizeThreadStatus(threadChat.status);
  const uiMessages = toUIMessages({
    dbMessages,
    agent,
    threadStatus,
    skipSeededAssistantText: hasCanonicalProjectionSeed,
  });
  const agUiInitialMessages = dbMessagesToAgUiMessages(dbMessages, {
    includeAssistantHistory: !hasCanonicalProjectionSeed,
  });

  return {
    source,
    transcriptSource: "ag-ui-replay",
    threadId: threadChat.threadId,
    threadChatId: threadChat.id,
    dbMessages,
    uiMessages,
    agUiInitialMessages,
    agent,
    threadStatus,
    queuedMessages: normalizeQueuedMessages(threadChat.queuedMessages),
    permissionMode: threadChat.permissionMode,
    hasCanonicalProjectionSeed,
    hasCheckpoint: dbMessages.some((message) => message.type === "git-diff"),
    latestGitDiffTimestamp: findLatestGitDiffTimestamp(dbMessages),
    artifactThread,
    artifacts: {
      descriptors: getArtifactDescriptors({
        messages: uiMessages,
        thread: artifactThread,
      }),
    },
    sidePanel: {
      messages: dbMessages,
      threadChatId: threadChat.id,
    },
    meta: meta ?? createInitialThreadMetaSnapshot(),
    githubSummary,
    lifecycle: {
      threadStatus,
      runId: runId ?? null,
      runStarted: runId !== null && runId !== undefined,
      threadChatUpdatedAt: threadChat.updatedAt ?? null,
    },
    quarantine: [],
  };
}

function normalizeThreadStatus(status: ThreadStatus | null | undefined) {
  return status ?? null;
}

function normalizeQueuedMessages(
  messages: ThreadPageChat["queuedMessages"],
): DBUserMessage[] | null {
  return messages && messages.length > 0 ? (messages as DBUserMessage[]) : null;
}

function findLatestGitDiffTimestamp(dbMessages: DBMessage[]): string | null {
  for (let index = dbMessages.length - 1; index >= 0; index--) {
    const message = dbMessages[index];
    if (message?.type === "git-diff") {
      return message.timestamp ?? null;
    }
  }
  return null;
}

export function createInitialThreadMetaSnapshot(): ThreadMetaSnapshot {
  return {
    tokenUsage: null,
    rateLimits: null,
    modelReroute: null,
    mcpServerStatus: {},
    bootSteps: [],
    installProgress: null,
  };
}

export function getArtifactDescriptorsForMessages({
  messages,
  artifactThread,
}: {
  messages: UIMessage[];
  artifactThread: {
    id: string;
    updatedAt: Date | string;
    gitDiff: string | null;
    gitDiffStats: GitDiffStats | null;
  };
}) {
  return getArtifactDescriptors({ messages, thread: artifactThread });
}
