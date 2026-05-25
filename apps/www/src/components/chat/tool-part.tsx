import { normalizeToolCall } from "@terragon/agent/tool-calls";
import { AllToolParts, type UIMessage, type UIPart } from "@terragon/shared";
import type { ArtifactDescriptor } from "@terragon/shared/db/artifact-descriptors";
import { ChildThreadInfo } from "@terragon/shared/db/types";
import React, { memo, type ReactNode, useCallback, useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { ImagePart } from "./image-part";
import { PdfPart } from "./pdf-part";
import { RichTextPart } from "./rich-text-part";
import {
  type ArtifactDescriptorLookup,
  findArtifactDescriptorForPart,
} from "./secondary-panel-helpers";
import { TextFilePart } from "./text-file-part";
import { PromptBoxRef } from "./thread-context";
import { BashTool } from "./tools/bash-tool";
import { DefaultTool } from "./tools/default-tool";
import { EditTool } from "./tools/edit-tool";
import { ExitPlanModeTool } from "./tools/exit-plan-mode-tool";
import { FileChangeTool } from "./tools/file-change-tool";
import { LSTool } from "./tools/ls-tool";
import { MultiEditTool } from "./tools/multi-edit-tool";
import { NotebookEditTool, NotebookReadTool } from "./tools/notebook-tool";
import { PermissionRequestTool } from "./tools/permission-request-tool";
import { ProgressChunks } from "./tools/progress-chunks";
import { ReadTool } from "./tools/read-tool";
import { SearchTool } from "./tools/search-tool";
import { SuggestFollowupTaskTool } from "./tools/suggest-followup-task-tool";
import { TaskTool } from "./tools/task-tool";
import { TodoReadTool, TodoWriteTool } from "./tools/todo-tool";
import {
  isToolName,
  type ToolArgs,
  type ToolName,
} from "./tools/tool-registry";
import { getToolVerb } from "./tools/utils";
import { WebFetchTool, WebSearchTool } from "./tools/web-tool";
import { WriteTool } from "./tools/write-tool";

/**
 * Sibling state needed by a subset of tool renderers (Task, ExitPlanMode,
 * SuggestFollowupTask, PermissionRequest). Most tools take only `toolPart` and
 * ignore this. Carried as one struct so the dispatch table below stays a
 * uniform `Record<ToolName, RenderFn>`.
 */
export type ToolRenderContext = {
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
  artifactDescriptorLookup?: ArtifactDescriptorLookup;
  onOpenArtifact?: (artifactId: string) => void;
  /**
   * Opens an in-repo file path in the artifacts panel. `handleOpenRepoFile` in
   * `chat-ui.tsx` classifies the path and dispatches a `repo-file.opened` event
   * so the reducer synthesizes the artifact descriptor. `undefined` when the
   * `repoFilePreview` flag is off — its presence alone gates the affordance.
   * Renderers with a single `file_path` arg should use `repoFileArgClick`
   * rather than reading this directly.
   */
  onOpenRepoFile?: (filePath: string) => void;
  renderChildToolPart: (childToolPart: AllToolParts) => ReactNode;
};

/**
 * Resolves the click handler for a tool whose `toolArg` is a single in-repo
 * file path (Read/Write/Edit/MultiEdit). Returns `undefined` when the affordance
 * is gated off or the path is missing, so the derivation lives here once instead
 * of being duplicated across each renderer.
 */
function repoFileArgClick(
  ctx: ToolRenderContext,
  filePath: string | undefined,
): (() => void) | undefined {
  return ctx.onOpenRepoFile && filePath
    ? () => ctx.onOpenRepoFile?.(filePath)
    : undefined;
}

/**
 * Per-name tool variant. For tool names present as a discriminated arm in
 * `AllToolParts` (the typed daemon tools), this resolves to the exact
 * `UIToolPart<N, ...>` variant. For names that arrive only via the catch-all
 * `UIToolPart<string, Record<string, any>>` arm — `MCPTool` and
 * `mcp__terry__SuggestFollowupTask` — `Extract` collapses to `never`, so we
 * fall back to `AllToolParts`. The runtime discriminator is still
 * `toolPart.name`, dispatched through `isToolName`.
 */
type ToolPartFor<N extends ToolName> = [
  Extract<AllToolParts, { name: N }>,
] extends [never]
  ? AllToolParts
  : Extract<AllToolParts, { name: N }>;

/**
 * Per-name renderer: the dispatch table parameterizes each entry with the
 * exact tool variant for that key, so each renderer body sees its narrowed
 * `toolPart` without runtime casts. Compare to the previous shape, which
 * typed every entry as `(AllToolParts) => ...` and required a per-renderer
 * `narrow<N>()` cast inside the body.
 */
type ToolRenderer<N extends ToolName> = (
  toolPart: ToolPartFor<N>,
  ctx: ToolRenderContext,
) => ReactNode;

type ToolDispatchTable = { [N in ToolName]: ToolRenderer<N> };

/**
 * Typed dispatch table keyed by `ToolName` from `tool-registry.ts`. The mapped
 * `ToolDispatchTable` type makes TS prove every registry entry has a renderer
 * at compile time AND that each renderer body sees the correctly narrowed
 * variant. Adding a new `ToolName` without a dispatch entry is a type error.
 * Unknown tool names (not in `ToolName`) fall back to `renderUnknownTool` at
 * runtime.
 */
const TOOL_DISPATCH: ToolDispatchTable = {
  Read: (tp, ctx) => (
    <ReadTool
      toolPart={tp}
      onToolArgClick={repoFileArgClick(ctx, tp.parameters.file_path)}
    />
  ),
  Write: (tp, ctx) => (
    <WriteTool
      toolPart={tp}
      onToolArgClick={repoFileArgClick(ctx, tp.parameters.file_path)}
    />
  ),
  Edit: (tp, ctx) => {
    // Some Edit calls come without new/old_string (e.g. partial updates from
    // older daemon versions). Fall back to DefaultTool rather than crash.
    if (
      tp.parameters &&
      "new_string" in tp.parameters &&
      "old_string" in tp.parameters
    ) {
      return (
        <EditTool
          toolPart={tp}
          onToolArgClick={repoFileArgClick(ctx, tp.parameters.file_path)}
        />
      );
    }
    return <DefaultTool toolPart={tp} />;
  },
  MultiEdit: (tp, ctx) => (
    <MultiEditTool
      toolPart={tp}
      onToolArgClick={repoFileArgClick(ctx, tp.parameters.file_path)}
    />
  ),
  Grep: (tp) => <SearchTool toolPart={tp} />,
  Glob: (tp) => <SearchTool toolPart={tp} />,
  LS: (tp) => <LSTool toolPart={tp} />,
  Bash: (tp) => <BashTool toolPart={tp} />,
  TodoRead: (tp) => <TodoReadTool toolPart={tp} />,
  TodoWrite: (tp) => <TodoWriteTool toolPart={tp} />,
  NotebookRead: (tp) => <NotebookReadTool toolPart={tp} />,
  NotebookEdit: (tp) => <NotebookEditTool toolPart={tp} />,
  Task: (tp, ctx) => (
    <TaskTool toolPart={tp} renderToolPart={ctx.renderChildToolPart} />
  ),
  WebFetch: (tp) => <WebFetchTool toolPart={tp} />,
  WebSearch: (tp) => <WebSearchTool toolPart={tp} />,
  SuggestFollowupTask: (tp, ctx) => (
    <SuggestFollowupTaskTool
      toolPart={{ ...tp, name: "SuggestFollowupTask" }}
      threadId={ctx.threadId}
      childThreads={ctx.childThreads}
      githubRepoFullName={ctx.githubRepoFullName}
      repoBaseBranchName={ctx.repoBaseBranchName}
    />
  ),
  // Alias from the MCP follow-up server. Same args, same component. The cast
  // is sound because both names share the `SuggestFollowupTask` parameter
  // shape (see ToolRegistry in tool-registry.ts).
  mcp__terry__SuggestFollowupTask: (tp, ctx) =>
    TOOL_DISPATCH.SuggestFollowupTask(
      tp as Extract<AllToolParts, { name: "SuggestFollowupTask" }>,
      ctx,
    ),
  ExitPlanMode: (tp, ctx) => (
    <ExitPlanModeTool
      toolPart={tp}
      threadId={ctx.threadId}
      threadChatId={ctx.threadChatId}
      messages={ctx.messagesRef.current}
      isReadOnly={ctx.isReadOnly}
      onOptimisticPermissionModeUpdate={ctx.onOptimisticPermissionModeUpdate}
      artifactDescriptors={ctx.artifactDescriptors}
      artifactDescriptorLookup={ctx.artifactDescriptorLookup}
      onOpenArtifact={ctx.onOpenArtifact}
    />
  ),
  PermissionRequest: (tp, ctx) => (
    <PermissionRequestTool
      toolPart={tp}
      threadId={ctx.threadId}
      threadChatId={ctx.threadChatId}
      isReadOnly={ctx.isReadOnly}
    />
  ),
  FileChange: (tp, ctx) => (
    <FileChangeTool toolPart={tp} onOpenRepoFile={ctx.onOpenRepoFile} />
  ),
  // Codex MCPTool: rewrite name to `mcp__server__tool` then route to
  // DefaultTool. The daemon emits it pre-rewrite; this is the only place that
  // rewrite happens.
  MCPTool: (tp) => {
    const { server, tool, ...mcpArgs } = tp.parameters as ToolArgs<"MCPTool">;
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
 * `TOOL_DISPATCH`'s mapped type; this only fires on names outside the
 * registry's domain.
 */
const renderUnknownTool = (tp: AllToolParts): ReactNode => (
  <DefaultTool toolPart={tp} />
);

/**
 * Hoisted predicate-typed filter: a discriminated-union narrower for the
 * artifact-bearing UI part variants. Defined at module scope so the closure
 * isn't reallocated per render.
 */
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
  artifactDescriptorLookup?: ArtifactDescriptorLookup;
  onOpenArtifact?: (artifactId: string) => void;
  onOpenRepoFile?: (filePath: string) => void;
};

export function renderToolPartContent(
  rawToolPart: AllToolParts,
  renderCtx: ToolRenderContext,
): ReactNode {
  const toolPart = normalizeToolCall(rawToolPart.agent, rawToolPart);
  const renderedTool = renderNormalizedToolPart(toolPart, renderCtx);

  const artifactParts = toolPart.parts.filter(isArtifactPart);

  const progressChunks = toolPart.progressChunks;
  const progressHiddenCount = toolPart.progressHiddenCount ?? 0;
  const mcpMetadata = toolPart.mcpMetadata;
  const isInProgress =
    toolPart.toolStatus === "in_progress" && toolPart.status === "pending";

  // Show MCP server badge for mcp__ prefixed tools or when mcpMetadata present
  const mcpServer =
    mcpMetadata?.server ??
    (() => {
      const match = toolPart.name.match(/^mcp__([^_]+)__/);
      return match ? match[1] : null;
    })();

  const hasExtras = !!mcpServer || !!progressChunks?.length || isInProgress;

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
        <ProgressChunks
          chunks={progressChunks}
          hiddenCount={progressHiddenCount}
        />
      )}
      {isInProgress && !progressChunks?.length && (
        <span className="text-xs text-muted-foreground animate-pulse">
          {getToolVerb(toolPart.name, "pending")}
        </span>
      )}
    </>
  );

  if (artifactParts.length === 0 && !hasExtras) {
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
            artifacts: renderCtx.artifactDescriptors,
            lookup: renderCtx.artifactDescriptorLookup,
            part,
          });
          const handleOpenArtifact =
            artifactDescriptor && renderCtx.onOpenArtifact
              ? () => renderCtx.onOpenArtifact?.(artifactDescriptor.id)
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
}

export function renderToolPart(
  rawToolPart: AllToolParts,
  renderCtx: ToolRenderContext,
): ReactNode {
  const toolPart = normalizeToolCall(rawToolPart.agent, rawToolPart);
  return renderNormalizedToolPart(toolPart, renderCtx);
}

function renderNormalizedToolPart(
  toolPart: AllToolParts,
  renderCtx: ToolRenderContext,
): ReactNode {
  // `isToolName` proves membership in `TOOL_DISPATCH`, but TS still sees the
  // looked-up entry as a contravariant union of `ToolRenderer<N>` for each N
  // in `ToolName` — and the intersected parameter type collapses to `never`.
  // Widen at the dispatch boundary once via a typed alias; the runtime
  // discriminator is `toolPart.name` matching the registry key, so the
  // dispatch is sound. Mirrors the pattern in `renderPartFromRegistry`.
  type DispatchFn = (tp: AllToolParts, ctx: ToolRenderContext) => ReactNode;
  const renderer: DispatchFn = isToolName(toolPart.name)
    ? (TOOL_DISPATCH[toolPart.name] as DispatchFn)
    : renderUnknownTool;
  return renderer(toolPart, renderCtx);
}

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
  artifactDescriptorLookup,
  onOpenArtifact,
  onOpenRepoFile,
}: ToolPartProps) {
  // Stable recursive renderer. Deps mirror the props compared by
  // `areToolPartPropsEqual` below — when those are referentially stable across
  // renders, this callback identity is too, so memoized children of `TaskTool`
  // (which receives this via `renderToolPart`) don't see a churning prop.
  const renderChildToolPart = useCallback(
    (childToolPart: AllToolParts) => (
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
        artifactDescriptorLookup={artifactDescriptorLookup}
        onOpenArtifact={onOpenArtifact}
        onOpenRepoFile={onOpenRepoFile}
      />
    ),
    [
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
      artifactDescriptorLookup,
      onOpenArtifact,
      onOpenRepoFile,
      ToolPart,
    ],
  );

  // Context passed to renderers that need sibling state (Task, ExitPlanMode,
  // etc.). Tools that only need `toolPart` ignore it. Memoized on the same
  // dependency set as `renderChildToolPart` so dispatch-site renderers see
  // a stable `ctx` reference across renders.
  const renderCtx = useMemo<ToolRenderContext>(
    () => ({
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
      artifactDescriptorLookup,
      onOpenArtifact,
      onOpenRepoFile,
      renderChildToolPart,
    }),
    [
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
      artifactDescriptorLookup,
      onOpenArtifact,
      onOpenRepoFile,
      renderChildToolPart,
    ],
  );

  return renderToolPartContent(rawToolPart, renderCtx);
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
    prevProps.messagesRef !== nextProps.messagesRef ||
    prevProps.isReadOnly !== nextProps.isReadOnly ||
    prevProps.promptBoxRef !== nextProps.promptBoxRef ||
    prevProps.githubRepoFullName !== nextProps.githubRepoFullName ||
    prevProps.repoBaseBranchName !== nextProps.repoBaseBranchName ||
    prevProps.branchName !== nextProps.branchName ||
    prevProps.onOptimisticPermissionModeUpdate !==
      nextProps.onOptimisticPermissionModeUpdate ||
    prevProps.artifactDescriptors !== nextProps.artifactDescriptors ||
    prevProps.artifactDescriptorLookup !== nextProps.artifactDescriptorLookup ||
    prevProps.onOpenArtifact !== nextProps.onOpenArtifact ||
    prevProps.onOpenRepoFile !== nextProps.onOpenRepoFile
  ) {
    return false;
  }

  if (shouldToolPartTrackChildThreads(prevProps.toolPart)) {
    return prevProps.childThreads === nextProps.childThreads;
  }
  return true;
}

function shouldToolPartTrackChildThreads(toolPart: AllToolParts): boolean {
  switch (toolPart.name) {
    case "Task":
    case "SuggestFollowupTask":
    case "mcp__terry__SuggestFollowupTask":
      return true;
    case "MCPTool":
      return (
        toolPart.parameters.server === "terry" &&
        toolPart.parameters.tool === "SuggestFollowupTask"
      );
    default:
      return false;
  }
}

export { ToolPart };
