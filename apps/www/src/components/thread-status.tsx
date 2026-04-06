import { combineThreadStatuses } from "@/agent/thread-status";
import { cn } from "@/lib/utils";
import { ThreadInfo, ThreadStatus } from "@terragon/shared";
import { Clock, Check, CircleDashed, X, File, Calendar } from "lucide-react";
import { memo } from "react";

type MinimalThreadStatus =
  | "unread" // Thread is unread
  | "scheduled" // Thread is scheduled
  | "draft" // Thread saved as draft, not submitted
  | "pending" // Combines: queued, queued-tasks-concurrency, queued-sandbox-creation-rate-limit
  | "active" // Combines: booting, working
  | "finishing" // Combines: stopping, checkpointing, working-done
  | "complete" // Final state
  | "error"; // Any error state

function getMinimalStatus(detailedStatus: ThreadStatus): MinimalThreadStatus {
  const statusMap: Record<ThreadStatus, MinimalThreadStatus> = {
    draft: "draft",
    scheduled: "scheduled",
    queued: "pending",
    "queued-tasks-concurrency": "pending",
    "queued-sandbox-creation-rate-limit": "pending",
    "queued-agent-rate-limit": "pending",
    "queued-blocked": "pending", // deprecated but still mapping
    booting: "active",
    working: "active",
    stopping: "finishing",
    checkpointing: "finishing",
    "working-done": "finishing",
    complete: "complete",
    "working-error": "error",
    "working-stopped": "finishing",
    stopped: "complete",
    error: "error",
  };

  return statusMap[detailedStatus] || "pending";
}

function getStatusLabel({
  status,
  isError,
}: {
  status: ThreadStatus;
  isError?: boolean;
}): string {
  if (isError) {
    return "Error";
  }
  const labels: Record<ThreadStatus, string> = {
    draft: "Draft",
    queued: "Queued",
    scheduled: "Scheduled",
    "queued-tasks-concurrency": "Waiting for sandbox",
    "queued-sandbox-creation-rate-limit": "Rate limited",
    "queued-agent-rate-limit": "Agent rate limit reached",
    "queued-blocked": "Blocked",
    booting: "Starting",
    working: "Running",
    stopping: "Stopping",
    checkpointing: "Wrapping up",
    "working-done": "Finishing",
    complete: "Complete",
    "working-error": "Error",
    "working-stopped": "Stopped",
    stopped: "Stopped",
    error: "Error",
  };

  return labels[status] || status;
}

export const ThreadStatusIndicator = memo(function ThreadStatusIndicator({
  thread,
}: {
  thread: Pick<ThreadInfo, "isUnread" | "threadChats" | "draftMessage">;
}) {
  const status = combineThreadStatuses(
    thread.threadChats.map((chat) => chat.status),
  );
  const isError = thread.threadChats.some((chat) => chat.errorMessage !== null);
  return (
    <MinimalStatusIndicator
      isUnread={thread.isUnread}
      isDraft={!!thread.draftMessage}
      status={status}
      isError={isError}
    />
  );
});

function MinimalStatusIndicator({
  isUnread,
  isDraft,
  isError,
  status,
  className,
}: {
  isUnread: boolean;
  isDraft: boolean;
  status: ThreadStatus;
  isError: boolean;
  className?: string;
}) {
  let minimalStatus = getMinimalStatus(status);
  // active should take precedence over unread
  if (isUnread && minimalStatus !== "active") {
    minimalStatus = "unread";
  } else if (isError) {
    minimalStatus = "error";
  } else if (isDraft) {
    minimalStatus = "draft";
  }

  const strokeWidth = 2.5;
  const size = "size-3.5";
  const icons = {
    draft: (
      <File strokeWidth={2} className={cn("text-muted-foreground", size)} />
    ),
    scheduled: (
      <Calendar
        strokeWidth={strokeWidth}
        className={cn("text-muted-foreground", size)}
      />
    ),
    pending: (
      <Clock strokeWidth={strokeWidth} className={cn("text-amber-600", size)} />
    ),
    active: (
      <CircleDashed
        strokeWidth={2}
        className={cn(
          "text-foreground/60 animate-[spin_2s_linear_infinite]",
          size,
        )}
      />
    ),
    finishing: (
      <Check
        strokeWidth={strokeWidth}
        className={cn("text-emerald-600", size)}
      />
    ),
    complete: (
      <Check
        strokeWidth={strokeWidth}
        className={cn("text-emerald-600", size)}
      />
    ),
    error: <X strokeWidth={strokeWidth} className={cn("text-red-600", size)} />,
    unread: <div className="w-2 h-2 rounded-full bg-blue-500" />,
  };
  return (
    <div
      className={cn("flex-shrink-0", className)}
      title={getStatusLabel({ status, isError })}
    >
      {icons[minimalStatus]}
    </div>
  );
}
