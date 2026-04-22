import { memo, useEffect, useMemo, useState } from "react";
import {
  DBMessage,
  DBUserMessage,
  GitDiffStats,
  ThreadInfoFull,
  ThreadStatus,
  UIMessage,
} from "@terragon/shared";
import type { DeliveryLoopState } from "@terragon/shared/db/types";
import type { ArtifactDescriptor } from "@terragon/shared/db/artifact-descriptors";

import { AIAgent, AIModel } from "@terragon/agent/types";
import { BootingSubstatus } from "@terragon/sandbox/types";
import { ChatMessageWithToolbar } from "./chat-message";
import { BootChecklist } from "./boot-checklist";
import { LeafLoading } from "./leaf-loading";
import { PromptBoxRef } from "./thread-context";
import Link from "next/link";
import {
  runScheduledThread,
  cancelScheduledThread,
} from "@/server-actions/scheduled-thread";
import { useTouchDevice } from "@/hooks/useTouchDevice";
import { useServerActionMutation } from "@/queries/server-action-helpers";
import { buildThreadPlanOccurrenceMap } from "./assistant-ui/plan-occurrences";
import { getActiveAgentMessageId } from "./chat-message.utils";

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
  // Find the latest agent message (used for `isLatestAgentMessage` row prop).
  let latestAgentMessageIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "agent") {
      latestAgentMessageIndex = i;
      break;
    }
  }

  // Identify the agent message the user is actively waiting on (the one
  // currently being executed). See `getActiveAgentMessageId` for the
  // heuristic; the value is message-scoped, so only that one message
  // receives `isActiveTurn=true` and all previous agent messages collapse
  // their pre-final activity under "Finished working" the moment a newer
  // agent message (or a newer user turn) supersedes them.
  const activeAgentMessageId = getActiveAgentMessageId({
    messages,
    isAgentWorking,
  });

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
        const isActiveTurn =
          activeAgentMessageId !== null && message.id === activeAgentMessageId;
        return (
          <ChatMessageWithToolbar
            key={message.id}
            message={message}
            messageIndex={index}
            isAgentWorking={rowIsAgentWorking}
            isActiveTurn={isActiveTurn}
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

  return messageList;
});

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

/**
 * Classifies a delivery-loop state into footer behavior buckets. Active
 * states keep the current "Assistant is working" footer; passive-wait
 * states show a quieter line with no interrupt hint and no animation;
 * terminal states hide the footer entirely.
 *
 * Note: `blocked` covers both `awaiting_manual_fix` and
 * `awaiting_operator_action` — the underlying v3 distinction is collapsed
 * at the API boundary (see `stateToDeliveryLoopState`), so we render a
 * single "Waiting for your input" message for both.
 */
export type DeliveryLoopFooterKind =
  | { kind: "active" }
  | { kind: "passive"; message: string }
  | { kind: "hidden" };

export function classifyDeliveryLoopFooter(
  state: DeliveryLoopState | null | undefined,
): DeliveryLoopFooterKind {
  if (state === null || state === undefined) {
    return { kind: "active" };
  }
  switch (state) {
    case "planning":
    case "implementing":
    case "review_gate":
    case "ci_gate":
    case "babysitting":
      return { kind: "active" };
    case "awaiting_pr_link":
      return { kind: "passive", message: "Waiting for PR merge" };
    case "blocked":
      return { kind: "passive", message: "Waiting for your input" };
    case "done":
    case "stopped":
    case "terminated_pr_closed":
    case "terminated_pr_merged":
      return { kind: "hidden" };
    default:
      // Unknown state -> preserve current "Assistant is working" behavior.
      return { kind: "active" };
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
  threadId,
  passiveWait,
}: {
  agent: AIAgent;
  status: ThreadStatus;
  bootingSubstatus?: BootingSubstatus;
  reattemptQueueAt: Date | null;
  /** Required when status === "booting" to power the BootChecklist. */
  threadId?: string;
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
  // persist timing) we show the accurate delivery-loop-derived message.
  if (passiveWait) {
    return (
      <PassiveWaitFooter
        message={passiveWait.message}
        reason={passiveWait.reason ?? null}
      />
    );
  }

  // The booting status renders a persistent checklist instead of a single line.
  if (status === "booting" && threadId) {
    return (
      <LeafLoading
        message={
          <BootChecklist
            threadId={threadId}
            currentSubstatus={bootingSubstatus ?? null}
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
