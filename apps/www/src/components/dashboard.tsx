"use client";

import {
  DashboardPromptBoxHandleSubmit,
  DashboardPromptBox,
} from "./promptbox/dashboard-promptbox";
import { ThreadListMain } from "./thread-list/main";
import { newThread } from "@/server-actions/new-thread";
import { useTypewriterEffect } from "@/hooks/useTypewriter";
import { useCallback, useState } from "react";
import { InfiniteData, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  threadQueryKeys,
  useInfiniteThreadList,
} from "@/queries/thread-queries";
import { ThreadInfo } from "@terragon/shared";
import { convertToPlainText } from "@/lib/db-message-helpers";
import { HandleUpdate } from "./promptbox/use-promptbox";
import { cn } from "@/lib/utils";
import { RecommendedTasks } from "./recommended-tasks";
import { useAtomValue } from "jotai";
import { selectedModelAtom } from "@/atoms/user-flags";
import { unwrapError, unwrapResult } from "@/lib/server-actions";

export function Dashboard({
  showArchived = false,
}: {
  showArchived?: boolean;
}) {
  const [typewriterEffectEnabled, setTypewriterEffectEnabled] = useState(true);
  const placeholder = useTypewriterEffect(typewriterEffectEnabled);
  const queryClient = useQueryClient();
  const handleSubmit = useCallback<DashboardPromptBoxHandleSubmit>(
    async ({
      userMessage,
      repoFullName,
      selectedModels,
      branchName,
      saveAsDraft,
      scheduleAt,
      disableGitCheckpointing,
      skipSetup,
      createNewBranch,
      runInSdlcLoop,
    }) => {
      // Build an optimistic thread to show immediately in the list
      const optimisticId = `optimistic-${Date.now()}`;
      const now = new Date();
      const optimisticThread: ThreadInfo = {
        id: optimisticId,
        userId: "",
        name:
          convertToPlainText({
            message: userMessage,
            skipAttachments: true,
          }).slice(0, 100) || "New task",
        githubRepoFullName: repoFullName,
        githubPRNumber: null,
        githubIssueNumber: null,
        codesandboxId: null,
        sandboxProvider: "e2b",
        sandboxSize: null,
        sandboxStatus: null,
        bootingSubstatus: null,
        createdAt: now,
        updatedAt: now,
        repoBaseBranchName: branchName || "main",
        branchName: null,
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
        threadChats: [
          {
            id: "optimistic-chat",
            agent: "claudeCode",
            status: saveAsDraft
              ? ("draft" as any)
              : scheduleAt
                ? ("scheduled" as any)
                : "queued",
            errorMessage: null,
          },
        ],
      };

      // Optimistically prepend to all matching list queries
      const listQueryKey = threadQueryKeys.list({ archived: showArchived });
      await queryClient.cancelQueries({ queryKey: threadQueryKeys.list(null) });
      queryClient.setQueryData<InfiniteData<ThreadInfo[]>>(
        listQueryKey,
        (old) => {
          if (!old) return old;
          const [firstPage = [], ...rest] = old.pages;
          return { ...old, pages: [[optimisticThread, ...firstPage], ...rest] };
        },
      );

      try {
        unwrapResult(
          await newThread({
            message: userMessage,
            githubRepoFullName: repoFullName,
            branchName,
            saveAsDraft,
            disableGitCheckpointing,
            skipSetup,
            createNewBranch,
            runInSdlcLoop,
            scheduleAt,
            selectedModels,
          }),
        );
        if (saveAsDraft) {
          toast.success("Task saved as draft successfully.");
        }
        // Refetch to replace optimistic entry with real data
        queryClient.invalidateQueries({
          queryKey: threadQueryKeys.list(null),
        });
      } catch (error: any) {
        // Roll back optimistic update
        queryClient.setQueryData<InfiniteData<ThreadInfo[]>>(
          listQueryKey,
          (old) => {
            if (!old) return old;
            return {
              ...old,
              pages: old.pages.map((page) =>
                page.filter((t) => t.id !== optimisticId),
              ),
            };
          },
        );
        console.error("Failed to create thread:", error);
        toast.error(unwrapError(error), { duration: 5000 });
        throw error;
      }
    },
    [queryClient, showArchived],
  );

  const handleStop = useCallback(async () => {
    throw new Error("Cannot stop thread in dashboard.");
  }, []);

  const onUpdate = useCallback<HandleUpdate>(({ userMessage }) => {
    const plainText = convertToPlainText({
      message: userMessage,
      skipAttachments: true,
    });
    setTypewriterEffectEnabled(plainText.length === 0);
  }, []);

  const [promptText, setPromptText] = useState<string | null>(null);
  const selectedModel = useAtomValue(selectedModelAtom);

  // Determine if there are any active tasks; used for Sawyer UI empty state
  const { data } = useInfiniteThreadList({ archived: false });
  const showRecommendedTasks =
    (data?.pages.flatMap((page) => page) ?? []).length < 3;

  return (
    <div
      className={cn(
        "flex flex-col h-full max-w-2xl w-full mx-auto gap-8 justify-start pt-2.5",
      )}
    >
      <DashboardPromptBox
        placeholder={placeholder}
        status={null}
        threadId={null}
        onUpdate={onUpdate}
        handleStop={handleStop}
        handleSubmit={handleSubmit}
        promptText={promptText ?? undefined}
      />
      {showRecommendedTasks && (
        <div className="space-y-2 hidden lg:block">
          <h3 className="text-sm font-medium text-muted-foreground/70">
            Suggested tasks
          </h3>
          <RecommendedTasks
            onTaskSelect={(p) => setPromptText(p)}
            selectedModel={selectedModel}
          />
        </div>
      )}
      <div className="lg:hidden">
        <ThreadListMain
          queryFilters={{ archived: showArchived }}
          viewFilter={showArchived ? "archived" : "active"}
          allowGroupBy={true}
          showSuggestedTasks={showRecommendedTasks}
          setPromptText={setPromptText}
        />
      </div>
    </div>
  );
}
