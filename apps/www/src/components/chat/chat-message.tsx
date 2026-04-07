"use client";

import React, { memo, useMemo } from "react";
import { UIMessage, UIPart, ThreadInfoFull } from "@terragon/shared";
import type { ArtifactDescriptor } from "@terragon/shared/db/artifact-descriptors";
import { MessagePart } from "./message-part";
import { cn } from "@/lib/utils";
import { MessageToolbar } from "./chat-message-toolbar";
import {
  Message as AIMessage,
  MessageContent as AIMessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import {
  DEFAULT_MESSAGE_PART_PROPS,
  ForkDialogData,
  MessagePartRenderProps,
  RedoDialogData,
} from "./chat-message.types";
import {
  buildPlanOccurrenceMap,
  groupParts,
  messageContainsToolName,
} from "./chat-message.utils";
import { ImageGroup } from "./chat-message-image-group";
import { AgentMetaFooter } from "./chat-message-agent-meta-footer";
import { SystemMessage } from "./chat-message-system";
import { CollapsibleAgentActivityGroup } from "./chat-message-collapsible-activity";

type ChatMessageProps = {
  message: UIMessage;
  useAiElementsLayout?: boolean;
  className?: string;
  isLatestMessage?: boolean;
  isAgentWorking?: boolean;
  messagePartProps?: MessagePartRenderProps;
  thread?: ThreadInfoFull | null;
  latestGitDiffTimestamp?: string | null;
  artifactDescriptors?: ArtifactDescriptor[];
  onOpenArtifact?: (artifactId: string) => void;
  /** Thread-global plan occurrence map (from ChatMessages). */
  planOccurrences?: Map<UIPart, number>;
};

type ChatMessageWithToolbarProps = {
  message: UIMessage;
  useAiElementsLayout?: boolean;
  messageIndex: number;
  className?: string;
  isFirstUserMessage: boolean;
  isLatestMessage: boolean;
  isAgentWorking: boolean;
  isLatestAgentMessage: boolean;
  messagePartProps?: MessagePartRenderProps;
  thread?: ThreadInfoFull | null;
  latestGitDiffTimestamp?: string | null;
  redoDialogData?: RedoDialogData;
  forkDialogData?: ForkDialogData;
  artifactDescriptors?: ArtifactDescriptor[];
  onOpenArtifact?: (artifactId: string) => void;
  planOccurrences?: Map<UIPart, number>;
};

export const ChatMessage = memo(function ChatMessage({
  message,
  useAiElementsLayout = false,
  className,
  isLatestMessage = false,
  isAgentWorking = false,
  messagePartProps = DEFAULT_MESSAGE_PART_PROPS,
  thread = null,
  latestGitDiffTimestamp = null,
  artifactDescriptors = [],
  onOpenArtifact = () => {},
  planOccurrences: planOccurrencesProp,
}: ChatMessageProps) {
  // Prefer thread-global occurrences from parent; fall back to per-message.
  const perMessagePlanOccurrences = useMemo(
    () => buildPlanOccurrenceMap(message.parts as UIPart[]),
    [message.parts],
  );
  const planOccurrences = planOccurrencesProp ?? perMessagePlanOccurrences;

  if (message.role === "system") {
    return (
      <SystemMessage
        message={message}
        thread={thread}
        latestGitDiffTimestamp={latestGitDiffTimestamp}
        artifactDescriptors={artifactDescriptors}
        onOpenArtifact={onOpenArtifact}
      />
    );
  }
  const groups = groupParts({
    parts: message.parts,
    isLatestMessage,
    isAgentWorking,
  });
  const lastGroupIndex = groups.length - 1;
  const from =
    message.role === "user"
      ? "user"
      : message.role === "agent"
        ? "assistant"
        : "system";

  const content = (
    <MessageResponse>
      <div className="flex flex-col gap-2">
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
                useAiElementsLayout={useAiElementsLayout}
                artifactDescriptors={artifactDescriptors}
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
                    useAiElementsLayout={useAiElementsLayout}
                    {...messagePartProps}
                    artifactDescriptors={artifactDescriptors}
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
    </MessageResponse>
  );

  if (useAiElementsLayout) {
    return (
      <AIMessage
        from={from}
        style={{ overflowAnchor: "none" }}
        className={className}
      >
        <AIMessageContent from={from}>{content}</AIMessageContent>
      </AIMessage>
    );
  }

  return (
    <div
      style={{ overflowAnchor: "none" }}
      className={cn(
        "p-4 rounded-xl w-full break-words transition-all duration-200 animate-in fade-in slide-in-from-bottom-2 duration-300",
        {
          "bg-[var(--warm-stone)] ml-auto max-w-[85%] w-fit shadow-warm-lift":
            message.role === "user",
          "mr-auto bg-white shadow-outline-ring": message.role === "agent",
        },
        className,
      )}
    >
      {content}
    </div>
  );
});

export const ChatMessageWithToolbar = memo(function ChatMessageWithToolbar({
  message,
  useAiElementsLayout = false,
  messageIndex,
  className,
  isLatestMessage = false,
  isFirstUserMessage = false,
  isAgentWorking = false,
  isLatestAgentMessage = false,
  messagePartProps = DEFAULT_MESSAGE_PART_PROPS,
  thread = null,
  latestGitDiffTimestamp = null,
  redoDialogData,
  forkDialogData,
  artifactDescriptors = [],
  onOpenArtifact = () => {},
  planOccurrences,
}: ChatMessageWithToolbarProps) {
  return (
    <div
      className="flex flex-col gap-1 group [scroll-margin-top:6rem]"
      data-message-index={messageIndex}
    >
      <ChatMessage
        message={message}
        useAiElementsLayout={useAiElementsLayout}
        className={className}
        isLatestMessage={isLatestMessage}
        isAgentWorking={isAgentWorking}
        messagePartProps={messagePartProps}
        thread={thread}
        latestGitDiffTimestamp={latestGitDiffTimestamp}
        artifactDescriptors={artifactDescriptors}
        onOpenArtifact={onOpenArtifact}
        planOccurrences={planOccurrences}
      />
      <MessageToolbar
        message={message}
        messageIndex={messageIndex}
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
    prevProps.useAiElementsLayout !== nextProps.useAiElementsLayout ||
    prevProps.messageIndex !== nextProps.messageIndex ||
    prevProps.className !== nextProps.className ||
    prevProps.isFirstUserMessage !== nextProps.isFirstUserMessage ||
    prevProps.isLatestMessage !== nextProps.isLatestMessage ||
    prevProps.isAgentWorking !== nextProps.isAgentWorking ||
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
    messageContainsToolName(prevProps.message, "ExitPlanMode") &&
    prevToolProps.messages !== nextToolProps.messages
  ) {
    return false;
  }

  if (
    prevProps.artifactDescriptors !== nextProps.artifactDescriptors ||
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
