import { Button } from "@/components/ui/button";
import { PRStatusPill } from "@/components/pr-status-pill";
import { fixGithubChecks } from "@/server-actions/fix-github-checks";
import { markPRReadyForReview } from "@/server-actions/mark-pr-ready";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { isAgentWorking } from "@/agent/thread-status";
import {
  GithubCheckStatus,
  GithubPRStatus,
  ThreadStatus,
} from "@terragon/shared";
import { useServerActionMutation } from "@/queries/server-action-helpers";

export function GitHubQuickActions({
  threadId,
  threadChatId,
  status,
  githubPRNumber,
  prStatus,
  prChecksStatus,
  githubRepoFullName,
}: {
  threadId: string;
  threadChatId: string;
  githubRepoFullName: string;
  status: ThreadStatus | null;
  githubPRNumber: number | null;
  prStatus: GithubPRStatus | null;
  prChecksStatus: GithubCheckStatus | null;
}) {
  const { mutate: fixChecks, isPending: isFixing } = useServerActionMutation({
    mutationFn: async () => {
      const result = await fixGithubChecks({ threadId, threadChatId });
      // Give the system message a chance to be sent
      await new Promise((resolve) => setTimeout(resolve, 2000));
      return result;
    },
  });
  const { mutate: markReady, isPending: isMarking } = useServerActionMutation({
    mutationFn: async () => {
      const result = await markPRReadyForReview({ threadId });
      // Give the system a chance to update
      await new Promise((resolve) => setTimeout(resolve, 2000));
      return result;
    },
  });

  const shouldShowBanner = githubPRNumber && prStatus;
  if (!shouldShowBanner) {
    return null;
  }
  const agentIsWorking = status !== null && isAgentWorking(status);
  const shouldShowFixButton = !agentIsWorking && prChecksStatus === "failure";
  const shouldShowMarkReadyButton =
    prStatus === "draft" && prChecksStatus !== "failure";
  const isVisible = shouldShowFixButton || shouldShowMarkReadyButton;
  if (!isVisible) {
    return null;
  }
  const isFixingChecks = isFixing;
  const isMarkingReady = isMarking;
  return (
    <div
      className={cn(
        "box-content border-t border-x rounded-tl-md rounded-tr-md border-border bg-muted/50 pb-2 -mb-2 overflow-hidden flex items-center gap-2 text-sm px-2 h-10",
      )}
    >
      <PRStatusPill
        status={prStatus}
        checksStatus={prChecksStatus}
        prNumber={githubPRNumber!}
        repoFullName={githubRepoFullName}
      />
      {shouldShowFixButton && (
        <>
          <span className="text-muted-foreground truncate">
            GitHub Checks Failed
          </span>
          &middot;
          <Button
            size="sm"
            variant="link"
            onClick={() => fixChecks()}
            disabled={isFixingChecks}
            className="underline !px-0 cursor-pointer !bg-transparent flex items-center gap-1"
          >
            {isFixingChecks ? "Sending..." : "Fix it"}
            {isFixingChecks && <Loader2 className="h-3 w-3 animate-spin" />}
          </Button>
        </>
      )}
      {shouldShowMarkReadyButton && (
        <>
          <span className="text-muted-foreground truncate">
            {prChecksStatus === "success" ? "Checks passed" : "Checks running"}
          </span>
          &middot;
          <Button
            size="sm"
            variant="link"
            onClick={() => markReady()}
            disabled={isMarkingReady}
            className="underline !px-0 cursor-pointer !bg-transparent flex items-center gap-1"
          >
            Ready for review
            {isMarkingReady && <Loader2 className="h-3 w-3 animate-spin" />}
          </Button>
        </>
      )}
    </div>
  );
}
