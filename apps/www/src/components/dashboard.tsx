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
import { Rocket } from "lucide-react";

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
    }) => {
      await createThreadMutation.mutateAsync({
        message: userMessage,
        githubRepoFullName: repoFullName,
        branchName,
        saveAsDraft,
        disableGitCheckpointing,
        skipSetup,
        createNewBranch,
        scheduleAt,
        selectedModels,
      });
      if (saveAsDraft) {
        toast.success("Task saved as draft successfully.");
      } else {
        toast.success("Task created! Getting to work...", {
          icon: <Rocket className="size-4" />,
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
    // Center the hero vertically when there's not much content below it.
    // justify-center on tall viewports settles the headline + prompt
    // around the optical middle instead of clinging to the top edge.
    <div
      className={cn(
        // Symmetric vertical padding (py-16 = 64px) so the hero feels
        // balanced rather than clinging to the top with 80px unused below.
        // Outer gap-8 gives clear separation between conceptual blocks.
        "flex flex-col h-full max-w-chat w-full mx-auto gap-8 justify-center py-16 px-6",
        "animate-in fade-in duration-300",
      )}
    >
      <div className="flex flex-col gap-3">
        <h1 className="font-display text-[40px] font-normal tracking-[-0.035em] leading-[1.05] text-foreground">
          What would you like to build?
        </h1>
        {/* Subtitle: shorter is better here. The previous 2-line copy
            described what happens behind the scenes; the user already
            knows that. One line reads as a confident product statement. */}
        <p className="text-[15px] leading-relaxed text-muted-foreground">
          Describe a task and I&apos;ll get to work.
        </p>
      </div>

      <div>
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
        // Brand caption-uppercase: 12px / 500 / 1.5px tracking. Reduced
        // section gap since the rows below now have their own padding.
        <div className="space-y-3 hidden md:block">
          <h2 className="text-[12px] uppercase tracking-[0.13em] font-medium text-muted-foreground">
            Suggested tasks
          </h2>
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
