import {
  DBUserMessage,
  ThreadInfo,
  ThreadPageChat,
  ThreadPageShell,
} from "@terragon/shared";
import {
  archiveThread,
  unarchiveThread,
} from "@/server-actions/archive-thread";
import { deleteThread } from "@/server-actions/delete-thread";
import { readThread } from "@/server-actions/read-thread";
import { unreadThread } from "@/server-actions/unread-thread";
import {
  threadQueryKeys,
  isValidThreadListFilter,
  isMatchingThreadForFilter,
  threadQueryOptions,
  threadChatQueryOptions,
  threadShellQueryOptions,
  ThreadListFilters,
} from "./thread-queries";
import { updateThreadVisibilityAction } from "@/server-actions/thread-visibility";
import { updateThreadName } from "@/server-actions/update-thread-name";
import {
  submitDraftThread,
  updateDraftThread,
} from "@/server-actions/draft-thread";
import { ServerActionResult } from "@/lib/server-actions";
import { useServerActionMutation } from "./server-action-helpers";
import { InfiniteData, useQueryClient } from "@tanstack/react-query";
import {
  newThread,
  type NewThreadArgs,
  type NewThreadResult,
} from "@/server-actions/new-thread";
import {
  insertThreadInfo,
  removeThreadInfo,
  replaceThreadInfo,
} from "@/collections/thread-info-collection";
import { convertToPlainText } from "@/lib/db-message-helpers";
import { modelToAgent } from "@terragon/agent/utils";
import type { AIModel, SelectedAIModels } from "@terragon/agent/types";
import { toast } from "sonner";

type OptimisticThreadDescriptor = {
  id: string;
  model: AIModel;
  thread: ThreadInfo;
};

function getThreadStatusForCreate({
  saveAsDraft,
  scheduleAt,
}: Pick<NewThreadArgs, "saveAsDraft" | "scheduleAt">) {
  if (saveAsDraft) {
    return "draft" as const;
  }
  if (scheduleAt) {
    return "scheduled" as const;
  }
  return "queued" as const;
}

function getOptimisticModels({
  userMessage,
  selectedModels,
  saveAsDraft,
}: {
  userMessage: DBUserMessage;
  selectedModels?: SelectedAIModels;
  saveAsDraft?: boolean;
}): AIModel[] {
  if (
    saveAsDraft ||
    !selectedModels ||
    Object.keys(selectedModels).length === 0
  ) {
    return userMessage.model ? [userMessage.model] : [];
  }

  const selectedModelKeys = Object.keys(selectedModels) as AIModel[];
  if (!userMessage.model) {
    return selectedModelKeys;
  }

  return [
    userMessage.model,
    ...selectedModelKeys.filter((model) => model !== userMessage.model),
  ];
}

export function buildOptimisticThreadsForCreate({
  userMessage,
  githubRepoFullName,
  branchName,
  createNewBranch = true,
  saveAsDraft,
  scheduleAt,
  disableGitCheckpointing,
  skipSetup,
  selectedModels,
}: {
  userMessage: DBUserMessage;
  githubRepoFullName: string;
  branchName: string;
  createNewBranch?: boolean;
  saveAsDraft?: boolean;
  scheduleAt?: number | null;
  disableGitCheckpointing?: boolean;
  skipSetup?: boolean;
  selectedModels?: SelectedAIModels;
}): OptimisticThreadDescriptor[] {
  const models = getOptimisticModels({
    userMessage,
    selectedModels,
    saveAsDraft,
  });
  const now = new Date();
  const title =
    convertToPlainText({
      message: userMessage,
      skipAttachments: true,
    }).slice(0, 100) || "New task";
  const status = getThreadStatusForCreate({ saveAsDraft, scheduleAt });

  return models.map((model, index) => {
    const id = `optimistic-${Date.now()}-${index}-${model}`;
    return {
      id,
      model,
      thread: {
        id,
        userId: "",
        name: title,
        githubRepoFullName,
        githubPRNumber: null,
        githubIssueNumber: null,
        codesandboxId: null,
        sandboxProvider: "e2b",
        sandboxSize: null,
        sandboxStatus: null,
        bootingSubstatus: null,
        createdAt: now,
        updatedAt: now,
        repoBaseBranchName: createNewBranch ? branchName || "main" : "main",
        branchName: createNewBranch ? null : branchName,
        archived: false,
        automationId: null,
        parentThreadId: null,
        parentToolId: null,
        draftMessage: saveAsDraft ? userMessage : null,
        disableGitCheckpointing: disableGitCheckpointing ?? false,
        skipSetup: skipSetup ?? false,
        sourceType: "www",
        sourceMetadata: null,
        version: 1,
        gitDiffStats: null,
        authorName: null,
        authorImage: null,
        prStatus: null,
        prChecksStatus: null,
        visibility: null,
        isUnread: false,
        messageSeq: 0,
        threadChats: [
          {
            id: `optimistic-chat-${index}`,
            agent: modelToAgent(model),
            status,
            errorMessage: null,
          },
        ],
      },
    };
  });
}

function updateThreadListQueries(
  queryClient: ReturnType<typeof useQueryClient>,
  updatePage: (
    page: ThreadInfo[],
    filters: ThreadListFilters | null,
    pageIndex: number,
  ) => ThreadInfo[],
) {
  const cache = queryClient.getQueryCache();
  const queries = cache.findAll({ queryKey: threadQueryKeys.list(null) });

  queries.forEach((query) => {
    const queryKey = query.queryKey;
    const maybeFilters = queryKey[2];
    const filters = isValidThreadListFilter(maybeFilters) ? maybeFilters : null;
    queryClient.setQueryData<InfiniteData<ThreadInfo[]>>(queryKey, (old) => {
      if (!old) {
        return old;
      }
      return {
        ...old,
        pages: old.pages.map((page, pageIndex) =>
          updatePage(page, filters, pageIndex),
        ),
      };
    });
  });
}

function insertOptimisticThreadIntoListQueries(
  queryClient: ReturnType<typeof useQueryClient>,
  thread: ThreadInfo,
) {
  updateThreadListQueries(queryClient, (page, filters, pageIndex) => {
    if (filters && !isMatchingThreadForFilter(thread, filters)) {
      return page;
    }
    if (page.some((existingThread) => existingThread.id === thread.id)) {
      return page;
    }
    if (pageIndex > 0) {
      return page;
    }
    return [thread, ...page];
  });
}

function removeOptimisticThreadFromListQueries(
  queryClient: ReturnType<typeof useQueryClient>,
  threadId: string,
) {
  updateThreadListQueries(queryClient, (page) =>
    page.filter((thread) => thread.id !== threadId),
  );
}

function replaceOptimisticThreadInListQueries(
  queryClient: ReturnType<typeof useQueryClient>,
  {
    optimisticId,
    nextThread,
  }: {
    optimisticId: string;
    nextThread: ThreadInfo;
  },
) {
  updateThreadListQueries(queryClient, (page, filters, pageIndex) => {
    const withoutOptimistic = page.filter(
      (thread) => thread.id !== optimisticId,
    );
    const nextPage = withoutOptimistic.map((thread) =>
      thread.id === nextThread.id ? nextThread : thread,
    );

    if (filters && !isMatchingThreadForFilter(nextThread, filters)) {
      return nextPage;
    }
    if (nextPage.some((thread) => thread.id === nextThread.id)) {
      return nextPage;
    }
    if (pageIndex > 0) {
      return nextPage;
    }
    return [nextThread, ...nextPage];
  });
}

function reconcileCreatedThreads({
  optimisticThreads,
  result,
  queryClient,
}: {
  optimisticThreads: OptimisticThreadDescriptor[];
  result: NewThreadResult;
  queryClient: ReturnType<typeof useQueryClient>;
}) {
  const optimisticByModel = new Map(
    optimisticThreads.map((thread) => [thread.model, thread]),
  );

  result.createdThreads.forEach((createdThread) => {
    const optimistic = optimisticByModel.get(createdThread.model);
    if (!optimistic) {
      return;
    }

    const reconciledThread: ThreadInfo = {
      ...optimistic.thread,
      id: createdThread.threadId,
      threadChats: optimistic.thread.threadChats.map((threadChat, index) =>
        index === 0
          ? { ...threadChat, id: createdThread.threadChatId }
          : threadChat,
      ),
    };

    replaceThreadInfo({
      existingId: optimistic.id,
      nextThread: reconciledThread,
    });
    replaceOptimisticThreadInListQueries(queryClient, {
      optimisticId: optimistic.id,
      nextThread: reconciledThread,
    });
    optimisticByModel.delete(createdThread.model);
  });

  result.failedModels.forEach((failedModel) => {
    const optimistic = optimisticByModel.get(failedModel.model);
    if (!optimistic) {
      return;
    }
    removeThreadInfo(optimistic.id);
    removeOptimisticThreadFromListQueries(queryClient, optimistic.id);
    optimisticByModel.delete(failedModel.model);
  });

  optimisticByModel.forEach((optimisticThread) => {
    removeThreadInfo(optimisticThread.id);
    removeOptimisticThreadFromListQueries(queryClient, optimisticThread.id);
  });
}

// Generic hook for thread mutations with optimistic updates
function useThreadMutation<TVariables extends { threadId: string }>({
  mutationFn,
  updateThread,
  updateShell,
  onMutateExtra,
}: {
  mutationFn: (variables: TVariables) => Promise<ServerActionResult>;
  updateThread: (thread: ThreadInfo, variables: TVariables) => ThreadInfo;
  updateShell?: (
    thread: ThreadPageShell,
    variables: TVariables,
  ) => ThreadPageShell;
  onMutateExtra?: (
    queryClient: ReturnType<typeof useQueryClient>,
    variables: TVariables,
  ) => void;
}) {
  const queryClient = useQueryClient();
  return useServerActionMutation({
    mutationFn,
    onMutate: async (variables) => {
      const { threadId } = variables;

      // Cancel any outgoing refetches
      await queryClient.cancelQueries({ queryKey: ["threads"] });

      // Helper to update a thread
      const updateThreadWrapper = (thread: ThreadInfo) => {
        if (thread.id !== threadId) return thread;
        return updateThread(thread, variables);
      };

      // Update thread detail query
      queryClient.setQueryData<ThreadInfo>(
        threadQueryKeys.detail(threadId),
        (old) => (old ? updateThreadWrapper(old) : old),
      );
      if (updateShell) {
        queryClient.setQueryData<ThreadPageShell>(
          threadQueryKeys.shell(threadId),
          (old) => (old ? updateShell(old, variables) : old),
        );
      }

      // Update all thread list queries (both filtered and unfiltered)
      const cache = queryClient.getQueryCache();
      const queries = cache.findAll({ queryKey: threadQueryKeys.list(null) });

      queries.forEach((query) => {
        const queryKey = query.queryKey as any[];
        const filters = queryKey[2];
        queryClient.setQueryData<InfiniteData<ThreadInfo[]>>(
          queryKey,
          (old) => {
            if (!old) return old;
            return {
              ...old,
              pages: old.pages.map((page, idx) => {
                const thread = page.find((t) => t.id === threadId);
                if (!thread) {
                  return page;
                }
                const updatedThread = updateThread(thread, variables);
                if (isValidThreadListFilter(filters)) {
                  if (!isMatchingThreadForFilter(updatedThread, filters)) {
                    return page.filter((t) => t.id !== threadId);
                  }
                }
                return page.map((t) => (t.id === threadId ? updatedThread : t));
              }),
            };
          },
        );
      });

      onMutateExtra?.(queryClient, variables);
    },
    onError: (error, variables) => {
      console.error(error);
      queryClient.invalidateQueries({
        queryKey: threadQueryKeys.detail(variables.threadId),
      });
      queryClient.invalidateQueries({
        queryKey: threadQueryKeys.shell(variables.threadId),
      });
      queryClient.invalidateQueries({ queryKey: threadQueryKeys.list(null) });
    },
  });
}

// Archive/Unarchive mutation
export function useArchiveMutation() {
  return useThreadMutation({
    mutationFn: async ({
      threadId,
      archive,
    }: {
      threadId: string;
      archive: boolean;
    }) => {
      if (archive) {
        return archiveThread(threadId);
      } else {
        return unarchiveThread(threadId);
      }
    },
    updateThread: (thread, { archive }) => ({
      ...thread,
      archived: archive,
      // When archiving, mark as read (server does this too)
      isUnread: archive ? false : thread.isUnread,
    }),
    updateShell: (thread, { archive }) => ({
      ...thread,
      archived: archive,
      isUnread: archive ? false : thread.isUnread,
    }),
  });
}

// Read thread mutation
export function useReadThreadMutation() {
  return useThreadMutation({
    mutationFn: readThread,
    updateThread: (thread) => ({ ...thread, isUnread: false }),
    updateShell: (thread) => ({ ...thread, isUnread: false }),
    onMutateExtra: (queryClient, { threadId, threadChatIdOrNull }) => {
      if (!threadChatIdOrNull) {
        return;
      }
      queryClient.setQueryData<ThreadPageChat>(
        threadQueryKeys.chat(threadId, threadChatIdOrNull),
        (old) => (old ? { ...old, isUnread: false } : old),
      );
    },
  });
}

// Unread thread mutation
export function useUnreadThreadMutation() {
  return useThreadMutation({
    mutationFn: unreadThread,
    updateThread: (thread) => ({ ...thread, isUnread: true }),
    updateShell: (thread) => ({ ...thread, isUnread: true }),
    onMutateExtra: (queryClient, { threadId }) => {
      queryClient.setQueriesData<ThreadPageChat>(
        { queryKey: ["threads", "chat", threadId] },
        (old) => (old ? { ...old, isUnread: true } : old),
      );
    },
  });
}

// Delete mutation with optimistic removal
export function useDeleteThreadMutation() {
  const queryClient = useQueryClient();
  return useServerActionMutation({
    mutationFn: deleteThread,
    onMutate: async (threadId) => {
      // Cancel any outgoing refetches
      await queryClient.cancelQueries({ queryKey: ["threads"] });
      // Remove thread from detail query
      queryClient.removeQueries({ queryKey: threadQueryKeys.detail(threadId) });
      queryClient.removeQueries({ queryKey: threadQueryKeys.shell(threadId) });
      queryClient.removeQueries({ queryKey: ["threads", "chat", threadId] });
      queryClient.removeQueries({ queryKey: threadQueryKeys.diff(threadId) });
      // Update thread lists
      queryClient.setQueriesData<InfiniteData<ThreadInfo[]>>(
        { queryKey: threadQueryKeys.list(null) },
        (old) => {
          if (!old) return old;
          return {
            ...old,
            pages: old.pages.map((page) =>
              page.filter((thread) => thread.id !== threadId),
            ),
          };
        },
      );
    },
    onError: (_, threadId) => {
      queryClient.invalidateQueries({
        queryKey: threadQueryKeys.detail(threadId),
      });
      queryClient.invalidateQueries({
        queryKey: threadQueryKeys.shell(threadId),
      });
      queryClient.invalidateQueries({ queryKey: threadQueryKeys.list(null) });
    },
  });
}

export function useUpdateThreadVisibilityMutation() {
  return useThreadMutation({
    mutationFn: updateThreadVisibilityAction,
    updateThread: (thread, { visibility }) => ({ ...thread, visibility }),
    updateShell: (thread, { visibility }) => ({ ...thread, visibility }),
  });
}

export function useUpdateThreadNameMutation() {
  return useThreadMutation({
    mutationFn: updateThreadName,
    updateThread: (thread, { name }) => ({ ...thread, name }),
    updateShell: (thread, { name }) => ({ ...thread, name }),
  });
}

export function useUpdateDraftThreadMutation() {
  return useThreadMutation({
    mutationFn: updateDraftThread,
    updateThread: (thread, { updates }) => ({ ...thread, ...updates }),
    updateShell: (thread, { updates }) => ({ ...thread, ...updates }),
  });
}

export function useSubmitDraftThreadMutation() {
  return useThreadMutation({
    mutationFn: submitDraftThread,
    updateThread: (thread, args) => ({
      ...thread,
      status: args.scheduleAt ? ("scheduled" as const) : ("queued" as const),
      scheduleAt: args.scheduleAt ? new Date(args.scheduleAt) : null,
      draftMessage: null,
    }),
  });
}

export function useCreateThreadMutation() {
  const queryClient = useQueryClient();

  return useServerActionMutation<
    NewThreadArgs,
    NewThreadResult,
    { optimisticThreads: OptimisticThreadDescriptor[] }
  >({
    mutationFn: newThread,
    onMutate: async (variables) => {
      const optimisticThreads = buildOptimisticThreadsForCreate({
        userMessage: variables.message,
        githubRepoFullName: variables.githubRepoFullName,
        branchName: variables.branchName,
        createNewBranch: variables.createNewBranch,
        saveAsDraft: variables.saveAsDraft,
        scheduleAt: variables.scheduleAt,
        disableGitCheckpointing: variables.disableGitCheckpointing,
        skipSetup: variables.skipSetup,
        selectedModels: variables.selectedModels,
      });

      await queryClient.cancelQueries({ queryKey: ["threads"] });

      optimisticThreads.forEach(({ thread }) => {
        insertThreadInfo(thread);
        insertOptimisticThreadIntoListQueries(queryClient, thread);
      });

      return { optimisticThreads };
    },
    onSuccess: (result, variables, context) => {
      const optimisticThreads = context?.optimisticThreads ?? [];
      reconcileCreatedThreads({
        optimisticThreads,
        result,
        queryClient,
      });

      result.createdThreads.forEach((createdThread) => {
        void queryClient.prefetchQuery(
          threadQueryOptions(createdThread.threadId),
        );
        void queryClient.prefetchQuery(
          threadShellQueryOptions(createdThread.threadId),
        );
        void queryClient.prefetchQuery(
          threadChatQueryOptions({
            threadId: createdThread.threadId,
            threadChatId: createdThread.threadChatId,
          }),
        );
      });

      void queryClient.invalidateQueries({
        queryKey: threadQueryKeys.list(null),
      });

      if (result.failedModels.length > 0) {
        const failedModelList = result.failedModels
          .map((failedModel) => failedModel.model)
          .join(", ");
        toast.error(
          `Some tasks could not be created: ${failedModelList}. The successful tasks are still available.`,
        );
      }
    },
    onError: (error, variables, context) => {
      console.error(error);
      context?.optimisticThreads.forEach((optimisticThread) => {
        removeThreadInfo(optimisticThread.id);
        removeOptimisticThreadFromListQueries(queryClient, optimisticThread.id);
      });
      void queryClient.invalidateQueries({
        queryKey: threadQueryKeys.list(null),
      });
    },
  });
}
