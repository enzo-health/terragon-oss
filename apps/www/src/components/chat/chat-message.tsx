"use client";

import React, { memo, useMemo, useState } from "react";
import {
  AllToolParts,
  DBUserMessage,
  GitDiffStats,
  UIAgentMessage,
  UIMessage,
  UIPart,
  UISystemMessage,
  ThreadInfoFull,
  UIUserMessage,
  UIGitDiffPart,
} from "@terragon/shared";
import type { ArtifactDescriptor } from "@terragon/shared/db/artifact-descriptors";
import { extractProposedPlanText } from "@terragon/shared/db/artifact-descriptors";
import { AIAgent, AIModel } from "@terragon/agent/types";
import { MessagePart, MessagePartProps } from "./message-part";
import { cn } from "@/lib/utils";
import { ChevronDown, ChevronRight } from "lucide-react";
import { MessageToolbar } from "./chat-message-toolbar";
import { ImageLightbox } from "@/components/shared/image-lightbox";
import { GitDiffPart } from "./git-diff-part";
import {
  Message as AIMessage,
  MessageContent as AIMessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";

type UIUserOrAgentPart =
  | UIAgentMessage["parts"][number]
  | UIUserMessage["parts"][number];

type PartGroup = {
  type: UIUserOrAgentPart["type"] | "collapsible-agent-activity";
  parts: UIUserOrAgentPart[];
};

type MessagePartRenderProps = Pick<
  MessagePartProps,
  | "githubRepoFullName"
  | "branchName"
  | "baseBranchName"
  | "hasCheckpoint"
  | "toolProps"
>;

type RedoDialogData = {
  threadId: string;
  repoFullName: string;
  repoBaseBranchName: string;
  disableGitCheckpointing: boolean;
  skipSetup: boolean;
  permissionMode: "allowAll" | "plan";
  initialUserMessage: DBUserMessage;
};

type ForkDialogData = {
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

const DEFAULT_MESSAGE_PART_PROPS: MessagePartRenderProps = {
  githubRepoFullName: "",
  branchName: null,
  baseBranchName: "main",
  hasCheckpoint: false,
  toolProps: {
    threadId: "",
    threadChatId: "",
    messages: [],
    isReadOnly: false,
    childThreads: [],
    githubRepoFullName: "",
    repoBaseBranchName: "main",
    branchName: null,
  },
};

function toolPartContainsName(part: AllToolParts, toolName: string): boolean {
  if (part.name === toolName) {
    return true;
  }
  if (part.name !== "Task") {
    return false;
  }
  return part.parts.some(
    (childPart) =>
      childPart.type === "tool" && toolPartContainsName(childPart, toolName),
  );
}

function messageContainsToolName(
  message: UIMessage,
  toolName: string,
): boolean {
  if (message.role !== "agent") {
    return false;
  }
  return message.parts.some(
    (part) => part.type === "tool" && toolPartContainsName(part, toolName),
  );
}

// Never collapse these tool names
const nonCollapsibleToolNames = new Set<string>([
  "SuggestFollowupTask",
  "mcp__terry__SuggestFollowupTask",
  "ExitPlanMode",
  "PermissionRequest",
]);

function getPartGroupType({
  part,
  partIdx,
  numParts,
  lastTextPartIdx,
}: {
  part: UIUserOrAgentPart;
  partIdx: number;
  numParts: number;
  lastTextPartIdx: number;
}): PartGroup["type"] {
  const isLastPart = partIdx === numParts - 1;
  if (isLastPart) {
    return part.type;
  }
  const isLastTextPartOrAfter =
    lastTextPartIdx !== -1 && lastTextPartIdx <= partIdx;
  if (isLastTextPartOrAfter) {
    return part.type;
  }
  switch (part.type) {
    case "tool": {
      if (nonCollapsibleToolNames.has(part.name)) {
        return part.type;
      }
      return "collapsible-agent-activity";
    }
    case "text":
    case "thinking": {
      return "collapsible-agent-activity";
    }
    default: {
      return part.type;
    }
  }
}

// Group image parts together and identify collapsible tool sequences
function groupParts({
  parts,
  isLatestMessage,
  isAgentWorking,
}: {
  parts: UIUserOrAgentPart[];
  isLatestMessage: boolean;
  isAgentWorking: boolean;
}): PartGroup[] {
  const groups: PartGroup[] = [];
  let currentGroup: PartGroup | null = null;

  // Find the index of the last text part in the message
  let lastTextPartIdx = -1;
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i]?.type === "text") {
      lastTextPartIdx = i;
      break;
    }
  }

  const numParts = parts.length;
  for (let i = 0; i < numParts; i++) {
    const part = parts[i];
    if (!part) {
      continue;
    }
    const partGroupType = getPartGroupType({
      part,
      partIdx: i,
      numParts,
      lastTextPartIdx,
    });
    if (currentGroup === null) {
      currentGroup = { type: partGroupType, parts: [part] };
      continue;
    }
    if (partGroupType === currentGroup.type) {
      currentGroup.parts.push(part);
      continue;
    }
    if (partGroupType !== currentGroup.type) {
      groups.push(currentGroup);
      currentGroup = { type: partGroupType, parts: [part] };
      continue;
    }
  }
  // Handle the last group
  if (currentGroup) {
    groups.push(currentGroup);
  }
  return groups;
}

function ImageGroup({
  group,
  messagePartProps,
  isLatestMessage = false,
  artifactDescriptors,
  onOpenArtifact,
}: {
  group: PartGroup;
  messagePartProps: MessagePartRenderProps;
  isLatestMessage?: boolean;
  artifactDescriptors: ArtifactDescriptor[];
  onOpenArtifact: (artifactId: string) => void;
}) {
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);

  const imageUrls = group.parts
    .filter(
      (part): part is { type: "image"; image_url: string } =>
        part.type === "image",
    )
    .map((part) => part.image_url);

  const numParts = group.parts.length;
  return (
    <>
      <div className="flex gap-2 flex-wrap">
        {group.parts.map((part, partIndex) => {
          return (
            <MessagePart
              key={partIndex}
              part={part}
              onClick={() => setExpandedIndex(partIndex)}
              isLatest={isLatestMessage && partIndex === numParts - 1}
              {...messagePartProps}
              artifactDescriptors={artifactDescriptors}
              onOpenArtifact={onOpenArtifact}
            />
          );
        })}
      </div>
      {expandedIndex !== null && imageUrls[expandedIndex] && (
        <ImageLightbox
          imageUrl={imageUrls[expandedIndex]}
          isOpen={true}
          onClose={() => setExpandedIndex(null)}
          images={imageUrls}
          currentIndex={expandedIndex}
          onIndexChange={setExpandedIndex}
        />
      )}
    </>
  );
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return remainingSeconds > 0
    ? `${minutes}m ${remainingSeconds}s`
    : `${minutes}m`;
}

function AgentMetaFooter({
  meta,
}: {
  meta: NonNullable<UIAgentMessage["meta"]>;
}) {
  const parts: string[] = [];
  if (meta.duration_ms > 0) {
    parts.push(formatDuration(meta.duration_ms));
  }
  if (meta.num_turns > 0) {
    parts.push(`${meta.num_turns} turn${meta.num_turns === 1 ? "" : "s"}`);
  }
  if (parts.length === 0) return null;
  return (
    <div className="text-xs text-muted-foreground/60 font-mono pt-1 select-none">
      {parts.join(" · ")}
    </div>
  );
}

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

function SystemMessage({
  message,
  thread,
  latestGitDiffTimestamp,
  artifactDescriptors,
  onOpenArtifact,
}: {
  message: UISystemMessage;
  thread: ThreadInfoFull | null;
  latestGitDiffTimestamp: string | null;
  artifactDescriptors: ArtifactDescriptor[];
  onOpenArtifact: (artifactId: string) => void;
}) {
  const [isCollapsed, setIsCollapsed] = useState(true);
  const getLabel = () => {
    switch (message.message_type) {
      case "retry-git-commit-and-push":
        return "Git commit and push failed. Retrying...";
      case "generic-retry":
        return "Retrying...";
      case "invalid-token-retry":
        return "Authentication token might have expired. Retrying...";
      case "clear-context":
        return "Conversation context cleared.";
      case "compact-result":
        return "Conversation context compacted.";
      case "cancel-schedule":
        return "Scheduled task cancelled.";
      case "fix-github-checks":
        return "Fixing GitHub Checks...";
      case "sdlc-error-retry":
        return "An error occurred. Automatically retrying...";
      case "follow-up-retry-failed":
        return "Follow-up processing failed.";
      case "stop":
      case "git-diff":
        return "";
      default:
        const _exhaustiveCheck: never = message;
        return _exhaustiveCheck;
    }
  };

  const getDotClassName = () => {
    switch (message.message_type) {
      case "retry-git-commit-and-push":
      case "fix-github-checks":
      case "generic-retry":
      case "invalid-token-retry":
        return "bg-red-500";
      case "clear-context":
      case "compact-result":
        return "bg-green-500";
      case "cancel-schedule":
        return "bg-muted-foreground";
      case "sdlc-error-retry":
        return "bg-red-500";
      case "follow-up-retry-failed":
        return "bg-red-500";
      case "stop":
      case "git-diff":
        return "";
      default:
        const _exhaustiveCheck: never = message;
        return _exhaustiveCheck;
    }
  };

  const showMoreButton = message.parts.length > 0;

  if (message.message_type === "stop") {
    return <div className="p-2">Execution interrupted by user.</div>;
  }
  if (message.message_type === "git-diff") {
    if (!thread) {
      return null;
    }
    const gitDiffPart = message.parts[0] as UIGitDiffPart;
    return (
      <div className="p-2">
        <GitDiffPart
          gitDiffPart={gitDiffPart}
          thread={thread}
          isLatest={latestGitDiffTimestamp === gitDiffPart.timestamp}
          artifactDescriptors={artifactDescriptors}
          onOpenArtifact={onOpenArtifact}
        />
      </div>
    );
  }
  return (
    <div className="py-2 px-4 rounded-xl mr-auto w-fit flex flex-col gap-2">
      <div className="flex flex-col gap-2">
        <div
          className="grid grid-cols-[auto_1fr] gap-3 text-muted-foreground/60 transition-colors hover:text-muted-foreground cursor-pointer group/system"
          onClick={() => setIsCollapsed(!isCollapsed)}
        >
          <span className="h-5 flex items-center">
            <span
              className={cn(
                "shrink-0 size-1.5 rounded-full inline-block",
                getDotClassName(),
              )}
              aria-hidden="true"
            />
          </span>
          <span className="text-[13px] font-sans tracking-[0.14px]">
            <span>{getLabel()}</span>
            {showMoreButton && (
              <>
                &nbsp;
                <span className="inline-block opacity-60 group-hover/system:opacity-100 transition-opacity select-none">
                  ({isCollapsed ? "Show more" : "Show less"})
                </span>
              </>
            )}
          </span>
        </div>
        {!isCollapsed && showMoreButton && (
          <div className="max-h-[200px] overflow-auto border border-border/30 rounded-xl p-3 bg-white/50 shadow-inset-edge">
            <pre className="whitespace-pre-wrap text-[11px] font-mono leading-relaxed text-muted-foreground/80">
              {message.parts.map((part, partIndex) => {
                return part.text;
              })}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}

function CollapsibleAgentActivityGroupLabel({
  isLatestMessage,
  isAgentWorking,
}: {
  isLatestMessage: boolean;
  isAgentWorking: boolean;
}) {
  if (isLatestMessage && isAgentWorking) {
    return <span className="truncate animate-shine">Working...</span>;
  }
  return <span className="truncate">Finished working</span>;
}

function CollapsibleAgentActivityGroup({
  group,
  agent,
  useAiElementsLayout = false,
  isLatestMessage = false,
  isAgentWorking = false,
  messagePartProps,
  artifactDescriptors,
  onOpenArtifact,
  planOccurrences,
}: {
  group: PartGroup;
  agent: AIAgent | null;
  useAiElementsLayout?: boolean;
  isLatestMessage: boolean;
  isAgentWorking: boolean;
  messagePartProps: MessagePartRenderProps;
  artifactDescriptors: ArtifactDescriptor[];
  onOpenArtifact: (artifactId: string) => void;
  planOccurrences: Map<UIPart, number>;
}) {
  const [isCollapsed, setIsCollapsed] = useState(true);
  const numParts = group.parts.length;
  return (
    <div className="flex flex-col gap-0.5 group/item">
      <button
        onClick={() => setIsCollapsed(!isCollapsed)}
        className="flex items-center gap-1 py-1 text-sm text-muted-foreground opacity-75 group-hover/item:opacity-100 transition-opacity"
      >
        <CollapsibleAgentActivityGroupLabel
          isLatestMessage={isLatestMessage}
          isAgentWorking={isAgentWorking}
        />
        {isCollapsed ? (
          <ChevronRight className="h-4 w-4 shrink-0 opacity-75 group-hover/item:opacity-100 transition-opacity sm:opacity-0" />
        ) : (
          <ChevronDown className="h-4 w-4 shrink-0 opacity-75 group-hover/item:opacity-100 transition-opacity" />
        )}
      </button>
      {!isCollapsed && (
        <div className="flex flex-col gap-2 p-4 max-h-[50dvh] overflow-y-auto border border-border/40 rounded-xl bg-white shadow-inset-edge">
          {group.parts.map((part, partIndex) => {
            return (
              <MessagePart
                key={partIndex}
                part={part}
                isLatest={isLatestMessage && partIndex === numParts - 1}
                isAgentWorking={isAgentWorking}
                useAiElementsLayout={useAiElementsLayout}
                {...messagePartProps}
                artifactDescriptors={artifactDescriptors}
                onOpenArtifact={onOpenArtifact}
                planOccurrenceIndex={planOccurrences.get(part)}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * Builds a map of part object -> plan occurrence index for parts that contain
 * identical `<proposed_plan>` text. Keyed by reference so that group-level
 * lookups work regardless of which subset of parts is being iterated.
 */
function buildPlanOccurrenceMap(parts: UIPart[]): Map<UIPart, number> {
  const counts = new Map<string, number>();
  const result = new Map<UIPart, number>();
  for (const part of parts) {
    if (part.type !== "text") continue;
    const planText = extractProposedPlanText(part.text);
    if (!planText) continue;
    const count = counts.get(planText) ?? 0;
    result.set(part, count);
    counts.set(planText, count + 1);
  }
  return result;
}
