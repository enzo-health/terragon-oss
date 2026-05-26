import React, { memo, useCallback, useMemo, type ReactNode } from "react";
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
import {
  getCapability,
  getToolCapabilities,
  isToolName,
  type PermissionMode,
  type ToolCapability,
  type ToolName,
} from "./tools/tool-registry";
import { Badge } from "@/components/ui/badge";
import { RichTextPart } from "./rich-text-part";
import { TextFilePart } from "./text-file-part";
import { PdfPart } from "./pdf-part";
import { ImagePart } from "./image-part";
import {
  findArtifactDescriptorForPart,
  type ArtifactDescriptorLookup,
} from "./secondary-panel-helpers";
import { PromptBoxRef } from "./thread-context";
import { ChildThreadInfo } from "@terragon/shared/db/types";

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
  renderChildToolPart: (childToolPart: AllToolParts) => ReactNode;
};

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
 * Per-name renderer: each entry receives (1) the narrowed tool-part variant
 * for that key and (2) a capability bag sliced from `ToolRenderContext`.
 * Renderers extract only the capabilities they declared via
 * `TOOL_CAPABILITY_REQUIREMENTS` in `tool-registry.ts`. Simple tools like
 * `Read` only need `basic` (the toolPart itself); stateful tools like
 * `SuggestFollowupTask` pull `threadAccess`, `childThreads`, etc.
 */
type ToolRenderer<N extends ToolName> = (
  toolPart: ToolPartFor<N>,
  capabilities: ToolCapability[],
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
  Read: (tp) => <ReadTool toolPart={tp} />,
  Write: (tp) => <WriteTool toolPart={tp} />,
  Edit: (tp) => {
    // Some Edit calls come without new/old_string (e.g. partial updates from
    // older daemon versions). Fall back to DefaultTool rather than crash.
    if (
      tp.parameters &&
      "new_string" in tp.parameters &&
      "old_string" in tp.parameters
    ) {
      return <EditTool toolPart={tp} />;
    }
    return <DefaultTool toolPart={tp} />;
  },
  MultiEdit: (tp) => <MultiEditTool toolPart={tp} />,
  Grep: (tp) => <SearchTool toolPart={tp} />,
  Glob: (tp) => <SearchTool toolPart={tp} />,
  LS: (tp) => <LSTool toolPart={tp} />,
  Bash: (tp) => <BashTool toolPart={tp} />,
  TodoRead: (tp) => <TodoReadTool toolPart={tp} />,
  TodoWrite: (tp) => <TodoWriteTool toolPart={tp} />,
  NotebookRead: (tp) => <NotebookReadTool toolPart={tp} />,
  NotebookEdit: (tp) => <NotebookEditTool toolPart={tp} />,
  Task: (tp, caps) => {
    const childCap = getCapability(caps, "renderChild");
    return (
      <TaskTool toolPart={tp} renderToolPart={childCap.renderChildToolPart} />
    );
  },
  WebFetch: (tp) => <WebFetchTool toolPart={tp} />,
  WebSearch: (tp) => <WebSearchTool toolPart={tp} />,
  SuggestFollowupTask: (tp, caps) => {
    const threadCap = getCapability(caps, "threadAccess");
    const childCap = getCapability(caps, "childThreads");
    const ghCap = getCapability(caps, "githubContext");
    return (
      <SuggestFollowupTaskTool
        toolPart={{ ...tp, name: "SuggestFollowupTask" }}
        threadId={threadCap.threadId}
        childThreads={childCap.childThreads}
        githubRepoFullName={ghCap.repoFullName}
        repoBaseBranchName={ghCap.repoBaseBranchName}
      />
    );
  },
  // Alias from the MCP follow-up server. Same args, same component. The cast
  // is sound because both names share the `SuggestFollowupTask` parameter
  // shape (see ToolRegistry in tool-registry.ts).
  mcp__terry__SuggestFollowupTask: (tp, caps) =>
    TOOL_DISPATCH.SuggestFollowupTask(
      tp as Extract<AllToolParts, { name: "SuggestFollowupTask" }>,
      caps,
    ),
  ExitPlanMode: (tp, caps) => {
    const msgCap = getCapability(caps, "messagesRef");
    const artCap = getCapability(caps, "artifactAccess");
    return (
      <ExitPlanModeTool
        toolPart={tp}
        messages={msgCap.messagesRef.current}
        artifactDescriptors={artCap.artifactDescriptors}
        artifactDescriptorLookup={artCap.artifactDescriptorLookup}
        onOpenArtifact={artCap.onOpenArtifact}
      />
    );
  },
  PermissionRequest: (tp, caps) => {
    const threadCap = getCapability(caps, "threadAccess");
    const roCap = getCapability(caps, "readOnly");
    return (
      <PermissionRequestTool
        toolPart={tp}
        threadId={threadCap.threadId}
        threadChatId={threadCap.threadChatId}
        isReadOnly={roCap.isReadOnly}
      />
    );
  },
  FileChange: (tp) => <FileChangeTool toolPart={tp} />,
  // Codex MCPTool: rewrite name to `mcp__server__tool` then route to
  // DefaultTool. The daemon emits it pre-rewrite; this is the only place that
  // rewrite happens.
  MCPTool: (tp) => {
    const params = tp.parameters;
    if (!params || typeof params !== "object") {
      return <DefaultTool toolPart={tp} />;
    }
    const server = Reflect.get(params, "server");
    const tool = Reflect.get(params, "tool");
    const mcpName =
      typeof server === "string" && typeof tool === "string"
        ? `mcp__${server}__${tool}`
        : tp.name;
    const {
      server: _s,
      tool: _t,
      ...mcpArgs
    } = params as Record<string, unknown>;
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

/**
 * Build a capability array for a given tool name from the full render context.
 * Only includes capabilities the tool has declared it needs.
 */
function buildCapabilities(
  toolName: ToolName,
  renderCtx: ToolRenderContext,
): ToolCapability[] {
  const required = getToolCapabilities(toolName);
  const caps: ToolCapability[] = [];

  if (required.includes("basic")) {
    // `basic` is filled in at the dispatch site with the normalized toolPart,
    // not here — the toolPart varies per call.
  }
  if (required.includes("threadAccess")) {
    caps.push({
      kind: "threadAccess",
      threadId: renderCtx.threadId,
      threadChatId: renderCtx.threadChatId,
    });
  }
  if (required.includes("childThreads")) {
    caps.push({
      kind: "childThreads",
      childThreads: renderCtx.childThreads,
    });
  }
  if (required.includes("permissionMode")) {
    caps.push({
      kind: "permissionMode",
      mode:
        renderCtx.onOptimisticPermissionModeUpdate === undefined
          ? "allowAll"
          : ("allowAll" as PermissionMode), // We don't have the current mode here; this capability is unused by any tool today
      onUpdate: renderCtx.onOptimisticPermissionModeUpdate ?? (() => {}),
    });
  }
  if (required.includes("githubContext")) {
    caps.push({
      kind: "githubContext",
      repoFullName: renderCtx.githubRepoFullName,
      repoBaseBranchName: renderCtx.repoBaseBranchName,
    });
  }
  if (required.includes("messagesRef")) {
    caps.push({
      kind: "messagesRef",
      messagesRef: renderCtx.messagesRef,
    });
  }
  if (required.includes("readOnly")) {
    caps.push({
      kind: "readOnly",
      isReadOnly: renderCtx.isReadOnly,
    });
  }
  if (required.includes("artifactAccess")) {
    caps.push({
      kind: "artifactAccess",
      artifactDescriptors: renderCtx.artifactDescriptors,
      artifactDescriptorLookup: renderCtx.artifactDescriptorLookup,
      onOpenArtifact: renderCtx.onOpenArtifact,
    });
  }
  if (required.includes("renderChild")) {
    caps.push({
      kind: "renderChild",
      renderChildToolPart: renderCtx.renderChildToolPart,
    });
  }

  return caps;
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
  const name = toolPart.name;
  // Unknown tool names bypass capability slicing and go straight to DefaultTool.
  if (!isToolName(name)) {
    return renderUnknownTool(toolPart);
  }

  const capabilities = buildCapabilities(name, renderCtx);
  // Always include `basic` with the toolPart as the first capability.
  const allCapabilities: ToolCapability[] = [
    { kind: "basic", toolPart },
    ...capabilities,
  ];

  // `isToolName` proves membership in `TOOL_DISPATCH`, but TS still sees the
  // looked-up entry as a contravariant union of `ToolRenderer<N>` for each N
  // in `ToolName` — and the intersected parameter type collapses to `never`.
  // Widen at the dispatch boundary once via a typed alias; the runtime
  // discriminator is `toolPart.name` matching the registry key, so the
  // dispatch is sound. Mirrors the pattern in `renderPartFromRegistry`.
  type DispatchFn = (tp: AllToolParts, caps: ToolCapability[]) => ReactNode;
  const renderer: DispatchFn = TOOL_DISPATCH[name] as DispatchFn;
  return renderer(toolPart, allCapabilities);
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
    prevProps.onOpenArtifact !== nextProps.onOpenArtifact
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
