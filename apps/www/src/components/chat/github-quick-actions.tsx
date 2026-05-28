import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { PRStatusPill } from "@/components/pr-status-pill";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { isAgentWorking } from "@/agent/thread-status";
import {
  GithubCheckStatus,
  GithubPRStatus,
  ThreadStatus,
} from "@terragon/shared";
import { useThreadIntent } from "@/hooks/use-thread-intent";

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
  const { publish } = useThreadIntent();
  const [isFixing, setIsFixing] = useState(false);
  const [isMarking, setIsMarking] = useState(false);

  const handleFixChecks = useCallback(async () => {
    setIsFixing(true);
    try {
      await publish({ type: "fix-checks", threadId, threadChatId });
      // Give the system message a chance to be sent
      await new Promise((resolve) => setTimeout(resolve, 2000));
    } catch {
      // Error handled by subscriber
    } finally {
      setIsFixing(false);
    }
  }, [publish, threadId, threadChatId]);

  const handleMarkReady = useCallback(async () => {
    setIsMarking(true);
    try {
      await publish({ type: "mark-pr-ready", threadId });
      // Give the system a chance to update
      await new Promise((resolve) => setTimeout(resolve, 2000));
    } catch {
      // Error handled by subscriber
    } finally {
      setIsMarking(false);
    }
  }, [publish, threadId]);

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
            onClick={handleFixChecks}
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
            onClick={handleMarkReady}
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
