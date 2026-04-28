import React, { memo, type ReactNode } from "react";
import { normalizeToolCall } from "@terragon/agent/tool-calls";
import { AllToolParts, type UIPart, type UIMessage } from "@terragon/shared";
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
import type { ToolName } from "./tools/tool-registry";
import { Badge } from "@/components/ui/badge";
import { RichTextPart } from "./rich-text-part";
import { TextFilePart } from "./text-file-part";
import { PdfPart } from "./pdf-part";
import { ImagePart } from "./image-part";
import { findArtifactDescriptorForPart } from "./secondary-panel";
import { PromptBoxRef } from "./thread-context";
import { ChildThreadInfo } from "@terragon/shared/db/types";

/**
 * Sibling state needed by a subset of tool renderers (Task, ExitPlanMode,
 * SuggestFollowupTask, PermissionRequest). Most tools take only `toolPart` and
 * ignore this. Carried as one struct so the dispatch table below stays a
 * uniform `Record<ToolName, RenderFn>`.
 */
type ToolRenderContext = {
  threadId: string;
  threadChatId: string;
  messagesRef: { current: UIMessage[] };
  isReadOnly: boolean;
  promptBoxRef?: React.RefObject<PromptBoxRef | null>;
  childThreads: ChildThreadInfo[];
  githubRepoFullName: string;
  repoBaseBranchName: string;
  branchName: string | null;
  onOptimisticPermissionModeUpdate?: (mode: "allowAll" | "plan") => void;
  artifactDescriptors: ArtifactDescriptor[];
  onOpenArtifact?: (artifactId: string) => void;
  renderChildToolPart: (childToolPart: AllToolParts) => ReactNode;
};

type ToolRenderer = (
  toolPart: AllToolParts,
  ctx: ToolRenderContext,
) => ReactNode;

/**
 * Typed cast for the very common "narrow `AllToolParts` to one variant" step.
 * Every renderer below knows its key statically, so the cast is sound — but TS
 * can't infer that from the `Record<ToolName, ToolRenderer>` shape alone.
 */
const narrow = <N extends AllToolParts["name"]>(tp: AllToolParts) =>
  tp as Extract<AllToolParts, { name: N }>;

/**
 * Typed dispatch table keyed by `ToolName` from `tool-registry.ts`. Using
 * `Record<ToolName, ToolRenderer>` makes TS prove every registry entry has a
 * renderer at compile time — adding a new `ToolName` without a dispatch entry
 * is a type error. Unknown tool names (not in `ToolName`) fall back to
 * `renderUnknownTool` at runtime.
 */
const TOOL_DISPATCH: Record<ToolName, ToolRenderer> = {
  Read: (tp) => <ReadTool toolPart={narrow<"Read">(tp)} />,
  Write: (tp) => <WriteTool toolPart={narrow<"Write">(tp)} />,
  Edit: (tp) => {
    // Some Edit calls come without new/old_string (e.g. partial updates from
    // older daemon versions). Fall back to DefaultTool rather than crash.
    if (
      tp.parameters &&
      "new_string" in tp.parameters &&
      "old_string" in tp.parameters
    ) {
      return <EditTool toolPart={narrow<"Edit">(tp)} />;
    }
    return <DefaultTool toolPart={tp} />;
  },
  MultiEdit: (tp) => <MultiEditTool toolPart={narrow<"MultiEdit">(tp)} />,
  Grep: (tp) => <SearchTool toolPart={narrow<"Grep">(tp)} />,
  Glob: (tp) => <SearchTool toolPart={narrow<"Glob">(tp)} />,
  LS: (tp) => <LSTool toolPart={narrow<"LS">(tp)} />,
  Bash: (tp) => <BashTool toolPart={narrow<"Bash">(tp)} />,
  TodoRead: (tp) => <TodoReadTool toolPart={narrow<"TodoRead">(tp)} />,
  TodoWrite: (tp) => <TodoWriteTool toolPart={narrow<"TodoWrite">(tp)} />,
  NotebookRead: (tp) => (
    <NotebookReadTool toolPart={narrow<"NotebookRead">(tp)} />
  ),
  NotebookEdit: (tp) => (
    <NotebookEditTool toolPart={narrow<"NotebookEdit">(tp)} />
  ),
  Task: (tp, ctx) => (
    <TaskTool
      toolPart={narrow<"Task">(tp)}
      renderToolPart={ctx.renderChildToolPart}
    />
  ),
  WebFetch: (tp) => <WebFetchTool toolPart={narrow<"WebFetch">(tp)} />,
  WebSearch: (tp) => <WebSearchTool toolPart={narrow<"WebSearch">(tp)} />,
  SuggestFollowupTask: (tp, ctx) => (
    <SuggestFollowupTaskTool
      toolPart={{
        ...narrow<"SuggestFollowupTask">(tp),
        name: "SuggestFollowupTask",
      }}
      threadId={ctx.threadId}
      childThreads={ctx.childThreads}
      githubRepoFullName={ctx.githubRepoFullName}
      repoBaseBranchName={ctx.repoBaseBranchName}
    />
  ),
  // Alias from the MCP follow-up server. Same args, same component.
  mcp__terry__SuggestFollowupTask: (tp, ctx) =>
    TOOL_DISPATCH.SuggestFollowupTask(tp, ctx),
  ExitPlanMode: (tp, ctx) => (
    <ExitPlanModeTool
      toolPart={narrow<"ExitPlanMode">(tp)}
      threadId={ctx.threadId}
      threadChatId={ctx.threadChatId}
      messages={ctx.messagesRef.current}
      isReadOnly={ctx.isReadOnly}
      onOptimisticPermissionModeUpdate={ctx.onOptimisticPermissionModeUpdate}
      artifactDescriptors={ctx.artifactDescriptors}
      onOpenArtifact={ctx.onOpenArtifact}
    />
  ),
  PermissionRequest: (tp, ctx) => (
    <PermissionRequestTool
      toolPart={narrow<"PermissionRequest">(tp)}
      threadId={ctx.threadId}
      threadChatId={ctx.threadChatId}
      isReadOnly={ctx.isReadOnly}
    />
  ),
  FileChange: (tp) => <FileChangeTool toolPart={narrow<"FileChange">(tp)} />,
  // Codex MCPTool: rewrite name to `mcp__server__tool` then route to
  // DefaultTool. The daemon emits it pre-rewrite; this is the only place that
  // rewrite happens.
  MCPTool: (tp) => {
    const { server, tool, ...mcpArgs } = tp.parameters as {
      server?: string;
      tool?: string;
      [key: string]: unknown;
    };
    const mcpName = server && tool ? `mcp__${server}__${tool}` : tp.name;
    return (
      <DefaultTool toolPart={{ ...tp, name: mcpName, parameters: mcpArgs }} />
    );
  },
};

/**
 * Runtime fallback for tool names not in the typed `ToolName` registry — e.g.
 * arbitrary `mcp__*` tools the daemon forwards or unknown tool names from a
 * newer daemon version. Compile-time exhaustiveness is preserved by
 * `TOOL_DISPATCH`'s `Record<ToolName, ...>` type; this only fires on names
 * outside the registry's domain.
 */
const renderUnknownTool: ToolRenderer = (tp) => <DefaultTool toolPart={tp} />;

/**
 * Type predicate: narrows an arbitrary string to `ToolName` by membership
 * in `TOOL_DISPATCH`. Replaces the previous `as ToolName` widening cast,
 * which let any daemon-supplied string slip into the dispatch table lookup
 * without proof. The runtime check is the same `name in TOOL_DISPATCH`
 * shape it always was — TypeScript just gets to see the narrowing now.
 */
function isToolName(name: string): name is ToolName {
  return name in TOOL_DISPATCH;
}

export type ToolPartProps = {
  toolPart: AllToolParts;
  threadId: string;
  threadChatId: string;
  messagesRef: { current: UIMessage[] };
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
  messagesRef,
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

  // Context passed to renderers that need sibling state (Task, ExitPlanMode,
  // etc.). Tools that only need `toolPart` ignore it. Phase 3b's typed-dispatch
  // alternative: compile-time exhaustiveness via `Record<ToolName, ...>`
  // without adopting `makeAssistantToolUI` (which requires args/result shapes
  // we don't have until plan Phases 1+2 land).
  const renderCtx: ToolRenderContext = {
    threadId,
    threadChatId,
    messagesRef,
    isReadOnly,
    promptBoxRef,
    childThreads,
    githubRepoFullName,
    repoBaseBranchName,
    branchName,
    onOptimisticPermissionModeUpdate,
    artifactDescriptors,
    onOpenArtifact,
    renderChildToolPart: (childToolPart) => (
      <ToolPart
        toolPart={childToolPart}
        threadId={threadId}
        threadChatId={threadChatId}
        messagesRef={messagesRef}
        isReadOnly={isReadOnly}
        promptBoxRef={promptBoxRef}
        childThreads={childThreads}
        githubRepoFullName={githubRepoFullName}
        repoBaseBranchName={repoBaseBranchName}
        branchName={branchName}
        onOptimisticPermissionModeUpdate={onOptimisticPermissionModeUpdate}
        artifactDescriptors={artifactDescriptors}
        onOpenArtifact={onOpenArtifact}
      />
    ),
  };

  const renderer = isToolName(toolPart.name)
    ? TOOL_DISPATCH[toolPart.name]
    : renderUnknownTool;
  const renderedTool = renderer(toolPart, renderCtx);

  // Predicate-typed filter so the switch below sees correctly narrowed parts
  // without per-case `as` casts. `UIPart` is a discriminated union on `type`;
  // narrowing through `Extract` keeps the dispatch source-of-truth in one
  // place.
  const isArtifactPart = (
    part: UIPart,
  ): part is Extract<
    UIPart,
    { type: "rich-text" | "text-file" | "pdf" | "image" }
  > =>
    part.type === "rich-text" ||
    part.type === "text-file" ||
    part.type === "pdf" ||
    part.type === "image";
  const artifactParts = toolPart.parts.filter(isArtifactPart);

  // Extended lifecycle fields carried from DBToolCall via InternalToolPart.
  // These live on the daemon-side `DBToolCall` (db-message.ts) but are not on
  // the UI `AllToolParts` union — widening the UI type to include them is a
  // separate refactor. The intersection cast is the minimum-surface bridge.
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
                  richTextPart={part}
                  onOpenInArtifactWorkspace={handleOpenArtifact}
                />
              );
            case "text-file":
              return (
                <TextFilePart
                  key={artifactDescriptor?.id ?? index}
                  textFileUrl={part.file_url}
                  filename={part.filename}
                  mimeType={part.mime_type}
                  onOpenInArtifactWorkspace={handleOpenArtifact}
                />
              );
            case "pdf":
              return (
                <PdfPart
                  key={artifactDescriptor?.id ?? index}
                  pdfUrl={part.pdf_url}
                  filename={part.filename}
                  onOpenInArtifactWorkspace={handleOpenArtifact}
                />
              );
            case "image":
              return (
                <ImagePart
                  key={artifactDescriptor?.id ?? index}
                  imageUrl={part.image_url}
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
    default:
      return true;
  }
}

export { ToolPart };
