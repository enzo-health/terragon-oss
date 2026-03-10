import {
  BroadcastActiveChatRealtimeFields,
  BroadcastThreadShellRealtimeFields,
} from "@terragon/types/broadcast";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { DB } from "../db";
import * as schema from "../db/schema";
import {
  ThreadPageChat,
  ThreadPageChatSummary,
  ThreadPageDiff,
  ThreadPageShell,
  ThreadStatus,
  ThreadVisibility,
} from "../db/types";
import { LEGACY_THREAD_CHAT_ID } from "../utils/thread-utils";
import { getUser } from "./user";

const activeThreadStatuses: ReadonlySet<ThreadStatus> = new Set([
  "queued",
  "queued-blocked",
  "queued-sandbox-creation-rate-limit",
  "queued-tasks-concurrency",
  "queued-agent-rate-limit",
  "booting",
  "working",
  "stopping",
  "working-stopped",
  "working-error",
  "working-done",
  "checkpointing",
]);

type AuthorizedThreadAccess = {
  ownerUserId: string;
  visibility: ThreadVisibility;
};

type ThreadPageChatSummaryWithCreatedAt = ThreadPageChatSummary & {
  createdAt: Date;
};

async function getAuthorizedThreadAccess({
  db,
  threadId,
  userId,
  getHasRepoPermissions,
  allowAdmin = false,
}: {
  db: DB;
  threadId: string;
  userId: string;
  getHasRepoPermissions?: (repoFullName: string) => Promise<boolean>;
  allowAdmin?: boolean;
}): Promise<AuthorizedThreadAccess | undefined> {
  const threadResultArr = await db
    .select({
      userId: schema.thread.userId,
      githubRepoFullName: schema.thread.githubRepoFullName,
      visibility: sql<ThreadVisibility>`COALESCE(${schema.threadVisibility.visibility}, ${schema.userSettings.defaultThreadVisibility}, 'private')`,
    })
    .from(schema.thread)
    .leftJoin(
      schema.threadVisibility,
      eq(schema.threadVisibility.threadId, schema.thread.id),
    )
    .leftJoin(
      schema.userSettings,
      eq(schema.userSettings.userId, schema.thread.userId),
    )
    .where(eq(schema.thread.id, threadId));

  if (threadResultArr.length === 0) {
    return undefined;
  }

  const threadResult = threadResultArr[0]!;
  if (threadResult.userId === userId) {
    return {
      ownerUserId: threadResult.userId,
      visibility: threadResult.visibility,
    };
  }

  if (allowAdmin) {
    const user = await getUser({ db, userId });
    if (user?.role === "admin") {
      return {
        ownerUserId: threadResult.userId,
        visibility: threadResult.visibility,
      };
    }
  }

  switch (threadResult.visibility) {
    case "private":
      return undefined;
    case "link":
      return {
        ownerUserId: threadResult.userId,
        visibility: threadResult.visibility,
      };
    case "repo":
      if (await getHasRepoPermissions?.(threadResult.githubRepoFullName)) {
        return {
          ownerUserId: threadResult.userId,
          visibility: threadResult.visibility,
        };
      }
      return undefined;
    default: {
      const _exhaustiveCheck: never = threadResult.visibility;
      throw new Error(`Invalid visibility: ${_exhaustiveCheck}`);
    }
  }
}

function getThreadChatTimestampValue(chat: ThreadPageChatSummaryWithCreatedAt) {
  const updatedAtTime = chat.updatedAt.getTime();
  if (Number.isFinite(updatedAtTime)) {
    return updatedAtTime;
  }
  const createdAtTime = chat.createdAt.getTime();
  if (Number.isFinite(createdAtTime)) {
    return createdAtTime;
  }
  return 0;
}

function getPrimaryThreadChatSummary(
  chats: ThreadPageChatSummaryWithCreatedAt[],
): ThreadPageChatSummary {
  const activeChats = chats.filter((chat) =>
    activeThreadStatuses.has(chat.status),
  );
  const candidateChats = activeChats.length > 0 ? activeChats : chats;
  const primaryChat = [...candidateChats].sort(
    (left, right) =>
      getThreadChatTimestampValue(right) - getThreadChatTimestampValue(left),
  )[0];
  if (!primaryChat) {
    throw new Error("Thread does not have any thread chats");
  }
  const { createdAt: _createdAt, ...summary } = primaryChat;
  return summary;
}

function createLegacyThreadChatSummary({
  thread,
  isUnread,
}: {
  thread: Pick<
    typeof schema.thread.$inferSelect,
    | "id"
    | "createdAt"
    | "updatedAt"
    | "agent"
    | "agentVersion"
    | "status"
    | "errorMessage"
    | "errorMessageInfo"
    | "scheduleAt"
    | "reattemptQueueAt"
    | "contextLength"
    | "permissionMode"
  >;
  isUnread: boolean;
}): ThreadPageChatSummaryWithCreatedAt {
  return {
    id: LEGACY_THREAD_CHAT_ID,
    threadId: thread.id,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    agent: thread.agent,
    agentVersion: thread.agentVersion,
    status: thread.status,
    errorMessage: thread.errorMessage,
    errorMessageInfo: thread.errorMessageInfo,
    scheduleAt: thread.scheduleAt,
    reattemptQueueAt: thread.reattemptQueueAt,
    contextLength: thread.contextLength,
    permissionMode: thread.permissionMode ?? "allowAll",
    isUnread,
  };
}

function toThreadPageChatSummaryWithCreatedAt(
  chat: Pick<
    ThreadPageChat,
    | "id"
    | "threadId"
    | "createdAt"
    | "updatedAt"
    | "agent"
    | "agentVersion"
    | "status"
    | "errorMessage"
    | "errorMessageInfo"
    | "scheduleAt"
    | "reattemptQueueAt"
    | "contextLength"
    | "permissionMode"
    | "isUnread"
  >,
): ThreadPageChatSummaryWithCreatedAt {
  return {
    id: chat.id,
    threadId: chat.threadId,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
    agent: chat.agent,
    agentVersion: chat.agentVersion,
    status: chat.status,
    errorMessage: chat.errorMessage,
    errorMessageInfo: chat.errorMessageInfo,
    scheduleAt: chat.scheduleAt,
    reattemptQueueAt: chat.reattemptQueueAt,
    contextLength: chat.contextLength,
    permissionMode: chat.permissionMode ?? "allowAll",
    isUnread: chat.isUnread,
  };
}

function getThreadPageShellSelect() {
  return {
    id: schema.thread.id,
    userId: schema.thread.userId,
    name: schema.thread.name,
    githubRepoFullName: schema.thread.githubRepoFullName,
    repoBaseBranchName: schema.thread.repoBaseBranchName,
    branchName: schema.thread.branchName,
    githubPRNumber: schema.thread.githubPRNumber,
    githubIssueNumber: schema.thread.githubIssueNumber,
    codesandboxId: schema.thread.codesandboxId,
    sandboxProvider: schema.thread.sandboxProvider,
    sandboxSize: schema.thread.sandboxSize,
    sandboxStatus: schema.thread.sandboxStatus,
    bootingSubstatus: schema.thread.bootingSubstatus,
    gitDiffStats: schema.thread.gitDiffStats,
    archived: schema.thread.archived,
    createdAt: schema.thread.createdAt,
    updatedAt: schema.thread.updatedAt,
    automationId: schema.thread.automationId,
    parentThreadId: schema.thread.parentThreadId,
    parentToolId: schema.thread.parentToolId,
    draftMessage: schema.thread.draftMessage,
    disableGitCheckpointing: schema.thread.disableGitCheckpointing,
    skipSetup: schema.thread.skipSetup,
    sourceType: schema.thread.sourceType,
    sourceMetadata: schema.thread.sourceMetadata,
    version: schema.thread.version,
    agent: schema.thread.agent,
    agentVersion: schema.thread.agentVersion,
    status: schema.thread.status,
    errorMessage: schema.thread.errorMessage,
    errorMessageInfo: schema.thread.errorMessageInfo,
    scheduleAt: schema.thread.scheduleAt,
    reattemptQueueAt: schema.thread.reattemptQueueAt,
    contextLength: schema.thread.contextLength,
    permissionMode: schema.thread.permissionMode,
  };
}

function getThreadPageShellThreadChatSummarySelect() {
  return {
    id: schema.threadChat.id,
    threadId: schema.threadChat.threadId,
    createdAt: schema.threadChat.createdAt,
    updatedAt: schema.threadChat.updatedAt,
    agent: schema.threadChat.agent,
    agentVersion: schema.threadChat.agentVersion,
    status: schema.threadChat.status,
    errorMessage: schema.threadChat.errorMessage,
    errorMessageInfo: schema.threadChat.errorMessageInfo,
    scheduleAt: schema.threadChat.scheduleAt,
    reattemptQueueAt: schema.threadChat.reattemptQueueAt,
    contextLength: schema.threadChat.contextLength,
    permissionMode: schema.threadChat.permissionMode,
  };
}

function getThreadPageLegacyChatSelect() {
  return {
    id: schema.thread.id,
    userId: schema.thread.userId,
    name: schema.thread.name,
    createdAt: schema.thread.createdAt,
    updatedAt: schema.thread.updatedAt,
    agent: schema.thread.agent,
    agentVersion: schema.thread.agentVersion,
    status: schema.thread.status,
    messages: schema.thread.messages,
    queuedMessages: schema.thread.queuedMessages,
    sessionId: schema.thread.sessionId,
    errorMessage: schema.thread.errorMessage,
    errorMessageInfo: schema.thread.errorMessageInfo,
    scheduleAt: schema.thread.scheduleAt,
    reattemptQueueAt: schema.thread.reattemptQueueAt,
    contextLength: schema.thread.contextLength,
    permissionMode: schema.thread.permissionMode,
  };
}

function getThreadPageFullChatSelect() {
  return {
    id: schema.threadChat.id,
    userId: schema.threadChat.userId,
    threadId: schema.threadChat.threadId,
    title: schema.threadChat.title,
    createdAt: schema.threadChat.createdAt,
    updatedAt: schema.threadChat.updatedAt,
    agent: schema.threadChat.agent,
    agentVersion: schema.threadChat.agentVersion,
    status: schema.threadChat.status,
    messages: schema.threadChat.messages,
    queuedMessages: schema.threadChat.queuedMessages,
    sessionId: schema.threadChat.sessionId,
    errorMessage: schema.threadChat.errorMessage,
    errorMessageInfo: schema.threadChat.errorMessageInfo,
    scheduleAt: schema.threadChat.scheduleAt,
    reattemptQueueAt: schema.threadChat.reattemptQueueAt,
    contextLength: schema.threadChat.contextLength,
    permissionMode: schema.threadChat.permissionMode,
    codexPreviousResponseId: schema.threadChat.codexPreviousResponseId,
  };
}

export function toBroadcastThreadShellRealtimeFields(
  shell: ThreadPageShell,
): BroadcastThreadShellRealtimeFields {
  return {
    userId: shell.userId,
    name: shell.name,
    automationId: shell.automationId,
    archived: shell.archived,
    visibility: shell.visibility,
    isUnread: shell.isUnread,
    createdAt: shell.createdAt.toISOString(),
    updatedAt: shell.updatedAt.toISOString(),
    branchName: shell.branchName,
    repoBaseBranchName: shell.repoBaseBranchName,
    githubRepoFullName: shell.githubRepoFullName,
    githubPRNumber: shell.githubPRNumber,
    githubIssueNumber: shell.githubIssueNumber,
    prStatus: shell.prStatus,
    prChecksStatus: shell.prChecksStatus,
    sandboxStatus: shell.sandboxStatus,
    bootingSubstatus: shell.bootingSubstatus,
    codesandboxId: shell.codesandboxId,
    sandboxProvider: shell.sandboxProvider,
    sandboxSize: shell.sandboxSize,
    hasGitDiff: shell.hasGitDiff,
    gitDiffStats: shell.gitDiffStats,
    parentThreadId: shell.parentThreadId,
    parentThreadName: shell.parentThreadName,
    parentToolId: shell.parentToolId,
    authorName: shell.authorName,
    authorImage: shell.authorImage,
    draftMessage: shell.draftMessage,
    skipSetup: shell.skipSetup,
    disableGitCheckpointing: shell.disableGitCheckpointing,
    sourceType: shell.sourceType ?? undefined,
    sourceMetadata: shell.sourceMetadata,
    version: shell.version,
    primaryThreadChatId: shell.primaryThreadChatId,
    childThreads: shell.childThreads,
  };
}

export function toBroadcastActiveChatRealtimeFields(
  chat: ThreadPageChat | ThreadPageChatSummary,
): BroadcastActiveChatRealtimeFields {
  return {
    agent: chat.agent,
    agentVersion: chat.agentVersion,
    status: chat.status,
    errorMessage: chat.errorMessage,
    errorMessageInfo: chat.errorMessageInfo,
    scheduleAt: chat.scheduleAt ? chat.scheduleAt.toISOString() : null,
    reattemptQueueAt: chat.reattemptQueueAt
      ? chat.reattemptQueueAt.toISOString()
      : null,
    contextLength: chat.contextLength,
    permissionMode: chat.permissionMode ?? "allowAll",
    isUnread: chat.isUnread,
    updatedAt: chat.updatedAt.toISOString(),
  };
}

export async function getThreadPageShellWithPermissions({
  db,
  threadId,
  userId,
  getHasRepoPermissions,
  allowAdmin = false,
}: {
  db: DB;
  threadId: string;
  userId: string;
  getHasRepoPermissions?: (repoFullName: string) => Promise<boolean>;
  allowAdmin?: boolean;
}): Promise<ThreadPageShell | undefined> {
  const access = await getAuthorizedThreadAccess({
    db,
    threadId,
    userId,
    getHasRepoPermissions,
    allowAdmin,
  });
  if (!access) {
    return undefined;
  }

  const parentThread = alias(schema.thread, "parentThread");
  const [threads, childThreads, threadChats] = await Promise.all([
    db
      .select({
        ...getThreadPageShellSelect(),
        authorName: schema.user.name,
        authorImage: schema.user.image,
        prStatus: schema.githubPR.status,
        prChecksStatus: schema.githubPR.checksStatus,
        parentThreadName: parentThread.name,
        isUnread: sql<boolean>`NOT COALESCE(${schema.threadReadStatus.isRead}, true)`,
        hasGitDiff: sql<boolean>`${schema.thread.gitDiff} IS NOT NULL`,
      })
      .from(schema.thread)
      .leftJoin(
        schema.githubPR,
        and(
          eq(schema.githubPR.repoFullName, schema.thread.githubRepoFullName),
          eq(schema.githubPR.number, schema.thread.githubPRNumber),
        ),
      )
      .leftJoin(parentThread, eq(parentThread.id, schema.thread.parentThreadId))
      .leftJoin(schema.user, eq(schema.user.id, schema.thread.userId))
      .leftJoin(
        schema.threadReadStatus,
        and(
          eq(schema.threadReadStatus.threadId, schema.thread.id),
          eq(schema.threadReadStatus.userId, userId),
        ),
      )
      .where(
        and(
          eq(schema.thread.id, threadId),
          eq(schema.thread.userId, access.ownerUserId),
        ),
      ),
    db.query.thread.findMany({
      columns: {
        id: true,
        parentToolId: true,
      },
      where: eq(schema.thread.parentThreadId, threadId),
      orderBy: (thread) => [desc(thread.createdAt)],
    }),
    db
      .select({
        ...getThreadPageShellThreadChatSummarySelect(),
        isUnread: sql<boolean>`NOT COALESCE(${schema.threadChatReadStatus.isRead}, true)`,
      })
      .from(schema.threadChat)
      .leftJoin(
        schema.threadChatReadStatus,
        and(
          eq(schema.threadChatReadStatus.threadId, schema.threadChat.threadId),
          eq(schema.threadChatReadStatus.userId, userId),
          eq(schema.threadChatReadStatus.threadChatId, schema.threadChat.id),
        ),
      )
      .where(
        and(
          eq(schema.threadChat.threadId, threadId),
          eq(schema.threadChat.userId, access.ownerUserId),
        ),
      )
      .orderBy(asc(schema.threadChat.createdAt)),
  ]);

  const thread = threads[0];
  if (!thread) {
    return undefined;
  }

  const chatSummaries = threadChats.length
    ? threadChats.map(toThreadPageChatSummaryWithCreatedAt)
    : [createLegacyThreadChatSummary({ thread, isUnread: thread.isUnread })];
  const primaryThreadChat = getPrimaryThreadChatSummary(chatSummaries);

  return {
    id: thread.id,
    userId: thread.userId,
    name: thread.name,
    branchName: thread.branchName,
    repoBaseBranchName: thread.repoBaseBranchName,
    githubRepoFullName: thread.githubRepoFullName,
    automationId: thread.automationId,
    codesandboxId: thread.codesandboxId,
    sandboxProvider: thread.sandboxProvider,
    sandboxSize: thread.sandboxSize,
    bootingSubstatus: thread.bootingSubstatus,
    archived: thread.archived,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    visibility: access.visibility,
    prStatus: thread.prStatus,
    prChecksStatus: thread.prChecksStatus,
    authorName: thread.authorName,
    authorImage: thread.authorImage,
    githubPRNumber: thread.githubPRNumber,
    githubIssueNumber: thread.githubIssueNumber,
    sandboxStatus: thread.sandboxStatus,
    gitDiffStats: thread.gitDiffStats,
    parentThreadName: thread.parentThreadName,
    parentThreadId: thread.parentThreadId,
    parentToolId: thread.parentToolId,
    draftMessage: thread.draftMessage,
    skipSetup: thread.skipSetup,
    disableGitCheckpointing: thread.disableGitCheckpointing,
    sourceType: thread.sourceType,
    sourceMetadata: thread.sourceMetadata,
    version: thread.version,
    isUnread: thread.isUnread,
    childThreads,
    hasGitDiff: thread.hasGitDiff,
    primaryThreadChatId: primaryThreadChat.id,
    primaryThreadChat,
  };
}

export async function getThreadPageChatWithPermissions({
  db,
  threadId,
  threadChatId,
  userId,
  getHasRepoPermissions,
  allowAdmin = false,
}: {
  db: DB;
  threadId: string;
  threadChatId: string;
  userId: string;
  getHasRepoPermissions?: (repoFullName: string) => Promise<boolean>;
  allowAdmin?: boolean;
}): Promise<ThreadPageChat | undefined> {
  const access = await getAuthorizedThreadAccess({
    db,
    threadId,
    userId,
    getHasRepoPermissions,
    allowAdmin,
  });
  if (!access) {
    return undefined;
  }

  if (threadChatId === LEGACY_THREAD_CHAT_ID) {
    const threadResult = await db
      .select({
        ...getThreadPageLegacyChatSelect(),
        isUnread: sql<boolean>`NOT COALESCE(${schema.threadReadStatus.isRead}, true)`,
      })
      .from(schema.thread)
      .leftJoin(
        schema.threadReadStatus,
        and(
          eq(schema.threadReadStatus.threadId, schema.thread.id),
          eq(schema.threadReadStatus.userId, userId),
        ),
      )
      .where(
        and(
          eq(schema.thread.id, threadId),
          eq(schema.thread.userId, access.ownerUserId),
        ),
      );

    const thread = threadResult[0];
    if (!thread) {
      return undefined;
    }

    const messages = thread.messages ?? [];
    return {
      id: LEGACY_THREAD_CHAT_ID,
      userId: thread.userId,
      threadId: thread.id,
      title: thread.name ?? null,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      agent: thread.agent,
      agentVersion: thread.agentVersion,
      status: thread.status,
      sessionId: thread.sessionId,
      errorMessage: thread.errorMessage,
      errorMessageInfo: thread.errorMessageInfo,
      scheduleAt: thread.scheduleAt,
      reattemptQueueAt: thread.reattemptQueueAt,
      contextLength: thread.contextLength,
      permissionMode: thread.permissionMode ?? "allowAll",
      codexPreviousResponseId: null,
      isUnread: thread.isUnread,
      messages,
      queuedMessages: thread.queuedMessages ?? [],
      messageCount: messages.length,
      chatSequence: null,
    };
  }

  const threadChatResult = await db
    .select({
      ...getThreadPageFullChatSelect(),
      isUnread: sql<boolean>`NOT COALESCE(${schema.threadChatReadStatus.isRead}, true)`,
    })
    .from(schema.threadChat)
    .leftJoin(
      schema.threadChatReadStatus,
      and(
        eq(schema.threadChatReadStatus.threadId, schema.threadChat.threadId),
        eq(schema.threadChatReadStatus.userId, userId),
        eq(schema.threadChatReadStatus.threadChatId, schema.threadChat.id),
      ),
    )
    .where(
      and(
        eq(schema.threadChat.id, threadChatId),
        eq(schema.threadChat.threadId, threadId),
        eq(schema.threadChat.userId, access.ownerUserId),
      ),
    );

  const threadChat = threadChatResult[0];
  if (!threadChat) {
    return undefined;
  }

  return {
    ...threadChat,
    messageCount: threadChat.messages?.length ?? 0,
    chatSequence: null,
  };
}

export async function getThreadPageDiffWithPermissions({
  db,
  threadId,
  userId,
  getHasRepoPermissions,
  allowAdmin = false,
}: {
  db: DB;
  threadId: string;
  userId: string;
  getHasRepoPermissions?: (repoFullName: string) => Promise<boolean>;
  allowAdmin?: boolean;
}): Promise<ThreadPageDiff | undefined> {
  const access = await getAuthorizedThreadAccess({
    db,
    threadId,
    userId,
    getHasRepoPermissions,
    allowAdmin,
  });
  if (!access) {
    return undefined;
  }

  const threadResult = await db.query.thread.findFirst({
    where: and(
      eq(schema.thread.id, threadId),
      eq(schema.thread.userId, access.ownerUserId),
    ),
    columns: {
      gitDiff: true,
      gitDiffStats: true,
    },
  });

  if (!threadResult) {
    return undefined;
  }

  return {
    gitDiff: threadResult.gitDiff,
    gitDiffStats: threadResult.gitDiffStats,
    hasGitDiff: threadResult.gitDiff !== null,
  };
}
