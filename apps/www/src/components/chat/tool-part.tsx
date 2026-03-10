import React, { memo } from "react";
import { normalizeToolCall } from "@terragon/agent/tool-calls";
import { AllToolParts, DBMessage } from "@terragon/shared";
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
}: ToolPartProps) {
  const toolPart = normalizeToolCall(rawToolPart.agent, rawToolPart);
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
        <LSTool toolPart={toolPart as Extract<AllToolParts, { name: "LS" }>} />
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
          toolPart={toolPart as Extract<AllToolParts, { name: "NotebookEdit" }>}
        />
      );
    case "NotebookRead":
      return (
        <NotebookReadTool
          toolPart={toolPart as Extract<AllToolParts, { name: "NotebookRead" }>}
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
          toolPart={toolPart as Extract<AllToolParts, { name: "ExitPlanMode" }>}
          threadId={threadId}
          threadChatId={threadChatId}
          messages={messages}
          isReadOnly={isReadOnly}
          promptBoxRef={promptBoxRef}
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
    prevProps.branchName !== nextProps.branchName
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
