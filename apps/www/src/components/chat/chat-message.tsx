"use client";

import { ThreadInfoFull, UIMessage, UIPart } from "@terragon/shared";
import type { ArtifactDescriptor } from "@terragon/shared/db/artifact-descriptors";
import React, { memo, useMemo } from "react";
import { cn } from "@/lib/utils";
import {
  DEFAULT_MESSAGE_PART_PROPS,
  ForkDialogData,
  MessagePartRenderProps,
  RedoDialogData,
} from "./chat-message.types";
import { buildPlanOccurrenceMap, groupParts } from "./chat-message.utils";
import { AgentMetaFooter } from "./chat-message-agent-meta-footer";
import { CollapsibleAgentActivityGroup } from "./chat-message-collapsible-activity";
import { ImageGroup } from "./chat-message-image-group";
import { SystemMessage } from "./chat-message-system";
import { MessageToolbar } from "./chat-message-toolbar";
import { MessagePart } from "./message-part";
import type { ArtifactDescriptorLookup } from "./secondary-panel-helpers";

type ChatMessageProps = {
  message: UIMessage;
  className?: string;
  isLatestMessage?: boolean;
  isAgentWorking?: boolean;
  /**
   * True only when THIS specific agent message is the one currently being
   * executed (id matches the thread's `activeAgentMessageId` and the agent
   * is working). Drives `groupParts` — when false, pre-final activity
   * collapses under "Finished working" even if the overall thread is still
   * working on a different (newer) message.
   */
  isActiveTurn?: boolean;
  messagePartProps?: MessagePartRenderProps;
  thread?: ThreadInfoFull | null;
  latestGitDiffTimestamp?: string | null;
  artifactDescriptors?: ArtifactDescriptor[];
  artifactDescriptorLookup?: ArtifactDescriptorLookup;
  onOpenArtifact?: (artifactId: string) => void;
  onOpenRepoFile?: (path: string, preferArtifactId?: string) => void;
  /** Thread-global plan occurrence map (from ChatMessages). */
  planOccurrences?: Map<UIPart, number>;
};

type ChatMessageWithToolbarProps = {
  message: UIMessage;
  messageIndex: number;
  className?: string;
  isFirstUserMessage: boolean;
  isLatestMessage: boolean;
  isAgentWorking: boolean;
  isActiveTurn: boolean;
  isLatestAgentMessage: boolean;
  messagePartProps?: MessagePartRenderProps;
  thread?: ThreadInfoFull | null;
  latestGitDiffTimestamp?: string | null;
  redoDialogData?: RedoDialogData;
  forkDialogData?: ForkDialogData;
  artifactDescriptors?: ArtifactDescriptor[];
  artifactDescriptorLookup?: ArtifactDescriptorLookup;
  onOpenArtifact?: (artifactId: string) => void;
  planOccurrences?: Map<UIPart, number>;
};

export const ChatMessage = memo(function ChatMessage({
  message,
  className,
  isLatestMessage = false,
  isAgentWorking = false,
  isActiveTurn = false,
  messagePartProps = DEFAULT_MESSAGE_PART_PROPS,
  thread = null,
  latestGitDiffTimestamp = null,
  artifactDescriptors = [],
  artifactDescriptorLookup,
  onOpenArtifact = () => {},
  onOpenRepoFile,
  planOccurrences: planOccurrencesProp,
}: ChatMessageProps) {
  // Prefer thread-global occurrences from parent; fall back to per-message.
  const perMessagePlanOccurrences = useMemo(
    () => buildPlanOccurrenceMap(message.parts as UIPart[]),
    [message.parts],
  );
  const planOccurrences = planOccurrencesProp ?? perMessagePlanOccurrences;

  // Hooks must be called unconditionally (before any early return).
  // Cast: groupParts expects UIUserOrAgentPart[] but message.parts is a
  // discriminated union that hasn't narrowed yet. The result is only used
  // in the non-system branch below.
  const groups = useMemo(
    () =>
      groupParts({
        parts: message.parts as UIPart[],
        isActiveTurn,
      }),
    [message.parts, isActiveTurn],
  );

  if (message.role === "system") {
    return (
      <SystemMessage
        message={message}
        thread={thread}
        latestGitDiffTimestamp={latestGitDiffTimestamp}
        artifactDescriptors={artifactDescriptors}
        artifactDescriptorLookup={artifactDescriptorLookup}
        onOpenArtifact={onOpenArtifact}
        onOpenRepoFile={onOpenRepoFile}
      />
    );
  }
  const lastGroupIndex = groups.length - 1;

  const content = (
    // Single rhythm inside the message: gap-3 (12px) between part groups.
    // The previous double-wrapper (outer gap-3 + inner gap-2) created two
    // competing rhythms that flattened the visual hierarchy of grouped tools.
    <div className="flex flex-col gap-3 text-sm leading-relaxed">
      <div className="flex flex-col gap-3">
        {groups.map((group, groupIndex) => {
          if (group.type === "collapsible-agent-activity") {
            return (
              <CollapsibleAgentActivityGroup
                key={groupIndex}
                agent={"agent" in message ? message.agent : null}
                group={group}
                isLatestMessage={isLatestMessage}
                isAgentWorking={isAgentWorking}
                messagePartProps={messagePartProps}
                artifactDescriptors={artifactDescriptors}
                artifactDescriptorLookup={artifactDescriptorLookup}
                onOpenArtifact={onOpenArtifact}
                planOccurrences={planOccurrences}
              />
            );
          }
          if (group.type === "image") {
            return (
              <ImageGroup
                key={groupIndex}
                group={group}
                messagePartProps={messagePartProps}
                isLatestMessage={isLatestMessage}
                artifactDescriptors={artifactDescriptors}
                artifactDescriptorLookup={artifactDescriptorLookup}
                onOpenArtifact={onOpenArtifact}
              />
            );
          }
          return (
            <React.Fragment key={groupIndex}>
              {group.parts.map((part, partIndex) => {
                return (
                  <MessagePart
                    key={`${groupIndex}-${partIndex}`}
                    part={part}
                    isLatest={isLatestMessage && groupIndex === lastGroupIndex}
                    isAgentWorking={isAgentWorking}
                    {...messagePartProps}
                    artifactDescriptors={artifactDescriptors}
                    artifactDescriptorLookup={artifactDescriptorLookup}
                    onOpenArtifact={onOpenArtifact}
                    planOccurrenceIndex={planOccurrences.get(part)}
                  />
                );
              })}
            </React.Fragment>
          );
        })}
        {message.role === "agent" && message.meta && (
          <AgentMetaFooter meta={message.meta} />
        )}
      </div>
    </div>
  );

  return (
    <div
      style={{ overflowAnchor: "none" }}
      className={cn(
        "w-full break-words",
        message.role === "user"
          ? // Brand: cream feature-card surface, no border ("color-block first,
            // shadow rare"). The warm-lift shadow does the elevation work.
            "ml-auto w-fit max-w-[90%] sm:max-w-[85%] animate-in fade-in slide-in-from-bottom-2 rounded-[calc(var(--radius)+0.15rem)] bg-card text-card-foreground px-4 py-3 shadow-[var(--shadow-warm-lift)] md:px-5"
          : "mr-auto",
        className,
      )}
    >
      {content}
    </div>
  );
}, areChatMessagePropsEqual);

function areChatMessagePropsEqual(
  prevProps: ChatMessageProps,
  nextProps: ChatMessageProps,
) {
  const prevMessagePartProps =
    prevProps.messagePartProps ?? DEFAULT_MESSAGE_PART_PROPS;
  const nextMessagePartProps =
    nextProps.messagePartProps ?? DEFAULT_MESSAGE_PART_PROPS;
  if (
    prevProps.message !== nextProps.message ||
    prevProps.className !== nextProps.className ||
    prevProps.isLatestMessage !== nextProps.isLatestMessage ||
    prevProps.isAgentWorking !== nextProps.isAgentWorking ||
    prevProps.isActiveTurn !== nextProps.isActiveTurn
  ) {
    return false;
  }
  if (
    prevProps.message.role === "system" &&
    (prevProps.thread !== nextProps.thread ||
      prevProps.latestGitDiffTimestamp !== nextProps.latestGitDiffTimestamp)
  ) {
    return false;
  }

  if (
    prevMessagePartProps.githubRepoFullName !==
      nextMessagePartProps.githubRepoFullName ||
    prevMessagePartProps.branchName !== nextMessagePartProps.branchName ||
    prevMessagePartProps.baseBranchName !==
      nextMessagePartProps.baseBranchName ||
    prevMessagePartProps.hasCheckpoint !== nextMessagePartProps.hasCheckpoint
  ) {
    return false;
  }

  const prevToolProps = prevMessagePartProps.toolProps;
  const nextToolProps = nextMessagePartProps.toolProps;
  if (
    prevToolProps.threadId !== nextToolProps.threadId ||
    prevToolProps.threadChatId !== nextToolProps.threadChatId ||
    prevToolProps.isReadOnly !== nextToolProps.isReadOnly ||
    prevToolProps.promptBoxRef !== nextToolProps.promptBoxRef ||
    prevToolProps.childThreads !== nextToolProps.childThreads ||
    prevToolProps.githubRepoFullName !== nextToolProps.githubRepoFullName ||
    prevToolProps.repoBaseBranchName !== nextToolProps.repoBaseBranchName ||
    prevToolProps.branchName !== nextToolProps.branchName ||
    prevToolProps.onOptimisticPermissionModeUpdate !==
      nextToolProps.onOptimisticPermissionModeUpdate
  ) {
    return false;
  }

  if (
    prevProps.artifactDescriptors !== nextProps.artifactDescriptors ||
    prevProps.artifactDescriptorLookup !== nextProps.artifactDescriptorLookup ||
    prevProps.onOpenArtifact !== nextProps.onOpenArtifact ||
    prevProps.planOccurrences !== nextProps.planOccurrences
  ) {
    return false;
  }

  return true;
}

export const ChatMessageWithToolbar = memo(function ChatMessageWithToolbar({
  message,
  messageIndex,
  className,
  isLatestMessage = false,
  isFirstUserMessage = false,
  isAgentWorking = false,
  isActiveTurn = false,
  isLatestAgentMessage = false,
  messagePartProps = DEFAULT_MESSAGE_PART_PROPS,
  thread = null,
  latestGitDiffTimestamp = null,
  redoDialogData,
  forkDialogData,
  artifactDescriptors = [],
  artifactDescriptorLookup,
  onOpenArtifact = () => {},
  planOccurrences,
}: ChatMessageWithToolbarProps) {
  return (
    <div
      // gap-0 between bubble and toolbar — toolbar carries its own mt-1
      // breathing internally, so a parent gap stacks two spacers.
      className="flex flex-col group [scroll-margin-top:6rem] [content-visibility:auto] [contain-intrinsic-size:auto_160px]"
      data-message-index={messageIndex}
      data-message-id={message.id}
      data-message-role={message.role}
    >
      <ChatMessage
        message={message}
        className={className}
        isLatestMessage={isLatestMessage}
        isAgentWorking={isAgentWorking}
        isActiveTurn={isActiveTurn}
        messagePartProps={messagePartProps}
        thread={thread}
        latestGitDiffTimestamp={latestGitDiffTimestamp}
        artifactDescriptors={artifactDescriptors}
        artifactDescriptorLookup={artifactDescriptorLookup}
        onOpenArtifact={onOpenArtifact}
        planOccurrences={planOccurrences}
      />
      <MessageToolbar
        message={message}
        messageIndex={messageIndex}
        taskId={thread?.id}
        isFirstUserMessage={isFirstUserMessage}
        isLatestAgentMessage={isLatestAgentMessage}
        isAgentWorking={isAgentWorking}
        redoDialogData={redoDialogData}
        forkDialogData={forkDialogData}
      />
    </div>
  );
}, areChatMessageWithToolbarPropsEqual);

function areChatMessageWithToolbarPropsEqual(
  prevProps: ChatMessageWithToolbarProps,
  nextProps: ChatMessageWithToolbarProps,
) {
  const prevMessagePartProps =
    prevProps.messagePartProps ?? DEFAULT_MESSAGE_PART_PROPS;
  const nextMessagePartProps =
    nextProps.messagePartProps ?? DEFAULT_MESSAGE_PART_PROPS;
  if (
    prevProps.message !== nextProps.message ||
    prevProps.messageIndex !== nextProps.messageIndex ||
    prevProps.className !== nextProps.className ||
    prevProps.isFirstUserMessage !== nextProps.isFirstUserMessage ||
    prevProps.isLatestMessage !== nextProps.isLatestMessage ||
    prevProps.isAgentWorking !== nextProps.isAgentWorking ||
    prevProps.isActiveTurn !== nextProps.isActiveTurn ||
    prevProps.isLatestAgentMessage !== nextProps.isLatestAgentMessage
  ) {
    return false;
  }
  if (
    prevProps.message.role === "system" &&
    (prevProps.thread !== nextProps.thread ||
      prevProps.latestGitDiffTimestamp !== nextProps.latestGitDiffTimestamp)
  ) {
    return false;
  }

  if (
    prevMessagePartProps.githubRepoFullName !==
      nextMessagePartProps.githubRepoFullName ||
    prevMessagePartProps.branchName !== nextMessagePartProps.branchName ||
    prevMessagePartProps.baseBranchName !==
      nextMessagePartProps.baseBranchName ||
    prevMessagePartProps.hasCheckpoint !== nextMessagePartProps.hasCheckpoint
  ) {
    return false;
  }

  const prevToolProps = prevMessagePartProps.toolProps;
  const nextToolProps = nextMessagePartProps.toolProps;
  if (
    prevToolProps.threadId !== nextToolProps.threadId ||
    prevToolProps.threadChatId !== nextToolProps.threadChatId ||
    prevToolProps.isReadOnly !== nextToolProps.isReadOnly ||
    prevToolProps.promptBoxRef !== nextToolProps.promptBoxRef ||
    prevToolProps.childThreads !== nextToolProps.childThreads ||
    prevToolProps.githubRepoFullName !== nextToolProps.githubRepoFullName ||
    prevToolProps.repoBaseBranchName !== nextToolProps.repoBaseBranchName ||
    prevToolProps.branchName !== nextToolProps.branchName
  ) {
    return false;
  }

  if (
    prevProps.artifactDescriptors !== nextProps.artifactDescriptors ||
    prevProps.artifactDescriptorLookup !== nextProps.artifactDescriptorLookup ||
    prevProps.onOpenArtifact !== nextProps.onOpenArtifact ||
    prevProps.planOccurrences !== nextProps.planOccurrences
  ) {
    return false;
  }

  return (
    prevProps.redoDialogData === nextProps.redoDialogData &&
    prevProps.forkDialogData === nextProps.forkDialogData
  );
}
