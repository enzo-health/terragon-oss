import React, { memo } from "react";
import { normalizeToolCall } from "@terragon/agent/tool-calls";
import {
  AllToolParts,
  DBMessage,
  type UIImagePart,
  type UIPdfPart,
  type UIRichTextPart,
  type UITextFilePart,
} from "@terragon/shared";
import type { ArtifactDescriptor } from "@terragon/shared/db/artifact-descriptors";
import { ReadTool } from "./tools/read-tool";
import { WriteTool } from "./tools/write-tool";
import { EditTool } from "./tools/edit-tool";
import { MultiEditTool } from "./tools/multi-edit-tool";
import { SearchTool } from "./tools/search-tool";
import { BashTool } from "./tools/bash-tool";
import { LSTool } from "./tools/ls-tool";
import { TodoReadTool, TodoWriteTool } from "./tools/todo-tool";
import { NotebookEditTool, NotebookReadTool } from "./tools/notebook-tool";
import { WebFetchTool, WebSearchTool } from "./tools/web-tool";
import { TaskTool } from "./tools/task-tool";
import { SuggestFollowupTaskTool } from "./tools/suggest-followup-task-tool";
import { ExitPlanModeTool } from "./tools/exit-plan-mode-tool";
import { PermissionRequestTool } from "./tools/permission-request-tool";
import { FileChangeTool } from "./tools/file-change-tool";
import { DefaultTool } from "./tools/default-tool";
import { ProgressChunks } from "./tools/progress-chunks";
import { getToolVerb } from "./tools/utils";
import { Badge } from "@/components/ui/badge";
import { RichTextPart } from "./rich-text-part";
import { TextFilePart } from "./text-file-part";
import { PdfPart } from "./pdf-part";
import { ImagePart } from "./image-part";
import { findArtifactDescriptorForPart } from "./secondary-panel";
import { PromptBoxRef } from "./thread-context";
import { ChildThreadInfo } from "@terragon/shared/db/types";

export type ToolPartProps = {
  toolPart: AllToolParts;
  threadId: string;
  threadChatId: string;
  messages: DBMessage[];
  isReadOnly: boolean;
  promptBoxRef?: React.RefObject<PromptBoxRef | null>;
  childThreads: ChildThreadInfo[];
  githubRepoFullName: string;
  repoBaseBranchName: string;
  branchName: string | null;
  onOptimisticPermissionModeUpdate?: (mode: "allowAll" | "plan") => void;
  artifactDescriptors?: ArtifactDescriptor[];
  onOpenArtifact?: (artifactId: string) => void;
};

const ToolPart = memo(function ToolPart({
  toolPart: rawToolPart,
  threadId,
  threadChatId,
  messages,
  isReadOnly,
  promptBoxRef,
  childThreads,
  githubRepoFullName,
  repoBaseBranchName,
  branchName,
  onOptimisticPermissionModeUpdate,
  artifactDescriptors = [],
  onOpenArtifact,
}: ToolPartProps) {
  const toolPart = normalizeToolCall(rawToolPart.agent, rawToolPart);

  const renderedTool = (() => {
    switch (toolPart.name) {
      case "Read":
        return (
          <ReadTool
            toolPart={toolPart as Extract<AllToolParts, { name: "Read" }>}
          />
        );
      case "Write":
        return (
          <WriteTool
            toolPart={toolPart as Extract<AllToolParts, { name: "Write" }>}
          />
        );
      case "Edit":
        if (
          toolPart.parameters &&
          "new_string" in toolPart.parameters &&
          "old_string" in toolPart.parameters
        ) {
          return (
            <EditTool
              toolPart={toolPart as Extract<AllToolParts, { name: "Edit" }>}
            />
          );
        }
        return <DefaultTool toolPart={toolPart} />;
      case "MultiEdit":
        return (
          <MultiEditTool
            toolPart={toolPart as Extract<AllToolParts, { name: "MultiEdit" }>}
          />
        );
      case "Grep":
      case "Glob":
        return (
          <SearchTool
            toolPart={
              toolPart as Extract<AllToolParts, { name: "Grep" | "Glob" }>
            }
          />
        );
      case "LS":
        return (
          <LSTool
            toolPart={toolPart as Extract<AllToolParts, { name: "LS" }>}
          />
        );
      case "Bash":
        return (
          <BashTool
            toolPart={toolPart as Extract<AllToolParts, { name: "Bash" }>}
          />
        );
      case "TodoWrite":
        return (
          <TodoWriteTool
            toolPart={toolPart as Extract<AllToolParts, { name: "TodoWrite" }>}
          />
        );
      case "TodoRead":
        return (
          <TodoReadTool
            toolPart={toolPart as Extract<AllToolParts, { name: "TodoRead" }>}
          />
        );
      case "NotebookEdit":
        return (
          <NotebookEditTool
            toolPart={
              toolPart as Extract<AllToolParts, { name: "NotebookEdit" }>
            }
          />
        );
      case "NotebookRead":
        return (
          <NotebookReadTool
            toolPart={
              toolPart as Extract<AllToolParts, { name: "NotebookRead" }>
            }
          />
        );
      case "Task":
        return (
          <TaskTool
            toolPart={toolPart as Extract<AllToolParts, { name: "Task" }>}
            renderToolPart={(childToolPart) => (
              <ToolPart
                toolPart={childToolPart}
                threadId={threadId}
                threadChatId={threadChatId}
                messages={messages}
                isReadOnly={isReadOnly}
                promptBoxRef={promptBoxRef}
                childThreads={childThreads}
                githubRepoFullName={githubRepoFullName}
                repoBaseBranchName={repoBaseBranchName}
                branchName={branchName}
                onOptimisticPermissionModeUpdate={
                  onOptimisticPermissionModeUpdate
                }
                artifactDescriptors={artifactDescriptors}
                onOpenArtifact={onOpenArtifact}
              />
            )}
          />
        );
      case "WebFetch":
        return (
          <WebFetchTool
            toolPart={toolPart as Extract<AllToolParts, { name: "WebFetch" }>}
          />
        );
      case "WebSearch":
        return (
          <WebSearchTool
            toolPart={toolPart as Extract<AllToolParts, { name: "WebSearch" }>}
          />
        );
      case "SuggestFollowupTask":
      case "mcp__terry__SuggestFollowupTask":
        return (
          <SuggestFollowupTaskTool
            toolPart={
              { ...toolPart, name: "SuggestFollowupTask" } as Extract<
                AllToolParts,
                { name: "SuggestFollowupTask" }
              >
            }
            threadId={threadId}
            childThreads={childThreads}
            githubRepoFullName={githubRepoFullName}
            repoBaseBranchName={repoBaseBranchName}
          />
        );
      case "ExitPlanMode":
        return (
          <ExitPlanModeTool
            toolPart={
              toolPart as Extract<AllToolParts, { name: "ExitPlanMode" }>
            }
            threadId={threadId}
            threadChatId={threadChatId}
            messages={messages}
            isReadOnly={isReadOnly}
            onOptimisticPermissionModeUpdate={onOptimisticPermissionModeUpdate}
            artifactDescriptors={artifactDescriptors}
            onOpenArtifact={onOpenArtifact}
          />
        );
      case "PermissionRequest":
        return (
          <PermissionRequestTool
            toolPart={
              toolPart as Extract<AllToolParts, { name: "PermissionRequest" }>
            }
            threadId={threadId}
            threadChatId={threadChatId}
            isReadOnly={isReadOnly}
          />
        );
      case "FileChange":
        return (
          <FileChangeTool
            toolPart={toolPart as Extract<AllToolParts, { name: "FileChange" }>}
          />
        );
      case "MCPTool": {
        // Codex MCPTool: transform to mcp__server__tool format for DefaultTool
        const { server, tool, ...mcpArgs } = toolPart.parameters as {
          server?: string;
          tool?: string;
          [key: string]: unknown;
        };
        const mcpName =
          server && tool ? `mcp__${server}__${tool}` : toolPart.name;
        return (
          <DefaultTool
            toolPart={{ ...toolPart, name: mcpName, parameters: mcpArgs }}
          />
        );
      }
      default:
        return <DefaultTool toolPart={toolPart} />;
    }
  })();

  const artifactParts = toolPart.parts.filter(
    (part) =>
      part.type === "rich-text" ||
      part.type === "text-file" ||
      part.type === "pdf" ||
      part.type === "image",
  );

  // Extended lifecycle fields carried from DBToolCall via InternalToolPart
  const extendedPart = toolPart as AllToolParts & {
    progressChunks?: Array<{ seq: number; text: string }>;
    mcpMetadata?: { server: string; tool: string };
    toolStatus?: string;
  };
  const progressChunks = extendedPart.progressChunks;
  const mcpMetadata = extendedPart.mcpMetadata;
  const isInProgress =
    extendedPart.toolStatus === "in_progress" && toolPart.status === "pending";

  // Show MCP server badge for mcp__ prefixed tools or when mcpMetadata present
  const mcpServer =
    mcpMetadata?.server ??
    (() => {
      const match = toolPart.name.match(/^mcp__([^_]+)__/);
      return match ? match[1] : null;
    })();

  const extraContent = (
    <>
      {mcpServer && (
        <Badge
          variant="outline"
          className="text-[10px] px-1.5 py-0 font-mono"
          data-testid="mcp-badge"
        >
          MCP: {mcpServer}
        </Badge>
      )}
      {progressChunks && progressChunks.length > 0 && (
        <ProgressChunks chunks={progressChunks} />
      )}
      {isInProgress && !progressChunks?.length && (
        <span className="text-xs text-muted-foreground animate-pulse">
          {getToolVerb(toolPart.name, "pending")}
        </span>
      )}
    </>
  );

  if (
    artifactParts.length === 0 &&
    !mcpServer &&
    !progressChunks?.length &&
    !isInProgress
  ) {
    return renderedTool;
  }

  if (artifactParts.length === 0) {
    return (
      <div className="flex flex-col gap-1">
        {renderedTool}
        {extraContent}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {renderedTool}
      {extraContent}
      <div className="flex flex-col gap-2 pl-4">
        {artifactParts.map((part, index) => {
          const artifactDescriptor = findArtifactDescriptorForPart({
            artifacts: artifactDescriptors,
            part,
          });
          const handleOpenArtifact =
            artifactDescriptor && onOpenArtifact
              ? () => onOpenArtifact(artifactDescriptor.id)
              : undefined;

          switch (part.type) {
            case "rich-text":
              return (
                <RichTextPart
                  key={artifactDescriptor?.id ?? index}
                  richTextPart={part as UIRichTextPart}
                  onOpenInArtifactWorkspace={handleOpenArtifact}
                />
              );
            case "text-file":
              return (
                <TextFilePart
                  key={artifactDescriptor?.id ?? index}
                  textFileUrl={(part as UITextFilePart).file_url}
                  filename={(part as UITextFilePart).filename}
                  mimeType={(part as UITextFilePart).mime_type}
                  onOpenInArtifactWorkspace={handleOpenArtifact}
                />
              );
            case "pdf":
              return (
                <PdfPart
                  key={artifactDescriptor?.id ?? index}
                  pdfUrl={(part as UIPdfPart).pdf_url}
                  filename={(part as UIPdfPart).filename}
                  onOpenInArtifactWorkspace={handleOpenArtifact}
                />
              );
            case "image":
              return (
                <ImagePart
                  key={artifactDescriptor?.id ?? index}
                  imageUrl={(part as UIImagePart).image_url}
                  onOpenInArtifactWorkspace={handleOpenArtifact}
                />
              );
            default:
              return null;
          }
        })}
      </div>
    </div>
  );
}, areToolPartPropsEqual);

function areToolPartPropsEqual(
  prevProps: ToolPartProps,
  nextProps: ToolPartProps,
) {
  if (prevProps.toolPart !== nextProps.toolPart) {
    return false;
  }
  if (
    prevProps.threadId !== nextProps.threadId ||
    prevProps.threadChatId !== nextProps.threadChatId ||
    prevProps.isReadOnly !== nextProps.isReadOnly ||
    prevProps.promptBoxRef !== nextProps.promptBoxRef ||
    prevProps.githubRepoFullName !== nextProps.githubRepoFullName ||
    prevProps.repoBaseBranchName !== nextProps.repoBaseBranchName ||
    prevProps.branchName !== nextProps.branchName ||
    prevProps.onOptimisticPermissionModeUpdate !==
      nextProps.onOptimisticPermissionModeUpdate ||
    prevProps.artifactDescriptors !== nextProps.artifactDescriptors ||
    prevProps.onOpenArtifact !== nextProps.onOpenArtifact
  ) {
    return false;
  }

  const normalizedToolPart = normalizeToolCall(
    prevProps.toolPart.agent,
    prevProps.toolPart,
  );
  switch (normalizedToolPart.name) {
    case "SuggestFollowupTask":
    case "mcp__terry__SuggestFollowupTask":
      return prevProps.childThreads === nextProps.childThreads;
    case "ExitPlanMode":
      return prevProps.messages === nextProps.messages;
    default:
      return true;
  }
}

export { ToolPart };
