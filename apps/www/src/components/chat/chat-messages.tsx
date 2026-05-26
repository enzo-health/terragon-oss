import { useEffect, useState } from "react";
import { ThreadStatus } from "@terragon/shared";
import { AIAgent } from "@terragon/agent/types";
import { BootingSubstatus } from "@terragon/sandbox/types";
import { BootChecklist } from "./boot-checklist";
import { LeafLoading } from "./leaf-loading";
import type { ThreadMetaSnapshot } from "./meta-chips/use-thread-meta-events";
import Link from "next/link";
import {
  runScheduledThread,
  cancelScheduledThread,
} from "@/server-actions/scheduled-thread";
import { useTouchDevice } from "@/hooks/useTouchDevice";
import { useServerActionMutation } from "@/queries/server-action-helpers";

function getAgentRateLimitMessage({
  agent,
  retryAtStr,
}: {
  agent: AIAgent;
  retryAtStr: string;
}): string | React.ReactNode {
  return (
    <div className="flex flex-col">
      Agent rate limit reached. {retryAtStr}{" "}
      {agent === "claudeCode" && (
        <Link
          href="https://docs.terragonlabs.com/docs/agent-providers/claude-code#automatic-rate-limit-handling"
          target="_blank"
          rel="noopener noreferrer"
          className="underline hover:no-underline text-sm"
        >
          Troubleshoot Claude rate limits
        </Link>
      )}
    </div>
  );
}

function getStatusMessage({
  agent,
  status,
  bootingSubstatus,
  reattemptQueueAt,
  isTouchDevice,
}: {
  agent: AIAgent;
  status: ThreadStatus;
  bootingSubstatus?: BootingSubstatus;
  reattemptQueueAt?: Date | null;
  isTouchDevice: boolean;
}): string | React.ReactNode {
  switch (status) {
    case "draft":
      return "Draft";
    case "queued":
      return "Waiting to start";
    case "scheduled":
      return "Scheduled to run";
    case "queued-blocked":
    case "queued-tasks-concurrency":
      return "Waiting for another task to finish";
    case "queued-sandbox-creation-rate-limit":
      return "Waiting for a sandbox to be available";
    case "queued-agent-rate-limit": {
      if (reattemptQueueAt) {
        const now = new Date();
        const retryTime = new Date(reattemptQueueAt);
        const diffMs = retryTime.getTime() - now.getTime();
        if (diffMs > 0) {
          const minutes = Math.ceil(diffMs / 60000);
          if (minutes === 1) {
            return getAgentRateLimitMessage({
              agent,
              retryAtStr: "Retrying in about 1 minute.",
            });
          } else if (minutes < 60) {
            return getAgentRateLimitMessage({
              agent,
              retryAtStr: `Retrying in about ${minutes} minutes.`,
            });
          } else {
            return getAgentRateLimitMessage({
              agent,
              retryAtStr: `Retrying: ${retryTime.toLocaleString()}.`,
            });
          }
        }
      }
      return getAgentRateLimitMessage({ agent, retryAtStr: "" });
    }
    case "booting":
      // Handled directly in WorkingMessage (renders BootChecklist with hooks).
      return null;
    case "working":
      return (
        <p>
          Assistant is working{" "}
          {!isTouchDevice && (
            <span className="font-mono text-xs text-muted-foreground/70 inline-block">
              (esc to interrupt)
            </span>
          )}
        </p>
      );
    case "stopping":
      return "Wrapping up";
    case "working-stopped":
      return "Wrapping up";
    case "error":
      return "Wrapping up";
    case "working-error":
      return "Wrapping up";
    case "working-done":
      return "Wrapping up";
    case "checkpointing":
      return "Wrapping up";
    case "complete":
      return "Complete";
    case "stopped":
      return "Stopped";
    default:
      // This ensures exhaustiveness - TypeScript will error if a case is missing
      const _exhaustiveCheck: never = status;
      return _exhaustiveCheck;
  }
}

export function PassiveWaitFooter({
  message,
  reason,
}: {
  message: string;
  reason?: string | null;
}) {
  return (
    <div className="flex flex-col gap-0.5 px-2 text-muted-foreground/70 text-sm">
      <span>{message}</span>
      {reason ? (
        <span className="text-muted-foreground/70 text-xs">{reason}</span>
      ) : null}
    </div>
  );
}

export function WorkingMessage({
  agent,
  status,
  bootingSubstatus,
  reattemptQueueAt,
  metaSnapshot,
  passiveWait,
}: {
  agent: AIAgent;
  status: ThreadStatus;
  bootingSubstatus?: BootingSubstatus;
  reattemptQueueAt: Date | null;
  metaSnapshot: ThreadMetaSnapshot;
  /**
   * When provided, render a quieter passive-wait line instead of the
   * animated "Assistant is working" indicator. Used when the delivery
   * loop is in a passive state (awaiting PR merge, waiting for human
   * input) so users aren't misled into thinking the agent is stuck.
   */
  passiveWait?: { message: string; reason?: string | null } | null;
}) {
  const isTouchDevice = useTouchDevice();
  const [_, setForceUpdate] = useState(0);
  useEffect(() => {
    if (status === "queued-agent-rate-limit" && reattemptQueueAt) {
      const interval = setInterval(() => {
        setForceUpdate((prev) => prev + 1);
      }, 1000 * 60);
      return () => clearInterval(interval);
    }
  }, [status, reattemptQueueAt]);

  // Passive-wait takes precedence: regardless of the underlying thread
  // status (which may still read "working" due to broadcast-before-
  // persist timing) we show the accurate run-derived message.
  if (passiveWait) {
    return (
      <PassiveWaitFooter
        message={passiveWait.message}
        reason={passiveWait.reason ?? null}
      />
    );
  }

  // The booting status renders a persistent checklist instead of a single line.
  if (status === "booting") {
    return (
      <LeafLoading
        message={
          <BootChecklist
            currentSubstatus={bootingSubstatus ?? null}
            metaSnapshot={metaSnapshot}
          />
        }
      />
    );
  }

  const message = getStatusMessage({
    agent,
    status,
    bootingSubstatus,
    reattemptQueueAt,
    isTouchDevice,
  });
  return <LeafLoading message={message} />;
}

export function MessageScheduled({
  threadId,
  threadChatId,
  scheduleAt,
}: {
  threadId: string;
  threadChatId: string;
  scheduleAt: Date;
}) {
  const runScheduledThreadMutation = useServerActionMutation({
    mutationFn: runScheduledThread,
  });
  const cancelScheduledThreadMutation = useServerActionMutation({
    mutationFn: cancelScheduledThread,
  });
  return (
    <div className="flex flex-col gap-1">
      <LeafLoading
        message={
          <div className="flex flex-col gap-0">
            Scheduled to run at{" "}
            {scheduleAt?.toLocaleString(undefined, {
              dateStyle: "short",
              timeStyle: "short",
            })}
            .
            <div className="space-x-2 text-muted-foreground">
              <button
                className="text-xs underline cursor-pointer"
                onClick={async () => {
                  await runScheduledThreadMutation.mutateAsync({
                    threadId,
                    threadChatId,
                  });
                }}
              >
                Run now
              </button>
              <button
                className="text-xs underline cursor-pointer"
                onClick={async () => {
                  await cancelScheduledThreadMutation.mutateAsync({
                    threadId,
                    threadChatId,
                  });
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        }
      />
    </div>
  );
}
