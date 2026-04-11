"use client";

import {
  DashboardPromptBoxHandleSubmit,
  DashboardPromptBox,
} from "./promptbox/dashboard-promptbox";
import { ThreadListMain } from "./thread-list/main";
import { newThread } from "@/server-actions/new-thread";
import { useTypewriterEffect } from "@/hooks/useTypewriter";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { ThreadInfo } from "@terragon/shared";
import { getThreadInfoCollection } from "@/collections/thread-info-collection";
import { useInfiniteThreadList } from "@/queries/thread-queries";
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
      runInDeliveryLoop,
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
        messageSeq: 0,
        threadChats: [
          {
            id: "optimistic-chat",
            agent: "claudeCode",
            status: saveAsDraft ? "draft" : scheduleAt ? "scheduled" : "queued",
            errorMessage: null,
          },
        ],
      };

      // Optimistically insert into the TanStack DB collection
      const collection = getThreadInfoCollection();
      if (collection.status === "ready") {
        collection.insert(optimisticThread);
      }

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
            runInDeliveryLoop,
            scheduleAt,
            selectedModels,
          }),
        );
        if (saveAsDraft) {
          toast.success("Task saved as draft successfully.");
        }
      } catch (error: unknown) {
        // Roll back optimistic insert
        if (
          collection.status === "ready" &&
          collection.state.has(optimisticId)
        ) {
          collection.delete(optimisticId);
        }
        console.error("Failed to create thread:", error);
        toast.error(unwrapError(error), { duration: 5000 });
        throw error;
      }
    },
    [],
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

  // Show recommended tasks when user has few active threads
  const { data: threadPages } = useInfiniteThreadList({ archived: false });
  const showRecommendedTasks = (threadPages?.pages[0]?.length ?? 0) < 3;

  return (
    <div
      className={cn(
        "flex flex-col h-full max-w-chat w-full mx-auto gap-6 justify-start pt-8 pb-20 px-6",
      )}
    >
      <div className="flex flex-col gap-2">
        <h1 className="text-[32px] font-display font-semibold tracking-[-0.02em] leading-[1.1] text-foreground">
          What would you like to build?
        </h1>
        <p className="text-[14px] text-muted-foreground">
          Describe a task and I&apos;ll get to work in a sandbox.
        </p>
      </div>

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
        <div className="space-y-6 hidden md:block">
          <h3 className="text-[11px] uppercase tracking-[0.12em] font-semibold text-muted-foreground">
            Suggested tasks
          </h3>
          <RecommendedTasks
            onTaskSelect={setPromptText}
            selectedModel={selectedModel}
          />
        </div>
      )}
      <div className="md:hidden">
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
