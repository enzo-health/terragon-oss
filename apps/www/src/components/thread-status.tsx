import { combineThreadStatuses } from "@/agent/thread-status";
import { cn } from "@/lib/utils";
import { ThreadInfo, ThreadStatus } from "@terragon/shared";
import { Clock, Check, CircleDashed, X, File, Calendar } from "lucide-react";
import React, { memo } from "react";

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

/** "sm" renders a compact glyph suitable for an overlay badge; "default"
 * keeps the historical size used everywhere the indicator stands alone. */
export type ThreadStatusIndicatorSize = "sm" | "default";

export const ThreadStatusIndicator = memo(function ThreadStatusIndicator({
  thread,
  isOptimistic,
  size = "default",
}: {
  thread: Pick<ThreadInfo, "isUnread" | "threadChats" | "draftMessage">;
  isOptimistic?: boolean;
  size?: ThreadStatusIndicatorSize;
}) {
  // For optimistic threads, show creating state
  if (isOptimistic) {
    const dotSize = size === "sm" ? "h-2 w-2" : "h-2.5 w-2.5";
    return (
      <div className="flex-shrink-0" title="Creating">
        <span className={cn("relative flex", dotSize)}>
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-coral/30 opacity-60" />
          <span
            className={cn(
              "relative inline-flex rounded-full bg-coral/50",
              dotSize,
            )}
          />
        </span>
      </div>
    );
  }

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
      size={size}
    />
  );
});

function MinimalStatusIndicator({
  isUnread,
  isDraft,
  isError,
  status,
  className,
  size = "default",
}: {
  isUnread: boolean;
  isDraft: boolean;
  status: ThreadStatus;
  isError: boolean;
  className?: string;
  size?: ThreadStatusIndicatorSize;
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
  const iconSize = size === "sm" ? "size-2.5" : "size-3.5";
  const unreadDot = size === "sm" ? "w-1.5 h-1.5" : "w-2 h-2";
  const icons = {
    draft: <File strokeWidth={2} className={cn("text-mid", iconSize)} />,
    scheduled: (
      <Calendar
        strokeWidth={strokeWidth}
        className={cn("text-mid", iconSize)}
      />
    ),
    pending: (
      <Clock
        strokeWidth={strokeWidth}
        className={cn("text-warning", iconSize)}
      />
    ),
    active: (
      <CircleDashed
        strokeWidth={2}
        className={cn(
          "text-strong/60 animate-[spin_2s_linear_infinite]",
          iconSize,
        )}
      />
    ),
    finishing: (
      <Check
        strokeWidth={strokeWidth}
        className={cn("text-success", iconSize)}
      />
    ),
    complete: (
      <Check
        strokeWidth={strokeWidth}
        className={cn("text-success", iconSize)}
      />
    ),
    error: (
      <X strokeWidth={strokeWidth} className={cn("text-error", iconSize)} />
    ),
    unread: <div className={cn("rounded-full bg-info", unreadDot)} />,
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
