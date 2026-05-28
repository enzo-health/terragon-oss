"use client";

import {
  DashboardPromptBoxHandleSubmit,
  DashboardPromptBox,
} from "./promptbox/dashboard-promptbox";
import { ThreadListMain } from "./thread-list/main";
import { useTypewriterEffect } from "@/hooks/useTypewriter";
import { useCallback, useEffect, useState } from "react";
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
      className="rounded-xl border border-hairline bg-card/80 px-4 py-3 shadow-[var(--shadow-warm-lift)] animate-in fade-in slide-in-from-bottom-1 duration-[var(--duration-base)] ease-[var(--ease-emphasis)]"
    >
      <div className="flex items-start gap-3">
        <div className="relative mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-coral/10 text-coral">
          <span
            aria-hidden
            className="absolute inline-flex transition-[opacity,transform,filter] duration-[var(--duration-base)] ease-[var(--ease-emphasis)]"
            style={{
              opacity: isOpening ? 0 : 1,
              transform: isOpening ? "scale(0.25)" : "scale(1)",
              filter: isOpening ? "blur(4px)" : "blur(0px)",
            }}
          >
            <Loader2 className="size-3.5 animate-spin" />
          </span>
          <span
            aria-hidden
            className="absolute inline-flex transition-[opacity,transform,filter] duration-[var(--duration-base)] ease-[var(--ease-emphasis)]"
            style={{
              opacity: isOpening ? 1 : 0,
              transform: isOpening ? "scale(1)" : "scale(0.25)",
              filter: isOpening ? "blur(0px)" : "blur(4px)",
            }}
          >
            <Check className="size-3.5" />
          </span>
        </div>
        <div className="relative min-w-0 flex-1">
          <div
            key={state.kind}
            className="animate-in fade-in slide-in-from-bottom-1 duration-[var(--duration-quick)] ease-[var(--ease-emphasis)]"
          >
            <div className="flex items-center gap-2">
              <p className="text-sm font-medium text-foreground text-balance">
                {state.title}
              </p>
              <span
                className="h-1.5 w-1.5 rounded-full bg-coral/70 transition-opacity duration-[var(--duration-base)]"
                style={{ opacity: isOpening ? 0 : 1 }}
              />
            </div>
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground text-pretty">
              {state.detail}
            </p>
          </div>
        </div>
        <div
          className="shrink-0 transition-[opacity,transform] duration-[var(--duration-base)] ease-[var(--ease-emphasis)]"
          style={{
            opacity: state.taskHref ? 1 : 0,
            transform: state.taskHref ? "translateX(0)" : "translateX(4px)",
            pointerEvents: state.taskHref ? "auto" : "none",
          }}
          aria-hidden={!state.taskHref}
        >
          {state.taskHref ? (
            <Button asChild variant="outline" size="xs">
              <a href={state.taskHref}>Open</a>
            </Button>
          ) : (
            <Button variant="outline" size="xs" disabled tabIndex={-1}>
              Open
            </Button>
          )}
        </div>
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
        if (scheduleAt) {
          toast.success("Task scheduled.", {
            icon: <Rocket className="size-4" />,
            duration: 2000,
          });
          router.push(taskHref);
        } else {
          await new Promise((resolve) => setTimeout(resolve, 140));
          router.push(taskHref);
        }
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
  const isLaunching = launchState.kind !== "idle";
  const showRecommendedExpanded = showRecommendedTasks && !isLaunching;

  const [visibleLaunchState, setVisibleLaunchState] = useState<Exclude<
    LaunchState,
    { kind: "idle" }
  > | null>(null);
  useEffect(() => {
    if (launchState.kind !== "idle") {
      setVisibleLaunchState(launchState);
      return;
    }
    const timeout = setTimeout(() => setVisibleLaunchState(null), 240);
    return () => clearTimeout(timeout);
  }, [launchState]);

  return (
    <div
      className={cn(
        "flex flex-col h-full max-w-chat w-full mx-auto gap-8 justify-center py-16 px-6",
        "animate-in fade-in duration-300",
      )}
    >
      <div className="flex flex-col gap-3">
        <h1 className="font-display text-[40px] font-normal tracking-[-0.035em] leading-[1.05] text-foreground text-balance">
          What would you like to build?
        </h1>
        <p className="text-[15px] leading-relaxed text-muted-foreground text-pretty">
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
        <div
          className={cn(
            "grid transition-[grid-template-rows,opacity] duration-[var(--duration-base)] ease-[var(--ease-emphasis)]",
            isLaunching
              ? "grid-rows-[1fr] opacity-100"
              : "grid-rows-[0fr] opacity-0",
          )}
          aria-hidden={!isLaunching}
        >
          <div className="overflow-hidden">
            {visibleLaunchState ? (
              <DashboardLaunchStatus state={visibleLaunchState} />
            ) : null}
          </div>
        </div>
      </div>
      <div
        className={cn(
          "hidden md:grid transition-[grid-template-rows,opacity] duration-[var(--duration-base)] ease-[var(--ease-emphasis)]",
          showRecommendedExpanded
            ? "grid-rows-[1fr] opacity-100"
            : "grid-rows-[0fr] opacity-0",
        )}
        aria-hidden={!showRecommendedExpanded}
      >
        <div className="overflow-hidden">
          <div className="space-y-3">
            <h2 className="text-[12px] uppercase tracking-[0.13em] font-medium text-muted-foreground">
              Suggested tasks
            </h2>
            <RecommendedTasks
              onTaskSelect={setPromptText}
              selectedModel={selectedModel}
            />
          </div>
        </div>
      </div>
      <div className="md:hidden">
        <ThreadListMain
          queryFilters={{ archived: showArchived }}
          viewFilter={showArchived ? "archived" : "active"}
          allowGroupBy={true}
          showSuggestedTasks={showRecommendedExpanded}
          setPromptText={setPromptText}
        />
      </div>
    </div>
  );
}
