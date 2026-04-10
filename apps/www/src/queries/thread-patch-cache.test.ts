import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { ThreadInfo, ThreadPageChat, ThreadPageShell } from "@leo/shared";
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

function createThreadShell(): ThreadPageShell {
  return {
    id: "thread-1",
    userId: "user-1",
    name: "Test task",
    branchName: "feature/test-task",
    repoBaseBranchName: "main",
    githubRepoFullName: "leo/example",
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
    patchVersion: 0,
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

  it("accepts seq-only patches that jump ahead (confirmation after optimistic)", () => {
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

    // Seq-only patches (no messages) are confirmations — accepted, not invalidated
    expect(invalidateQueriesSpy).not.toHaveBeenCalledWith({
      queryKey: threadQueryKeys.chat("thread-1", "chat-1"),
    });
    const chat = queryClient.getQueryData<ThreadPageChat>(
      threadQueryKeys.chat("thread-1", "chat-1"),
    );
    expect(chat?.chatSequence).toBe(7);
    expect(chat?.status).toBe("working");
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
          githubRepoFullName: "leo/example",
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

describe("seq-based fast path", () => {
  it("appends messages when seq is exactly next in sequence", () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(
      threadQueryKeys.chat("thread-1", "chat-1"),
      createThreadChat({ chatSequence: 3, messageSeq: 3 }),
    );
    const invalidateQueriesSpy = vi.spyOn(queryClient, "invalidateQueries");

    applyThreadPatchToQueryClient({
      queryClient,
      patch: {
        threadId: "thread-1",
        threadChatId: "chat-1",
        op: "upsert",
        chatSequence: 4,
        appendMessages: [
          {
            type: "agent",
            parent_tool_use_id: null,
            parts: [{ type: "text", text: "Seq 4 message" }],
          },
        ],
        chat: { updatedAt: NEXT_CHAT_UPDATED_AT },
      },
    });

    const nextChat = queryClient.getQueryData<ThreadPageChat>(
      threadQueryKeys.chat("thread-1", "chat-1"),
    );
    expect(nextChat?.messageCount).toBe(2);
    expect(nextChat?.messages?.at(-1)).toMatchObject({ type: "agent" });
    expect(nextChat?.chatSequence).toBe(4);
    expect(invalidateQueriesSpy).not.toHaveBeenCalled();
  });

  it("applies rapid consecutive patches without invalidation", () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(
      threadQueryKeys.chat("thread-1", "chat-1"),
      createThreadChat({ chatSequence: 1, messageSeq: 1 }),
    );
    const invalidateQueriesSpy = vi.spyOn(queryClient, "invalidateQueries");

    // Seq 2
    applyThreadPatchToQueryClient({
      queryClient,
      patch: {
        threadId: "thread-1",
        threadChatId: "chat-1",
        op: "upsert",
        chatSequence: 2,
        appendMessages: [
          {
            type: "agent",
            parent_tool_use_id: null,
            parts: [{ type: "text", text: "Message 2" }],
          },
        ],
        chat: { updatedAt: NEXT_CHAT_UPDATED_AT },
      },
    });

    // Seq 3
    applyThreadPatchToQueryClient({
      queryClient,
      patch: {
        threadId: "thread-1",
        threadChatId: "chat-1",
        op: "upsert",
        chatSequence: 3,
        appendMessages: [
          {
            type: "agent",
            parent_tool_use_id: null,
            parts: [{ type: "text", text: "Message 3" }],
          },
        ],
        chat: { updatedAt: NEXT_CHAT_UPDATED_AT },
      },
    });

    const nextChat = queryClient.getQueryData<ThreadPageChat>(
      threadQueryKeys.chat("thread-1", "chat-1"),
    );
    expect(nextChat?.messageCount).toBe(3);
    expect(nextChat?.chatSequence).toBe(3);
    expect(invalidateQueriesSpy).not.toHaveBeenCalled();
  });

  it("ignores duplicate seq-based patches", () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(
      threadQueryKeys.chat("thread-1", "chat-1"),
      createThreadChat({ chatSequence: 5, messageSeq: 5 }),
    );

    applyThreadPatchToQueryClient({
      queryClient,
      patch: {
        threadId: "thread-1",
        threadChatId: "chat-1",
        op: "upsert",
        chatSequence: 5,
        appendMessages: [
          {
            type: "agent",
            parent_tool_use_id: null,
            parts: [{ type: "text", text: "Duplicate" }],
          },
        ],
        chat: { updatedAt: NEXT_CHAT_UPDATED_AT },
      },
    });

    const nextChat = queryClient.getQueryData<ThreadPageChat>(
      threadQueryKeys.chat("thread-1", "chat-1"),
    );
    // Should not have appended
    expect(nextChat?.messageCount).toBe(1);
    expect(nextChat?.chatSequence).toBe(5);
  });

  it("ignores stale seq-based patches", () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(
      threadQueryKeys.chat("thread-1", "chat-1"),
      createThreadChat({
        chatSequence: 5,
        messageSeq: 5,
        status: "working" as any,
      }),
    );

    applyThreadPatchToQueryClient({
      queryClient,
      patch: {
        threadId: "thread-1",
        threadChatId: "chat-1",
        op: "upsert",
        chatSequence: 3,
        chat: { status: "complete", updatedAt: STALE_CHAT_UPDATED_AT },
      },
    });

    const nextChat = queryClient.getQueryData<ThreadPageChat>(
      threadQueryKeys.chat("thread-1", "chat-1"),
    );
    expect(nextChat?.status).toBe("working");
  });

  it("invalidates on seq gap (missed messages)", () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(
      threadQueryKeys.chat("thread-1", "chat-1"),
      createThreadChat({ chatSequence: 2, messageSeq: 2 }),
    );
    const invalidateQueriesSpy = vi.spyOn(queryClient, "invalidateQueries");

    applyThreadPatchToQueryClient({
      queryClient,
      patch: {
        threadId: "thread-1",
        threadChatId: "chat-1",
        op: "upsert",
        chatSequence: 5,
        appendMessages: [
          {
            type: "agent",
            parent_tool_use_id: null,
            parts: [{ type: "text", text: "Skipped seq 3 and 4" }],
          },
        ],
        chat: { updatedAt: NEXT_CHAT_UPDATED_AT },
      },
    });

    expect(invalidateQueriesSpy).toHaveBeenCalledWith({
      queryKey: threadQueryKeys.chat("thread-1", "chat-1"),
    });
  });

  it("appends messages on next-in-sequence regardless of expectedMessageCount", () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(
      threadQueryKeys.chat("thread-1", "chat-1"),
      createThreadChat({
        chatSequence: 1,
        messageSeq: 1,
        messages: [
          {
            type: "user",
            model: null,
            parts: [{ type: "text", text: "msg1" }],
          },
          {
            type: "agent",
            parent_tool_use_id: null,
            parts: [{ type: "text", text: "msg2" }],
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
        chatSequence: 2,
        expectedMessageCount: 999,
        appendMessages: [
          {
            type: "agent",
            parent_tool_use_id: null,
            parts: [{ type: "text", text: "msg3" }],
          },
        ],
        chat: { updatedAt: NEXT_CHAT_UPDATED_AT },
      },
    });

    const nextChat = queryClient.getQueryData<ThreadPageChat>(
      threadQueryKeys.chat("thread-1", "chat-1"),
    );
    expect(nextChat?.messageCount).toBe(3);
    expect(nextChat?.chatSequence).toBe(2);
    expect(invalidateQueriesSpy).not.toHaveBeenCalled();
  });
});

describe("optimistic rendering (pre-broadcast + confirmation)", () => {
  it("applies pre-broadcast messages without chatSequence, then confirmation updates seq", () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(
      threadQueryKeys.chat("thread-1", "chat-1"),
      createThreadChat({
        chatSequence: 3,
        messageSeq: 3,
        messages: [
          {
            type: "user",
            model: null,
            parts: [{ type: "text", text: "msg1" }],
          },
        ],
        messageCount: 1,
      }),
    );

    // Phase 1: Pre-broadcast — messages with no chatSequence
    applyThreadPatchToQueryClient({
      queryClient,
      patch: {
        threadId: "thread-1",
        threadChatId: "chat-1",
        op: "upsert",
        appendMessages: [
          {
            type: "agent",
            parent_tool_use_id: null,
            parts: [{ type: "text", text: "optimistic msg" }],
          },
        ],
      },
    });

    let chat = queryClient.getQueryData<ThreadPageChat>(
      threadQueryKeys.chat("thread-1", "chat-1"),
    );
    expect(chat?.messageCount).toBe(2);
    expect(chat?.chatSequence).toBe(3); // unchanged — no seq in pre-broadcast

    // Phase 2: Confirmation — chatSequence only, no messages
    applyThreadPatchToQueryClient({
      queryClient,
      patch: {
        threadId: "thread-1",
        threadChatId: "chat-1",
        op: "upsert",
        chatSequence: 4,
        chat: { updatedAt: NEXT_CHAT_UPDATED_AT },
      },
    });

    chat = queryClient.getQueryData<ThreadPageChat>(
      threadQueryKeys.chat("thread-1", "chat-1"),
    );
    expect(chat?.messageCount).toBe(2); // still 2 — no duplicate
    expect(chat?.chatSequence).toBe(4); // seq updated
  });

  it("handles error refetch after pre-broadcast by invalidating cache", () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(
      threadQueryKeys.chat("thread-1", "chat-1"),
      createThreadChat({
        chatSequence: 5,
        messageSeq: 5,
        messages: [
          {
            type: "user",
            model: null,
            parts: [{ type: "text", text: "msg1" }],
          },
        ],
        messageCount: 1,
      }),
    );

    // Phase 1: Pre-broadcast — messages appear optimistically
    applyThreadPatchToQueryClient({
      queryClient,
      patch: {
        threadId: "thread-1",
        threadChatId: "chat-1",
        op: "upsert",
        appendMessages: [
          {
            type: "agent",
            parent_tool_use_id: null,
            parts: [{ type: "text", text: "optimistic msg" }],
          },
        ],
      },
    });

    let chat = queryClient.getQueryData<ThreadPageChat>(
      threadQueryKeys.chat("thread-1", "chat-1"),
    );
    expect(chat?.messageCount).toBe(2);

    const invalidateQueriesSpy = vi.spyOn(queryClient, "invalidateQueries");

    // Phase 2: Error — DB write failed, server sends refetch
    applyThreadPatchToQueryClient({
      queryClient,
      patch: {
        threadId: "thread-1",
        threadChatId: "chat-1",
        op: "refetch",
        refetch: ["chat"],
      },
    });

    // Should trigger invalidation so client re-fetches from DB
    expect(invalidateQueriesSpy).toHaveBeenCalled();
  });

  it("pre-broadcast without seq followed by rapid confirmation does not duplicate messages", () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(
      threadQueryKeys.chat("thread-1", "chat-1"),
      createThreadChat({
        chatSequence: 1,
        messageSeq: 1,
        messages: [],
        messageCount: 0,
      }),
    );
    const invalidateQueriesSpy = vi.spyOn(queryClient, "invalidateQueries");

    // Pre-broadcast
    applyThreadPatchToQueryClient({
      queryClient,
      patch: {
        threadId: "thread-1",
        threadChatId: "chat-1",
        op: "upsert",
        appendMessages: [
          {
            type: "agent",
            parent_tool_use_id: null,
            parts: [{ type: "text", text: "hello" }],
          },
        ],
      },
    });

    // Confirmation with seq
    applyThreadPatchToQueryClient({
      queryClient,
      patch: {
        threadId: "thread-1",
        threadChatId: "chat-1",
        op: "upsert",
        chatSequence: 2,
        chat: { updatedAt: NEXT_CHAT_UPDATED_AT },
      },
    });

    const chat = queryClient.getQueryData<ThreadPageChat>(
      threadQueryKeys.chat("thread-1", "chat-1"),
    );
    expect(chat?.messageCount).toBe(1); // exactly 1, not duplicated
    expect(chat?.chatSequence).toBe(2);
    expect(invalidateQueriesSpy).not.toHaveBeenCalled();
  });
});

describe("dual-seq (messageSeq + patchVersion)", () => {
  it("status-only patch with patchVersion applies metadata without invalidating messages", () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(
      threadQueryKeys.chat("thread-1", "chat-1"),
      createThreadChat({
        chatSequence: 5,
        messageSeq: 5,
        patchVersion: 1,
        messages: [
          {
            type: "user",
            model: null,
            parts: [{ type: "text", text: "msg1" }],
          },
          {
            type: "agent",
            parent_tool_use_id: null,
            parts: [{ type: "text", text: "msg2" }],
          },
        ],
        messageCount: 2,
        status: "working" as any,
      }),
    );
    const invalidateQueriesSpy = vi.spyOn(queryClient, "invalidateQueries");

    applyThreadPatchToQueryClient({
      queryClient,
      patch: {
        threadId: "thread-1",
        threadChatId: "chat-1",
        op: "upsert",
        patchVersion: 2,
        chat: {
          status: "complete",
          updatedAt: NEXT_CHAT_UPDATED_AT,
        },
      },
    });

    const chat = queryClient.getQueryData<ThreadPageChat>(
      threadQueryKeys.chat("thread-1", "chat-1"),
    );
    expect(chat?.status).toBe("complete");
    expect(chat?.messageCount).toBe(2);
    expect(chat?.messages).toHaveLength(2);
    expect(chat?.patchVersion).toBe(2);
    expect(chat?.messageSeq).toBe(5);
    expect(
      queryClient.getQueryState(threadQueryKeys.chat("thread-1", "chat-1"))
        ?.isInvalidated,
    ).toBe(false);
    expect(invalidateQueriesSpy).not.toHaveBeenCalledWith({
      queryKey: threadQueryKeys.chat("thread-1", "chat-1"),
    });
  });

  it("message patch with messageSeq appends and updates both seqs", () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(
      threadQueryKeys.chat("thread-1", "chat-1"),
      createThreadChat({
        chatSequence: 5,
        messageSeq: 5,
        patchVersion: 1,
        messages: [
          {
            type: "user",
            model: null,
            parts: [{ type: "text", text: "msg1" }],
          },
        ],
        messageCount: 1,
      }),
    );

    applyThreadPatchToQueryClient({
      queryClient,
      patch: {
        threadId: "thread-1",
        threadChatId: "chat-1",
        op: "upsert",
        messageSeq: 6,
        patchVersion: 2,
        chatSequence: 6,
        appendMessages: [
          {
            type: "agent",
            parent_tool_use_id: null,
            parts: [{ type: "text", text: "response" }],
          },
        ],
        chat: { updatedAt: NEXT_CHAT_UPDATED_AT },
      },
    });

    const chat = queryClient.getQueryData<ThreadPageChat>(
      threadQueryKeys.chat("thread-1", "chat-1"),
    );
    expect(chat?.messageCount).toBe(2);
    expect(chat?.messages?.at(-1)).toMatchObject({
      type: "agent",
      parts: [{ type: "text", text: "response" }],
    });
    expect(chat?.messageSeq).toBe(6);
    expect(chat?.patchVersion).toBe(2);
  });

  it("stale patchVersion is ignored", () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(
      threadQueryKeys.chat("thread-1", "chat-1"),
      createThreadChat({
        chatSequence: 5,
        messageSeq: 5,
        patchVersion: 5,
        status: "working" as any,
      }),
    );

    applyThreadPatchToQueryClient({
      queryClient,
      patch: {
        threadId: "thread-1",
        threadChatId: "chat-1",
        op: "upsert",
        patchVersion: 3,
        chat: {
          status: "complete",
          updatedAt: STALE_CHAT_UPDATED_AT,
        },
      },
    });

    const chat = queryClient.getQueryData<ThreadPageChat>(
      threadQueryKeys.chat("thread-1", "chat-1"),
    );
    expect(chat?.status).toBe("working");
    expect(chat?.patchVersion).toBe(5);
  });

  it("messageSeq gap triggers invalidation", () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(
      threadQueryKeys.chat("thread-1", "chat-1"),
      createThreadChat({
        chatSequence: 5,
        messageSeq: 5,
        patchVersion: 1,
      }),
    );
    const invalidateQueriesSpy = vi.spyOn(queryClient, "invalidateQueries");

    applyThreadPatchToQueryClient({
      queryClient,
      patch: {
        threadId: "thread-1",
        threadChatId: "chat-1",
        op: "upsert",
        messageSeq: 7,
        patchVersion: 2,
        chatSequence: 7,
        appendMessages: [
          {
            type: "agent",
            parent_tool_use_id: null,
            parts: [{ type: "text", text: "skipped seq 6" }],
          },
        ],
        chat: { updatedAt: NEXT_CHAT_UPDATED_AT },
      },
    });

    expect(invalidateQueriesSpy).toHaveBeenCalledWith({
      queryKey: threadQueryKeys.chat("thread-1", "chat-1"),
    });
  });

  it("duplicate messageSeq is ignored", () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(
      threadQueryKeys.chat("thread-1", "chat-1"),
      createThreadChat({
        chatSequence: 5,
        messageSeq: 5,
        patchVersion: 5,
        messages: [
          {
            type: "user",
            model: null,
            parts: [{ type: "text", text: "msg1" }],
          },
        ],
        messageCount: 1,
      }),
    );

    applyThreadPatchToQueryClient({
      queryClient,
      patch: {
        threadId: "thread-1",
        threadChatId: "chat-1",
        op: "upsert",
        messageSeq: 5,
        patchVersion: 5,
        chatSequence: 5,
        appendMessages: [
          {
            type: "agent",
            parent_tool_use_id: null,
            parts: [{ type: "text", text: "duplicate" }],
          },
        ],
        chat: { updatedAt: NEXT_CHAT_UPDATED_AT },
      },
    });

    const chat = queryClient.getQueryData<ThreadPageChat>(
      threadQueryKeys.chat("thread-1", "chat-1"),
    );
    expect(chat?.messageCount).toBe(1);
    expect(chat?.messageSeq).toBe(5);
  });

  it("full flow: optimistic → confirmation → status update", () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(
      threadQueryKeys.chat("thread-1", "chat-1"),
      createThreadChat({
        chatSequence: 5,
        messageSeq: 5,
        patchVersion: 0,
        messages: [
          {
            type: "user",
            model: null,
            parts: [{ type: "text", text: "initial" }],
          },
        ],
        messageCount: 1,
      }),
    );

    // Phase 1: Optimistic pre-broadcast (no messageSeq, no patchVersion)
    applyThreadPatchToQueryClient({
      queryClient,
      patch: {
        threadId: "thread-1",
        threadChatId: "chat-1",
        op: "upsert",
        appendMessages: [
          {
            type: "agent",
            parent_tool_use_id: null,
            parts: [{ type: "text", text: "optimistic" }],
          },
        ],
      },
    });

    let chat = queryClient.getQueryData<ThreadPageChat>(
      threadQueryKeys.chat("thread-1", "chat-1"),
    );
    expect(chat?.messageCount).toBe(2);
    expect(chat?.messageSeq).toBe(5); // unchanged
    expect(chat?.patchVersion).toBe(0); // unchanged

    // Phase 2: Confirmation (messageSeq=6, patchVersion=1, no appendMessages)
    applyThreadPatchToQueryClient({
      queryClient,
      patch: {
        threadId: "thread-1",
        threadChatId: "chat-1",
        op: "upsert",
        messageSeq: 6,
        patchVersion: 1,
        chatSequence: 6,
        chat: { updatedAt: NEXT_CHAT_UPDATED_AT },
      },
    });

    chat = queryClient.getQueryData<ThreadPageChat>(
      threadQueryKeys.chat("thread-1", "chat-1"),
    );
    expect(chat?.messageCount).toBe(2); // no duplicate
    expect(chat?.messageSeq).toBe(6);
    expect(chat?.patchVersion).toBe(1);

    // Phase 3: Status-only (patchVersion=2, no messageSeq, no appendMessages)
    applyThreadPatchToQueryClient({
      queryClient,
      patch: {
        threadId: "thread-1",
        threadChatId: "chat-1",
        op: "upsert",
        patchVersion: 2,
        chat: {
          status: "complete",
          updatedAt: NEXT_CHAT_UPDATED_AT,
        },
      },
    });

    chat = queryClient.getQueryData<ThreadPageChat>(
      threadQueryKeys.chat("thread-1", "chat-1"),
    );
    expect(chat?.status).toBe("complete");
    expect(chat?.messageCount).toBe(2); // messages preserved
    expect(chat?.messageSeq).toBe(6); // unchanged
    expect(chat?.patchVersion).toBe(2);
  });
});
