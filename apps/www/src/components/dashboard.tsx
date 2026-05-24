"use client";

import {
  DashboardPromptBoxHandleSubmit,
  DashboardPromptBox,
} from "./promptbox/dashboard-promptbox";
import { ThreadListMain } from "./thread-list/main";
import { useTypewriterEffect } from "@/hooks/useTypewriter";
import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useInfiniteThreadList } from "@/queries/thread-queries";
import { convertToPlainText } from "@/lib/db-message-helpers";
import { HandleUpdate } from "./promptbox/use-promptbox";
import { cn } from "@/lib/utils";
import { RecommendedTasks } from "./recommended-tasks";
import { useAtomValue } from "jotai";
import { selectedModelAtom } from "@/atoms/user-flags";
import { useCreateThreadMutation } from "@/queries/thread-mutations";
import { Check, Loader2, Rocket } from "lucide-react";
import { Button } from "./ui/button";

type LaunchState =
  | { kind: "idle" }
  | {
      kind: "creating" | "opening";
      title: string;
      detail: string;
      taskHref?: string;
    };

function DashboardLaunchStatus({
  state,
}: {
  state: Exclude<LaunchState, { kind: "idle" }>;
}) {
  const isOpening = state.kind === "opening";

  return (
    <div
      role="status"
      aria-live="polite"
      className="rounded-xl border border-hairline bg-card/80 px-4 py-3 shadow-[var(--shadow-warm-lift)] animate-in fade-in slide-in-from-bottom-1 duration-200"
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-coral/10 text-coral">
          {isOpening ? (
            <Check className="size-3.5" aria-hidden />
          ) : (
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium text-foreground">{state.title}</p>
            <span className="h-1.5 w-1.5 rounded-full bg-coral/70 animate-pulse" />
          </div>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
            {state.detail}
          </p>
        </div>
        {state.taskHref ? (
          <Button asChild variant="outline" size="xs" className="shrink-0">
            <a href={state.taskHref}>Open</a>
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function Dashboard({
  showArchived = false,
}: {
  showArchived?: boolean;
}) {
  const [typewriterEffectEnabled, setTypewriterEffectEnabled] = useState(true);
  const placeholder = useTypewriterEffect(typewriterEffectEnabled);
  const createThreadMutation = useCreateThreadMutation();
  const router = useRouter();
  const [launchState, setLaunchState] = useState<LaunchState>({
    kind: "idle",
  });
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
      setLaunchState({
        kind: "creating",
        title: saveAsDraft
          ? "Saving draft"
          : scheduleAt
            ? "Scheduling task"
            : "Creating task",
        detail:
          saveAsDraft || scheduleAt
            ? "Keeping your workspace ready without starting the agent."
            : "Creating the task and preparing the workspace. You will move there automatically.",
      });
      const result = await createThreadMutation.mutateAsync({
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
        setLaunchState({ kind: "idle" });
        toast.success("Task saved as draft successfully.");
      } else {
        const taskHref = `/task/${result.threadId}`;
        setLaunchState({
          kind: "opening",
          title: scheduleAt ? "Task scheduled" : "Opening task",
          detail: scheduleAt
            ? "The task is ready and will run at the scheduled time."
            : "Task created. Opening the live agent workspace now.",
          taskHref,
        });
        toast.success(
          scheduleAt ? "Task scheduled." : "Task created! Opening task...",
          {
            icon: <Rocket className="size-4" />,
            duration: 2000,
          },
        );
        router.push(taskHref);
      }
    },
    [createThreadMutation, router],
  );

  const handlePromptSubmit = useCallback<DashboardPromptBoxHandleSubmit>(
    async (args) => {
      try {
        await handleSubmit(args);
      } catch (error) {
        setLaunchState({ kind: "idle" });
        throw error;
      }
    },
    [handleSubmit],
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

  const { data: threadPages } = useInfiniteThreadList({ archived: false });
  const showRecommendedTasks = (threadPages?.pages[0]?.length ?? 0) < 3;

  return (
    <div
      className={cn(
        "flex flex-col h-full max-w-chat w-full mx-auto gap-8 justify-center py-16 px-6",
        "animate-in fade-in duration-300",
      )}
    >
      <div className="flex flex-col gap-3">
        <h1 className="font-display text-[40px] font-normal tracking-[-0.035em] leading-[1.05] text-foreground">
          What would you like to build?
        </h1>
        <p className="text-[15px] leading-relaxed text-muted-foreground">
          Describe a task and I&apos;ll get to work.
        </p>
      </div>

      <div className="space-y-3">
        <DashboardPromptBox
          placeholder={placeholder}
          status={null}
          threadId={null}
          onUpdate={onUpdate}
          handleStop={handleStop}
          handleSubmit={handlePromptSubmit}
          promptText={promptText ?? undefined}
        />
        {launchState.kind !== "idle" ? (
          <DashboardLaunchStatus state={launchState} />
        ) : null}
      </div>
      {showRecommendedTasks && launchState.kind === "idle" && (
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
          showSuggestedTasks={
            showRecommendedTasks && launchState.kind === "idle"
          }
          setPromptText={setPromptText}
        />
      </div>
    </div>
  );
}
