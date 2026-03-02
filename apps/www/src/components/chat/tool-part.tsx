import React, { memo } from "react";
import { normalizeToolCall } from "@terragon/agent/tool-calls";
import { AllToolParts } from "@terragon/shared";
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
import { DefaultTool } from "./tools/default-tool";

const ToolPart = memo(function ToolPart({
  toolPart,
}: {
  toolPart: AllToolParts;
}) {
  toolPart = normalizeToolCall(toolPart.agent, toolPart);
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
          ToolPartComponent={ToolPart}
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
        />
      );
    case "ExitPlanMode":
      return (
        <ExitPlanModeTool
          toolPart={toolPart as Extract<AllToolParts, { name: "ExitPlanMode" }>}
        />
      );
    case "PermissionRequest":
      return (
        <PermissionRequestTool
          toolPart={
            toolPart as Extract<AllToolParts, { name: "PermissionRequest" }>
          }
        />
      );
    default:
      return <DefaultTool toolPart={toolPart} />;
  }
});

export { ToolPart };
