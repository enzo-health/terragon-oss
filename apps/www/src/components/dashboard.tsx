"use client";

import {
  DashboardPromptBoxHandleSubmit,
  DashboardPromptBox,
} from "./promptbox/dashboard-promptbox";
import { ThreadListMain } from "./thread-list/main";
import { useTypewriterEffect } from "@/hooks/useTypewriter";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { useInfiniteThreadList } from "@/queries/thread-queries";
import { convertToPlainText } from "@/lib/db-message-helpers";
import { HandleUpdate } from "./promptbox/use-promptbox";
import { cn } from "@/lib/utils";
import { RecommendedTasks } from "./recommended-tasks";
import { useAtomValue } from "jotai";
import { selectedModelAtom } from "@/atoms/user-flags";
import { useCreateThreadMutation } from "@/queries/thread-mutations";

export function Dashboard({
  showArchived = false,
}: {
  showArchived?: boolean;
}) {
  const [typewriterEffectEnabled, setTypewriterEffectEnabled] = useState(true);
  const placeholder = useTypewriterEffect(typewriterEffectEnabled);
  const createThreadMutation = useCreateThreadMutation();
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
      await createThreadMutation.mutateAsync({
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
      });
      if (saveAsDraft) {
        toast.success("Task saved as draft successfully.");
      } else {
        toast.success("Task created! Getting to work...", {
          icon: "🚀",
          duration: 3000,
        });
      }
    },
    [createThreadMutation],
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
        "animate-in fade-in slide-in-from-bottom-4 duration-500 ease-out",
      )}
    >
      <div
        className={cn(
          "flex flex-col gap-2",
          "animate-in fade-in slide-in-from-bottom-2 duration-500 delay-100",
        )}
      >
        <h1 className="text-[32px] font-display font-semibold tracking-[-0.02em] leading-[1.1] text-foreground">
          What would you like to build?
        </h1>
        <p className="text-[14px] text-muted-foreground">
          Describe a task and I&apos;ll get to work in a sandbox.
        </p>
      </div>

      <div className="animate-in fade-in slide-in-from-bottom-2 duration-500 delay-200">
        <DashboardPromptBox
          placeholder={placeholder}
          status={null}
          threadId={null}
          onUpdate={onUpdate}
          handleStop={handleStop}
          handleSubmit={handleSubmit}
          promptText={promptText ?? undefined}
        />
      </div>
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
