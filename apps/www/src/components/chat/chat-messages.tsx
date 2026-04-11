import { memo, useEffect, useMemo, useState } from "react";
import {
  DBMessage,
  DBUserMessage,
  GitDiffStats,
  ThreadInfoFull,
  ThreadStatus,
  UIMessage,
  UIPart,
} from "@terragon/shared";
import type { ArtifactDescriptor } from "@terragon/shared/db/artifact-descriptors";
import { extractProposedPlanText } from "@terragon/shared/db/artifact-descriptors";
import { AIAgent, AIModel } from "@terragon/agent/types";
import { BootingSubstatus } from "@terragon/sandbox/types";
import { ChatMessageWithToolbar } from "./chat-message";
import { LeafLoading } from "./leaf-loading";
import { PromptBoxRef } from "./thread-context";
import Link from "next/link";
import { useFeatureFlag } from "@/hooks/use-feature-flag";
import {
  Conversation,
  ConversationContent,
} from "@/components/ai-elements/conversation";
import {
  runScheduledThread,
  cancelScheduledThread,
} from "@/server-actions/scheduled-thread";
import { useTouchDevice } from "@/hooks/useTouchDevice";
import { useServerActionMutation } from "@/queries/server-action-helpers";

export const ChatMessages = memo(function ChatMessages({
  messages,
  isAgentWorking,
  thread,
  latestGitDiffTimestamp,
  githubRepoFullName,
  branchName,
  baseBranchName,
  hasCheckpoint,
  toolProps,
  redoDialogData,
  forkDialogData,
  artifactDescriptors = [],
  onOpenArtifact = () => {},
}: {
  messages: UIMessage[];
  isAgentWorking: boolean;
  thread?: ThreadInfoFull | null;
  latestGitDiffTimestamp?: string | null;
  githubRepoFullName?: string;
  branchName?: string | null;
  baseBranchName?: string;
  hasCheckpoint?: boolean;
  toolProps?: {
    threadId: string;
    threadChatId: string;
    messages: DBMessage[];
    isReadOnly: boolean;
    promptBoxRef?: React.RefObject<PromptBoxRef | null>;
    childThreads: { id: string; parentToolId: string | null }[];
    githubRepoFullName: string;
    repoBaseBranchName: string;
    branchName: string | null;
  };
  redoDialogData?: {
    threadId: string;
    repoFullName: string;
    repoBaseBranchName: string;
    disableGitCheckpointing: boolean;
    skipSetup: boolean;
    permissionMode: "allowAll" | "plan";
    initialUserMessage: DBUserMessage;
  };
  forkDialogData?: {
    threadId: string;
    threadChatId: string;
    repoFullName: string;
    repoBaseBranchName: string;
    branchName: string | null;
    gitDiffStats: GitDiffStats | null;
    disableGitCheckpointing: boolean;
    skipSetup: boolean;
    agent: AIAgent;
    lastSelectedModel: AIModel | null;
  };
  artifactDescriptors?: ArtifactDescriptor[];
  onOpenArtifact?: (artifactId: string) => void;
}) {
  const messagePartProps = useMemo(
    () => ({
      githubRepoFullName: githubRepoFullName ?? "",
      branchName: branchName ?? null,
      baseBranchName: baseBranchName ?? "main",
      hasCheckpoint: hasCheckpoint ?? false,
      toolProps: toolProps ?? {
        threadId: "",
        threadChatId: "",
        messages: [],
        isReadOnly: false,
        childThreads: [],
        githubRepoFullName: "",
        repoBaseBranchName: "main",
        branchName: null,
      },
    }),
    [githubRepoFullName, branchName, baseBranchName, hasCheckpoint, toolProps],
  );
  const useAiElementsLayout = useFeatureFlag("chatAIV2Renderer");
  // Find the latest agent message
  let latestAgentMessageIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "agent") {
      latestAgentMessageIndex = i;
      break;
    }
  }

  // Thread-global plan occurrence map: keyed by UIPart reference -> its
  // thread-global occurrence index for that plan text. This mirrors the
  // `planTextOccurrences` counter in `getArtifactDescriptors` so the render
  // side can match descriptors by occurrence index.
  const planOccurrences = useMemo(
    () => buildThreadPlanOccurrenceMap(messages),
    [messages],
  );

  const messageList = (
    <>
      {messages.map((message: UIMessage, index: number) => {
        const isLatestMessage = index === messages.length - 1;
        const isFirstUserMessage = index === 0 && message.role === "user";
        const isLatestAgentMessage =
          message.role === "agent" && index === latestAgentMessageIndex;
        const rowIsAgentWorking =
          isAgentWorking && isLatestMessage && message.role === "agent";
        return (
          <ChatMessageWithToolbar
            key={message.id}
            message={message}
            useAiElementsLayout={useAiElementsLayout}
            messageIndex={index}
            isAgentWorking={rowIsAgentWorking}
            isLatestMessage={isLatestMessage}
            isFirstUserMessage={isFirstUserMessage}
            isLatestAgentMessage={isLatestAgentMessage}
            messagePartProps={messagePartProps}
            thread={message.role === "system" ? thread : null}
            latestGitDiffTimestamp={
              message.role === "system"
                ? (latestGitDiffTimestamp ?? null)
                : null
            }
            redoDialogData={isFirstUserMessage ? redoDialogData : undefined}
            forkDialogData={isLatestAgentMessage ? forkDialogData : undefined}
            artifactDescriptors={artifactDescriptors}
            onOpenArtifact={onOpenArtifact}
            planOccurrences={planOccurrences}
          />
        );
      })}
    </>
  );

  if (useAiElementsLayout) {
    return (
      <Conversation>
        <ConversationContent className="gap-12">
          {messageList}
        </ConversationContent>
      </Conversation>
    );
  }

  return messageList;
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

/**
 * Builds a thread-global plan occurrence map across all messages.
 * Mirrors the `planTextOccurrences` counter in `getArtifactDescriptors`
 * so that the render side can match descriptors by occurrence index.
 * Recurses into nested tool parts to match the descriptor traversal.
 */
function buildThreadPlanOccurrenceMap(
  messages: UIMessage[],
): Map<UIPart, number> {
  const counts = new Map<string, number>();
  const result = new Map<UIPart, number>();

  function walkParts(parts: UIPart[]) {
    for (const part of parts) {
      if (part.type === "text") {
        const planText = extractProposedPlanText(
          (part as { text: string }).text,
        );
        if (planText) {
          const count = counts.get(planText) ?? 0;
          result.set(part, count);
          counts.set(planText, count + 1);
        }
      } else if (part.type === "tool" && "parts" in part) {
        // Recurse into nested tool output (e.g. Task/subagent)
        walkParts((part as { parts: UIPart[] }).parts);
      }
    }
  }

  for (const message of messages) {
    // Only count agent text parts -- mirrors getArtifactDescriptors which only
    // creates plan descriptors for agent messages.
    if (message.role !== "agent") continue;
    walkParts(message.parts);
  }
  return result;
}
