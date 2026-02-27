import React from "react";
import { AllToolParts } from "@terragon/shared";

import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Sparkles, ExternalLink, Rocket } from "lucide-react";
import { useThread } from "../thread-context";
import Link from "next/link";
import { selectedModelAtom } from "@/atoms/user-flags";
import { useAtomValue } from "jotai";
import { useServerActionMutation } from "@/queries/server-action-helpers";
import { newThread } from "@/server-actions/new-thread";

export function SuggestFollowupTaskTool({
  toolPart,
}: {
  toolPart: Extract<AllToolParts, { name: "SuggestFollowupTask" }>;
}) {
  const { thread } = useThread();
  const selectedModel = useAtomValue(selectedModelAtom);
  // Find if a child thread exists for this toolPart
  const existingChildThread = thread?.childThreads?.find(
    (child) => child.parentToolId === toolPart.id,
  );

  const createNewThreadMutation = useServerActionMutation({
    mutationFn: newThread,
  });

  const handleCreateFollowUpTask = async () => {
    if (!thread) {
      return;
    }
    await createNewThreadMutation.mutateAsync({
      githubRepoFullName: thread.githubRepoFullName,
      branchName: thread.repoBaseBranchName,
      sourceType: "www-suggested-followup-task",
      parentThreadId: thread.id,
      parentToolId: toolPart.id,
      message: {
        type: "user",
        model: selectedModel,
        timestamp: new Date().toISOString(),
        parts: [
          {
            type: "text",
            text: `${toolPart.parameters.title}\n\n${toolPart.parameters.description}`,
          },
        ],
      },
    });
  };

  return (
    <div className="flex flex-col gap-2 border border-border rounded-md p-3 sm:p-4 bg-card">
      <div className="flex flex-col sm:flex-row sm:items-baseline sm:justify-between gap-2 sm:gap-4">
        <div className="flex items-start sm:items-baseline gap-2 min-w-0">
          <Sparkles className="size-3 text-yellow-600 shrink-0 mt-0.5 sm:mt-0" />
          <span className="font-semibold text-sm sm:text-base text-foreground leading-tight break-words">
            {toolPart.parameters.title}
          </span>
        </div>
        {toolPart.status === "completed" && (
          <div className="shrink-0 self-start sm:self-auto">
            {existingChildThread ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    asChild
                    className="h-8 text-xs sm:text-sm"
                  >
                    <Link href={`/task/${existingChildThread.id}`}>
                      View
                      <ExternalLink className="size-3.5 sm:size-4 ml-1" />
                    </Link>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>View task</TooltipContent>
              </Tooltip>
            ) : (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    onClick={handleCreateFollowUpTask}
                    disabled={createNewThreadMutation.isPending}
                    variant="outline"
                    size="sm"
                    className="h-8 text-xs sm:text-sm"
                  >
                    Start
                    {createNewThreadMutation.isPending ? (
                      <div className="size-3.5 sm:size-4 animate-spin rounded-full border-2 border-current border-t-transparent ml-1" />
                    ) : (
                      <Rocket className="size-3.5 sm:size-4 ml-1" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Create follow-up task</TooltipContent>
              </Tooltip>
            )}
          </div>
        )}
      </div>
      {toolPart.parameters.description && (
        <p className="text-xs sm:text-sm text-muted-foreground whitespace-pre-wrap leading-relaxed">
          {toolPart.parameters.description}
        </p>
      )}
    </div>
  );
}
