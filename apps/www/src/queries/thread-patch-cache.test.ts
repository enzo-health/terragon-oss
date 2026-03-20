import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type {
  ThreadInfo,
  ThreadPageChat,
  ThreadPageShell,
} from "@terragon/shared";
import type { BroadcastThreadPatch } from "@terragon/types/broadcast";
import {
  applyThreadPatchToListQueries,
  applyThreadPatchToQueryClient,
} from "./thread-patch-cache";
import { threadQueryKeys } from "./thread-queries";

const INITIAL_CHAT_UPDATED_AT = "2026-03-09T00:00:00.000Z";
const NEXT_CHAT_UPDATED_AT = "2026-03-09T00:00:05.000Z";
const STALE_CHAT_UPDATED_AT = "2026-03-08T23:59:55.000Z";
const INITIAL_CHAT_SEQUENCE = new Date(INITIAL_CHAT_UPDATED_AT).getTime();
const NEXT_CHAT_SEQUENCE = new Date(NEXT_CHAT_UPDATED_AT).getTime();
const STALE_CHAT_SEQUENCE = new Date(STALE_CHAT_UPDATED_AT).getTime();

function createThreadShell(): ThreadPageShell {
  return {
    id: "thread-1",
    userId: "user-1",
    name: "Test task",
    branchName: "feature/test-task",
    repoBaseBranchName: "main",
    githubRepoFullName: "terragon/example",
    automationId: null,
    codesandboxId: "sandbox-1",
    sandboxProvider: "e2b",
    sandboxSize: "small",
    bootingSubstatus: null,
    archived: false,
    createdAt: new Date(INITIAL_CHAT_UPDATED_AT),
    updatedAt: new Date(INITIAL_CHAT_UPDATED_AT),
    visibility: "private",
    prStatus: null,
    prChecksStatus: null,
    authorName: "Tyler",
    authorImage: null,
    githubPRNumber: null,
    githubIssueNumber: null,
    sandboxStatus: "running",
    gitDiffStats: null,
    parentThreadName: null,
    parentThreadId: null,
    parentToolId: null,
    draftMessage: null,
    skipSetup: false,
    disableGitCheckpointing: false,
    sourceType: "www",
    sourceMetadata: {
      type: "www",
      deliveryLoopOptIn: false,
    },
    version: 1,
    isUnread: false,
    messageSeq: 0,
    childThreads: [],
    hasGitDiff: false,
    primaryThreadChatId: "chat-1",
    primaryThreadChat: {
      id: "chat-1",
      threadId: "thread-1",
      agent: "claudeCode",
      agentVersion: 1,
      status: "queued",
      errorMessage: null,
      errorMessageInfo: null,
      scheduleAt: null,
      reattemptQueueAt: null,
      contextLength: null,
      permissionMode: "allowAll",
      isUnread: false,
      messageSeq: 0,
      updatedAt: new Date(INITIAL_CHAT_UPDATED_AT),
    },
  };
}

function createThreadChat(
  overrides: Partial<ThreadPageChat> = {},
): ThreadPageChat {
  return {
    id: "chat-1",
    userId: "user-1",
    threadId: "thread-1",
    title: null,
    createdAt: new Date(INITIAL_CHAT_UPDATED_AT),
    updatedAt: new Date(INITIAL_CHAT_UPDATED_AT),
    agent: "claudeCode",
    agentVersion: 1,
    status: "queued",
    sessionId: null,
    errorMessage: null,
    errorMessageInfo: null,
    scheduleAt: null,
    reattemptQueueAt: null,
    contextLength: null,
    permissionMode: "allowAll",
    codexPreviousResponseId: null,
    isUnread: false,
    messageSeq: 0,
    messages: [
      {
        type: "user",
        model: null,
        parts: [{ type: "text", text: "Initial prompt" }],
      },
    ],
    queuedMessages: [],
    messageCount: 1,
    chatSequence: INITIAL_CHAT_SEQUENCE,
    ...overrides,
  };
}

function createThreadListEntry(): ThreadInfo {
  const shell = createThreadShell();
  return {
    id: shell.id,
    userId: shell.userId,
    name: shell.name,
    githubRepoFullName: shell.githubRepoFullName,
    githubPRNumber: shell.githubPRNumber,
    githubIssueNumber: shell.githubIssueNumber,
    codesandboxId: shell.codesandboxId,
    sandboxProvider: shell.sandboxProvider,
    sandboxSize: shell.sandboxSize,
    sandboxStatus: shell.sandboxStatus,
    bootingSubstatus: shell.bootingSubstatus,
    createdAt: shell.createdAt,
    updatedAt: shell.updatedAt,
    repoBaseBranchName: shell.repoBaseBranchName,
    branchName: shell.branchName,
    archived: shell.archived,
    automationId: shell.automationId,
    parentThreadId: shell.parentThreadId,
    parentToolId: shell.parentToolId,
    draftMessage: shell.draftMessage,
    disableGitCheckpointing: shell.disableGitCheckpointing,
    skipSetup: shell.skipSetup,
    sourceType: shell.sourceType,
    sourceMetadata: shell.sourceMetadata,
    version: shell.version,
    gitDiffStats: shell.gitDiffStats,
    authorName: shell.authorName,
    authorImage: shell.authorImage,
    prStatus: shell.prStatus,
    prChecksStatus: shell.prChecksStatus,
    visibility: shell.visibility,
    isUnread: shell.isUnread,
    messageSeq: shell.messageSeq,
    threadChats: [
      {
        id: shell.primaryThreadChat.id,
        agent: shell.primaryThreadChat.agent,
        status: shell.primaryThreadChat.status,
        errorMessage: shell.primaryThreadChat.errorMessage,
      },
    ],
  };
}

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
}

function setThreadListData(
  queryClient: QueryClient,
  filters: { archived?: boolean },
  threads: ThreadInfo[],
) {
  queryClient.setQueryData(threadQueryKeys.list(filters), {
    pageParams: [0],
    pages: [threads],
  });
}

describe("applyThreadPatchToQueryClient", () => {
  it("appends timestamp-sequenced messages to the active chat cache", () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(
      threadQueryKeys.shell("thread-1"),
      createThreadShell(),
    );
    queryClient.setQueryData(
      threadQueryKeys.chat("thread-1", "chat-1"),
      createThreadChat(),
    );

    const patch: BroadcastThreadPatch = {
      threadId: "thread-1",
      threadChatId: "chat-1",
      op: "upsert",
      chatSequence: NEXT_CHAT_SEQUENCE,
      expectedMessageCount: 1,
      appendMessages: [
        {
          type: "agent",
          parent_tool_use_id: null,
          parts: [{ type: "text", text: "Working on it" }],
        },
      ],
      chat: {
        updatedAt: NEXT_CHAT_UPDATED_AT,
      },
    };

    applyThreadPatchToQueryClient({ queryClient, patch });

    const nextChat = queryClient.getQueryData<ThreadPageChat>(
      threadQueryKeys.chat("thread-1", "chat-1"),
    );

    expect(nextChat?.messageCount).toBe(2);
    expect(nextChat?.messages?.at(-1)).toMatchObject({
      type: "agent",
    });
    expect(nextChat?.chatSequence).toBe(NEXT_CHAT_SEQUENCE);
  });

  it("ignores stale chat patches with an older timestamp sequence", () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(threadQueryKeys.chat("thread-1", "chat-1"), {
      ...createThreadChat(),
      status: "working" as const,
    });
    const invalidateQueriesSpy = vi.spyOn(queryClient, "invalidateQueries");

    applyThreadPatchToQueryClient({
      queryClient,
      patch: {
        threadId: "thread-1",
        threadChatId: "chat-1",
        op: "upsert",
        chatSequence: STALE_CHAT_SEQUENCE,
        chat: {
          status: "complete",
          updatedAt: STALE_CHAT_UPDATED_AT,
        },
      },
    });

    const nextChat = queryClient.getQueryData<ThreadPageChat>(
      threadQueryKeys.chat("thread-1", "chat-1"),
    );

    expect(nextChat?.status).toBe("working");
    expect(nextChat?.chatSequence).toBe(INITIAL_CHAT_SEQUENCE);
    expect(invalidateQueriesSpy).not.toHaveBeenCalled();
  });

  it("still invalidates diff when a stale chat patch is ignored", () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(threadQueryKeys.chat("thread-1", "chat-1"), {
      ...createThreadChat(),
      status: "working" as const,
    });
    const invalidateQueriesSpy = vi.spyOn(queryClient, "invalidateQueries");

    applyThreadPatchToQueryClient({
      queryClient,
      patch: {
        threadId: "thread-1",
        threadChatId: "chat-1",
        op: "upsert",
        chatSequence: STALE_CHAT_SEQUENCE,
        diffChanged: true,
        chat: {
          status: "complete",
          updatedAt: STALE_CHAT_UPDATED_AT,
        },
      },
    });

    expect(invalidateQueriesSpy).toHaveBeenCalledWith({
      queryKey: threadQueryKeys.diff("thread-1"),
    });
  });

  it("invalidates diff when patch requests explicit diff refetch", () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(
      threadQueryKeys.shell("thread-1"),
      createThreadShell(),
    );
    const invalidateQueriesSpy = vi.spyOn(queryClient, "invalidateQueries");

    applyThreadPatchToQueryClient({
      queryClient,
      patch: {
        threadId: "thread-1",
        op: "upsert",
        refetch: ["diff"],
      },
    });

    expect(invalidateQueriesSpy).toHaveBeenCalledWith({
      queryKey: threadQueryKeys.diff("thread-1"),
    });
  });

  it("invalidates duplicate append patches once message counts no longer line up", () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(
      threadQueryKeys.chat("thread-1", "chat-1"),
      createThreadChat({
        updatedAt: new Date(NEXT_CHAT_UPDATED_AT),
        chatSequence: NEXT_CHAT_SEQUENCE,
        messages: [
          {
            type: "user",
            model: null,
            parts: [{ type: "text", text: "Initial prompt" }],
          },
          {
            type: "agent",
            parent_tool_use_id: null,
            parts: [{ type: "text", text: "Working on it" }],
          },
        ],
        messageCount: 2,
      }),
    );
    const invalidateQueriesSpy = vi.spyOn(queryClient, "invalidateQueries");

    applyThreadPatchToQueryClient({
      queryClient,
      patch: {
        threadId: "thread-1",
        threadChatId: "chat-1",
        op: "upsert",
        chatSequence: NEXT_CHAT_SEQUENCE,
        expectedMessageCount: 1,
        appendMessages: [
          {
            type: "agent",
            parent_tool_use_id: null,
            parts: [{ type: "text", text: "Duplicate append" }],
          },
        ],
        chat: {
          updatedAt: NEXT_CHAT_UPDATED_AT,
        },
      },
    });

    expect(invalidateQueriesSpy).toHaveBeenCalledWith({
      queryKey: threadQueryKeys.chat("thread-1", "chat-1"),
    });
  });

  it("invalidates counter-style sequence gaps", () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(
      threadQueryKeys.chat("thread-1", "chat-1"),
      createThreadChat({ chatSequence: 5 }),
    );
    const invalidateQueriesSpy = vi.spyOn(queryClient, "invalidateQueries");

    applyThreadPatchToQueryClient({
      queryClient,
      patch: {
        threadId: "thread-1",
        threadChatId: "chat-1",
        op: "upsert",
        chatSequence: 7,
        chat: {
          status: "working",
          updatedAt: NEXT_CHAT_UPDATED_AT,
        },
      },
    });

    expect(invalidateQueriesSpy).toHaveBeenCalledWith({
      queryKey: threadQueryKeys.chat("thread-1", "chat-1"),
    });
  });

  it("applies timestamp-sequenced status updates incrementally", () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(
      threadQueryKeys.chat("thread-1", "chat-1"),
      createThreadChat(),
    );
    const invalidateQueriesSpy = vi.spyOn(queryClient, "invalidateQueries");

    applyThreadPatchToQueryClient({
      queryClient,
      patch: {
        threadId: "thread-1",
        threadChatId: "chat-1",
        op: "upsert",
        chatSequence: NEXT_CHAT_SEQUENCE,
        chat: {
          status: "working",
          updatedAt: NEXT_CHAT_UPDATED_AT,
        },
      },
    });

    const nextChat = queryClient.getQueryData<ThreadPageChat>(
      threadQueryKeys.chat("thread-1", "chat-1"),
    );

    expect(nextChat?.status).toBe("working");
    expect(nextChat?.chatSequence).toBe(NEXT_CHAT_SEQUENCE);
    expect(invalidateQueriesSpy).not.toHaveBeenCalled();
  });

  it("invalidates the active chat when append counts do not line up", () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(
      threadQueryKeys.chat("thread-1", "chat-1"),
      createThreadChat(),
    );
    const invalidateQueriesSpy = vi.spyOn(queryClient, "invalidateQueries");

    applyThreadPatchToQueryClient({
      queryClient,
      patch: {
        threadId: "thread-1",
        threadChatId: "chat-1",
        op: "upsert",
        chatSequence: NEXT_CHAT_SEQUENCE,
        expectedMessageCount: 0,
        appendMessages: [
          {
            type: "agent",
            parent_tool_use_id: null,
            parts: [{ type: "text", text: "Out of sync" }],
          },
        ],
      },
    });

    expect(invalidateQueriesSpy).toHaveBeenCalledWith({
      queryKey: threadQueryKeys.chat("thread-1", "chat-1"),
    });
  });

  it("invalidates when tail of cached messages matches appendMessages (duplicate delivery)", () => {
    const queryClient = createQueryClient();
    const agentMsg = {
      type: "agent" as const,
      parent_tool_use_id: null,
      parts: [{ type: "text" as const, text: "Working on it" }],
    };
    queryClient.setQueryData(
      threadQueryKeys.chat("thread-1", "chat-1"),
      createThreadChat({
        messages: [
          {
            type: "user",
            model: null,
            parts: [{ type: "text", text: "Initial prompt" }],
          },
          agentMsg,
        ],
        messageCount: 2,
        updatedAt: new Date(NEXT_CHAT_UPDATED_AT),
        chatSequence: NEXT_CHAT_SEQUENCE,
      }),
    );
    const invalidateQueriesSpy = vi.spyOn(queryClient, "invalidateQueries");

    // Send the same message as an append — should detect tail-overlap duplicate
    applyThreadPatchToQueryClient({
      queryClient,
      patch: {
        threadId: "thread-1",
        threadChatId: "chat-1",
        op: "upsert",
        chatSequence: NEXT_CHAT_SEQUENCE,
        expectedMessageCount: 1,
        appendMessages: [
          {
            type: "agent",
            parent_tool_use_id: null,
            parts: [{ type: "text", text: "Working on it" }],
          },
        ],
        chat: {
          updatedAt: NEXT_CHAT_UPDATED_AT,
        },
      },
    });

    // Should invalidate (refetch) rather than appending a duplicate
    expect(invalidateQueriesSpy).toHaveBeenCalledWith({
      queryKey: threadQueryKeys.chat("thread-1", "chat-1"),
    });
    // Message count should remain 2, not grow to 3
    const nextChat = queryClient.getQueryData<ThreadPageChat>(
      threadQueryKeys.chat("thread-1", "chat-1"),
    );
    expect(nextChat?.messages).toHaveLength(2);
  });

  it("invalidates explicit chat refetch patches without mutating the cache", () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(
      threadQueryKeys.chat("thread-1", "chat-1"),
      createThreadChat(),
    );
    const previousChat = queryClient.getQueryData<ThreadPageChat>(
      threadQueryKeys.chat("thread-1", "chat-1"),
    );
    const invalidateQueriesSpy = vi.spyOn(queryClient, "invalidateQueries");

    applyThreadPatchToQueryClient({
      queryClient,
      patch: {
        threadId: "thread-1",
        threadChatId: "chat-1",
        op: "refetch",
        refetch: ["chat"],
      },
    });

    expect(
      queryClient.getQueryData(threadQueryKeys.chat("thread-1", "chat-1")),
    ).toBe(previousChat);
    expect(invalidateQueriesSpy).toHaveBeenCalledWith({
      queryKey: threadQueryKeys.chat("thread-1", "chat-1"),
    });
  });

  it("invalidates the shell query when a non-primary chat receives an update", () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(
      threadQueryKeys.shell("thread-1"),
      createThreadShell(),
    );
    const invalidateQueriesSpy = vi.spyOn(queryClient, "invalidateQueries");

    applyThreadPatchToQueryClient({
      queryClient,
      patch: {
        threadId: "thread-1",
        threadChatId: "chat-2",
        op: "upsert",
        chatSequence: NEXT_CHAT_SEQUENCE,
        chat: {
          status: "working",
          updatedAt: NEXT_CHAT_UPDATED_AT,
        },
      },
    });

    expect(invalidateQueriesSpy).toHaveBeenCalledWith({
      queryKey: threadQueryKeys.shell("thread-1"),
    });
  });

  it("invalidates the new primary chat when the shell switches active chats", () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(
      threadQueryKeys.shell("thread-1"),
      createThreadShell(),
    );
    const invalidateQueriesSpy = vi.spyOn(queryClient, "invalidateQueries");

    applyThreadPatchToQueryClient({
      queryClient,
      patch: {
        threadId: "thread-1",
        threadChatId: "chat-2",
        op: "upsert",
        shell: {
          primaryThreadChatId: "chat-2",
        },
        chat: {
          status: "working",
          updatedAt: NEXT_CHAT_UPDATED_AT,
        },
      },
    });

    expect(invalidateQueriesSpy).toHaveBeenCalledWith({
      queryKey: threadQueryKeys.chat("thread-1", "chat-2"),
    });
  });

  it("does not invalidate list queries from the task-page reducer", () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(
      threadQueryKeys.shell("thread-1"),
      createThreadShell(),
    );
    const invalidateQueriesSpy = vi.spyOn(queryClient, "invalidateQueries");

    applyThreadPatchToQueryClient({
      queryClient,
      patch: {
        threadId: "thread-1",
        op: "refetch",
        refetch: ["list"],
      },
    });

    expect(invalidateQueriesSpy).not.toHaveBeenCalledWith({
      queryKey: threadQueryKeys.list(null),
    });
  });
});

describe("applyThreadPatchToListQueries", () => {
  it("does not mutate the active chat cache when the sidebar receives an append patch", () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(
      threadQueryKeys.chat("thread-1", "chat-1"),
      createThreadChat(),
    );
    const previousChat = queryClient.getQueryData<ThreadPageChat>(
      threadQueryKeys.chat("thread-1", "chat-1"),
    );

    applyThreadPatchToListQueries({
      queryClient,
      patch: {
        threadId: "thread-1",
        threadChatId: "chat-1",
        op: "upsert",
        chatSequence: NEXT_CHAT_SEQUENCE,
        expectedMessageCount: 1,
        appendMessages: [
          {
            type: "agent",
            parent_tool_use_id: null,
            parts: [{ type: "text", text: "Working on it" }],
          },
        ],
      },
    });

    expect(
      queryClient.getQueryData(threadQueryKeys.chat("thread-1", "chat-1")),
    ).toBe(previousChat);
  });

  it("keeps list query references stable on append ticks with no visible sidebar change", () => {
    const queryClient = createQueryClient();
    setThreadListData(queryClient, { archived: false }, [
      createThreadListEntry(),
    ]);
    const previousList = queryClient.getQueryData(
      threadQueryKeys.list({ archived: false }),
    );

    applyThreadPatchToListQueries({
      queryClient,
      patch: {
        threadId: "thread-1",
        threadChatId: "chat-1",
        op: "upsert",
        chatSequence: NEXT_CHAT_SEQUENCE,
        expectedMessageCount: 1,
        appendMessages: [
          {
            type: "agent",
            parent_tool_use_id: null,
            parts: [{ type: "text", text: "Working on it" }],
          },
        ],
        chat: {
          agent: "claudeCode",
          status: "queued",
          errorMessage: null,
          updatedAt: NEXT_CHAT_UPDATED_AT,
        },
      },
    });

    expect(
      queryClient.getQueryData(threadQueryKeys.list({ archived: false })),
    ).toBe(previousList);
  });

  it("inserts a new thread into matching list queries from shell-only data", () => {
    const queryClient = createQueryClient();
    setThreadListData(queryClient, { archived: true }, []);

    applyThreadPatchToListQueries({
      queryClient,
      patch: {
        threadId: "thread-2",
        threadChatId: "chat-2",
        op: "upsert",
        shell: {
          userId: "user-1",
          name: "Archived task",
          githubRepoFullName: "terragon/example",
          repoBaseBranchName: "main",
          branchName: "feature/archived",
          sandboxProvider: "e2b",
          sourceType: "www",
          sourceMetadata: {
            type: "www",
            deliveryLoopOptIn: false,
          },
          visibility: "private",
          archived: true,
          primaryThreadChatId: "chat-2",
          createdAt: "2026-03-09T00:00:10.000Z",
          updatedAt: "2026-03-09T00:00:10.000Z",
        },
      },
    });

    const archivedList = queryClient.getQueryData<{
      pages: ThreadInfo[][];
    }>(threadQueryKeys.list({ archived: true }));

    expect(archivedList?.pages[0]?.map((thread) => thread.id)).toEqual([
      "thread-2",
    ]);
    expect(archivedList?.pages[0]?.[0]?.threadChats[0]?.id).toBe("chat-2");
  });

  it("moves threads between filtered lists when archived state changes from a shell-only patch", () => {
    const queryClient = createQueryClient();
    setThreadListData(queryClient, { archived: false }, [
      createThreadListEntry(),
    ]);
    setThreadListData(queryClient, { archived: true }, []);

    applyThreadPatchToListQueries({
      queryClient,
      patch: {
        threadId: "thread-1",
        threadChatId: "chat-1",
        op: "upsert",
        shell: {
          userId: "user-1",
          archived: true,
          updatedAt: "2026-03-09T00:00:20.000Z",
        },
      },
    });

    const activeList = queryClient.getQueryData<{
      pages: ThreadInfo[][];
    }>(threadQueryKeys.list({ archived: false }));
    const archivedList = queryClient.getQueryData<{
      pages: ThreadInfo[][];
    }>(threadQueryKeys.list({ archived: true }));

    expect(activeList?.pages[0]).toEqual([]);
    expect(archivedList?.pages[0]?.map((thread) => thread.id)).toEqual([
      "thread-1",
    ]);
    expect(archivedList?.pages[0]?.[0]?.threadChats[0]?.status).toBe("queued");
  });

  it("does not invalidate list queries when a delete patch is already applied locally", () => {
    const queryClient = createQueryClient();
    setThreadListData(queryClient, { archived: false }, [
      createThreadListEntry(),
    ]);
    const invalidateQueriesSpy = vi.spyOn(queryClient, "invalidateQueries");

    applyThreadPatchToListQueries({
      queryClient,
      patch: {
        threadId: "thread-1",
        op: "delete",
        refetch: ["list"],
      },
    });

    expect(invalidateQueriesSpy).not.toHaveBeenCalledWith({
      queryKey: threadQueryKeys.list(null),
    });
  });

  it("invalidates list queries when explicitly requested", () => {
    const queryClient = createQueryClient();
    setThreadListData(queryClient, { archived: false }, [
      createThreadListEntry(),
    ]);
    const invalidateQueriesSpy = vi.spyOn(queryClient, "invalidateQueries");

    applyThreadPatchToListQueries({
      queryClient,
      patch: {
        threadId: "thread-1",
        op: "refetch",
        refetch: ["list"],
      },
    });

    expect(invalidateQueriesSpy).toHaveBeenCalledWith({
      queryKey: threadQueryKeys.list(null),
    });
  });
});
