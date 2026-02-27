import { memo, useEffect, useState } from "react";
import { UIMessage, ThreadStatus } from "@terragon/shared";
import { AIAgent } from "@terragon/agent/types";
import { BootingSubstatus } from "@terragon/sandbox/types";
import { ChatMessageWithToolbar } from "./chat-message";
import { LeafLoading } from "./leaf-loading";
import Link from "next/link";
import {
  runScheduledThread,
  cancelScheduledThread,
} from "@/server-actions/scheduled-thread";
import { useTouchDevice } from "@/hooks/useTouchDevice";
import { useServerActionMutation } from "@/queries/server-action-helpers";

export const ChatMessages = memo(function ChatMessages({
  messages,
  isAgentWorking,
}: {
  messages: UIMessage[];
  isAgentWorking: boolean;
}) {
  // Find the latest agent message
  let latestAgentMessageIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "agent") {
      latestAgentMessageIndex = i;
      break;
    }
  }

  return (
    <>
      {messages.map((message: UIMessage, index: number) => {
        const isLatestMessage = index === messages.length - 1;
        const isFirstUserMessage = index === 0 && message.role === "user";
        const isLatestAgentMessage =
          message.role === "agent" && index === latestAgentMessageIndex;
        return (
          <ChatMessageWithToolbar
            key={index}
            message={message}
            messageIndex={index}
            isAgentWorking={isAgentWorking}
            isLatestMessage={isLatestMessage}
            isFirstUserMessage={isFirstUserMessage}
            isLatestAgentMessage={isLatestAgentMessage}
          />
        );
      })}
    </>
  );
});

function getBootingSubstatusMessage(substatus: BootingSubstatus): string {
  switch (substatus) {
    case "provisioning":
    case "provisioning-done":
      return "Provisioning machine";
    case "cloning-repo":
      return "Cloning repository";
    case "installing-sandbox-scripts":
      return "Installing scripts";
    case "installing-agent":
      return "Installing agent";
    case "running-setup-script":
      return "Running terragon-setup.sh";
    case "booting-done":
      return "Waiting for assistant to start";
    default:
      const _exhaustiveCheck: never = substatus;
      return _exhaustiveCheck;
  }
}

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
      return (
        <p>
          {bootingSubstatus
            ? getBootingSubstatusMessage(bootingSubstatus)
            : "Booting environment"}{" "}
          {!isTouchDevice && (
            <span className="font-mono text-xs text-muted-foreground/70 inline-block">
              (esc to interrupt)
            </span>
          )}
        </p>
      );
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

export function WorkingMessage({
  agent,
  status,
  bootingSubstatus,
  reattemptQueueAt,
}: {
  agent: AIAgent;
  status: ThreadStatus;
  bootingSubstatus?: BootingSubstatus;
  reattemptQueueAt: Date | null;
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
